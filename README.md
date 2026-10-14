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

### Log (mileage)
- **Start a trip with one tap:** Business ABN, Business TFN, To work, To home or
  Personal. The time and start odometer are filled in for you.
- **Finish with one number:** the end odometer or the trip distance.
  *Same as last time* suggests the usual distance for that route.
- **Clients:** tap a recent client or type one. Driving straight from one
  client to the next is marked *between clients* automatically, with ABN/TFN
  shown at both ends in reports.
- **Reminders:** "still driving?" if a trip has been open for 3+ hours, and a
  **weekly odometer check** that finds unlogged km and can log them as personal.
- **Breakdown** for the week, month, quarter or financial year: business vs
  personal %, and ABN vs TFN % of business.

### Expenses
- Amount, category, supplier (recent suppliers suggested; for **Petrol** a
  dropdown of Australian fuel brands plus *Other / independent…*), optional odometer
  and a **receipt photo**. Photos are shrunk to about 150–350 KB and stay
  readable.
- Categories: petrol, service, repairs, parts, tyres, car wash, registration,
  insurance, tolls & parking, clothing/uniform, laundry, plus **Other…** for
  anything else. Names you type are remembered as quick buttons.
- **Car-related expenses** (car costs, tolls & parking, and "Other" items
  marked car-related) are split by your mileage: business-use % (from the ATO
  logbook, or your trips until you have one), then ABN vs TFN by business km.
  The rest is **Personal**.
- **Not car-related** expenses (clothing, laundry, "Other" items switched off)
  are listed with their totals but **not split**.

### History
- Separate **Mileage** and **Expenses** histories, each with search and filters.
- Swipe left to delete (with Undo). Swipe a trip right to **repeat** it.
  Tap to edit.
- **Clear all**, with an offer to back up first.

### Reports
- Weekly, monthly, quarterly and **financial-year** reports are created
  automatically when each period ends.
- Each report (Excel + CSV) includes:
  - trips, odometer start/end, car details
  - business/personal and ABN/TFN percentages
  - an **Expenses** sheet with claimable estimates
  - a **Receipts** zip of that period's photos
- **Expense report** for any date range:
  - totals by category with % of total
  - every expense
  - at the end, the split of the **car-related** expenses into
    **Personal / ABN / TFN** (% and $), based on your mileage
  - then the not-car-related total (not split) and the overall total
- **ATO 12-week logbook** with business-use %.
- **Tax pack:** one zip per financial year with the workbook, the logbook, a
  summary and all receipt photos, ready for your accountant.
- **Clients:** rename or merge names, for example "ACME" → "Acme Pty Ltd".

### Backup
- Each night at 10pm (or the next time you open the app), a copy is kept
  inside the app. *Go back to last night's copy* undoes mistakes.
- A one-tap reminder saves **mileage-backup.zip** (trips, expenses and photos).
  Choose *Replace* to keep one up-to-date file. *Restore backup* loads it on
  a new phone.

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
