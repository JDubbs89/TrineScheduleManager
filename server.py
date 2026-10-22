#!/usr/bin/env python3
"""Serve Schedule Manager and proxy Trine's Web Forms course search.

The browser never receives MYPORTAL_SESSION_COOKIE. The proxy first loads the
search page to obtain fresh ASP.NET state, then submits the form and turns the
results table into JSON.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, HTTPCookieProcessor, Request, build_opener
from http.cookiejar import CookieJar


ROOT = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("SCHEDULE_DATA_FILE", "")).expanduser()
SEARCH_URL = (
    "https://myportal.trine.edu/ICS/default.aspx?portlet=Course_Schedules"
    "&screen=Advanced%20Course%20Search&screenType=next"
)
USER_AGENT = "ScheduleManager/1.0 (+local course search)"
MAX_REQUEST_BYTES = 32_768


def load_env(path: Path) -> None:
    """Load a small dotenv file without adding a runtime dependency."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value[:1] == value[-1:] and value[:1] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def cookie_header_from_json(raw: str) -> str:
    """Convert common browser-extension JSON exports into a Cookie header."""
    try:
        exported = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError(f"Cookie JSON is invalid: {error.msg}") from error

    if isinstance(exported, dict) and isinstance(exported.get("cookies"), list):
        exported = exported["cookies"]
    elif isinstance(exported, dict) and "name" in exported and "value" in exported:
        exported = [exported]
    elif isinstance(exported, dict):
        exported = [{"name": name, "value": value} for name, value in exported.items()]
    if not isinstance(exported, list):
        raise ValueError("Cookie JSON must be an array of cookies, a cookies object, or a name/value map")

    cookies: dict[str, str] = {}
    now = time.time()
    for item in exported:
        if not isinstance(item, dict):
            continue
        name, value = str(item.get("name", "")), str(item.get("value", ""))
        domain = str(item.get("domain", "")).lstrip(".").lower()
        path = str(item.get("path", "/"))
        expiry = item.get("expirationDate", item.get("expires"))
        if domain and domain != "myportal.trine.edu" and not "myportal.trine.edu".endswith("." + domain):
            continue
        if path and not "/ICS/default.aspx".startswith(path.rstrip("/") or "/"):
            continue
        try:
            if expiry not in (None, "", -1) and float(expiry) < now:
                continue
        except (TypeError, ValueError):
            pass
        if not name or any(char in name for char in ";=\r\n"):
            continue
        if any(char in value for char in ";\r\n"):
            continue
        cookies[name] = value
    if not cookies:
        raise ValueError("Cookie JSON contains no usable cookies for myportal.trine.edu")
    return "; ".join(f"{name}={value}" for name, value in cookies.items())


def configured_cookie(root: Path = ROOT) -> tuple[str, str]:
    """Read a raw header, inline JSON, or JSON export file (in that order)."""
    raw_header = os.environ.get("MYPORTAL_SESSION_COOKIE", "").strip()
    if raw_header:
        return raw_header, "header"
    inline_json = os.environ.get("MYPORTAL_COOKIES_JSON", "").strip()
    json_file = os.environ.get("MYPORTAL_COOKIES_JSON_FILE", "").strip()
    if inline_json:
        return cookie_header_from_json(inline_json), "JSON"
    if json_file:
        path = Path(json_file).expanduser()
        if not path.is_absolute():
            path = root / path
        try:
            return cookie_header_from_json(path.read_text(encoding="utf-8")), f"JSON file {path.name}"
        except OSError as error:
            raise ValueError(f"Could not read cookie JSON file {path}: {error.strerror}") from error
    return "", "public search"


@dataclass
class SelectField:
    name: str
    element_id: str = ""
    options: list[dict[str, str]] = field(default_factory=list)


