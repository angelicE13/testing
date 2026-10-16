// Pure logbook logic: validation, odometer chain, report building. No browser APIs,
// so the same code runs in the app and in the Node tests.
import { addDays, lastCompletedPeriod, localDate, localTime, periodContaining, periodLabel } from './periods.js';

export const UNIT = 'km';
/** Business clients, most recently used first. */
export function recentClients(trips, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const t of [...trips].sort(byStartDesc)) {
    if (t.category !== 'business') continue;
    for (const name of [t.to_client, t.purpose, t.from_client]) {
      const key = name?.toLowerCase();
      if (name && !seen.has(key)) {
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out.slice(0, limit);
}

/** The client you are leaving, if the last trip today ended at a client (for "between clients"). */
export function comingFromClient(trips, startOdo, startAt, timeZone) {
  const none = { client: '', type: '' };
  const last = [...trips].sort(byStartDesc).find((t) => t.end_odo !== null);
  if (!last || last.category !== 'business' || last.end_odo !== startOdo) return none;
  if (localDate(last.end_at, timeZone) !== localDate(startAt, timeZone)) return none;
  return { client: last.between_clients ? last.to_client : last.purpose, type: last.trip_type };
}

/** ABN/TFN of the client a between-clients trip started from (stored, or worked out from history). */
function fromTypeOf(t, allTrips) {
  if (t.from_type) return t.from_type;
  const prev = [...allTrips].sort(byStartDesc).find((x) => x.start_at < t.start_at && x.category === 'business'
    && (x.between_clients ? x.to_client : x.purpose) === t.from_client);
  return prev ? prev.trip_type : '';
}

export const PERIOD_TYPES = ['weekly', 'monthly', 'quarterly', 'financial_year'];
export const LOGBOOK_DAYS = 84; // ATO minimum: 12 continuous weeks

export const CATEGORIES = {
  personal: ['personal_travel', 'home', 'work'],
  business: ['tfn', 'abn'],
};

const SHORT_TYPE = { tfn: 'TFN', abn: 'ABN', personal_travel: 'Personal', home: 'Home', work: 'Work' };

export const TRIP_TYPE_LABELS = {
  personal_travel: 'Personal travel',
  home: 'Travel to home',
  work: 'Travel to work',
  tfn: 'Business (TFN)',
  abn: 'Business (ABN)',
};

export class ValidationError extends Error {}

export const round1 = (n) => Math.round(n * 10) / 10;

function toNumber(value, field, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${field} must be a positive number`);
  return round1(n);
}

function toIso(value, field, { required = false } = {}) {
  if (!value) {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} is not a valid date/time`);
  return d.toISOString();
}

const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 500) : '');

/** Validates and normalises a trip. Returns the fields to store. */
export function normaliseTrip(input) {
  const category = input.category;
  if (!CATEGORIES[category]) throw new ValidationError('Choose personal or business');
  const tripType = input.trip_type;
  if (!CATEGORIES[category].includes(tripType)) throw new ValidationError('Choose the type of trip');

  const startOdo = toNumber(input.start_odo, 'Start odometer', { required: true });
  const endOdo = toNumber(input.end_odo, 'End odometer');
  if (endOdo !== null && endOdo < startOdo) {
    throw new ValidationError('End odometer cannot be lower than start odometer');
  }

  const startAt = toIso(input.start_at, 'Start date/time', { required: true });
  const endAt = endOdo === null ? null : toIso(input.end_at, 'End date/time') ?? startAt;
  if (endAt && endAt < startAt) throw new ValidationError('End time cannot be before start time');

  const isBusiness = category === 'business';
  const purpose = text(input.purpose);
  const betweenClients = isBusiness && Boolean(input.between_clients);
  const fromClient = betweenClients ? text(input.from_client) : '';
  const toClient = betweenClients ? text(input.to_client) : '';
  // A trip can start before the client is chosen; it's required to finish.
  const finished = endOdo !== null;
  if (finished && isBusiness && !purpose && !betweenClients) {
    throw new ValidationError('Choose the client or purpose for this business trip');
  }
  if (betweenClients && (!fromClient || (finished && !toClient))) {
    throw new ValidationError('Choose which client you are going to');
  }

  return {
    start_at: startAt,
    end_at: endAt,
    start_odo: startOdo,
    end_odo: endOdo,
    distance: endOdo === null ? null : round1(endOdo - startOdo),
    category,
    trip_type: tripType,
    purpose,
    between_clients: betweenClients,
    from_client: fromClient,
    from_type: betweenClients && CATEGORIES.business.includes(input.from_type) ? input.from_type : '',
    to_client: toClient,
    notes: text(input.notes),
    start_odo_manual: Boolean(input.start_odo_manual),
  };
}

/** Newest first. */
export const byStartDesc = (a, b) => (a.start_at < b.start_at ? 1 : a.start_at > b.start_at ? -1 : b.id - a.id);

export function activeTrip(trips) {
  return [...trips].sort(byStartDesc).find((t) => t.end_odo === null) || null;
}

