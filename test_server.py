import socket
import sqlite3
import tempfile
import threading
import unittest
import json
import os
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from pathlib import Path
from urllib.error import URLError

from server import (
    AuthenticationError, CourseCache, PortalClient, ScheduleConflictError,
    Handler, SearchFormParser, TranscriptParser, UserStore, classify_section,
    configured_cookie, cookie_header_from_json, load_env, save_portal_cookie,
)


TRANSCRIPT_FIXTURE = '''<table id="pg0_V_tblDivisonData">
<tr><th>Type</th><th>Attempted Credits</th><th>Earned Credits</th><th>GPA Credits</th><th>Quality Points</th><th>GPA</th></tr>
<tr><td>Transfer</td><td>0.00</td><td>6.00</td><td>0.00</td><td>0.00</td><td>0.000</td></tr>
<tr><td>Career</td><td>12.00</td><td>18.00</td><td>12.00</td><td>42.00</td><td>3.500</td></tr></table>
<table><tr><th>Course</th><th>Title</th><th>Grade</th><th>Repeat</th><th>Attempted Credits</th><th>Earned Credits</th><th>GPA Credits</th><th>Quality Points</th><th>GPA</th></tr>
<tr><td>MA 313 01</td><td>Algebra</td><td>B+</td><td>-</td><td>3.00</td><td>3.00</td><td>3.00</td><td>10.50</td><td></td></tr>
<tr><td>BIO 114L 05</td><td>Lab</td><td>WIP</td><td>-</td><td>0.00</td><td>0.00</td><td>0.00</td><td>0.00</td><td></td></tr>
<tr><td>Career Totals:</td><td>12</td><td>18</td><td>12</td><td>42</td><td>3.500</td></tr></table>'''


class TranscriptTests(unittest.TestCase):
    def test_preserves_official_totals_and_grade_points(self):
        parser = TranscriptParser()
        parser.feed(TRANSCRIPT_FIXTURE)
        result = parser.result()
        self.assertEqual(result['earnedCredits'], 18)
        self.assertEqual(result['gpaCredits'], 12)
        self.assertEqual(result['qualityPoints'], 42)
        self.assertEqual(result['gpa'], 3.5)
        self.assertEqual(len(result['courses']), 2)
        self.assertEqual(result['courses'][0]['code'], 'MA 313')
        self.assertEqual(result['courses'][0]['qualityPoints'], 10.5)
        self.assertEqual(result['courses'][1]['code'], 'BIO 114L')

    def test_rejects_login_page_and_missing_cookie(self):
        parser = TranscriptParser()
        parser.feed('<form>Log in</form>')
        with self.assertRaisesRegex(RuntimeError, 'login cookie'):
            parser.result()
        with self.assertRaises(ValueError):
            PortalClient('').transcript()

    def test_submits_view_transcript_and_supports_remembered_report(self):
        client = PortalClient('test=value')
        initial = '''<form id="MAINFORM" action="?portlet=Unofficial_Transcript">
        <input type="hidden" name="__VIEWSTATE" value="fresh-state">
        <a id="pg0_V_lnkViewTrans">View</a></form>'''
        with patch.object(client, '_request', side_effect=[initial, TRANSCRIPT_FIXTURE]) as request:
            self.assertEqual(client.transcript()['gpa'], 3.5)
            body = request.call_args_list[1].args[1]
            self.assertIn(b'fresh-state', body)
            self.assertIn(b'pg0$V$lnkViewTrans', body)
        with patch.object(client, '_request', return_value=TRANSCRIPT_FIXTURE) as request:
            self.assertEqual(client.transcript()['gpa'], 3.5)
            request.assert_called_once()

    def test_transcript_is_owner_only_and_private_files_are_not_served(self):
        with tempfile.TemporaryDirectory() as directory:
            store = UserStore(Path(directory) / 'users.sqlite3', bcrypt_rounds=4)
            _owner, owner_token = store.register('portal-owner', 'long enough password')
            _other, other_token = store.register('other-student', 'long enough password')

            class TestHandler(Handler):
                user_store = store

                def log_message(self, *args):
                    pass

            httpd = ThreadingHTTPServer(('127.0.0.1', 0), TestHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = HTTPConnection(*httpd.server_address)
            try:
                with patch.dict(os.environ, {'MYPORTAL_OWNER_USERNAME': 'portal-owner'}), \
                     patch('server.configured_cookie', return_value=('test=value', 'test')), \
                     patch.object(PortalClient, 'transcript', return_value={'gpa': 3.5}) as fetch:
                    for token, status in [('', 401), (other_token, 403), (owner_token, 200)]:
                        connection.request('POST', '/api/transcript', headers={'Cookie': f'schedmgr_session={token}'})
                        response = connection.getresponse()
                        self.assertEqual(response.status, status)
                        result = json.loads(response.read())
                        if status == 200:
                            self.assertEqual(result['gpa'], 3.5)
                            self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                    fetch.assert_called_once()
                for path in ['/myportal-cookies.json', '/.env', '/schedule-users.sqlite3', '/%2eenv', '/']:
                    connection.request('GET', path)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200 if path == '/' else 404)
                    response.read()
                connection.request('HEAD', '/myportal-cookies.json')
                response = connection.getresponse()
                self.assertEqual(response.status, 404)
                response.read()
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()
                thread.join()
                store.connection.close()


