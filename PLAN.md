# Mileage Logbook — Plan

## Goal

A phone-first app to log every trip (personal or business) with start/end
odometer, purpose and time, stored in a database, with logbook files
generated automatically every week, month and quarter.

## Platform choice: installable web app (PWA) + small Node.js server

| Option | Phone UX | Runs scheduled jobs at 12 AM | Effort / cost |
|---|---|---|---|
| Native iOS/Android app | Excellent | Unreliable (OS kills background jobs) | High, app-store accounts |
| Spreadsheet / Google Form | Poor, no auto start-odo | Via scripts only | Low, but clunky |
| **PWA + Node server (chosen)** | Installs to home screen, full-screen, big buttons | **Yes** (the server runs the cron) | Low, one small server |

Why this wins: a phone cannot reliably wake up at midnight to build a file,
but a server can. The PWA gives an app-like experience on iPhone and Android
("Add to Home Screen") without an app store, and the same data is reachable
from a laptop for downloading reports.

Stack (kept deliberately small):

- **Server:** Node.js 22+, Express, built-in SQLite (`node:sqlite`, no native
  build step), `node-cron` for schedules, `exceljs` for Excel files.
- **Client:** plain HTML/CSS/JS (no build step), mobile-first, dark/light theme,
  service worker for fast loading and home-screen install.
- **Hosting:** any always-on box — a cheap VPS, Fly.io/Render/Railway with a
  persistent volume, a Raspberry Pi at home, or a Docker host.

## Features

### Trip entry
- **Two ways to log**
  - *Start trip / End trip*: tap Start when you leave (time + start odo filled
    in), tap End when you arrive (enter end odo, time filled in).
  - *Log a completed trip*: enter everything at once after the fact.
- **Start odometer automation:** pre-filled with the end odometer of the last
  trip. A toggle switches it to manual entry. The app warns if the start odo
  is lower than the last end odo, or if there is a gap (unlogged km).
- **Auto-compute:** type the end odo and the total is computed, or (with
  auto-compute on) type the total distance and the end odo is computed.
- **Classification**
  - Personal → *Personal travel* · *Travel to home* · *Travel to work*
  - Business → *TFN* or *ABN*, plus **purpose / client name**, plus a
    **"Between clients"** switch with *From client* and *To client*.
- Date and time for start and end (defaults to now, editable).

### History
- List of trips grouped by date with totals; tap to edit or delete.
- Totals for the current week / month / quarter on the home screen.

### Reports (automatic files)
| Report | Runs | Covers |
|---|---|---|
| Weekly | Every Monday 12:00 AM | Previous Monday–Sunday |
| Monthly | 1st of every month 12:00 AM | Previous calendar month |
| Quarterly | 1 Jan / 1 Apr / 1 Jul / 1 Oct 12:00 AM | Previous quarter (also labelled with the Australian financial-year quarter) |

- Each report is saved as **CSV** and **Excel (.xlsx)** in `data/reports/`
  and listed in the Reports tab for download.
- Columns: date, start time, end time, category, type (personal type or
  TFN/ABN), purpose/client, between-clients route, start odo, end odo,
  distance.
- Summary: total, business, personal, business-use %, TFN vs ABN totals.
- **Catch-up:** if the server was off at midnight, missing reports are
  generated the next time it starts. Generation is idempotent.
- Any custom date range can also be exported on demand.

### Settings / security
- Time zone (schedules run at midnight in *your* zone), distance unit (km/mi).
- Optional password (`APP_PASSWORD`) so the server can live on the internet.

## Data model

```
trips
  id, start_at, end_at, start_odo, end_odo, distance (computed),
  category (personal|business),
  trip_type (personal_travel|home|work|tfn|abn),
  purpose, between_clients (0/1), from_client, to_client, notes,
  start_odo_manual (0/1), created_at, updated_at

reports
  id, period_type (weekly|monthly|quarterly|custom),
  period_start, period_end, csv_path, xlsx_path,
  trip_count, total_distance, generated_at
  UNIQUE(period_type, period_start)
```

## Build phases

1. **MVP (this commit):** trip entry with auto start-odo and auto-compute,
   history with edit/delete, scheduled + catch-up reports (CSV/XLSX),
   on-demand export, PWA install, optional password, tests.
2. **Next:** offline queue (log trips with no signal, sync later), email the
   reports automatically, multiple vehicles (each with its own odometer
   chain), GPS-assisted distance check, photo of the odometer.
3. **Later:** client address book with autocomplete, recurring routes,
   charts, cloud backup of the database.
