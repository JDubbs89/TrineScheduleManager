# Schedule Manager

A local schedule planner for Trine students. Use it to organize courses by term, check conflicts, track requirements, and review published MyPortal sections without sending your planning data to a hosted service.

## Run it

    cd ScheduleManager
    python3 server.py                # then open http://localhost:8080

The planner itself still works from any static host (or `file://` in most browsers), but **Search MyPortal** requires `server.py` so the remote request can be made without exposing a session cookie to browser JavaScript.

State is stored in the browser (localStorage, per origin). Use **Data → Export JSON** to back up or move between devices.
The repository contains only the manager; plans are created locally in your browser. Use **Data → Create blank** to start a new plan, or **Import CSV** to add courses from a file with `Code` and `Title` columns. Optional columns include `Term`, `Credits`, `Grade`, `Category`, `Offered`, `Prerequisites`, and `Notes`. Terms may be IDs such as `FA26` or labels such as `Fall 2026`.

To load a private generated plan without putting it in Git, set `SCHEDULE_DATA_FILE` in `.env` to the absolute path of your generated `data.js` file:

    SCHEDULE_DATA_FILE=/home/you/private/schedule-data.js

The local server reads that file only at runtime and serves it to the local browser. If the setting is blank or the file is unavailable, the app starts with a blank plan. Existing browser data takes precedence.

## Use the planner

Use the sidebar to switch between **Dashboard**, **Timeline**, **Schedule**, **Requirements**, and **Course catalog**.

Use **Timeline** to:

- Drag a course to another semester or back to **Unscheduled**.
- Select a course card to review its term, section, class dates, days, time, prerequisites, dependencies, grade, and notes.
- Select **MyPortal** on a course card to check every published current or future semester.
- Select **Sync MyPortal** to search every published term for every spreadsheet course. Course details show published sections in other terms too. If the assigned semester has not been published yet, the card keeps its spreadsheet data and shows **spreadsheet**.
- In **Course catalog**, select **Schedule** or **Reschedule** beside a course to choose its semester without returning to the timeline.
- Select **×** on a semester to remove it. Any courses in that semester move to **Unscheduled**. You can select **Undo** to restore the semester and its courses.

Use **Schedule** to view recurring calendar events. The calendar includes daily, monthly, and semester views. In semester view, choose any semester with scheduled classes or **All semesters** from the selector. Events use MyPortal meeting days, times, and class start/end dates when available.

When you move a course, Schedule recommends an open section that does not overlap the selected sections already in that semester. If every published section overlaps, the move is blocked. You can choose a different section from the course details. Meeting patterns use `R` for Thursday; online session labels distinguish `OL1` and `OL2` when MyPortal provides them.

You can add a course to the current semester with its **+ Course** button, or move an existing course there. When you save, Schedule checks MyPortal and selects a conflict-free section whose class start date is after today. This allows a later session such as OL2 to be scheduled before it begins. Open the course and select **Unschedule** to remove it before that date. Once the selected section reaches its start date, its semester and section are locked. A course without a verifiable start date cannot be added to the current semester.

MyPortal may not have published every future semester yet. **Not listed** or **spreadsheet** means the course was absent from the semesters available to search; it does not mean the course will never be offered again. Schedule can only detect time conflicts for courses with published meeting data.

## Files

| file | purpose |
|---|---|
| `index.html`, `style.css` | shell + styling (light/dark follows OS) |
| `engine.js` | pure rules + optimizer (no DOM): offerings, prereqs, min grades, standing, credit limits |
| `app.js` | UI: planner board, requirements, catalog, dialogs |
| external `data.js` | optional private generated seed, configured with `SCHEDULE_DATA_FILE` |
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
    python3 tools/build_data.py "/path/to/private/control-sheet.xlsx" "/path/to/private/schedule-data.js"

Keep control sheets and generated `data.js` files outside version control. They may be used locally with the build tool, but should not be committed.

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