/** End odometer of the most recent finished trip (optionally ignoring the trip being edited). */
export function lastEndOdo(trips, excludeId = null) {
  const last = [...trips].sort(byStartDesc).find((t) => t.end_odo !== null && t.id !== excludeId);
  return last ? last.end_odo : null;
}

/** Non-blocking warnings about the odometer chain. */
export function odoWarnings(trips, startOdo, excludeId = null) {
  const last = lastEndOdo(trips, excludeId);
  if (last === null || startOdo === last) return [];
  return startOdo < last
    ? [`Start odometer is ${round1(last - startOdo)} ${UNIT} below the last trip's end (${last}).`]
    : [`${round1(startOdo - last)} ${UNIT} not logged since the last trip ended at ${last}.`];
}

// ---------- reports ----------

export function tripsInRange(trips, start, end, timeZone) {
  return trips
    .filter((t) => t.end_odo !== null)
    .filter((t) => {
      const day = localDate(t.start_at, timeZone);
      return day >= start && day <= end;
    })
    .sort((a, b) => -byStartDesc(a, b));
}

function purposeText(t, allTrips) {
  if (t.between_clients) {
    const from = fromTypeOf(t, allTrips);
    const route = `Between clients: ${t.from_client}${from ? ` (${SHORT_TYPE[from]})` : ''} → ${t.to_client} (${SHORT_TYPE[t.trip_type]})`;
    return t.purpose ? `${t.purpose} (${route})` : route;
  }
  return t.purpose || TRIP_TYPE_LABELS[t.trip_type];
}

export function buildRows(trips, timeZone, allTrips = trips) {
  return trips.map((t) => ({
    date: localDate(t.start_at, timeZone),
    start_time: localTime(t.start_at, timeZone),
    end_date: t.end_at ? localDate(t.end_at, timeZone) : '',
    end_time: t.end_at ? localTime(t.end_at, timeZone) : '',
    category: t.category === 'business' ? 'Business' : 'Personal',
    type: TRIP_TYPE_LABELS[t.trip_type],
    purpose: purposeText(t, allTrips),
    between_clients: t.between_clients ? 'Yes' : 'No',
    start_odo: t.start_odo,
    end_odo: t.end_odo,
    distance: t.distance,
    notes: t.notes,
  }));
}

const pct = (part, whole) => (whole ? round1((part / whole) * 100) : 0);

export function summarise(trips) {
  const sum = (list) => round1(list.reduce((acc, t) => acc + (t.distance || 0), 0));
  const business = trips.filter((t) => t.category === 'business');
  const total = sum(trips);
  const businessKm = sum(business);
  const abn = sum(business.filter((t) => t.trip_type === 'abn'));
  const tfn = sum(business.filter((t) => t.trip_type === 'tfn'));
  return {
    trips: trips.length,
    total,
    business: businessKm,
    personal: sum(trips.filter((t) => t.category === 'personal')),
    abn,
    tfn,
    betweenClients: sum(business.filter((t) => t.between_clients)),
    businessPercent: pct(businessKm, total),
    personalPercent: total ? round1(100 - pct(businessKm, total)) : 0,
    abnPercent: pct(abn, businessKm), // ABN and TFN are shares of business km
    tfnPercent: businessKm ? round1(100 - pct(abn, businessKm)) : 0,
  };
}

export const COLUMNS = [
  ['date', 'Date'], ['start_time', 'Start time'], ['end_date', 'End date'], ['end_time', 'End time'],
  ['category', 'Category'], ['type', 'Type'], ['purpose', 'Purpose / client'],
  ['between_clients', 'Between clients'], ['start_odo', 'Start odometer'], ['end_odo', 'End odometer'],
  ['distance', `Distance (${UNIT})`], ['notes', 'Notes'],
];

/** Label/value lines shown under every report (CSV, Excel and on screen). */
export function summaryLines(report) {
  const s = report.summary;
  const lines = [];
  const car = report.car || {};
  if (car.make || car.model || car.rego) {
    lines.push(['Car', [car.make, car.model].filter(Boolean).join(' ')]);
    lines.push(['Engine capacity', car.engine || '']);
    lines.push(['Registration', car.rego || '']);
  }
  lines.push(['Period', `${report.period_start} to ${report.period_end}`]);
  if (report.odometer) {
    lines.push(['Odometer at start of period', report.odometer.start ?? '']);
    lines.push(['Odometer at end of period', report.odometer.end ?? '']);
  }
  if (report.logbook) {
    const l = report.logbook;
    lines.push([`Total ${UNIT} travelled (odometer)`, l.totalByOdometer]);
    lines.push([`Unlogged ${UNIT} (treated as private)`, l.unlogged]);
    lines.push(['Business-use % (ATO logbook)', l.businessUsePercent]);
    if (l.inProgress) lines.push(['Status', `In progress — ${l.daysElapsed} of ${LOGBOOK_DAYS} days`]);
  }
  lines.push(
    ['Total trips', s.trips],
    [`Total ${UNIT} logged`, s.total],
    [`Business ${UNIT}`, s.business],
    ['Business %', s.businessPercent],
    [`Personal ${UNIT}`, s.personal],
    ['Personal %', s.personalPercent],
    [`  ABN ${UNIT}`, s.abn],
    ['  ABN % of business', s.abnPercent],
    [`  TFN ${UNIT}`, s.tfn],
    ['  TFN % of business', s.tfnPercent],
    [`  Between clients ${UNIT}`, s.betweenClients],
  );
  return lines;
}

