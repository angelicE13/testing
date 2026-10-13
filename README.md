# Mileage Logbook

A mileage logbook for your phone. Log business and personal trips and get weekly,
monthly and quarterly reports in Excel and CSV.

**Everything is stored on your phone.** There is no server and no account.
The app is just a web page (hosted free on GitHub Pages) that you add to your
home screen. After the first visit it works with no signal.

## Open it

**https://angelice13.github.io/testing/**

- **iPhone (Safari):** tap Share → *Add to Home Screen*. Always open it from
  that icon. iPhone keeps home-screen apps' data separately from Safari.
- **Android (Chrome):** menu ⋮ → *Install app* / *Add to Home screen*.

## Features

- **Start a trip with one tap:** Business ABN, Business TFN, Personal, To work or To home.
  The time and start odometer are filled in for you (tap *Change* if the
  odometer is different).
- **Finish with one number:** type the end odometer, or switch to *Trip
  distance* and type the km. Then tap *Finish trip*. The app remembers which
  one you prefer.
- **Clients:** for business trips, tap a recent client or type a new one. You
  can do this any time before finishing. If you leave one client and drive
  straight to the next, it's marked as *between clients* automatically.
- **+ Add a past trip** is the full form, for trips you forgot to log.
- **History:** tap a trip to edit or delete it.
- **Breakdown on the home screen** for this week, month, quarter or financial
  year:
  - business % vs personal % of all km
  - ABN % vs TFN % of business km
- **Reports** (Excel + CSV), each with odometer start/end, car details and the
  same percentages:
  - weekly, monthly and quarterly
  - **financial year** (1 Jul – 30 Jun)
  - between-clients trips show both ends, e.g. *Acme (ABN) → Blue Co (TFN)*

  Reports are created when the period ends: at 12 AM if the app is open,
  otherwise the next time you open it. Missed periods are caught up.
- **ATO 12-week logbook:** pick a start date. The report shows the logbook
  period, odometer at start and end, total km by odometer (unlogged km counted
  as private) and your **business-use %**.
- **Car details** (make, model, engine capacity, rego) are printed on every report.
- **Backup / restore:** saves a `.json` file with all your trips. The app
  reminds you if you haven't backed up for 2 weeks.

> ⚠️ Because data lives only on the phone, deleting the app, clearing Safari or
> Chrome website data, or losing the phone deletes your trips. Back up regularly.

## Publishing (one-time setup)

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Actions → "Publish app to GitHub Pages" → Run workflow** (or push any change).

Every push after that runs the tests and republishes the app. Phones get the new
version the next time the app is opened twice.

## Development

```bash
npm install     # dev only: Excel library + tests
npm start       # http://localhost:8080
npm test
```

The app is plain HTML/CSS/JS in `public/` with no build step. The logic in
`public/js/` (`logic.js`, `periods.js`, `store.js`) is shared with the Node tests.
