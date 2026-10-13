# Mileage Logbook — Plan

## Goal

A phone-first app to log every trip (personal or business) with start/end
odometer, purpose and time, stored in a database, with logbook files
generated automatically every week, month and quarter.

## Platform choice: phone-only installable web app (PWA)

Chosen by the user: **no server**. The app is a static web page hosted free on
GitHub Pages and added to the phone's home screen.

- **Data:** stored on the phone (IndexedDB). The app asks the browser to keep
  it permanently. Backup/restore uses a JSON file.
- **Offline:** a service worker stores every app file, so it opens and saves
  trips with no signal.
- **Reports:** a phone can't run a job at exactly 12 AM when the app is
  closed. Reports are created at midnight if the app is open, otherwise the
  first time it's opened after the period ends. Every missed period is caught
  up. Files are made on the phone (Excel via ExcelJS, CSV) and shared through
  the share sheet.
- **Time zone:** the phone's own (Australia/Melbourne).

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
| Report | Due from | Covers |
|---|---|---|
| Weekly | Monday 12:00 AM | Previous Monday–Sunday |
| Monthly | 1st of the month 12:00 AM | Previous calendar month |
| Quarterly | 1 Jan / 1 Apr / 1 Jul / 1 Oct 12:00 AM | Previous quarter (also labelled with the Australian financial-year quarter) |

- Created at that time if the app is open, otherwise the next time it's opened.
- Listed in the Reports tab. Each one can be saved or shared as **Excel (.xlsx)** or **CSV**.
- Columns: date, start time, end time, category, type (personal type or
  TFN/ABN), purpose/client, between-clients route, start odo, end odo,
  distance.
- Summary: total, business, personal, business-use %, TFN vs ABN totals.
- **Catch-up:** every period that ended while the app was closed gets its
  report. Periods with no trips are skipped. Each report is made only once.
- Any custom date range can also be exported on demand.

### Backup
- Save a backup file (to Files / iCloud Drive / Google Drive / email) and
  restore it on a new phone. A reminder appears after 2 weeks without one.

## Data model (IndexedDB on the phone)

```
trips    id, start_at, end_at, start_odo, end_odo, distance, category,
         trip_type, purpose, between_clients, from_client, to_client, notes,
         start_odo_manual, created_at, updated_at
reports  id, period_type, period_start, period_end, label, title,
         rows (snapshot), summary, generated_at
meta     lastBackupAt
```

## Build phases

1. **Initial version (now):** phone-only. Trip entry with auto start-odo and
   auto-compute, history with edit/delete, catch-up reports (CSV/XLSX),
   date-range export, backup/restore, works offline, tests.
2. **Next, based on real use:** multiple vehicles (each with its own odometer
   chain), automatic cloud backup, GPS-assisted distance check, photo of the
   odometer.
3. **Later:** client address book with autocomplete, recurring routes,
   charts, cloud backup of the database.
