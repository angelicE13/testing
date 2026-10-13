import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastCompletedPeriod, financialQuarter } from '../public/js/periods.js';
import { ValidationError, duePeriods, summarise, toCsv, makeReport } from '../public/js/logic.js';
import { Store, memoryAdapter } from '../public/js/store.js';

const TZ = 'Australia/Melbourne';
const newStore = () => new Store(memoryAdapter(), { timeZone: TZ }).load();

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

test('trips: distance computed, auto start odo and validation', async () => {
  const store = await newStore();
  const { trip: t } = await store.createTrip(trip());
  assert.equal(t.distance, 25.5);
  assert.equal(store.lastEndOdo(), 1025.5);

  const { warnings } = await store.createTrip(trip({ start_odo: 1030, end_odo: null, start_at: '2026-10-07T00:00:00Z' }));
  assert.match(warnings[0], /4\.5 km not logged/);

  await assert.rejects(store.createTrip(trip({ end_odo: 900 })), ValidationError);
  await assert.rejects(store.createTrip(trip({ purpose: '' })), /purpose or client/);
  await assert.rejects(store.createTrip(trip({ between_clients: true, from_client: 'A' })), /from.*to/);
  await assert.rejects(store.createTrip(trip({ category: 'personal', trip_type: 'abn' })), /type of trip/);
});

test('trips: start then end, only one active trip at a time', async () => {
  const store = await newStore();
  const { trip: t } = await store.createTrip(trip({ end_odo: null, end_at: null }));
  assert.equal(store.activeTrip().id, t.id);
  await assert.rejects(store.createTrip(trip({ end_odo: null })), /already in progress/);
  const { trip: ended } = await store.endTrip(t.id, { distance: 12.3 });
  assert.equal(ended.end_odo, 1012.3);
  assert.equal(ended.distance, 12.3);
  assert.equal(store.activeTrip(), null);
});

test('reports: catch up every missed period once, skipping empty ones', async () => {
  const store = await newStore();
  await store.createTrip(trip()); // Wed 7 Oct (Melbourne), business 25.5
  await store.createTrip(trip({
    category: 'personal', trip_type: 'work', purpose: '', start_odo: 1025.5, end_odo: 1035.5,
    start_at: '2026-10-07T22:00:00Z', end_at: '2026-10-07T22:30:00Z',
  }));
  await store.createTrip(trip({ start_odo: 1035.5, end_odo: 1040, start_at: '2026-10-20T00:00:00Z', end_at: null }));

  // Phone not opened until Tue 3 Nov: weeks of 5 Oct and 19 Oct are due (12 Oct week was empty), plus October.
  const created = await store.generateDue(new Date('2026-11-02T22:00:00Z'));
  assert.deepEqual(created.map((r) => `${r.period_type} ${r.period_start}`), [
    'weekly 2026-10-05', 'weekly 2026-10-19', 'monthly 2026-10-01',
  ]);
  const week = created[0];
  assert.equal(week.summary.trips, 2);
  assert.equal(week.summary.total, 35.5);
  assert.equal(week.summary.businessPercent, 71.8);
  assert.equal((await store.generateDue(new Date('2026-11-02T22:00:00Z'))).length, 0, 'idempotent');

  // Quarter Oct–Dec becomes due on 1 Jan, Melbourne time (31 Dec 13:00 UTC).
  const jan = await store.generateDue(new Date('2026-12-31T13:00:00Z'));
  assert.ok(jan.some((r) => r.period_type === 'quarterly' && r.period_start === '2026-10-01'));
});

test('reports: nothing due before a period ends', () => {
  const trips = [{ ...trip(), id: 1, distance: 25.5 }];
  assert.deepEqual(duePeriods(trips, [], '2026-10-11', TZ), []);
});

test('csv: escapes quotes/commas and neutralises formulas', async () => {
  const store = await newStore();
  await store.createTrip(trip({ purpose: '=HYPERLINK("x"), "Co"' }));
  const report = makeReport(store.trips, 'custom', '2026-10-01', '2026-10-31', TZ);
  const csv = toCsv(report);
  assert.ok(csv.includes(`"'=HYPERLINK(""x""), ""Co"""`));
  assert.equal(summarise([]).businessPercent, 0);
});

test('backup: export and restore round-trip, bad files rejected', async () => {
  const a = await newStore();
  await a.createTrip(trip());
  await a.generateReport('custom', '2026-10-01', '2026-10-31');
  const backup = JSON.parse(JSON.stringify(a.exportData()));

  const b = await newStore();
  await b.createTrip(trip({ purpose: 'will be replaced' }));
  await b.importData(backup);
  assert.equal(b.trips.length, 1);
  assert.equal(b.trips[0].purpose, 'Acme Pty Ltd');
  assert.equal(b.reports.length, 1);
  await assert.rejects(b.importData({ hello: 1 }), /not a Mileage Logbook backup/);
  assert.equal(b.trips.length, 1, 'nothing wiped on a bad file');
});