class SearchFormParser(HTMLParser):
    """Extract successful controls and option lists from MAINFORM."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_form = False
        self.form_depth = 0
        self.action = SEARCH_URL
        self.fields: list[tuple[str, str]] = []
        self.selects: dict[str, SelectField] = {}
        self._select: SelectField | None = None
        self._option: dict[str, str | bool] | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag == "form" and a.get("id") == "MAINFORM":
            self.in_form = True
            self.form_depth = 1
            self.action = urljoin(SEARCH_URL, a.get("action") or SEARCH_URL)
            return
        if not self.in_form:
            return
        if tag == "form":
            self.form_depth += 1
        if tag == "input":
            name = a.get("name")
            kind = (a.get("type") or "text").lower()
            if not name or a.get("disabled") is not None:
                return
            if kind in {"button", "image", "file", "reset", "submit"}:
                return
            if kind in {"checkbox", "radio"} and a.get("checked") is None:
                return
            # Global login/search controls are unrelated and can trigger validation.
            if not (name.startswith("pg0$V$") or kind == "hidden"):
                return
            self.fields.append((name, a.get("value") or ""))
        elif tag == "select" and a.get("name"):
            self._select = SelectField(a["name"], a.get("id") or "")
            self.selects[self._select.name] = self._select
        elif tag == "option" and self._select is not None:
            self._option = {
                "value": a.get("value") or "",
                "selected": a.get("selected") is not None,
            }
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._option is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if not self.in_form:
            return
        if tag == "option" and self._select is not None and self._option is not None:
            option = {
                "value": str(self._option["value"]),
                "label": " ".join("".join(self._text).split()),
            }
            if self._option["selected"]:
                option["selected"] = "true"
            self._select.options.append(option)
            self._option = None
            self._text = []
        elif tag == "select" and self._select is not None:
            selected = [o for o in self._select.options if o.get("selected") == "true"]
            defaults = selected or self._select.options[:1]
            self.fields.extend((self._select.name, o["value"]) for o in defaults)
            self._select = None
        elif tag == "form":
            self.form_depth -= 1
            if self.form_depth <= 0:
                self.in_form = False


class ResultsParser(HTMLParser):
    HEADERS = [
        "add", "textbooks", "courseCode", "title", "faculty", "seats",
        "status", "schedule", "credits", "beginDate", "endDate",
    ]

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_table = False
        self.in_body = False
        self.in_row = False
        self.in_cell = False
        self.skip_row = False
        self.cells: list[str] = []
        self.text: list[str] = []
        self.rows: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag == "table" and a.get("id") == "pg0_V_dgCourses":
            self.in_table = True
        elif self.in_table and tag == "tbody":
            self.in_body = True
        elif self.in_body and tag == "tr":
            classes = (a.get("class") or "").split()
            self.in_row = True
            self.skip_row = "subItem" in classes
            self.cells = []
        elif self.in_row and tag == "td":
            self.in_cell = True
            self.text = []
        elif self.in_cell and tag in {"br", "li"}:
            self.text.append(" ")

    def handle_data(self, data: str) -> None:
        if self.in_cell:
            self.text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self.in_cell:
            self.cells.append(" ".join("".join(self.text).split()))
            self.in_cell = False
        elif tag == "tr" and self.in_row:
            if not self.skip_row and len(self.cells) >= len(self.HEADERS):
                row = dict(zip(self.HEADERS, self.cells[: len(self.HEADERS)]))
                row["baseCode"] = base_course_code(row["courseCode"])
                row.update(classify_section(row))
                self.rows.append(row)
            self.in_row = False
        elif tag == "tbody" and self.in_body:
            self.in_body = False
        elif tag == "table" and self.in_table:
            self.in_table = False


def base_course_code(value: str) -> str:
    match = re.match(r"^([A-Za-z]{2,9})\s+(\d{3,4})\b", value.strip())
    return f"{match.group(1).upper()} {match.group(2)}" if match else value.strip()


def clock_minutes(value: str) -> int:
    match = re.match(r"^(\d{1,2}):(\d{2})\s*([AP]M)$", value.strip(), re.I)
    if not match:
        return -1
    hour, minute, meridiem = int(match.group(1)), int(match.group(2)), match.group(3).upper()
    hour = hour % 12 + (12 if meridiem == "PM" else 0)
    return hour * 60 + minute


def classify_section(row: dict[str, str]) -> dict[str, object]:
    """Turn MyPortal's display strings into conflict-checkable section data."""
    course_code, base_code = row["courseCode"], row["baseCode"]
    section_code = course_code[len(base_code):].strip()
    schedule = row.get("schedule", "")
    online = bool(re.search(r"\bOL\b|\bOL[12]\b", section_code, re.I)) or schedule.lower().startswith("online")
    meetings = []
    pattern = re.compile(
        r"\b([MTWRFSU]{1,7})\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)",
        re.I,
    )
    for match in pattern.finditer(schedule):
        start, end = clock_minutes(match.group(2)), clock_minutes(match.group(3))
        if start >= 0 and end > start:
            meetings.append({
                "days": list(match.group(1).upper()), "daysLabel": match.group(1).upper(),
                "start": start, "end": end,
                "startLabel": match.group(2).upper().replace(" ", " "),
                "endLabel": match.group(3).upper().replace(" ", " "),
            })
    first_start = min((meeting["start"] for meeting in meetings), default=-1)
    time_of_day = "Asynchronous" if online and not meetings else (
        "Morning" if 0 <= first_start < 720 else "Afternoon" if first_start < 1020 else "Evening" if first_start >= 0 else "Unscheduled"
    )
    begin = row.get("beginDate", "")
    end = row.get("endDate", "")
    online_session = ""
    if online:
        explicit = re.search(r"\bOL([12])\b", section_code, re.I)
        if explicit:
            online_session = "OL" + explicit.group(1)
        else:
            try:
                begin_month = datetime.strptime(begin, "%m/%d/%Y").month
                end_month = datetime.strptime(end, "%m/%d/%Y").month
                online_session = "OL1" if end_month <= 10 else "OL2" if begin_month >= 10 else "OL"
            except ValueError:
                online_session = "OL"
    location = schedule.split(";", 1)[1].strip() if ";" in schedule else ""
    seats = re.match(r"(\d+)\s*/\s*(\d+)", row.get("seats", ""))
    return {
        "sectionCode": section_code,
        "modality": "Online" if online else "In person",
        "onlineSession": online_session,
        "meetings": meetings,
        "daysLabel": ", ".join(dict.fromkeys(meeting["daysLabel"] for meeting in meetings)) or ("Online" if online else "TBA"),
        "timeLabel": ", ".join(dict.fromkeys(f'{meeting["startLabel"]}–{meeting["endLabel"]}' for meeting in meetings)) or ("Asynchronous" if online else "TBA"),
        "timeOfDay": time_of_day,
        "location": location,
        "seatsOpen": int(seats.group(1)) if seats else None,
        "capacity": int(seats.group(2)) if seats else None,
    }


