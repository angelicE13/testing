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
  await assert.rejects(store.createTrip(trip({ purpose: '' })), /client or purpose/);
  await assert.rejects(store.createTrip(trip({ between_clients: true, from_client: 'A' })), /which client/);
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

test('percentages: business/personal of total, ABN/TFN of business', async () => {
  const store = await newStore();
  await store.createTrip(trip({ trip_type: 'abn', start_odo: 0, end_odo: 30 }));
  await store.createTrip(trip({ trip_type: 'tfn', start_odo: 30, end_odo: 40, start_at: '2026-10-07T00:00:00Z', end_at: null }));
  await store.createTrip(trip({ category: 'personal', trip_type: 'home', purpose: '', start_odo: 40, end_odo: 100, start_at: '2026-10-07T02:00:00Z', end_at: null }));
  const s = summarise(store.trips);
  assert.deepEqual(
    [s.total, s.businessPercent, s.personalPercent, s.abnPercent, s.tfnPercent],
    [100, 40, 60, 75, 25],
  );
});

test('between clients shows ABN/TFN at both ends', async () => {
  const store = await newStore();
  await store.createTrip(trip({ trip_type: 'abn', purpose: 'Acme' })); // ends 1025.5
  await store.createTrip(trip({
    trip_type: 'tfn', purpose: '', between_clients: true, from_client: 'Acme', to_client: 'Blue Co',
    start_odo: 1025.5, end_odo: 1030, start_at: '2026-10-07T00:00:00Z', end_at: null,
  }));
  const report = makeReport(store.trips, 'custom', '2026-10-01', '2026-10-31', TZ);
  assert.equal(report.rows[1].purpose, 'Between clients: Acme (ABN) → Blue Co (TFN)');
});

test('ATO logbook: 12 weeks, odometer totals, business-use %, car details', async () => {
  const store = await newStore();
  await store.saveCar({ make: 'Toyota', model: 'RAV4', engine: '2.5L', rego: 'ABC123' });
  await store.createTrip(trip({ start_odo: 1000, end_odo: 1030 })); // business 30
  // 20 km gap not logged, then 50 personal
  await store.createTrip(trip({ category: 'personal', trip_type: 'personal_travel', purpose: '', start_odo: 1050, end_odo: 1100, start_at: '2026-10-08T00:00:00Z', end_at: null }));
  const r = await store.generateLogbook('2026-10-05', new Date('2026-10-10T00:00:00Z'));
  assert.equal(r.period_end, '2026-12-27');
  assert.deepEqual(r.odometer, { start: 1000, end: 1100 });
  assert.equal(r.logbook.totalByOdometer, 100);
  assert.equal(r.logbook.unlogged, 20);
  assert.equal(r.logbook.businessUsePercent, 30);
  assert.equal(r.logbook.inProgress, true);
  assert.match(toCsv(r), /Toyota RAV4 · 2\.5L · Rego ABC123/);
  assert.match(toCsv(r), /Business-use % \(ATO logbook\),30/);
});

test('financial year report is due after 30 June', async () => {
  const store = await newStore();
  await store.createTrip(trip({ start_at: '2026-03-02T00:00:00Z', end_at: null }));
  const created = await store.generateDue(new Date('2026-06-30T15:00:00Z')); // 1 Jul, 1am Melbourne
  const fy = created.find((r) => r.period_type === 'financial_year');
  assert.equal(fy.period_start, '2025-07-01');
  assert.equal(fy.label, 'FY2025-26 (1 Jul 2025 – 30 Jun 2026)');
});

// ---------- expenses ----------
import { summariseExpenses, normaliseExpense, receiptName } from '../public/js/expenses.js';

test('expenses: validation and custom "Other" categories', () => {
  assert.throws(() => normaliseExpense({ amount: 0, category: 'fuel', date: '2026-10-01' }), /amount/);
  assert.throws(() => normaliseExpense({ amount: 10, category: 'nope', date: '2026-10-01' }), /category/);
  assert.throws(() => normaliseExpense({ amount: 10, category: 'other', date: '2026-10-01' }), /what the expense is for/);
  const e = normaliseExpense({ amount: '45.206', category: 'other', category_label: ' Phone holder ', date: '2026-10-01' });
  assert.equal(e.amount, 45.21);
  assert.equal(e.category_label, 'Phone holder');
  assert.equal(normaliseExpense({ amount: 5, category: 'fuel', category_label: 'x', date: '2026-10-01' }).category_label, '');
});

test('expenses: only car-related expenses are split by mileage', () => {
  const list = [
    { amount: 100, category: 'fuel' },
    { amount: 300, category: 'service' },
    { amount: 50, category: 'clothing' }, // not car-related
    { amount: 50, category: 'other', category_label: 'Phone holder' }, // Other defaults to car-related
    { amount: 20, category: 'other', category_label: 'Stationery', car_related: false },
  ];
  const s = summariseExpenses(list, { businessUse: 60, abnShare: 75 });
  assert.equal(s.total, 520);
  assert.equal(s.carTotal, 450);
  assert.equal(s.nonCarTotal, 70);
  assert.equal(s.claimableTotal, 270);
  assert.deepEqual(s.claimable, { abn: 202.5, tfn: 67.5 });
  assert.deepEqual(s.split.personal, { pct: 40, amount: 180 });
  assert.equal(s.byCategory['Phone holder'], 50);
});

