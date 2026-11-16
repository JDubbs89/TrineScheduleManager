# Schedule Manager

A local schedule planner for Trine students. Use it to organize courses by term, check conflicts, track requirements, and review published MyPortal sections without sending your planning data to a hosted service.

## Run it

    cd ScheduleManager
    pip install -r requirements.txt
    python3 server.py                # then open http://localhost:8080

The planner itself still works from any static host (or `file://` in most browsers), but the local MyPortal catalog requires `server.py`.

State is always stored in the browser (localStorage, per origin). Select **Settings → Profile** to create a username/password account and synchronize that browser copy through `schedule-users.sqlite3`. Sign into the same account from another client that can reach the server to load the same plan. Passwords are stored only as salted bcrypt hashes; session cookies are HttpOnly and SameSite=Strict. Use **Settings → Data & backup → Export JSON** for an additional portable backup.

The built-in server uses plain HTTP. Only enter account credentials over localhost or a trusted private network. For access over the internet or an untrusted network, put the app behind an HTTPS reverse proxy before using accounts.
The repository contains only the manager; plans are created locally in your browser. Use **Settings → Data & backup → Create blank** to start a new plan, or **Import CSV** to add courses from a file with `Code` and `Title` columns. Optional columns include `Term`, `Credits`, `Grade`, `Category`, `Offered`, `Prerequisites`, and `Notes`. Terms may be IDs such as `FA26` or labels such as `Fall 2026`.

To load a private generated plan without putting it in Git, set `SCHEDULE_DATA_FILE` in `.env` to the absolute path of your generated `data.js` file:

    SCHEDULE_DATA_FILE=/home/you/private/schedule-data.js

The local server reads that file only at runtime and serves it to the local browser. If the setting is blank or the file is unavailable, the app starts with a blank plan. Existing browser data takes precedence.

**Refresh** downloads the published MyPortal catalog into `schedule-cache.sqlite3`. Search, availability checks, schedule enrichment, and conflict detection then use that completed local snapshot without contacting MyPortal. If a refresh fails, the app keeps using the previous completed snapshot. Set `SCHEDULE_CACHE_DB` in `.env` to choose another SQLite file; the database is local and ignored by Git.

## Use the planner

Use the sidebar to switch between **Dashboard**, **Timeline**, **Schedule**, **Requirements**, and **Course catalog**.

Use **Timeline** to:

- Drag a course to another semester or back to **Unscheduled**.
- Select a course card to review its term, section, class dates, days, time, prerequisites, dependencies, grade, and notes.
- Select **MyPortal** on a course card to check the local catalog for every published current or future semester.
- Select **Sync MyPortal** to replace the local catalog with a completed snapshot of every published term. Course details show published sections in other terms too. If the assigned semester has not been published yet, the card keeps its spreadsheet data and shows **spreadsheet**.
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
| `server.py` | local static server, MyPortal catalog importer, and catalog reader |
| `schedule-cache.sqlite3` | completed local snapshots of published MyPortal sections |
| `schedule-users.sqlite3` | user accounts, sessions, and revisioned synchronized schedules |
| `tools/build_data.py` | regenerates `data.js` from an updated control sheet |

## Accounts and multi-client schedules

Select **Settings → Profile → Create account** to upload the current browser plan when the account has no server schedule. On later clients, **Settings → Profile → Sign in** loads the server copy. Changes continue to save locally first and are then synchronized in the background.

On first startup, the server creates the default account `jonathan` with password `password123`. The browser signs into that account automatically and uploads its existing cached plan if the account does not have a schedule yet. Select **Settings → Profile → Change password** immediately; changing it signs out every other client session while keeping the current one active.

Each saved schedule has a revision number. If another client saves a newer revision first, Schedule Manager does not silently overwrite it. Open **Settings → Profile** and choose either **Use server copy** or **Use this browser copy**. Signing out leaves the current browser copy available locally.

Set `SCHEDULE_USER_DB` in `.env` to place the user database elsewhere. Back up this database to preserve accounts and synchronized schedules.

## Refresh and search the MyPortal catalog

Select **Refresh** on the Dashboard or **Sync MyPortal** on the Timeline to download undergraduate sections from all published terms. MyPortal limits broad searches to 20 rows, so a refresh divides capped departments into smaller course-number ranges. This can take several minutes. Do not restart the server while it runs.

After the refresh completes, open **Catalog → Search MyPortal…**. Searches and course-card availability checks use SQLite, so they do not add traffic to MyPortal. Choosing a result schedules the matching course already in your plan, or creates a custom course when there is no match.

The snapshot includes section status, seats, instructor, meeting schedule, credits, and start/end dates. MyPortal only exposes terms that the university has published; a course absent from those results may still be offered in a later, unpublished term.

If a refresh times out or MyPortal rejects a search, the new snapshot is discarded and the previous completed snapshot remains available. Wait before trying Refresh again. Set `MYPORTAL_REQUEST_INTERVAL_SECONDS` in `.env` to increase the delay between portal requests; the default is `1` second.

Catalog refresh uses MyPortal's public Course Schedules page and does not require a login cookie. Legacy cookie settings are not used for catalog downloads. `.env` is ignored by Git. The server otherwise uses Python's standard library, with `bcrypt` as the account-password dependency.

## Use your transcript GPA

Export your cookies from a signed-in MyPortal session to `myportal-cookies.json` beside `server.py`. In Schedule Manager, sign in and select **Settings → Data & backup → Import transcript**.

The GPA tile uses MyPortal's career GPA, GPA credits, and quality points, including its treatment of transfers and repeated courses. Current grades entered in your plan produce a separate projection; they do not change the imported GPA. The projection uses grade values observed in your transcript where available, and the planner's grade scale otherwise. Completed courses already in the transcript are counted once. Select **Import transcript** again after grades are posted to refresh the totals, or **Use planner GPA** to return to calculating GPA from your plan.

The imported transcript stays with your plan in browser storage, account sync, and JSON backups. Import does not add or change scheduled courses. Undo can reverse an import.

The cookie store is available only to the `jonathan` Schedule Manager account by default. Set `MYPORTAL_OWNER_USERNAME` in `.env` to use another account. To use a cookie export elsewhere, set `MYPORTAL_COOKIES_JSON_FILE` to its path. Restart the server after changing `.env`; replacing the cookie file does not require a restart. Keep cookie exports private.

If import reports that transcript access failed, sign in to MyPortal again and replace the cookie export. The previous imported GPA remains available if a refresh fails.

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
