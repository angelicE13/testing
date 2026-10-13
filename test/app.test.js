import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, ValidationError } from '../src/db.js';
import { lastCompletedPeriod, financialQuarter } from '../src/periods.js';
import { runDueReports, summarise, toCsv, buildRows } from '../src/reports.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

function setup(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mileage-'));
  const config = loadConfig({ DATA_DIR: dataDir, APP_TIMEZONE: 'Australia/Sydney', ...env });
  fs.mkdirSync(config.reportsDir, { recursive: true });
  return { config, store: openDb(config.dbFile) };
}

const trip = (o = {}) => ({
  category: 'business', trip_type: 'abn', purpose: 'Acme Pty Ltd',
  start_at: '2026-10-06T22:00:00Z', start_odo: 1000, end_odo: 1025.5, end_at: '2026-10-06T23:00:00Z', ...o,
});

test('periods: last completed week / month / quarter', () => {
  assert.deepEqual(lastCompletedPeriod('weekly', '2026-10-12'), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(lastCompletedPeriod('weekly', '2026-10-18'), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(lastCompletedPeriod('monthly', '2026-03-01'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(lastCompletedPeriod('quarterly', '2026-01-01'), { start: '2025-10-01', end: '2025-12-31' });
  assert.equal(financialQuarter('2026-07-01'), 'FY2026-27 Q1');
  assert.equal(financialQuarter('2027-04-01'), 'FY2026-27 Q4');
});

test('trips: distance computed, auto start odo and validation', () => {
  const { store } = setup();
  const { trip: t } = store.createTrip(trip());
  assert.equal(t.distance, 25.5);
  assert.equal(store.lastEndOdo(), 1025.5);

  const { warnings } = store.createTrip(trip({ start_odo: 1030, end_odo: 1040, start_at: '2026-10-07T00:00:00Z', end_at: null }));
  assert.match(warnings[0], /4\.5 unlogged/);

  assert.throws(() => store.createTrip(trip({ end_odo: 900 })), ValidationError);
  assert.throws(() => store.createTrip(trip({ purpose: '' })), /purpose or client/);
  assert.throws(() => store.createTrip(trip({ between_clients: true, from_client: 'A' })), /from.*to/);
  assert.throws(() => store.createTrip(trip({ category: 'personal', trip_type: 'abn' })), /trip_type/);
});

test('trips: start then end, only one active trip at a time', () => {
  const { store } = setup();
  const { trip: t } = store.createTrip(trip({ end_odo: null, end_at: null }));
  assert.equal(store.activeTrip().id, t.id);
  assert.throws(() => store.createTrip(trip({ end_odo: null, end_at: null })), /already in progress/);
  const { trip: ended } = store.endTrip(t.id, { distance: 12.3 });
  assert.equal(ended.end_odo, 1012.3);
  assert.equal(ended.distance, 12.3);
  assert.equal(store.activeTrip(), null);
});

test('reports: due reports are generated once with correct totals', async () => {
  const { store, config } = setup();
  store.createTrip(trip()); // Wed 7 Oct local, business 25.5
  store.createTrip(trip({
    category: 'personal', trip_type: 'work', purpose: '', start_odo: 1025.5, end_odo: 1035.5,
    start_at: '2026-10-07T22:00:00Z', end_at: '2026-10-07T22:30:00Z',
  }));
  const now = new Date('2026-10-11T13:00:00Z'); // Mon 12 Oct 00:00 Sydney
  const created = await runDueReports(store, config, now);
  assert.deepEqual(created.map((r) => r.period_type), ['weekly', 'monthly', 'quarterly']);
  const weekly = created[0];
  assert.equal(weekly.period_start, '2026-10-05');
  assert.equal(weekly.trip_count, 2);
  assert.equal(weekly.total_distance, 35.5);
  assert.ok(fs.existsSync(weekly.csv_path) && fs.existsSync(weekly.xlsx_path));
  assert.equal((await runDueReports(store, config, now)).length, 0, 'idempotent');

  const s = summarise(store.allCompletedTrips());
  assert.equal(s.businessPercent, 71.8);
  assert.equal(s.abn, 25.5);
});

test('csv: escapes quotes/commas and neutralises formulas', () => {
  const { store, config } = setup();
  store.createTrip(trip({ purpose: '=HYPERLINK("x"), "Co"' }));
  const rows = buildRows(store.allCompletedTrips(), config.timezone);
  const csv = toCsv({ title: 't', rows, summary: summarise([]), unit: 'km' });
  assert.ok(csv.includes(`"'=HYPERLINK(""x""), ""Co"""`));
});

test('http: password protects the API', async () => {
  const { store, config } = setup({ APP_PASSWORD: 'secret' });
  const server = createApp(store, config).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/trips`)).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"no"}' })).status, 401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"secret"}' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${base}/api/trips`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const bad = await fetch(`${base}/api/trips`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