def multipart(fields: list[tuple[str, str]]) -> tuple[bytes, str]:
    boundary = "----ScheduleManager" + secrets.token_hex(16)
    chunks: list[bytes] = []
    for name, value in fields:
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode("utf-8"),
            b"\r\n",
        ])
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class SafeRedirectHandler(HTTPRedirectHandler):
    """Follow redirects without ever forwarding the portal cookie off-host."""

    def redirect_request(self, request, fp, code, msg, headers, new_url):
        redirected = super().redirect_request(request, fp, code, msg, headers, new_url)
        if redirected and urlparse(new_url).hostname != urlparse(request.full_url).hostname:
            redirected.remove_header("Cookie")
        return redirected


class PortalClient:
    def __init__(self, cookie: str = "") -> None:
        self.cookie = cookie.strip()
        self.opener = build_opener(SafeRedirectHandler(), HTTPCookieProcessor(CookieJar()))
        self.public_search_client = PortalClient("") if self.cookie else self
        # A Web Forms viewstate belongs to the cookie session that fetched it.
        self.lock = threading.RLock()

    def _request(self, url: str, data: bytes | None = None, content_type: str = "") -> str:
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(url, data=data, headers=headers, method="POST" if data else "GET")
        try:
            with self.opener.open(request, timeout=25) as response:
                return response.read().decode(response.headers.get_content_charset() or "utf-8", "replace")
        except (TimeoutError, socket.timeout) as error:
            raise RuntimeError("MyPortal query timed out without a response") from error
        except HTTPError as error:
            raise RuntimeError(f"MyPortal returned HTTP {error.code}") from error
        except URLError as error:
            raise RuntimeError(f"Could not reach MyPortal: {error.reason}") from error

    def form(self) -> SearchFormParser:
        parser = SearchFormParser()
        parser.feed(self._request(SEARCH_URL))
        if "pg0$V$ddlTerm" not in parser.selects:
            hint = " The session cookie may have expired." if self.cookie else ""
            raise RuntimeError("MyPortal did not return the course search form." + hint)
        return parser

    def options(self) -> dict[str, object]:
        with self.lock:
            form = self.public_search_client.form()
        names = {
            "terms": "pg0$V$ddlTerm",
            "departments": "pg0$V$ddlDept",
            "divisions": "pg0$V$ddlDivision",
            "campuses": "pg0$V$ddlCampus",
            "statuses": "pg0$V$ddlSecStatus",
        }
        return {
            key: [{k: v for k, v in option.items() if k != "selected"}
                  for option in form.selects[name].options]
            for key, name in names.items()
        } | {"cookieConfigured": bool(self.cookie)}

    def search(self, query: dict[str, object]) -> dict[str, object]:
        with self.lock:
            return self.public_search_client._search(query)

    def availability(self, query: dict[str, object]) -> dict[str, object]:
        code = clean(query.get("courseCode"), 30).upper()
        match = re.match(r"^([A-Z]{2,9})\s+(\d{3,4})$", code)
        if not match:
            raise ValueError("Course code must look like CS 111 or CS 1113")
        department, number = match.groups()
        from_term = clean(query.get("fromTerm"), 4)
        if from_term and not re.match(r"^(FA|SP|SU)\d{2}$", from_term):
            raise ValueError("Invalid starting term")

        with self.lock:
            search_client = self.public_search_client
            form = search_client.form()
            published = []
            for option in form.selects["pg0$V$ddlTerm"].options:
                plan_term = portal_term_to_plan_term(option["value"], option["label"])
                if plan_term and (not from_term or plan_term_key(plan_term) >= plan_term_key(from_term)):
                    published.append((option, plan_term))
            published.sort(key=lambda item: plan_term_key(item[1]))

            terms = []
            for option, plan_term in published:
                response = search_client._search({
                    "term": option["value"], "department": department,
                    "courseNumber": number, "division": "UG", "campus": "",
                    "status": "OpenFull",
                })
                terms.append({
                    "term": option["value"], "termLabel": option["label"],
                    "planTerm": plan_term, "results": response["results"],
                })
        return {
            "courseCode": code,
            "terms": terms,
            "availableTerms": sum(bool(term["results"]) for term in terms),
        }

    def enrich_courses(self, query: dict[str, object]) -> dict[str, object]:
        courses = query.get("courses")
        if not isinstance(courses, list) or len(courses) > 100:
            raise ValueError("courses must be an array of at most 100 items")
        from_term = clean(query.get("fromTerm"), 4)
        if from_term and not re.match(r"^(FA|SP|SU)\d{2}$", from_term):
            raise ValueError("Invalid starting term")

        with self.lock:
            search_client = self.public_search_client
            form = search_client.form()
            published: dict[str, dict[str, str]] = {}
            for option in form.selects["pg0$V$ddlTerm"].options:
                plan_term = portal_term_to_plan_term(option["value"], option["label"])
                if plan_term and (not from_term or plan_term_key(plan_term) >= plan_term_key(from_term)):
                    published[plan_term] = {"value": option["value"], "label": option["label"]}

            enriched: dict[str, object] = {}
            errors = []
            records = []
            batch_bounds: dict[str, tuple[int, int]] = {}
            for raw in courses:
                if not isinstance(raw, dict):
                    continue
                course_id = clean(raw.get("id"), 80)
                code = clean(raw.get("code"), 30).upper()
                title = clean(raw.get("title"), 160)
                term = clean(raw.get("term"), 4)
                alternatives = raw.get("alt") if isinstance(raw.get("alt"), list) else []
                codes = [code, *(clean(value, 30).upper() for value in alternatives[:6])]
                valid_codes = [value for value in codes if re.match(r"^[A-Z]{2,9}\s+\d{3,4}$", value)]
                departments = list(dict.fromkeys(value.split()[0] for value in valid_codes))
                if not departments and re.match(r"^[A-Z]{2,9}$", code):
                    departments = [code]
                records.append((course_id, code, title, term, valid_codes, departments))
                for value in valid_codes:
                    department, number = value.split()
                    low, high = batch_bounds.get(department, (int(number), int(number)))
                    batch_bounds[department] = (min(low, int(number)), max(high, int(number)))
        batch_cache: dict[tuple[str, str], list[dict[str, object]]] = {}
        number_cache: dict[tuple[str, str, str], list[dict[str, object]]] = {}
        batch_failures: set[tuple[str, str]] = set()
        for course_id, code, title, term, valid_codes, departments in records:
                # Sweep every published term for every spreadsheet course. This
                # preserves currently published offerings even when the planner
                # assigns the course to a later, not-yet-published semester.
                target_terms = list(published)
                by_term: dict[str, object] = {}
                if term and term not in published:
                    by_term[term] = {
                        "source": "spreadsheet", "matchedBy": "",
                        "termLabel": term, "sections": [],
                    }
                for plan_term in target_terms:
                    portal_term = published[plan_term]
                    sections: list[dict[str, object]] = []
                    matched_by = ""
                    search_error = ""
                    try:
                        for candidate in valid_codes:
                            dept, number = candidate.split()
                            key = (portal_term["value"], dept)
                            bounds = batch_bounds.get(dept, (int(number), int(number)))
                            if key not in batch_cache and key not in batch_failures:
                                try:
                                    batch_cache[key] = search_client._search({
                                        "term": portal_term["value"], "department": dept,
                                        "courseFrom": str(bounds[0]), "courseTo": str(bounds[1]),
                                        "division": "UG", "campus": "", "status": "OpenFull",
                                    })["results"]
                                except ValueError as error:
                                    if str(error) != "Invalid course number range":
                                        raise
                                    batch_failures.add(key)
                            if key in batch_failures:
                                number_key = (portal_term["value"], dept, number)
                                if number_key not in number_cache:
                                    number_cache[number_key] = search_client._search({
                                        "term": portal_term["value"], "department": dept,
                                        "courseNumber": number, "division": "UG", "campus": "",
                                        "status": "OpenFull",
                                    })["results"]
                                candidates = number_cache[number_key]
                            else:
                                candidates = batch_cache[key]
                            sections = [
                                result for result in candidates
                                if re.match(rf"^{re.escape(dept)}\s+{re.escape(number)}(?:\s|$)", result.get("courseCode", ""))
                            ]
                            if sections:
                                matched_by = "code"
                                break
                        if not sections and title and departments:
                            sections = [
                                result for result in batch_cache.get((portal_term["value"], departments[0]), [])
                                if result.get("title", "").casefold() == title.casefold()
                            ]
                            if sections:
                                matched_by = "title"
                    except RuntimeError as error:
                        search_error = str(error)
                        errors.append(f"{code or title} · {plan_term}: {error}")
                    by_term[plan_term] = {
                        "source": "myportal",
                        "listed": bool(sections),
                        "matchedBy": matched_by,
                        "termLabel": portal_term["label"],
                        "sections": sections,
                        **({"error": search_error} if search_error else {}),
                    }
                enriched[course_id] = {"byTerm": by_term}
        return {
            "courses": enriched,
            "publishedTerms": [
                {"planTerm": term, "value": item["value"], "label": item["label"]}
                for term, item in sorted(published.items(), key=lambda pair: plan_term_key(pair[0]))
            ],
            "errors": errors,
        }

    def _search(self, query: dict[str, object]) -> dict[str, object]:
        form = self.form()
        fields = list(form.fields)

        def replace(name: str, value: str) -> None:
            nonlocal fields
            fields = [(key, old) for key, old in fields if key != name]
            fields.append((name, value))

        term = clean(query.get("term"), 20)
        if not term:
            raise ValueError("A term is required")
        allowed_terms = {o["value"] for o in form.selects["pg0$V$ddlTerm"].options}
        if term not in allowed_terms:
            raise ValueError("That term is no longer available on MyPortal")

        selected_term = next((value for name, value in fields if name == "pg0$V$ddlTerm"), "")
        if selected_term != term:
            replace("pg0$V$ddlTerm", term)
            replace("__EVENTTARGET", "pg0$V$ddlTerm")
            replace("__EVENTARGUMENT", "")
            body, content_type = multipart(fields)
            changed_html = self._request(form.action, body, content_type)
            changed_form = SearchFormParser()
            changed_form.feed(changed_html)
            if "pg0$V$ddlTerm" not in changed_form.selects:
                raise RuntimeError("MyPortal could not switch to the requested term")
            form = changed_form
            fields = list(form.fields)

        replace("pg0$V$ddlTerm", term)
        replace("pg0$V$ddlDept", clean(query.get("department"), 12))
        replace("pg0$V$ddlDivision", clean(query.get("division"), 4) or "UG")
        replace("pg0$V$ddlCampus", clean(query.get("campus"), 12))
        replace("pg0$V$ddlSecStatus", clean(query.get("status"), 12) or "OpenFull")

        number = clean(query.get("courseNumber"), 12)
        course_from = clean(query.get("courseFrom"), 12)
        course_to = clean(query.get("courseTo"), 12)
        course_from_field = form.selects.get("pg0$V$ddlCourseFrom")
        course_to_field = form.selects.get("pg0$V$ddlCourseTo")
        numbers = {o["value"] for o in course_from_field.options} if course_from_field else set()
        if course_from or course_to:
            if not course_from_field or not course_to_field:
                course_from = course_to = ""
            elif (not course_from or not course_to or course_from not in numbers
                    or course_to not in {o["value"] for o in course_to_field.options}):
                raise ValueError("Invalid course number range")
            else:
                replace("pg0$V$ddlCourseFrom", course_from)
                replace("pg0$V$ddlCourseTo", course_to)
        elif number and number in numbers and course_to_field:
            replace("pg0$V$ddlCourseFrom", number)
            replace("pg0$V$ddlCourseTo", number)
        elif number:
            replace("pg0$V$ddlCourseFrom", "")
            replace("pg0$V$ddlCourseTo", "")
            replace("pg0$V$ddlCourseRestrictor", "Contains")
            replace("pg0$V$txtCourseRestrictor", number)

        title = clean(query.get("title"), 100)
        if title:
            replace("pg0$V$ddlTitleRestrictor", "Contains")
            replace("pg0$V$txtTitleRestrictor", title)

        replace("pg0$V$btnSearch", "Search")
        body, content_type = multipart(fields)
        result_html = self._request(form.action, body, content_type)
        results = ResultsParser()
        results.feed(result_html)
        if not results.in_table and "pg0_V_dgCourses" not in result_html:
            raise RuntimeError("MyPortal did not return course results; its form may have changed")

        term_option = next(o for o in form.selects["pg0$V$ddlTerm"].options if o["value"] == term)
        plan_term = portal_term_to_plan_term(term, term_option["label"])
        for row in results.rows:
            row["planTerm"] = plan_term
            row["termLabel"] = term_option["label"]
        return {"results": results.rows, "term": term, "termLabel": term_option["label"]}


