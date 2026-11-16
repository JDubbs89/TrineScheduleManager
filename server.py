#!/usr/bin/env python3
"""Serve Schedule Manager and proxy Trine's Web Forms course search.

The browser never receives MYPORTAL_SESSION_COOKIE. The proxy first loads the
search page to obtain fresh ASP.NET state, then submits the form and turns the
results table into JSON.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time

import bcrypt
from dataclasses import dataclass, field
from datetime import UTC, datetime
from html.parser import HTMLParser
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, HTTPCookieProcessor, Request, build_opener
from http.cookiejar import CookieJar


ROOT = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("SCHEDULE_DATA_FILE", "")).expanduser()
CACHE_FILE = Path(os.environ.get("SCHEDULE_CACHE_DB", "schedule-cache.sqlite3")).expanduser()
USER_DB_FILE = Path(os.environ.get("SCHEDULE_USER_DB", "schedule-users.sqlite3")).expanduser()
SEARCH_URL = (
    "https://myportal.trine.edu/ICS/default.aspx?portlet=Course_Schedules"
    "&screen=Advanced%20Course%20Search&screenType=next"
)


class CatalogUnavailableError(RuntimeError):
    pass


class RefreshInProgressError(RuntimeError):
    pass


class AuthenticationError(RuntimeError):
    pass


class ScheduleConflictError(RuntimeError):
    def __init__(self, revision: int, updated_at: str = "") -> None:
        super().__init__("The schedule was changed by another client")
        self.revision = revision
        self.updated_at = updated_at


USER_AGENT = "ScheduleManager/1.0 (+local course search)"
MAX_REQUEST_BYTES = 2_000_000
SESSION_COOKIE = "schedmgr_session"


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
    default = root / "myportal-cookies.json"
    if default.is_file():
        return cookie_header_from_json(default.read_text(encoding="utf-8")), "myportal-cookies.json"
    return "", "public search"


TRANSCRIPT_URL = "https://myportal.trine.edu/ICS/Student/Transcripts_and_Grade_Reports.jnz?portlet=Unofficial_Transcript"


class TranscriptParser(HTMLParser):
    """Read the portal's HTML transcript, keeping its authoritative GPA totals."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self.table: list[list[str]] | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.table = []
        elif tag == "tr":
            self.row = []
        elif tag in {"td", "th"}:
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in {"td", "th"} and self.cell is not None:
            if self.row is not None:
                self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            if self.table is not None:
                self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None

    def result(self) -> dict:
        summary = None
        courses = []
        for table in self.tables:
            if not table:
                continue
            if table[0] == ["Type", "Attempted Credits", "Earned Credits", "GPA Credits", "Quality Points", "GPA"]:
                for row in table[1:]:
                    if len(row) == 6 and row[0] == "Career":
                        if summary is not None:
                            raise RuntimeError("Multiple transcript divisions found; select a division in MyPortal first")
                        summary = dict(zip(
                            ["attemptedCredits", "earnedCredits", "gpaCredits", "qualityPoints", "gpa"],
                            (float(value) for value in row[1:]),
                        ))
            elif table[0] == ["Course", "Title", "Grade", "Repeat", "Attempted Credits", "Earned Credits", "GPA Credits", "Quality Points", "GPA"]:
                for row in table[1:]:
                    code = re.match(r"^([A-Z]+\s+\d+[A-Z]?)\b", row[0]) if row else None
                    if len(row) != 9 or not code:
                        continue
                    courses.append({
                        "code": code[1], "title": row[1], "grade": row[2], "repeat": row[3],
                        "attemptedCredits": float(row[4]), "earnedCredits": float(row[5]),
                        "gpaCredits": float(row[6]), "qualityPoints": float(row[7]),
                    })
        if summary is None:
            raise RuntimeError("MyPortal did not return transcript totals. Refresh your login cookie export and try again")
        return {"source": "myportal", "fetchedAt": datetime.now(UTC).isoformat(),
                **summary, "courses": courses}


@dataclass
class SelectField:
    name: str
    element_id: str = ""
    options: list[dict[str, str]] = field(default_factory=list)


