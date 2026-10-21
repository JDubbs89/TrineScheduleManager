# Schedule Manager

Dependency-free degree planner built from your BSCS control sheet. It includes a small Python server for live MyPortal course search; planner data still stays in your browser.

## Run it

    cd ScheduleManager
    python3 server.py                # then open http://localhost:8080

The planner itself still works from any static host (or `file://` in most browsers), but **Search MyPortal** requires `server.py` so the remote request can be made without exposing a session cookie to browser JavaScript.

State is stored in the browser (localStorage, per origin). Use **Data → Export JSON** to back up or move between devices.

## Plan your schedule

Use the sidebar to switch between **Dashboard**, **Schedule**, **Requirements**, and **Course catalog**. The Dashboard shows plan metrics and a compact roadmap. Use Schedule to:

- Drag a course to another semester or back to **Unscheduled**.
- Select a course card to review its term, section, class dates, days, time, prerequisites, dependencies, grade, and notes.
- Select **MyPortal** on a course card to check every published current or future semester.
- Select **Sync MyPortal** to match each spreadsheet course to its published section data. If no match exists for its semester, the card keeps its spreadsheet data and shows **spreadsheet**.
- In **Course catalog**, select **Schedule** or **Reschedule** beside a course to choose its semester without returning to the timeline.
- Select **×** on a semester to remove it. Any courses in that semester move to **Unscheduled**. You can select **Undo** to restore the semester and its courses.

When you move a course, Schedule recommends an open section that does not overlap the selected sections already in that semester. If every published section overlaps, the move is blocked. You can choose a different section from the course details. Meeting patterns use `R` for Thursday; online session labels distinguish `OL1` and `OL2` when MyPortal provides them.

You can add a course to the current semester with its **+ Course** button, or move an existing course there. When you save, Schedule checks MyPortal and selects a conflict-free section whose class start date is after today. This allows a later session such as OL2 to be scheduled before it begins. Open the course and select **Unschedule** to remove it before that date. Once the selected section reaches its start date, its semester and section are locked. A course without a verifiable start date cannot be added to the current semester.

MyPortal may not have published every future semester yet. **Not listed** or **spreadsheet** means the course was absent from the semesters available to search; it does not mean the course will never be offered again. Schedule can only detect time conflicts for courses with published meeting data.

## Files

| file | purpose |
|---|---|
| `index.html`, `style.css` | shell + styling (light/dark follows OS) |
| `engine.js` | pure rules + optimizer (no DOM): offerings, prereqs, min grades, standing, credit limits |
| `app.js` | UI: planner board, requirements, catalog, dialogs |
| `data.js` | seed generated from the spreadsheet (only used on first load / reset) |
| `server.py` | local static server + MyPortal Web Forms search proxy |
| `tools/build_data.py` | regenerates `data.js` from an updated control sheet |

## Live MyPortal course search

Open **Catalog → Search MyPortal…**. Search options and results are loaded directly from Trine's current Course Schedules page. Choosing a result schedules the matching course already in your catalog, or creates a custom course when there is no match.

Every Schedule card also has a **MyPortal** action. It searches that course across all terms MyPortal publishes at or after the planner's current term, including sections, open/full status, seats, instructor, meeting schedule, credits, and start/end dates. **Sync MyPortal** imports those details for courses in the plan and recommends non-overlapping sections. MyPortal only exposes terms that the university has published; a course absent from those results may still be offered in a later, not-yet-published term.

The search endpoint was verified to work without signing in on October 21, 2026. Cookie support is included in case authenticated access exposes more data or Trine changes that policy. You can use the JSON exported by **Get cookies.txt LOCALLY**:

1. Export cookies for `myportal.trine.edu` as JSON and save the file as `myportal-cookies.json` beside `.env`.
2. Set `MYPORTAL_COOKIES_JSON_FILE=myportal-cookies.json` in `.env`.
3. Restart `python3 server.py`.

You may instead paste compact, single-line JSON after `MYPORTAL_COOKIES_JSON=` or use the complete semicolon-separated request header in `MYPORTAL_SESSION_COOKIE`. A raw header takes precedence if multiple methods are configured. The server filters JSON exports by domain, path, and expiration before constructing the cookie header.

`.env` is ignored by Git. Treat the cookie like a password: do not paste it into client-side files or commit it. MyPortal sessions expire, so replace it if searches begin returning an authentication error. The server uses Python's standard library only.

## Updating from a new spreadsheet

    pip install openpyxl
    python3 tools/build_data.py "BSCS_....xlsx" data.js

Then in the app: **Data → Reset to spreadsheet data** (this discards edits made in the app, export JSON first if needed).

## Rules the app enforces (current + future terms only)

- **Offered**: `FA`, `SP`, `ALL` from the sheet. `ALL` is *not* assumed to include summer (Settings toggle).
- **Prerequisites**: parsed from the sheet text. `"C" or better in X` enforces the grade. `A or B` groups, `A, B` means both.
  Codes not in your catalog (e.g. `MA 113`, `ECE 273`) count as met (placement/transfer).
- **Standing**: `Jr. Standing` / `Sr. Standing` use credits earned before the term (thresholds in Settings; defaults 60 / 90, verify against your catalog).
- **Load**: min 12 (warning) / max 18 (error) per term; editable. These are defaults, not read from the sheet.
- A prerequisite must be in a strictly earlier term; same-term does not count.

## Optimizer

Greedy list scheduler (longest prerequisite chain first, then most-restricted offering), run under several caps/summer settings to produce
side-by-side scenarios with generated pros/cons. Pin a course (edit dialog) to keep it fixed. Every application is undoable (Ctrl+Z / Undo).