def clean(value: object, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) > limit or any(ord(char) < 32 for char in text):
        raise ValueError("Invalid search value")
    return text


def portal_term_to_plan_term(value: str, label: str) -> str:
    match = re.match(r"^(\d{4});(FA|SP|SU)$", value)
    if not match:
        return ""
    base, season = int(match.group(1)), match.group(2)
    # Portal values use the academic-year start for every season.
    year = base if season == "FA" else base + 1
    return f"{season}{year % 100:02d}"


def plan_term_key(value: str) -> int:
    match = re.match(r"^(FA|SP|SU)(\d{2})$", value)
    if not match:
        raise ValueError("Invalid planner term")
    season, year = match.group(1), 2000 + int(match.group(2))
    return year * 3 + {"SP": 0, "SU": 1, "FA": 2}[season]


class Handler(SimpleHTTPRequestHandler):
    client: PortalClient

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/seed-data":
            self.seed_data()
            return
        if self.path == "/api/course-search/options":
            self.api(lambda: self.client.options())
            return
        super().do_GET()

    def seed_data(self) -> None:
        if not DATA_FILE:
            self.json_response({"available": False})
            return
        try:
            source = DATA_FILE.resolve()
            if not source.is_file():
                self.json_response({"available": False})
                return
            text = source.read_text(encoding="utf-8")
            match = re.search(r"window\.SEED\s*=\s*(\{.*\});?\s*$", text, re.S)
            if not match:
                raise ValueError("External data file is not a generated Schedule Manager seed")
            payload = json.loads(match.group(1))
            self.json_response({"available": True, "seed": payload})
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"seed-data error: {error}", file=sys.stderr)
            self.json_response({"error": "Configured schedule data could not be loaded"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        if self.path not in {"/api/course-search", "/api/course-availability", "/api/course-enrichment"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.json_response({"error": "Invalid request size"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object")
        except (json.JSONDecodeError, ValueError) as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        operation = {
            "/api/course-availability": self.client.availability,
            "/api/course-enrichment": self.client.enrich_courses,
        }.get(self.path, self.client.search)
        self.api(lambda: operation(payload))

    def api(self, operation) -> None:
        try:
            self.json_response(operation())
        except ValueError as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except RuntimeError as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
        except Exception as error:  # Keep secrets and upstream HTML out of responses.
            print(f"course-search error: {error}", file=sys.stderr)
            self.json_response({"error": "Course search failed unexpectedly"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def json_response(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Schedule Manager")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8080, type=int)
    args = parser.parse_args()
    load_env(ROOT / ".env")
    global DATA_FILE
    DATA_FILE = Path(os.environ.get("SCHEDULE_DATA_FILE", "")).expanduser()
    try:
        cookie, cookie_source = configured_cookie()
    except ValueError as error:
        parser.error(str(error))
    Handler.client = PortalClient(cookie)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Schedule Manager: http://{args.host}:{args.port}")
    print("MyPortal cookie: " + (f"configured from {cookie_source}" if cookie else "not configured (public search will be used)"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")


if __name__ == "__main__":
    main()