class SearchFormParser(HTMLParser):
    """Extract successful controls and option lists from MAINFORM."""

    def __init__(self, base_url: str = SEARCH_URL) -> None:
        super().__init__(convert_charrefs=True)
        self.in_form = False
        self.form_depth = 0
        self.base_url = base_url
        self.action = base_url
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
            self.action = urljoin(self.base_url, a.get("action") or self.base_url)
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
    clock = r"(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)"
    pattern = re.compile(rf"\b([MTWRFSU]{{1,7}})\s+{clock}", re.I)
    time_pattern = re.compile(clock, re.I)
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
    # Some locations use a time range without meeting days. Preserve the
    # displayed time, but do not invent days that would create false clashes.
    displayed_times = list(time_pattern.finditer(schedule))
    time_label = ", ".join(dict.fromkeys(
        f'{match.group(1).upper()}–{match.group(2).upper()}' for match in displayed_times
    ))
    segments = [segment.strip() for segment in schedule.split(";") if segment.strip()]
    location = "; ".join(
        segment for segment in segments
        if not time_pattern.search(segment) and segment.casefold() not in {"online", "to be arranged", "tba"}
    )
    seats = re.match(r"(\d+)\s*/\s*(\d+)", row.get("seats", ""))
    return {
        "sectionCode": section_code,
        "modality": "Online" if online else "In person",
        "onlineSession": online_session,
        "meetings": meetings,
        "daysLabel": ", ".join(dict.fromkeys(meeting["daysLabel"] for meeting in meetings)) or ("Online" if online else "TBA"),
        "timeLabel": time_label or ("Asynchronous" if online else "TBA"),
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


class UserStore:
    """Own account, session, and revisioned schedule persistence."""

    SESSION_SECONDS = 30 * 24 * 60 * 60

    def __init__(self, path: Path, bcrypt_rounds: int = 12) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.bcrypt_rounds = bcrypt_rounds
        self.connection = sqlite3.connect(self.path, check_same_thread=False)
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.lock = threading.RLock()
        with self.lock:
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    password_hash BLOB NOT NULL,
                    created_at TEXT NOT NULL,
                    must_change_password INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS user_sessions (
                    token_hash BLOB PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry
                    ON user_sessions (expires_at);
                CREATE TABLE IF NOT EXISTS user_schedules (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    revision INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    schedule_json TEXT NOT NULL
                );
            """)
            user_columns = {row[1] for row in self.connection.execute("PRAGMA table_info(users)")}
            if "must_change_password" not in user_columns:
                self.connection.execute(
                    "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"
                )
            self.connection.execute(
                "DELETE FROM user_sessions WHERE expires_at <= ?", (int(time.time()),)
            )
            self.connection.commit()

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

    @staticmethod
    def _username(value: object) -> str:
        username = str(value or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,32}", username):
            raise ValueError("Username must be 3–32 characters using letters, numbers, ., _, or -")
        return username

    @staticmethod
    def _password(value: object) -> bytes:
        password = str(value or "").encode("utf-8")
        if len(password) < 10:
            raise ValueError("Password must be at least 10 characters")
        if len(password) > 72:
            raise ValueError("Password must be at most 72 UTF-8 bytes")
        return password

    @staticmethod
    def _token_hash(token: str) -> bytes:
        return hashlib.sha256(token.encode("ascii", "ignore")).digest()

    def _new_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        self.connection.execute(
            "INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (self._token_hash(token), user_id, now, now + self.SESSION_SECONDS),
        )
        return token

    def register(self, username_value: object, password_value: object) -> tuple[dict[str, object], str]:
        username = self._username(username_value)
        password = self._password(password_value)
        password_hash = bcrypt.hashpw(password, bcrypt.gensalt(rounds=self.bcrypt_rounds))
        with self.lock:
            try:
                cursor = self.connection.execute(
                    "INSERT INTO users (username, password_hash, created_at, must_change_password) VALUES (?, ?, ?, 0)",
                    (username, password_hash, self._timestamp()),
                )
                token = self._new_session(int(cursor.lastrowid))
                self.connection.commit()
            except sqlite3.IntegrityError as error:
                self.connection.rollback()
                raise ValueError("That username is already registered") from error
        return {"id": int(cursor.lastrowid), "username": username, "mustChangePassword": False}, token

    def ensure_default_user(self, username_value: object, password_value: object) -> None:
        username = self._username(username_value)
        password = self._password(password_value)
        with self.lock:
            exists = self.connection.execute(
                "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (username,)
            ).fetchone()
            if exists:
                return
            password_hash = bcrypt.hashpw(password, bcrypt.gensalt(rounds=self.bcrypt_rounds))
            self.connection.execute(
                """INSERT INTO users
                   (username, password_hash, created_at, must_change_password)
                   VALUES (?, ?, ?, 1)""",
                (username, password_hash, self._timestamp()),
            )
            self.connection.commit()

    def login(self, username_value: object, password_value: object) -> tuple[dict[str, object], str]:
        username = self._username(username_value)
        password = self._password(password_value)
        with self.lock:
            row = self.connection.execute(
                "SELECT id, username, password_hash, must_change_password FROM users WHERE username = ? COLLATE NOCASE",
                (username,),
            ).fetchone()
            if not row or not bcrypt.checkpw(password, bytes(row[2])):
                raise AuthenticationError("Invalid username or password")
            token = self._new_session(int(row[0]))
            self.connection.commit()
        return {"id": int(row[0]), "username": row[1], "mustChangePassword": bool(row[3])}, token

    def authenticate(self, token: str) -> dict[str, object] | None:
        if not token:
            return None
        now = int(time.time())
        with self.lock:
            row = self.connection.execute(
                """SELECT users.id, users.username, user_sessions.expires_at,
                          users.must_change_password
                   FROM user_sessions JOIN users ON users.id = user_sessions.user_id
                   WHERE user_sessions.token_hash = ?""",
                (self._token_hash(token),),
            ).fetchone()
            if not row or int(row[2]) <= now:
                if row:
                    self.connection.execute(
                        "DELETE FROM user_sessions WHERE token_hash = ?", (self._token_hash(token),)
                    )
                    self.connection.commit()
                return None
        return {"id": int(row[0]), "username": row[1], "mustChangePassword": bool(row[3])}

    def change_password(self, user_id: int, current_value: object, new_value: object,
                        session_token: str) -> None:
        current = self._password(current_value)
        new_password = self._password(new_value)
        if current == new_password:
            raise ValueError("New password must be different from the current password")
        with self.lock:
            row = self.connection.execute(
                "SELECT password_hash FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if not row or not bcrypt.checkpw(current, bytes(row[0])):
                raise AuthenticationError("Current password is incorrect")
            password_hash = bcrypt.hashpw(new_password, bcrypt.gensalt(rounds=self.bcrypt_rounds))
            self.connection.execute(
                "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                (password_hash, user_id),
            )
            self.connection.execute(
                "DELETE FROM user_sessions WHERE user_id = ? AND token_hash != ?",
                (user_id, self._token_hash(session_token)),
            )
            self.connection.commit()

    def logout(self, token: str) -> None:
        if not token:
            return
        with self.lock:
            self.connection.execute(
                "DELETE FROM user_sessions WHERE token_hash = ?", (self._token_hash(token),)
            )
            self.connection.commit()

    @staticmethod
    def _schedule_json(state: object) -> str:
        if not isinstance(state, dict):
            raise ValueError("Schedule state must be an object")
        if not isinstance(state.get("courses"), list) or not isinstance(state.get("terms"), list):
            raise ValueError("Schedule state must include courses and terms")
        encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_REQUEST_BYTES:
            raise ValueError("Schedule is too large to save")
        return encoded

    def get_schedule(self, user_id: int) -> dict[str, object]:
        with self.lock:
            row = self.connection.execute(
                "SELECT revision, updated_at, schedule_json FROM user_schedules WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if not row:
            return {"revision": 0, "updatedAt": None, "state": None}
        return {"revision": int(row[0]), "updatedAt": row[1], "state": json.loads(row[2])}

    def save_schedule(self, user_id: int, state: object, expected_revision: object,
                      force: bool = False) -> dict[str, object]:
        schedule_json = self._schedule_json(state)
        try:
            expected = int(expected_revision)
        except (TypeError, ValueError) as error:
            raise ValueError("A valid schedule revision is required") from error
        with self.lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                row = self.connection.execute(
                    "SELECT revision, updated_at FROM user_schedules WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                current = int(row[0]) if row else 0
                if not force and expected != current:
                    raise ScheduleConflictError(current, row[1] if row else "")
                revision, updated_at = current + 1, self._timestamp()
                self.connection.execute(
                    """INSERT INTO user_schedules (user_id, revision, updated_at, schedule_json)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(user_id) DO UPDATE SET
                           revision = excluded.revision,
                           updated_at = excluded.updated_at,
                           schedule_json = excluded.schedule_json""",
                    (user_id, revision, updated_at, schedule_json),
                )
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise
        return {"revision": revision, "updatedAt": updated_at}


class CourseCache:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, check_same_thread=False)
        self.lock = threading.RLock()
        with self.lock:
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS catalog_syncs (
                    id INTEGER PRIMARY KEY,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    status TEXT NOT NULL,
                    error TEXT NOT NULL DEFAULT '',
                    options_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS catalog_terms (
                    sync_id INTEGER NOT NULL REFERENCES catalog_syncs(id),
                    term TEXT NOT NULL,
                    term_label TEXT NOT NULL,
                    plan_term TEXT NOT NULL,
                    PRIMARY KEY (sync_id, term)
                );
                CREATE TABLE IF NOT EXISTS catalog_sections (
                    sync_id INTEGER NOT NULL REFERENCES catalog_syncs(id),
                    term TEXT NOT NULL,
                    base_code TEXT NOT NULL,
                    course_code TEXT NOT NULL,
                    department TEXT NOT NULL,
                    course_number TEXT NOT NULL,
                    section_code TEXT NOT NULL,
                    title TEXT NOT NULL,
                    faculty TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    begin_date TEXT NOT NULL,
                    end_date TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    PRIMARY KEY (
                        sync_id, term, course_code, begin_date, end_date
                    )
                );
                CREATE INDEX IF NOT EXISTS idx_catalog_sections_lookup
                    ON catalog_sections (sync_id, term, department, course_number);
                CREATE INDEX IF NOT EXISTS idx_catalog_sections_code
                    ON catalog_sections (sync_id, base_code);
            """)
            columns = {row[1] for row in self.connection.execute("PRAGMA table_info(catalog_sections)")}
            if "faculty" not in columns:
                self.connection.execute(
                    "ALTER TABLE catalog_sections ADD COLUMN faculty TEXT NOT NULL DEFAULT ''"
                )
                self.connection.execute(
                    """UPDATE catalog_sections
                       SET faculty = COALESCE(json_extract(payload_json, '$.faculty'), '')"""
                )
            self.connection.execute(
                """UPDATE catalog_syncs
                   SET status = 'failed', completed_at = ?,
                       error = 'Server restarted before the catalog refresh completed'
                   WHERE status = 'running'""",
                (self._now(),),
            )
            self.connection.commit()

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

    def begin_catalog_sync(self, options: dict[str, object] | None = None) -> int:
        with self.lock:
            cursor = self.connection.execute(
                "INSERT INTO catalog_syncs (started_at, status, options_json) VALUES (?, 'running', ?)",
                (self._now(), json.dumps(options or {}, sort_keys=True)),
            )
            self.connection.commit()
            return int(cursor.lastrowid)

    def stage_catalog_term(self, sync_id: int, term: str, term_label: str,
                           plan_term: str, rows: list[dict[str, object]]) -> None:
        with self.lock:
            self.connection.execute(
                "INSERT OR REPLACE INTO catalog_terms (sync_id, term, term_label, plan_term) VALUES (?, ?, ?, ?)",
                (sync_id, term, term_label, plan_term),
            )
            self._insert_catalog_rows(sync_id, term, rows)
            self.connection.commit()

    def _insert_catalog_rows(self, sync_id: int, term: str,
                             rows: list[dict[str, object]]) -> None:
        for row in rows:
            base_code = str(row.get("baseCode") or base_course_code(str(row.get("courseCode") or "")))
            match = re.match(r"^([A-Z]{2,9})\s+(\d{3,4})$", base_code)
            department, number = match.groups() if match else ("", "")
            self.connection.execute(
                """INSERT OR REPLACE INTO catalog_sections (
                    sync_id, term, base_code, course_code, department,
                    course_number, section_code, title, faculty, status,
                    begin_date, end_date, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    sync_id, term, base_code, str(row.get("courseCode") or ""),
                    department, number, str(row.get("sectionCode") or ""),
                    str(row.get("title") or ""), str(row.get("faculty") or ""),
                    str(row.get("status") or ""),
                    str(row.get("beginDate") or ""), str(row.get("endDate") or ""),
                    json.dumps(row, default=str, sort_keys=True),
                ),
            )

    def replace_catalog_course(self, base_code: str,
                               rows_by_term: dict[str, list[dict[str, object]]]) -> str:
        """Atomically replace one course in every requested term of the active snapshot."""
        with self.lock:
            sync_id = self._active_sync_id()
            if sync_id is None:
                raise CatalogUnavailableError("The local MyPortal catalog is empty. Refresh MyPortal first")
            known_terms = {
                row[0] for row in self.connection.execute(
                    "SELECT term FROM catalog_terms WHERE sync_id = ?", (sync_id,)
                )
            }
            if not set(rows_by_term).issubset(known_terms):
                raise ValueError("A requested term is not in the active catalog")
            refreshed_at = self._now()
            try:
                for term, rows in rows_by_term.items():
                    self.connection.execute(
                        "DELETE FROM catalog_sections WHERE sync_id = ? AND term = ? AND base_code = ?",
                        (sync_id, term, base_code),
                    )
                    self._insert_catalog_rows(sync_id, term, rows)
                self.connection.execute(
                    "UPDATE catalog_syncs SET completed_at = ? WHERE id = ?",
                    (refreshed_at, sync_id),
                )
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise
            return refreshed_at

    def complete_catalog_sync(self, sync_id: int) -> None:
        with self.lock:
            self.connection.execute(
                "UPDATE catalog_syncs SET status = 'complete', completed_at = ? WHERE id = ?",
                (self._now(), sync_id),
            )
            # Keep the preceding snapshot as a fallback, and discard older runs.
            completed = [row[0] for row in self.connection.execute(
                "SELECT id FROM catalog_syncs WHERE status = 'complete' ORDER BY id DESC LIMIT 2"
            )]
            if completed:
                placeholders = ",".join("?" for _ in completed)
                old = [row[0] for row in self.connection.execute(
                    f"SELECT id FROM catalog_syncs WHERE status != 'running' AND id NOT IN ({placeholders})",
                    completed,
                )]
                for old_id in old:
                    self.connection.execute("DELETE FROM catalog_sections WHERE sync_id = ?", (old_id,))
                    self.connection.execute("DELETE FROM catalog_terms WHERE sync_id = ?", (old_id,))
                    self.connection.execute("DELETE FROM catalog_syncs WHERE id = ?", (old_id,))
            self.connection.commit()

    def fail_catalog_sync(self, sync_id: int, error: str) -> None:
        with self.lock:
            self.connection.execute(
                "UPDATE catalog_syncs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?",
                (self._now(), error[:500], sync_id),
            )
            self.connection.commit()

    def _active_sync_id(self) -> int | None:
        row = self.connection.execute(
            "SELECT id FROM catalog_syncs WHERE status = 'complete' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return int(row[0]) if row else None

    def catalog_status(self) -> dict[str, object]:
        with self.lock:
            row = self.connection.execute(
                """SELECT id, started_at, completed_at, status, error
                   FROM catalog_syncs ORDER BY id DESC LIMIT 1"""
            ).fetchone()
            active = self._active_sync_id()
            active_row = self.connection.execute(
                "SELECT completed_at FROM catalog_syncs WHERE id = ?", (active,)
            ).fetchone() if active is not None else None
            count = self.connection.execute(
                "SELECT COUNT(*) FROM catalog_sections WHERE sync_id = ?", (active,)
            ).fetchone()[0] if active is not None else 0
        return {
            "available": active is not None,
            "sections": count,
            "syncedAt": active_row[0] if active_row else None,
            "lastAttempt": ({
                "id": row[0], "startedAt": row[1], "completedAt": row[2],
                "status": row[3], "error": row[4],
            } if row else None),
        }

    def catalog_options(self) -> dict[str, object]:
        with self.lock:
            sync_id = self._active_sync_id()
            if sync_id is None:
                return {"terms": [], "departments": [], "divisions": [], "campuses": [], "statuses": []}
            terms = [
                {"value": row[0], "label": row[1]}
                for row in self.connection.execute(
                    "SELECT term, term_label FROM catalog_terms WHERE sync_id = ? ORDER BY plan_term",
                    (sync_id,),
                )
            ]
            departments = [
                {"value": row[0], "label": row[0]}
                for row in self.connection.execute(
                    "SELECT DISTINCT department FROM catalog_sections WHERE sync_id = ? AND department != '' ORDER BY department",
                    (sync_id,),
                )
            ]
        return {
            "terms": terms,
            "departments": [{"value": "", "label": "All departments"}, *departments],
            "divisions": [{"value": "UG", "label": "Undergraduate"}],
            "campuses": [{"value": "", "label": "All campuses"}],
            "statuses": [
                {"value": "OpenFull", "label": "Open and full"},
                {"value": "Open", "label": "Open"},
                {"value": "Full", "label": "Full"},
            ],
        }

    def search_catalog(self, query: dict[str, object]) -> list[dict[str, object]]:
        with self.lock:
            sync_id = self._active_sync_id()
            if sync_id is None:
                return []
            clauses = ["sync_id = ?"]
            values: list[object] = [sync_id]
            filters = {
                "term": ("term = ?", clean(query.get("term"), 20)),
                "department": ("department = ?", clean(query.get("department"), 12).upper()),
                "courseNumber": ("course_number = ?", clean(query.get("courseNumber"), 12)),
            }
            for sql, value in filters.values():
                if value:
                    clauses.append(sql)
                    values.append(value)
            title = clean(query.get("title"), 100)
            if title:
                clauses.append("title LIKE ? COLLATE NOCASE")
                values.append(f"%{title}%")
            status = clean(query.get("status"), 12)
            if status and status != "OpenFull":
                clauses.append("status = ? COLLATE NOCASE")
                values.append(status)
            rows = self.connection.execute(
                f"SELECT payload_json FROM catalog_sections WHERE {' AND '.join(clauses)} ORDER BY base_code, section_code, begin_date",
                values,
            )
            return [json.loads(row[0]) for row in rows]

    def catalog_terms(self) -> list[dict[str, str]]:
        with self.lock:
            sync_id = self._active_sync_id()
            if sync_id is None:
                return []
            return [
                {"value": row[0], "label": row[1], "planTerm": row[2]}
                for row in self.connection.execute(
                    "SELECT term, term_label, plan_term FROM catalog_terms WHERE sync_id = ? ORDER BY plan_term",
                    (sync_id,),
                )
            ]


class PortalClient:
    RESULT_LIMIT = 20

    def transcript(self) -> dict:
        if not self.cookie:
            raise ValueError("Export your signed-in MyPortal cookies to myportal-cookies.json first")
        with self.lock:
            page = self._request(TRANSCRIPT_URL)
            # MyPortal may remember the report view in the authenticated session.
            if 'id="pg0_V_tblDivisonData"' in page:
                parser = TranscriptParser()
                parser.feed(page)
                return parser.result()
            if "pg0_V_lnkViewTrans" not in page:
                raise RuntimeError("MyPortal transcript access failed. Refresh your login cookie export and try again")
            form = SearchFormParser(TRANSCRIPT_URL)
            form.feed(page)
            if urlparse(form.action).hostname != "myportal.trine.edu" or urlparse(form.action).scheme != "https":
                raise RuntimeError("MyPortal returned an unexpected transcript form")
            fields = [(k, v) for k, v in form.fields if k not in {"__EVENTTARGET", "__EVENTARGUMENT"}]
            fields.extend([("__EVENTTARGET", "pg0$V$lnkViewTrans"), ("__EVENTARGUMENT", "")])
            body, content_type = multipart(fields)
            parser = TranscriptParser()
            parser.feed(self._request(form.action, body, content_type))
            return parser.result()

    def __init__(self, cookie: str = "", cache: CourseCache | None = None) -> None:
        self.cookie = cookie.strip()
        self.opener = build_opener(SafeRedirectHandler(), HTTPCookieProcessor(CookieJar()))
        self.cache = cache
        self.public_search_client = PortalClient("", cache) if self.cookie else self
        # A Web Forms viewstate belongs to the cookie session that fetched it.
        self.lock = threading.RLock()
        self.refresh_lock = threading.Lock()
        self.request_lock = threading.Lock()
        self.last_request_finished = 0.0
        try:
            self.request_interval = max(0.0, float(os.environ.get("MYPORTAL_REQUEST_INTERVAL_SECONDS", "1.0")))
        except ValueError:
            self.request_interval = 1.0
        try:
            self.request_attempts = max(1, min(5, int(os.environ.get("MYPORTAL_REQUEST_ATTEMPTS", "3"))))
        except ValueError:
            self.request_attempts = 3
        try:
            self.retry_base_delay = max(0.0, float(os.environ.get("MYPORTAL_RETRY_BASE_SECONDS", "1.0")))
        except ValueError:
            self.retry_base_delay = 1.0

    def _request(self, url: str, data: bytes | None = None, content_type: str = "") -> str:
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(url, data=data, headers=headers, method="POST" if data else "GET")
        retryable_http = {408, 425, 429, 500, 502, 503, 504}
        for attempt in range(1, self.request_attempts + 1):
            cause: Exception
            message: str
            try:
                with self.request_lock:
                    remaining = self.request_interval - (time.monotonic() - self.last_request_finished)
                    if remaining > 0:
                        time.sleep(remaining)
                    try:
                        with self.opener.open(request, timeout=25) as response:
                            return response.read().decode(
                                response.headers.get_content_charset() or "utf-8", "replace"
                            )
                    finally:
                        # Failed requests count toward pacing too. Retrying
                        # immediately can amplify a portal or DNS outage.
                        self.last_request_finished = time.monotonic()
            except HTTPError as error:
                if error.code not in retryable_http:
                    raise RuntimeError(f"MyPortal returned HTTP {error.code}") from error
                cause = error
                message = f"MyPortal returned HTTP {error.code}"
            except (TimeoutError, socket.timeout) as error:
                cause = error
                message = "MyPortal query timed out without a response"
            except URLError as error:
                cause = error
                message = f"Could not reach MyPortal: {error.reason}"

            if attempt >= self.request_attempts:
                suffix = f" after {attempt} attempts" if attempt > 1 else ""
                raise RuntimeError(message + suffix) from cause

            time.sleep(self.retry_base_delay * (2 ** (attempt - 1)))

    def form(self) -> SearchFormParser:
        parser = SearchFormParser()
        parser.feed(self._request(SEARCH_URL))
        if "pg0$V$ddlTerm" not in parser.selects:
            hint = " The session cookie may have expired." if self.cookie else ""
            raise RuntimeError("MyPortal did not return the course search form." + hint)
        return parser

    def form_for_term(self, term: str) -> SearchFormParser:
        form = self.form()
        allowed_terms = {option["value"] for option in form.selects["pg0$V$ddlTerm"].options}
        if term not in allowed_terms:
            raise ValueError("That term is no longer available on MyPortal")
        selected_term = next((value for name, value in form.fields if name == "pg0$V$ddlTerm"), "")
        if selected_term == term:
            return form

        fields = [(name, value) for name, value in form.fields if name not in {
            "pg0$V$ddlTerm", "__EVENTTARGET", "__EVENTARGUMENT",
        }]
        fields.extend([
            ("pg0$V$ddlTerm", term),
            ("__EVENTTARGET", "pg0$V$ddlTerm"),
            ("__EVENTARGUMENT", ""),
        ])
        body, content_type = multipart(fields)
        changed = SearchFormParser()
        changed.feed(self._request(form.action, body, content_type))
        if "pg0$V$ddlTerm" not in changed.selects:
            raise RuntimeError("MyPortal could not switch to the requested term")
        return changed

    def options(self) -> dict[str, object]:
        if not self.cache:
            raise RuntimeError("The local MyPortal catalog is not configured")
        status = self.cache.catalog_status()
        if not status["available"]:
            raise CatalogUnavailableError("The local MyPortal catalog is empty. Refresh MyPortal first")
        return self.cache.catalog_options() | {
            "cookieConfigured": bool(self.cookie),
            "catalog": status,
            "source": "sqlite",
        }

    def search(self, query: dict[str, object]) -> dict[str, object]:
        if not self.cache or not self.cache.catalog_status()["available"]:
            raise CatalogUnavailableError("The local MyPortal catalog is empty. Refresh MyPortal first")
        term = clean(query.get("term"), 20)
        rows = self.cache.search_catalog(query)
        terms = {item["value"]: item for item in self.cache.catalog_terms()}
        selected = terms.get(term)
        if not selected:
            raise ValueError("That term is not in the local MyPortal catalog")
        return {"results": rows, "term": term, "termLabel": selected["label"], "source": "sqlite"}

    def live_options(self) -> dict[str, object]:
        form = self.form()
        fields = {
            "terms": "pg0$V$ddlTerm", "departments": "pg0$V$ddlDept",
            "divisions": "pg0$V$ddlDivision", "campuses": "pg0$V$ddlCampus",
            "statuses": "pg0$V$ddlSecStatus",
        }
        result = {}
        for key, name in fields.items():
            result[key] = [
                {"value": option["value"], "label": option["label"]}
                for option in form.selects.get(name, SelectField(name)).options
            ]
        return result | {"cookieConfigured": bool(self.cookie), "source": "myportal"}

    def live_search(self, query: dict[str, object]) -> dict[str, object]:
        result = self._search(query)
        return result | {"source": "myportal"}

    def availability(self, query: dict[str, object]) -> dict[str, object]:
        code = clean(query.get("courseCode"), 30).upper()
        match = re.match(r"^([A-Z]{2,9})\s+(\d{3,4}L?)$", code)
        if not match:
            raise ValueError("Course code must look like CS 111, CS 1113, or BIO 114L")
        department, number = match.groups()
        from_term = clean(query.get("fromTerm"), 4)
        if from_term and not re.match(r"^(FA|SP|SU)\d{2}$", from_term):
            raise ValueError("Invalid starting term")

        if not self.cache or not self.cache.catalog_status()["available"]:
            raise CatalogUnavailableError("The local MyPortal catalog is empty. Refresh MyPortal first")
        terms = []
        for item in self.cache.catalog_terms():
            plan_term = item["planTerm"]
            if from_term and plan_term_key(plan_term) < plan_term_key(from_term):
                continue
            rows = self.cache.search_catalog({
                "term": item["value"], "department": department,
                "courseNumber": number, "status": "OpenFull",
            })
            terms.append({
                "term": item["value"], "termLabel": item["label"],
                "planTerm": plan_term, "results": rows,
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

        if not self.cache or not self.cache.catalog_status()["available"]:
            raise CatalogUnavailableError("The local MyPortal catalog is empty. Refresh MyPortal first")
        published = {
            item["planTerm"]: {"value": item["value"], "label": item["label"]}
            for item in self.cache.catalog_terms()
            if not from_term or plan_term_key(item["planTerm"]) >= plan_term_key(from_term)
        }
        enriched: dict[str, object] = {}
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
            by_term: dict[str, object] = {}
            if term and term not in published:
                by_term[term] = {"source": "spreadsheet", "matchedBy": "", "termLabel": term, "sections": []}
            for plan_term, portal_term in published.items():
                sections: list[dict[str, object]] = []
                matched_by = ""
                for candidate in valid_codes:
                    department, number = candidate.split()
                    sections = self.cache.search_catalog({
                        "term": portal_term["value"], "department": department,
                        "courseNumber": number, "status": "OpenFull",
                    })
                    if sections:
                        matched_by = "code"
                        break
                if not sections and title:
                    exact = self.cache.search_catalog({"term": portal_term["value"], "title": title})
                    sections = [row for row in exact if str(row.get("title", "")).casefold() == title.casefold()]
                    if sections:
                        matched_by = "title"
                by_term[plan_term] = {
                    "source": "myportal", "listed": bool(sections), "matchedBy": matched_by,
                    "termLabel": portal_term["label"], "sections": sections,
                }
            enriched[course_id] = {"byTerm": by_term}
        return {
            "courses": enriched,
            "publishedTerms": [
                {"planTerm": term, "value": item["value"], "label": item["label"]}
                for term, item in sorted(published.items(), key=lambda pair: plan_term_key(pair[0]))
            ],
            "errors": [],
            "source": "sqlite",
        }

    @staticmethod
    def _dedupe_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
        unique: dict[tuple[str, str, str], dict[str, object]] = {}
        for row in rows:
            key = (
                str(row.get("courseCode") or ""),
                str(row.get("beginDate") or ""),
                str(row.get("endDate") or ""),
            )
            unique[key] = row
        return list(unique.values())

    def _fetch_department(self, search_client: "PortalClient", term: str,
                          department: str, numbers: list[str]) -> tuple[list[dict[str, object]], int]:
        base = {
            "term": term, "department": department, "division": "UG",
            "campus": "", "status": "OpenFull",
        }
        first = search_client._search(base)["results"]
        requests = 1
        if len(first) < self.RESULT_LIMIT:
            return first, requests
        if not numbers:
            raise RuntimeError(f"MyPortal capped {department} at {self.RESULT_LIMIT} rows and exposed no course ranges")

        def fetch_range(low: int, high: int) -> list[dict[str, object]]:
            nonlocal requests
            query = base | {"courseFrom": numbers[low], "courseTo": numbers[high]}
            rows = search_client._search(query)["results"]
            requests += 1
            if len(rows) < self.RESULT_LIMIT:
                return rows
            if low == high:
                split_rows = []
                for status in ("Open", "Full"):
                    part = search_client._search(query | {"status": status})["results"]
                    requests += 1
                    if len(part) >= self.RESULT_LIMIT:
                        raise RuntimeError(
                            f"MyPortal still capped {department} {numbers[low]} ({status}) at {self.RESULT_LIMIT} rows"
                        )
                    split_rows.extend(part)
                return split_rows
            middle = (low + high) // 2
            return fetch_range(low, middle) + fetch_range(middle + 1, high)

        return self._dedupe_rows(fetch_range(0, len(numbers) - 1)), requests

    def refresh_catalog(self) -> dict[str, object]:
        if not self.refresh_lock.acquire(blocking=False):
            raise RefreshInProgressError("A MyPortal catalog refresh is already in progress")
        try:
            return self._refresh_catalog()
        finally:
            self.refresh_lock.release()

    def refresh_course(self, query: dict[str, object]) -> dict[str, object]:
        code = clean(query.get("courseCode"), 30).upper()
        title = clean(query.get("title"), 160)
        match = re.match(r"^([A-Z]{2,9})\s+(\d{3,4}L?)(?:\s+(\d{1,4}))?$", code)
        if not match and not title:
            raise ValueError("A standard course code or course title is required")
        if not self.cache or not self.cache.catalog_status()["available"]:
            raise CatalogUnavailableError("The local MyPortal catalog is empty. Refresh MyPortal first")
        if not self.refresh_lock.acquire(blocking=False):
            raise RefreshInProgressError("A MyPortal catalog refresh is already in progress")
        try:
            with self.lock:
                search_client = self.public_search_client
                department, number = match.group(1, 2) if match else ("", "")
                rows_by_term: dict[str, list[dict[str, object]]] = {}
                term_results = []
                for item in self.cache.catalog_terms():
                    base = {
                        "term": item["value"], "department": department,
                        "courseNumber": number, "title": title, "division": "UG",
                        "campus": "", "status": "OpenFull",
                    }
                    rows = search_client._search(base)["results"]
                    request_count = 1
                    if len(rows) >= self.RESULT_LIMIT:
                        rows = []
                        for status in ("Open", "Full"):
                            part = search_client._search(base | {"status": status})["results"]
                            request_count += 1
                            if len(part) >= self.RESULT_LIMIT:
                                raise RuntimeError(
                                    f"MyPortal still capped {code} ({status}) at {self.RESULT_LIMIT} rows"
                                )
                            rows.extend(part)
                    rows = self._dedupe_rows(rows)
                    if match:
                        rows = [row for row in rows if row.get("baseCode") == code]
                    else:
                        rows = [row for row in rows if str(row.get("title", "")).casefold() == title.casefold()]
                    for row in rows:
                        row["planTerm"] = item["planTerm"]
                        row["termLabel"] = item["label"]
                    rows_by_term[item["value"]] = rows
                    term_results.append({
                        "term": item["value"], "planTerm": item["planTerm"],
                        "termLabel": item["label"], "sections": len(rows),
                        "portalSearches": request_count,
                    })
                refreshed_at = self.cache.replace_catalog_course(code, rows_by_term)
                return {
                    "courseCode": code,
                    "sections": sum(item["sections"] for item in term_results),
                    "terms": term_results,
                    "refreshedAt": refreshed_at,
                    "catalog": self.cache.catalog_status(),
                }
        finally:
            self.refresh_lock.release()

    def _refresh_catalog(self) -> dict[str, object]:
        if not self.cache:
            raise RuntimeError("The local MyPortal catalog is not configured")
        with self.lock:
            search_client = self.public_search_client
            form = search_client.form()
            terms = []
            for option in form.selects["pg0$V$ddlTerm"].options:
                plan_term = portal_term_to_plan_term(option["value"], option["label"])
                if plan_term:
                    terms.append((option, plan_term))
            if not terms:
                raise RuntimeError("MyPortal did not expose any catalog terms")
            sync_id = self.cache.begin_catalog_sync({
                "terms": len(terms), "source": "myportal-public",
            })
            request_count = 1
            section_count = 0
            try:
                for option, plan_term in terms:
                    term_form = search_client.form_for_term(option["value"])
                    departments = [
                        item["value"] for item in term_form.selects["pg0$V$ddlDept"].options
                        if re.match(r"^[A-Z]{2,9}$", item["value"])
                    ]
                    from_field = term_form.selects.get("pg0$V$ddlCourseFrom")
                    to_field = term_form.selects.get("pg0$V$ddlCourseTo")
                    from_numbers = {
                        item["value"] for item in (from_field.options if from_field else [])
                        if item["value"].isdigit()
                    }
                    to_numbers = {
                        item["value"] for item in (to_field.options if to_field else [])
                        if item["value"].isdigit()
                    }
                    numbers = sorted(from_numbers & to_numbers, key=lambda value: (int(value), value))
                    if not departments:
                        raise RuntimeError(f"MyPortal exposed no departments for {option['label']}")
                    rows = []
                    for department in departments:
                        found, used = self._fetch_department(search_client, option["value"], department, numbers)
                        rows.extend(found)
                        request_count += used
                    rows = self._dedupe_rows(rows)
                    for row in rows:
                        row["planTerm"] = plan_term
                        row["termLabel"] = option["label"]
                    self.cache.stage_catalog_term(sync_id, option["value"], option["label"], plan_term, rows)
                    section_count += len(rows)
                self.cache.complete_catalog_sync(sync_id)
            except Exception as error:
                self.cache.fail_catalog_sync(sync_id, str(error))
                raise
        return {
            "syncId": sync_id, "terms": len(terms), "sections": section_count,
            "portalSearches": request_count, "catalog": self.cache.catalog_status(),
        }

    def _search(self, query: dict[str, object]) -> dict[str, object]:
        term = clean(query.get("term"), 20)
        if not term:
            raise ValueError("A term is required")
        form = self.form_for_term(term)
        fields = list(form.fields)

        def replace(name: str, value: str) -> None:
            nonlocal fields
            fields = [(key, old) for key, old in fields if key != name]
            fields.append((name, value))

        replace("pg0$V$ddlTerm", term)
        replace("pg0$V$ddlDept", clean(query.get("department"), 12))
        division = clean(query.get("division"), 4) if "division" in query else "UG"
        replace("pg0$V$ddlDivision", division)
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
        else:
            # The Web Forms response can retain a selected range from a prior
            # postback. A department probe must explicitly clear it or the
            # apparent broad result may cover only that stale range.
            replace("pg0$V$ddlCourseFrom", "")
            replace("pg0$V$ddlCourseTo", "")
            replace("pg0$V$ddlCourseRestrictor", "")
            replace("pg0$V$txtCourseRestrictor", "")

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
    user_store: UserStore

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        # Serve only app assets, never cookie exports, private data or databases.
        path = Path(self.translate_path(self.path)).resolve()
        public = {ROOT / name for name in ("index.html", "app.js", "engine.js", "style.css")}
        if path == ROOT:
            path = ROOT / "index.html"
        if path not in public:
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def do_GET(self) -> None:
        if self.path == "/api/session":
            user = self.current_user()
            self.json_response({"authenticated": bool(user), "user": user})
            return
        if self.path == "/api/schedule":
            user = self.require_user()
            if user:
                self.json_response(self.user_store.get_schedule(int(user["id"])))
            return
        if self.path == "/api/seed-data":
            self.seed_data()
            return
        if self.path == "/api/course-search/options":
            self.api(lambda: self.client.options())
            return
        if self.path == "/api/course-search-live/options":
            self.api(lambda: self.client.live_options())
            return
        if self.path == "/api/catalog-status":
            self.api(lambda: self.client.cache.catalog_status() if self.client.cache else {"available": False})
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
        if self.path == "/api/transcript":
            user = self.require_user()
            if not user:
                return
            # This cookie export belongs to one student, not every app account.
            owner = os.environ.get("MYPORTAL_OWNER_USERNAME", "jonathan")
            if str(user["username"]).casefold() != owner.casefold():
                self.json_response({"error": "The server's MyPortal cookie store belongs to another account"}, HTTPStatus.FORBIDDEN)
                return
            def fetch_transcript():
                cookie, _source = configured_cookie()
                return PortalClient(cookie).transcript()
            self.api(fetch_transcript)
            return
        if self.path in {"/api/register", "/api/login", "/api/logout", "/api/change-password"}:
            try:
                payload = self.read_json()
                if self.path == "/api/logout":
                    self.user_store.logout(self.session_token())
                    self.json_response(
                        {"authenticated": False},
                        headers={"Set-Cookie": self.expired_session_cookie()},
                    )
                    return
                if self.path == "/api/change-password":
                    user = self.require_user()
                    if not user:
                        return
                    self.user_store.change_password(
                        int(user["id"]), payload.get("currentPassword"),
                        payload.get("newPassword"), self.session_token(),
                    )
                    self.json_response({"changed": True})
                    return
                if self.path == "/api/register":
                    user, token = self.user_store.register(payload.get("username"), payload.get("password"))
                    status = HTTPStatus.CREATED
                else:
                    user, token = self.user_store.login(payload.get("username"), payload.get("password"))
                    status = HTTPStatus.OK
                self.json_response(
                    {"authenticated": True, "user": user}, status,
                    {"Set-Cookie": self.session_cookie(token)},
                )
            except ValueError as error:
                self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except AuthenticationError as error:
                self.json_response({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
            return
        if self.path not in {
            "/api/course-search", "/api/course-search-live", "/api/course-availability", "/api/course-enrichment",
            "/api/catalog-refresh", "/api/course-refresh",
        }:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self.read_json()
        except (json.JSONDecodeError, ValueError) as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            return
        operation = {
            "/api/course-search-live": self.client.live_search,
            "/api/course-availability": self.client.availability,
            "/api/course-enrichment": self.client.enrich_courses,
            "/api/course-refresh": self.client.refresh_course,
            "/api/catalog-refresh": lambda _payload: self.client.refresh_catalog(),
        }.get(self.path, self.client.search)
        self.api(lambda: operation(payload))

    def do_PUT(self) -> None:
        if self.path != "/api/schedule":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        user = self.require_user()
        if not user:
            return
        try:
            payload = self.read_json()
            result = self.user_store.save_schedule(
                int(user["id"]), payload.get("state"), payload.get("revision"),
                bool(payload.get("force", False)),
            )
            self.json_response(result)
        except ValueError as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except ScheduleConflictError as error:
            self.json_response({
                "error": str(error), "revision": error.revision,
                "updatedAt": error.updated_at,
            }, HTTPStatus.CONFLICT)

    def read_json(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("Invalid request size")
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError("Expected a JSON object")
        return payload

    def session_token(self) -> str:
        raw = self.headers.get("Cookie", "")
        if not raw:
            return ""
        cookies = SimpleCookie()
        try:
            cookies.load(raw)
        except Exception:
            return ""
        morsel = cookies.get(SESSION_COOKIE)
        return morsel.value if morsel else ""

    def current_user(self) -> dict[str, object] | None:
        return self.user_store.authenticate(self.session_token())

    def require_user(self) -> dict[str, object] | None:
        user = self.current_user()
        if not user:
            self.json_response({"error": "Sign in to access this schedule"}, HTTPStatus.UNAUTHORIZED)
        return user

    @staticmethod
    def session_cookie(token: str) -> str:
        return f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={UserStore.SESSION_SECONDS}"

    @staticmethod
    def expired_session_cookie() -> str:
        return f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"

    def api(self, operation) -> None:
        try:
            self.json_response(operation())
        except ValueError as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except RefreshInProgressError as error:
            self.json_response({"error": str(error)}, HTTPStatus.CONFLICT)
        except CatalogUnavailableError as error:
            self.json_response({"error": str(error)}, HTTPStatus.SERVICE_UNAVAILABLE)
        except RuntimeError as error:
            self.json_response({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
        except Exception as error:  # Keep secrets and upstream HTML out of responses.
            print(f"course-search error: {error}", file=sys.stderr)
            self.json_response({"error": "Course search failed unexpectedly"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def json_response(self, payload: object, status: HTTPStatus = HTTPStatus.OK,
                      headers: dict[str, str] | None = None) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # The browser may navigate away during a long refresh. The sync
            # result is already recorded in SQLite, so there is nothing else
            # to send and no server traceback is useful.
            return


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve Schedule Manager")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8080, type=int)
    args = parser.parse_args()
    load_env(ROOT / ".env")
    global CACHE_FILE, DATA_FILE, USER_DB_FILE
    DATA_FILE = Path(os.environ.get("SCHEDULE_DATA_FILE", "")).expanduser()
    CACHE_FILE = Path(os.environ.get("SCHEDULE_CACHE_DB", str(ROOT / "schedule-cache.sqlite3"))).expanduser()
    USER_DB_FILE = Path(os.environ.get("SCHEDULE_USER_DB", str(ROOT / "schedule-users.sqlite3"))).expanduser()
    Handler.client = PortalClient("", CourseCache(CACHE_FILE))
    Handler.user_store = UserStore(USER_DB_FILE)
    Handler.user_store.ensure_default_user("jonathan", "password123")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Schedule Manager: http://{args.host}:{args.port}")
    print("MyPortal source: public course catalog (no login cookie used)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")


if __name__ == "__main__":
    main()
