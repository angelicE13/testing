# Mileage Logbook

A phone-first app for logging business and personal trips. It saves every trip
to a database and creates logbook files on its own each week, month and quarter.
See [PLAN.md](PLAN.md) for the design and roadmap.

## Features

- **Start trip / End trip** buttons, or log a trip after it's finished.
- **Start odometer fills itself in** from the last trip's end reading. Switch
  it off to type the reading yourself. You get a warning if there's a gap or
  an overlap.
- **Auto-compute:** type the end odometer or the distance, and the other one
  is worked out for you.
- **Personal** trips: personal travel, travel to home, travel to work.
  **Business** trips: TFN or ABN, client or purpose, and an option for travel
  between clients (from client → to client).
- **Automatic reports** (CSV + Excel) at 12:00 AM in your time zone:
  - weekly every Monday (covers the previous Mon–Sun)
  - monthly on the 1st (covers the previous month)
  - quarterly on 1 Jan / Apr / Jul / Oct (covers the previous quarter, also
    labelled with the Australian financial-year quarter)

  If the server was off at midnight, it creates any missed reports when it
  starts again. You can also export any date range yourself.
- Reports include date, start/end time, category, type, purpose/client,
  start/end odometer and distance, plus totals for business, personal, TFN
  and ABN, and your business-use %.
- Add it to your phone's home screen (PWA). Works in light and dark mode.

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
APP_PASSWORD=choose-a-password npm start
# open http://localhost:3000
```

| Variable | Default | Meaning |
|---|---|---|
| `APP_TIMEZONE` | `Australia/Sydney` | Time zone the midnight schedules run in (IANA name, e.g. `Australia/Perth`, `Asia/Manila`) |
| `APP_PASSWORD` | *(none)* | Login password. **Set this if the server can be reached from the internet.** |
| `SESSION_SECRET` | derived from the password | Signs the login cookie |
| `DISTANCE_UNIT` | `km` | `km` or `mi` |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where the SQLite database (`mileage.db`) and `reports/` are stored. Back this folder up. |

### Docker

```bash
docker build -t mileage .
docker run -d -p 3000:3000 -v mileage-data:/app/data \
  -e APP_PASSWORD=choose-a-password -e APP_TIMEZONE=Australia/Sydney mileage
```

### Using it on your phone

1. Host it somewhere that stays on, using HTTPS. Good options are a small VPS,
   Fly.io/Railway/Render with a persistent volume, or a home server behind
   Tailscale or Cloudflare Tunnel.
2. Open the URL on your phone.
   - **iPhone (Safari):** Share → *Add to Home Screen*.
   - **Android (Chrome):** menu → *Install app*.

## Tests

```bash
npm test
```