class CookieManagerTests(unittest.TestCase):
    def test_session_status_reads_portal_name_and_rejects_login_page(self):
        client = PortalClient('.ASPXAUTH=test')
        pages = [
            '<div id="welcomeBackBar"><span>Welcome back, <b>Jane Doe</b>!</span><a>Logout</a></div>',
            '<div id="welcomeBackBar"><span id="siteNavBar_welcomeBackBarLoggedIn_lblUserName">Jane &amp; Doe</span></div>',
            '<div id="welcomeBackBar"><div id="siteNavBar_welcomeBackBarLoggedOut_welcomeBackBarLoggedOut">Log in</div></div>',
        ]
        with patch.object(client, '_request', side_effect=pages):
            self.assertEqual(client.session_status(), {'valid': True, 'displayName': 'Jane Doe'})
            self.assertEqual(client.session_status(), {'valid': True, 'displayName': 'Jane & Doe'})
            self.assertEqual(client.session_status(), {'valid': False, 'displayName': ''})
        self.assertEqual(PortalClient('').session_status(), {'valid': False, 'displayName': ''})

    def test_persists_only_portal_cookies_and_reloads_after_restart(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            root = Path(directory)
            env = root / '.env'
            env.write_text('# Keep settings\nOTHER_SETTING=keep\nMYPORTAL_SESSION_COOKIE=old\nMYPORTAL_SESSION_COOKIE=duplicate\nMYPORTAL_COOKIES_JSON_FILE=old.json\n')
            exported = [
                {'name': '.ASPXAUTH', 'value': "new'login", 'domain': 'myportal.trine.edu'},
                {'name': 'foreign', 'value': 'private', 'domain': 'example.com'},
                {'name': 'expired', 'value': 'old', 'expirationDate': 1},
            ]
            cookie = cookie_header_from_json(json.dumps(exported))
            save_portal_cookie(cookie, root)
            self.assertEqual(configured_cookie(root)[0], ".ASPXAUTH=new'login")
            contents = env.read_text()
            self.assertIn('# Keep settings\nOTHER_SETTING=keep\n', contents)
            self.assertNotIn('foreign', contents)
            self.assertNotIn('expired', contents)
            self.assertEqual(contents.count('MYPORTAL_SESSION_COOKIE='), 1)
            self.assertEqual(env.stat().st_mode & 0o777, 0o600)
            for key in ['MYPORTAL_SESSION_COOKIE', 'MYPORTAL_COOKIES_JSON', 'MYPORTAL_COOKIES_JSON_FILE']:
                os.environ.pop(key, None)
            load_env(env)
            self.assertEqual(configured_cookie(root)[0], cookie)

    def test_failed_write_keeps_existing_file_and_active_session(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'MYPORTAL_SESSION_COOKIE': 'old=login'}):
            root = Path(directory)
            env = root / '.env'
            env.write_text('OTHER_SETTING=keep\n')
            with patch.object(Path, 'replace', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    save_portal_cookie('.ASPXAUTH=new', root)
            self.assertEqual(env.read_text(), 'OTHER_SETTING=keep\n')
            self.assertEqual(configured_cookie(root)[0], 'old=login')
            self.assertEqual(list(root.iterdir()), [env])

    def test_upload_access_validation_and_immediate_transcript_use(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'MYPORTAL_OWNER_USERNAME': 'portal-owner', 'MYPORTAL_SESSION_COOKIE': 'old=login'}):
            root = Path(directory)
            store = UserStore(root / 'users.sqlite3', bcrypt_rounds=4)
            _, owner_token = store.register('portal-owner', 'long enough password')
            _, other_token = store.register('other-student', 'long enough password')

            class TestHandler(Handler):
                user_store = store

                def log_message(self, *args):
                    pass

            httpd = ThreadingHTTPServer(('127.0.0.1', 0), TestHandler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            connection = HTTPConnection(*httpd.server_address)

            def request(method, token, payload=None, content_type='application/json', path='/api/myportal-cookies'):
                connection.request(method, path, body=json.dumps(payload) if payload is not None else None,
                                   headers={'Cookie': f'schedmgr_session={token}', 'Content-Type': content_type})
                response = connection.getresponse()
                return response.status, json.loads(response.read())

            try:
                payload = {'cookies': [{'name': '.ASPXAUTH', 'value': 'new-login', 'domain': 'myportal.trine.edu'}]}
                with patch('server.save_portal_cookie', side_effect=lambda cookie: save_portal_cookie(cookie, root)) as save, \
                     patch.object(PortalClient, 'session_status', return_value={'valid': True, 'displayName': 'Jane Doe'}) as session_status, \
                     patch.object(PortalClient, 'transcript', autospec=True, return_value={'gpa': 3.5}) as verify:
                    for token, expected in [('', 401), (other_token, 403)]:
                        self.assertEqual(request('POST', token, payload)[0], expected)
                    self.assertEqual(request('GET', other_token)[1], {'canManage': False})
                    session_status.assert_not_called()
                    self.assertEqual(request('GET', owner_token)[1], {'canManage': True, 'configured': True, 'valid': True, 'displayName': 'Jane Doe'})
                    session_status.side_effect = RuntimeError('upstream failure')
                    self.assertEqual(request('GET', owner_token)[1], {'canManage': True, 'valid': False, 'displayName': ''})
                    session_status.side_effect = None
                    for invalid in [None, [], {'foo': None}, [{'name': '.ASPXAUTH', 'value': 'old', 'expirationDate': 1}],
                                    [{'name': '.ASPXAUTH', 'value': 'bad\nheader'}],
                                    [{'name': '.ASPXAUTH', 'value': 'foreign', 'domain': 'example.com'}]]:
                        self.assertEqual(request('POST', owner_token, {'cookies': invalid})[0], 400)
                    self.assertEqual(request('POST', owner_token, payload, 'text/plain')[0], 400)
                    verify.assert_not_called()
                    save.assert_not_called()
                    verify.side_effect = RuntimeError('expired login')
                    self.assertEqual(request('POST', owner_token, payload)[0], 502)
                    save.assert_not_called()
                    self.assertEqual(configured_cookie(root)[0], 'old=login')
                    verify.side_effect = None
                    status, result = request('POST', owner_token, payload)
                    self.assertEqual(status, 200)
                    self.assertEqual(result, {'configured': True, 'verified': True, 'valid': True, 'displayName': 'Jane Doe'})
                    self.assertNotIn('new-login', json.dumps(result))
                    self.assertEqual(configured_cookie(root)[0], '.ASPXAUTH=new-login')
                    self.assertEqual(request('POST', owner_token, path='/api/transcript')[0], 200)
                    self.assertEqual(verify.call_args.args[0].cookie, '.ASPXAUTH=new-login')
            finally:
                connection.close()
                httpd.shutdown()
                httpd.server_close()
                thread.join()
                store.connection.close()


class UserStoreTests(unittest.TestCase):
    def test_registers_and_verifies_a_bcrypt_password(self):
        with tempfile.TemporaryDirectory() as directory:
            store = UserStore(Path(directory) / "users.sqlite3", bcrypt_rounds=4)
            user, token = store.register("student.one", "correct horse battery staple")

            stored = store.connection.execute(
                "SELECT password_hash FROM users WHERE id = ?", (user["id"],)
            ).fetchone()[0]
            self.assertTrue(bytes(stored).startswith((b"$2a$", b"$2b$")))
            self.assertEqual(store.authenticate(token)["username"], "student.one")
            logged_in, second_token = store.login("STUDENT.ONE", "correct horse battery staple")
            self.assertEqual(logged_in["id"], user["id"])
            self.assertEqual(store.authenticate(second_token)["id"], user["id"])
            with self.assertRaises(AuthenticationError):
                store.login("student.one", "incorrect password")
            store.connection.close()

    def test_schedule_persists_across_clients_and_rejects_stale_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "users.sqlite3"
            first = UserStore(path, bcrypt_rounds=4)
            user, _token = first.register("student", "long enough password")
            state = {"v": 1, "courses": [{"id": "c1", "code": "CS 1113"}], "terms": ["FA26"]}
            saved = first.save_schedule(user["id"], state, 0)
            self.assertEqual(saved["revision"], 1)
            first.connection.close()

            second = UserStore(path, bcrypt_rounds=4)
            loaded = second.get_schedule(user["id"])
            self.assertEqual(loaded["state"], state)
            self.assertEqual(loaded["revision"], 1)
            second.save_schedule(user["id"], {**state, "terms": ["FA26", "SP27"]}, 1)
            with self.assertRaises(ScheduleConflictError) as conflict:
                second.save_schedule(user["id"], state, 1)
            self.assertEqual(conflict.exception.revision, 2)
            second.connection.close()

    def test_logout_invalidates_only_that_session(self):
        with tempfile.TemporaryDirectory() as directory:
            store = UserStore(Path(directory) / "users.sqlite3", bcrypt_rounds=4)
            user, first_token = store.register("student", "long enough password")
            _user, second_token = store.login("student", "long enough password")
            store.logout(first_token)
            self.assertIsNone(store.authenticate(first_token))
            self.assertEqual(store.authenticate(second_token)["id"], user["id"])
            store.connection.close()

    def test_default_user_can_change_password_and_other_sessions_expire(self):
        with tempfile.TemporaryDirectory() as directory:
            store = UserStore(Path(directory) / "users.sqlite3", bcrypt_rounds=4)
            store.ensure_default_user("jonathan", "password123")
            user, current_token = store.login("jonathan", "password123")
            _user, other_token = store.login("jonathan", "password123")
            self.assertTrue(user["mustChangePassword"])

            store.change_password(user["id"], "password123", "a much better password", current_token)

            self.assertIsNotNone(store.authenticate(current_token))
            self.assertIsNone(store.authenticate(other_token))
            with self.assertRaises(AuthenticationError):
                store.login("jonathan", "password123")
            changed, _token = store.login("jonathan", "a much better password")
            self.assertFalse(changed["mustChangePassword"])
            store.connection.close()


class ScheduleParsingTests(unittest.TestCase):
    def test_preserves_time_when_portal_omits_meeting_days(self):
        parsed = classify_section({
            "courseCode": "CSIT 103 1D1",
            "baseCode": "CSIT 103",
            "schedule": "7:30 AM-4:30 PM; Detroit MI Campus, Detroit, TBA",
            "seats": "1 / 20",
            "beginDate": "8/24/2026",
            "endDate": "12/19/2026",
        })

        self.assertEqual(parsed["timeLabel"], "7:30 AM–4:30 PM")
        self.assertEqual(parsed["daysLabel"], "TBA")
        self.assertEqual(parsed["meetings"], [])

    def test_separates_multiple_meetings_from_location(self):
        parsed = classify_section({
            "courseCode": "BIO 201 01",
            "baseCode": "BIO 201",
            "schedule": "MWF 9:00 AM-9:50 AM; R 2:00 PM-3:50 PM; Best Hall, 201",
            "seats": "4 / 24",
            "beginDate": "8/24/2026",
            "endDate": "12/19/2026",
        })

        self.assertEqual(len(parsed["meetings"]), 2)
        self.assertEqual(parsed["location"], "Best Hall, 201")


class CatalogSnapshotTests(unittest.TestCase):
    @staticmethod
    def section(code, section, title="Course"):
        course_code = f"{code} {section}"
        row = {
            "courseCode": course_code, "baseCode": code, "sectionCode": section,
            "title": title, "status": "Open", "beginDate": "8/24/2026",
            "endDate": "12/19/2026", "schedule": "MWF 9:00 AM-9:50 AM; Best Hall, 201",
            "seats": "4 / 24", "credits": "3", "faculty": "Ada Lovelace",
        }
        row.update(classify_section(row))
        return row

    def test_queries_only_the_latest_completed_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CourseCache(Path(directory) / "catalog.sqlite3")
            first = cache.begin_catalog_sync()
            cache.stage_catalog_term(first, "2026;FA", "2026-2027 - Fall Semester", "FA26", [
                {"courseCode": "CS 1113 01", "baseCode": "CS 1113", "sectionCode": "01", "title": "Old", "status": "Open", "beginDate": "8/24/2026", "endDate": "12/19/2026"},
            ])
            cache.complete_catalog_sync(first)

            incomplete = cache.begin_catalog_sync()
            cache.stage_catalog_term(incomplete, "2026;FA", "2026-2027 - Fall Semester", "FA26", [
                {"courseCode": "CS 1113 02", "baseCode": "CS 1113", "sectionCode": "02", "title": "Incomplete", "status": "Open", "beginDate": "8/24/2026", "endDate": "12/19/2026"},
            ])

            rows = cache.search_catalog({"term": "2026;FA", "department": "CS", "courseNumber": "1113"})
            self.assertEqual([row["title"] for row in rows], ["Old"])

            cache.complete_catalog_sync(incomplete)
            rows = cache.search_catalog({"term": "2026;FA", "department": "CS", "courseNumber": "1113"})
            self.assertEqual([row["title"] for row in rows], ["Incomplete"])
            cache.connection.close()

    def test_migrates_and_backfills_faculty_column(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.sqlite3"
            connection = sqlite3.connect(path)
            connection.execute("""CREATE TABLE catalog_sections (
                sync_id INTEGER NOT NULL, term TEXT NOT NULL, base_code TEXT NOT NULL,
                course_code TEXT NOT NULL, department TEXT NOT NULL,
                course_number TEXT NOT NULL, section_code TEXT NOT NULL,
                title TEXT NOT NULL, status TEXT NOT NULL, begin_date TEXT NOT NULL,
                end_date TEXT NOT NULL, payload_json TEXT NOT NULL,
                PRIMARY KEY (sync_id, term, course_code, begin_date, end_date)
            )""")
            connection.execute(
                """INSERT INTO catalog_sections VALUES
                   (1, '2026;FA', 'CS 1113', 'CS 1113 01', 'CS', '1113', '01',
                    'Programming', 'Open', '8/24/2026', '12/19/2026', ?)""",
                ('{"faculty":"Grace Hopper"}',),
            )
            connection.commit()
            connection.close()

            cache = CourseCache(path)
            columns = {row[1] for row in cache.connection.execute("PRAGMA table_info(catalog_sections)")}
            self.assertIn("faculty", columns)
            self.assertEqual(
                cache.connection.execute("SELECT faculty FROM catalog_sections").fetchone()[0],
                "Grace Hopper",
            )
            cache.connection.close()

    def test_every_reader_uses_the_completed_sqlite_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CourseCache(Path(directory) / "catalog.sqlite3")
            sync_id = cache.begin_catalog_sync()
            cache.stage_catalog_term(sync_id, "2026;FA", "2026-2027 - Fall Semester", "FA26", [
                self.section("CS 1113", "01", "Programming"),
            ])
            cache.complete_catalog_sync(sync_id)
            client = PortalClient("", cache)

            self.assertEqual(len(client.search({"term": "2026;FA", "department": "CS"})["results"]), 1)
            self.assertEqual(client.availability({"courseCode": "CS 1113", "fromTerm": "FA26"})["availableTerms"], 1)
            enriched = client.enrich_courses({
                "fromTerm": "FA26",
                "courses": [{"id": "course-1", "code": "CS 1113", "title": "Programming", "term": "FA26"}],
            })
            section = enriched["courses"]["course-1"]["byTerm"]["FA26"]["sections"][0]
            self.assertEqual(section["timeLabel"], "9:00 AM–9:50 AM")
            self.assertEqual(section["faculty"], "Ada Lovelace")
            stored = cache.connection.execute(
                "SELECT faculty FROM catalog_sections WHERE sync_id = ?", (sync_id,)
            ).fetchone()
            self.assertEqual(stored[0], "Ada Lovelace")
            self.assertEqual(enriched["source"], "sqlite")
            cache.connection.close()

    def test_replaces_only_one_course_in_active_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CourseCache(Path(directory) / "catalog.sqlite3")
            sync_id = cache.begin_catalog_sync()
            cache.stage_catalog_term(sync_id, "2026;FA", "2026-2027 - Fall Semester", "FA26", [
                self.section("CS 1113", "01", "Old Programming"),
                self.section("MA 164", "01", "Calculus"),
            ])
            cache.complete_catalog_sync(sync_id)

            cache.replace_catalog_course("CS 1113", {
                "2026;FA": [self.section("CS 1113", "02", "Fresh Programming")],
            })

            programming = cache.search_catalog({"term": "2026;FA", "courseNumber": "1113"})
            calculus = cache.search_catalog({"term": "2026;FA", "courseNumber": "164"})
            self.assertEqual([(row["sectionCode"], row["title"]) for row in programming], [
                ("02", "Fresh Programming"),
            ])
            self.assertEqual([row["title"] for row in calculus], ["Calculus"])
            cache.connection.close()

    def test_refreshes_one_course_from_portal_into_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CourseCache(Path(directory) / "catalog.sqlite3")
            sync_id = cache.begin_catalog_sync()
            cache.stage_catalog_term(sync_id, "2026;FA", "2026-2027 - Fall Semester", "FA26", [
                self.section("CS 1113", "01", "Old Programming"),
            ])
            cache.stage_catalog_term(sync_id, "2026;SP", "2026-2027 - Spring Semester", "SP27", [])
            cache.complete_catalog_sync(sync_id)

            class FakePortal:
                def __init__(self):
                    self.calls = []

                def _search(inner_self, query):
                    inner_self.calls.append(query)
                    section = "02" if query["term"] == "2026;FA" else "03"
                    return {"results": [self.section("CS 1113", section, "Fresh Programming")]}

            client = PortalClient("", cache)
            fake = FakePortal()
            client.public_search_client = fake
            result = client.refresh_course({"courseCode": "CS 1113"})

            self.assertEqual(result["sections"], 2)
            self.assertEqual(len(fake.calls), 2)
            self.assertEqual(
                [row["sectionCode"] for row in cache.search_catalog({"term": "2026;FA", "courseNumber": "1113"})],
                ["02"],
            )
            self.assertEqual(
                [row["sectionCode"] for row in cache.search_catalog({"term": "2026;SP", "courseNumber": "1113"})],
                ["03"],
            )
            cache.connection.close()

    def test_restart_marks_interrupted_refresh_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.sqlite3"
            first = CourseCache(path)
            sync_id = first.begin_catalog_sync()
            first.connection.close()

            reopened = CourseCache(path)
            attempt = reopened.catalog_status()["lastAttempt"]
            self.assertEqual(attempt["id"], sync_id)
            self.assertEqual(attempt["status"], "failed")
            self.assertIn("restarted", attempt["error"])
            reopened.connection.close()

    def test_rejects_overlapping_catalog_refresh(self):
        client = PortalClient()
        client.refresh_lock.acquire()
        try:
            with self.assertRaisesRegex(RuntimeError, "already in progress"):
                client.refresh_catalog()
        finally:
            client.refresh_lock.release()

    def test_retries_temporary_dns_failure(self):
        class Headers:
            @staticmethod
            def get_content_charset():
                return "utf-8"

        class Response:
            headers = Headers()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read():
                return b"recovered"

        class FlakyOpener:
            def __init__(self):
                self.calls = 0

            def open(self, _request, timeout):
                self.calls += 1
                if self.calls < 3:
                    raise URLError(socket.gaierror(-3, "Temporary failure in name resolution"))
                return Response()

        client = PortalClient()
        client.opener = FlakyOpener()
        client.request_interval = 0
        client.retry_base_delay = 0
        client.request_attempts = 3

        self.assertEqual(client._request("https://myportal.trine.edu/test"), "recovered")
        self.assertEqual(client.opener.calls, 3)

    def test_catalog_importer_shards_a_capped_department(self):
        rows = [self.section(f"CS {100 + index}", "01") for index in range(25)]

        class FakeSearchClient:
            def __init__(self):
                self.calls = []

            def _search(inner_self, query):
                inner_self.calls.append(query)
                if "courseFrom" not in query:
                    return {"results": rows[:20]}
                low, high = int(query["courseFrom"]), int(query["courseTo"])
                return {"results": [row for row in rows if low <= int(row["baseCode"].split()[1]) <= high][:20]}

        client = PortalClient.__new__(PortalClient)
        fake = FakeSearchClient()
        found, requests = client._fetch_department(fake, "2026;FA", "CS", [str(number) for number in range(100, 125)])

        self.assertEqual(len(found), 25)
        self.assertEqual(requests, 4)

    def test_department_probe_clears_retained_course_range(self):
        form = SearchFormParser()
        form.feed("""<form id="MAINFORM" action="/search">
            <select name="pg0$V$ddlTerm"><option value="2026;FA" selected>2026-2027 - Fall Semester</option></select>
            <select name="pg0$V$ddlCourseFrom"><option value="101" selected>101</option></select>
            <select name="pg0$V$ddlCourseTo"><option value="493" selected>493</option></select>
        </form>""")

        class CapturingClient(PortalClient):
            def form_for_term(inner_self, term):
                return form

            def _request(inner_self, url, data=None, content_type=""):
                inner_self.sent_body = data.decode()
                return '<table id="pg0_V_dgCourses"><tbody></tbody></table>'

        client = CapturingClient()
        client.request_interval = 0
        client._search({"term": "2026;FA", "department": "CS", "division": "UG"})

        self.assertIn('name="pg0$V$ddlCourseFrom"\r\n\r\n\r\n', client.sent_body)
        self.assertIn('name="pg0$V$ddlCourseTo"\r\n\r\n\r\n', client.sent_body)
        self.assertNotIn('\r\n\r\n101\r\n', client.sent_body)
        self.assertNotIn('\r\n\r\n493\r\n', client.sent_body)


if __name__ == "__main__":
    unittest.main()