export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Prefix formula-like text so spreadsheets don't run it, then quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(report) {
  const car = report.car;
  const lines = [csvCell(report.title), csvCell(car ? `Car: ${[car.make, car.model].filter(Boolean).join(' ')} · ${car.engine || '-'} · Rego ${car.rego || '-'}` : '')];
  lines.push(COLUMNS.map(([, h]) => csvCell(h)).join(','));
  for (const r of report.rows) lines.push(COLUMNS.map(([k]) => csvCell(r[k])).join(','));
  lines.push('', 'Summary');
  for (const [k, v] of summaryLines(report)) lines.push(`${csvCell(k)},${csvCell(v)}`);
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel reads UTF-8 (→, accents) correctly
}

export function fileBase(report) {
  return `mileage-${report.period_type}-${report.period_start}_to_${report.period_end}`;
}

/** A report is a snapshot of the trips in a period at the time it was made. */
export function makeReport(trips, type, start, end, timeZone, now = new Date(), car = null, extras = {}) {
  const inRange = tripsInRange(trips, start, end, timeZone);
  const label = periodLabel(type, start, end);
  const summary = summarise(inRange);
  const odometer = inRange.length
    ? { start: inRange[0].start_odo, end: Math.max(...inRange.map((t) => t.end_odo)) }
    : null;
  const report = {
    period_type: type,
    period_start: start,
    period_end: end,
    label,
    title: type === 'logbook' ? `ATO car logbook – ${label.replace('ATO logbook ', '')}`
      : type === 'expenses' ? `Expense report – ${label.replace('Expenses ', '')}` : `Mileage logbook – ${label}`,
    car: car && Object.values(car).some(Boolean) ? { ...car } : null,
    odometer,
    rows: buildRows(inRange, timeZone, trips),
    summary,
    generated_at: now.toISOString(),
  };
  if (type === 'logbook') {
    const today = localDate(now, timeZone);
    const totalByOdometer = odometer ? round1(odometer.end - odometer.start) : 0;
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
    report.logbook = {
      totalByOdometer,
      unlogged: round1(Math.max(0, totalByOdometer - summary.total)),
      businessUsePercent: pct(summary.business, totalByOdometer),
      inProgress: today <= end,
      daysElapsed: Math.max(0, Math.min(LOGBOOK_DAYS, days)),
    };
  }
  if (extras.addExpenses) extras.addExpenses(report);
  return report;
}

/** 12-week (84-day) ATO logbook period starting on the given date. */
export function logbookPeriod(start) {
  return { start, end: addDays(start, LOGBOOK_DAYS - 1) };
}

/**
 * Every finished week/month/quarter (since the first trip) that has trips but no report yet.
 * Run whenever the app opens, so periods that ended while the phone was asleep are caught up.
 */
export function duePeriods(trips, reports, today, timeZone) {
  const done = trips.filter((t) => t.end_odo !== null);
  if (!done.length) return [];
  const firstDay = done.map((t) => localDate(t.start_at, timeZone)).sort()[0];
  const have = new Set(reports.map((r) => `${r.period_type}|${r.period_start}|${r.period_end}`));
  const due = [];
  for (const type of PERIOD_TYPES) {
    const lastEnd = lastCompletedPeriod(type, today).end;
    for (let p = periodContaining(type, firstDay); p.end <= lastEnd; p = periodContaining(type, addDays(p.end, 1))) {
      if (have.has(`${type}|${p.start}|${p.end}`)) continue;
      if (tripsInRange(done, p.start, p.end, timeZone).length) due.push({ type, ...p });
    }
  }
  return due;
}

// ---------- ATO logbook guide ----------

export const LOGBOOK_VALID_YEARS = 5;
export const LOGBOOK_CHANGE_POINTS = 10; // suggest a new logbook if business use moves this much

/** Progress of a 12-week logbook started on `start`, worked out live from the trips. */
export function logbookStatus(trips, start, now, timeZone) {
  const { end } = logbookPeriod(start);
  const r = makeReport(trips, 'logbook', start, end, timeZone, now);
  return {
    start,
    end,
    day: r.logbook.daysElapsed,
    days: LOGBOOK_DAYS,
    done: !r.logbook.inProgress,
    businessUse: r.logbook.businessUsePercent,
    totalKm: r.logbook.totalByOdometer,
  };
}

/** Last day a logbook ending on `end` can be used (it is valid for 5 years). */
export function logbookExpiry(end) {
  const [y, m, d] = end.split('-');
  return `${Number(y) + LOGBOOK_VALID_YEARS}-${m}-${d}`;
}

/** Business % over the last 12 weeks, to spot a change in how the car is used. */
export function recentBusinessUse(trips, today, timeZone) {
  return summarise(tripsInRange(trips, addDays(today, -(LOGBOOK_DAYS - 1)), today, timeZone));
}