test('expenses in reports use the ATO logbook business-use %', async () => {
  const store = await newStore();
  await store.createTrip(trip({ start_odo: 1000, end_odo: 1060 })); // business ABN 60
  await store.createTrip(trip({ category: 'personal', trip_type: 'home', purpose: '', start_odo: 1060, end_odo: 1100, start_at: '2026-10-08T00:00:00Z', end_at: null }));
  await store.generateLogbook('2026-10-05', new Date('2026-12-30T00:00:00Z')); // 60% business
  await store.createExpense({ amount: 200, category: 'fuel', date: '2026-10-10' });
  const r = await store.generateReport('monthly', '2026-10-01', '2026-10-31');
  assert.equal(r.expenses.summary.businessUse, 60);
  assert.match(r.expenses.summary.businessUseSource, /ATO logbook from 2026-10-05/);
  assert.equal(r.expenses.summary.claimable.abn, 120);
  assert.match(receiptName({ ...store.expenses[0], photo_id: 1 }), /^2026-10-10_Petrol_200\.00_\d+\.jpg$/);
});

test('clients: rename merges names across trips', async () => {
  const store = await newStore();
  await store.createTrip(trip({ purpose: 'ACME' }));
  await store.createTrip(trip({ purpose: '', between_clients: true, from_client: 'acme', to_client: 'Blue', start_odo: 1025.5, end_odo: 1030, start_at: '2026-10-07T00:00:00Z', end_at: null }));
  await store.renameClient('Acme', 'Acme Pty Ltd');
  assert.deepEqual(store.trips.map((t) => t.purpose || t.from_client), ['Acme Pty Ltd', 'Acme Pty Ltd']);
});

test('expense report: by category, % of total, and Personal/ABN/TFN split', async () => {
  const store = await newStore();
  await store.createTrip(trip({ trip_type: 'abn', start_odo: 0, end_odo: 30 }));
  await store.createTrip(trip({ trip_type: 'tfn', start_odo: 30, end_odo: 40, start_at: '2026-10-07T00:00:00Z', end_at: null }));
  await store.createTrip(trip({ category: 'personal', trip_type: 'home', purpose: '', start_odo: 40, end_odo: 100, start_at: '2026-10-07T02:00:00Z', end_at: null }));
  await store.createExpense({ amount: 150, category: 'fuel', date: '2026-10-08' });
  await store.createExpense({ amount: 50, category: 'other', category_label: 'Phone holder', date: '2026-10-09' });
  const r = await store.generateReport('expenses', '2026-10-01', '2026-10-31');
  const x = r.expenses.summary;
  assert.equal(r.title, 'Expense report – 1 Oct 2026 – 31 Oct 2026');
  assert.deepEqual(x.categories.map((c) => [c.label, c.amount, c.pct]), [['Petrol', 150, 75], ['Phone holder', 50, 25]]);
  // 40% business (ABN 75% of that = 30%, TFN 10%), 60% personal
  assert.deepEqual(x.split, {
    personal: { pct: 60, amount: 120 }, abn: { pct: 30, amount: 60 }, tfn: { pct: 10, amount: 20 },
  });
});

// ---------- logbook guide & method comparison ----------
import { logbookStatus, logbookExpiry, recentBusinessUse } from '../public/js/logic.js';
import { compareMethods, comparisonInputs } from '../public/js/methods.js';

test('logbook guide: progress, completion and 5-year expiry', async () => {
  const store = await newStore();
  await store.createTrip(trip({ start_odo: 1000, end_odo: 1040 })); // business 40
  await store.createTrip(trip({ category: 'personal', trip_type: 'home', purpose: '', start_odo: 1040, end_odo: 1100, start_at: '2026-10-08T00:00:00Z', end_at: null }));
  const mid = logbookStatus(store.trips, '2026-10-05', new Date('2026-11-07T01:00:00Z'), TZ);
  assert.deepEqual([mid.day, mid.done, mid.businessUse, mid.end], [34, false, 40, '2026-12-27']);
  const done = logbookStatus(store.trips, '2026-10-05', new Date('2026-12-28T01:00:00Z'), TZ);
  assert.equal(done.done, true);
  assert.equal(logbookExpiry('2026-12-27'), '2031-12-27');
  assert.equal(recentBusinessUse(store.trips, '2026-10-20', TZ).businessPercent, 40);
});

test('method comparison: logbook vs cents per km, tolls on top, 5,000 km cap', () => {
  const c = compareMethods({ carCosts: 6000, tolls: 200, depreciation: 4000, businessUse: 60, abnShare: 75, businessKm: 6000, rate: 0.88 });
  assert.equal(c.logbook.total, 6000); // (6000 + 4000) × 60%
  assert.deepEqual([c.logbook.abn, c.logbook.tfn], [4500, 1500]);
  assert.equal(c.cents.km, 5000);
  assert.equal(c.cents.total, 4400);
  assert.equal(c.better, 'logbook');
  assert.equal(c.difference, 1600);
  assert.equal(c.tolls.business, 120);
  assert.equal(compareMethods({ carCosts: 100, businessUse: 50, abnShare: 0, businessKm: 10 }).better, null, 'no rate yet');
  const inputs = comparisonInputs({
    tripSummary: { business: 40, businessPercent: 40, abnPercent: 75 },
    expenses: [{ id: 1, date: '2026-08-01', amount: 100, category: 'fuel' }, { id: 2, date: '2026-08-02', amount: 10, category: 'tolls_parking' }, { id: 3, date: '2026-08-03', amount: 50, category: 'clothing' }],
    start: '2026-07-01', end: '2027-06-30', logbook: null, rate: '0.88', depreciation: '',
  });
  assert.deepEqual([inputs.carCosts, inputs.tolls, inputs.businessUse, inputs.rate], [100, 10, 40, 0.88]);
});
