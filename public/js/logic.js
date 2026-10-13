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
  const last = [...trips].sort(byStartDesc).find((t) => t.end_odo !== null);
  if (!last || last.category !== 'business' || last.end_odo !== startOdo) return '';
  if (localDate(last.end_at, timeZone) !== localDate(startAt, timeZone)) return '';
  return last.between_clients ? last.to_client : last.purpose;
}

export const PERIOD_TYPES = ['weekly', 'monthly', 'quarterly'];

export const CATEGORIES = {
  personal: ['personal_travel', 'home', 'work'],
  business: ['tfn', 'abn'],
};

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

function purposeText(t) {
  if (t.between_clients) {
    const route = `Between clients: ${t.from_client} → ${t.to_client}`;
    return t.purpose ? `${t.purpose} (${route})` : route;
  }
  return t.purpose || TRIP_TYPE_LABELS[t.trip_type];
}

export function buildRows(trips, timeZone) {
  return trips.map((t) => ({
    date: localDate(t.start_at, timeZone),
    start_time: localTime(t.start_at, timeZone),
    end_date: t.end_at ? localDate(t.end_at, timeZone) : '',
    end_time: t.end_at ? localTime(t.end_at, timeZone) : '',
    category: t.category === 'business' ? 'Business' : 'Personal',
    type: TRIP_TYPE_LABELS[t.trip_type],
    purpose: purposeText(t),
    between_clients: t.between_clients ? 'Yes' : 'No',
    start_odo: t.start_odo,
    end_odo: t.end_odo,
    distance: t.distance,
    notes: t.notes,
  }));
}

export function summarise(trips) {
  const sum = (list) => round1(list.reduce((acc, t) => acc + (t.distance || 0), 0));
  const business = trips.filter((t) => t.category === 'business');
  const total = sum(trips);
  const businessKm = sum(business);
  return {
    trips: trips.length,
    total,
    business: businessKm,
    personal: sum(trips.filter((t) => t.category === 'personal')),
    tfn: sum(business.filter((t) => t.trip_type === 'tfn')),
    abn: sum(business.filter((t) => t.trip_type === 'abn')),
    betweenClients: sum(business.filter((t) => t.between_clients)),
    businessPercent: total ? round1((businessKm / total) * 100) : 0,
  };
}

export const COLUMNS = [
  ['date', 'Date'], ['start_time', 'Start time'], ['end_date', 'End date'], ['end_time', 'End time'],
  ['category', 'Category'], ['type', 'Type'], ['purpose', 'Purpose / client'],
  ['between_clients', 'Between clients'], ['start_odo', 'Start odometer'], ['end_odo', 'End odometer'],
  ['distance', `Distance (${UNIT})`], ['notes', 'Notes'],
];

export function summaryLines(s) {
  return [
    ['Total trips', s.trips],
    [`Total distance (${UNIT})`, s.total],
    [`Business (${UNIT})`, s.business],
    [`  TFN (${UNIT})`, s.tfn],
    [`  ABN (${UNIT})`, s.abn],
    [`  Between clients (${UNIT})`, s.betweenClients],
    [`Personal (${UNIT})`, s.personal],
    ['Business use %', s.businessPercent],
  ];
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Prefix formula-like text so spreadsheets don't run it, then quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(report) {
  const lines = [csvCell(report.title), ''];
  lines.push(COLUMNS.map(([, h]) => csvCell(h)).join(','));
  for (const r of report.rows) lines.push(COLUMNS.map(([k]) => csvCell(r[k])).join(','));
  lines.push('', 'Summary');
  for (const [k, v] of summaryLines(report.summary)) lines.push(`${csvCell(k)},${csvCell(v)}`);
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel reads UTF-8 (→, accents) correctly
}

export function fileBase(report) {
  return `mileage-${report.period_type}-${report.period_start}_to_${report.period_end}`;
}

/** A report is a snapshot of the trips in a period at the time it was made. */
export function makeReport(trips, type, start, end, timeZone, now = new Date()) {
  const inRange = tripsInRange(trips, start, end, timeZone);
  const label = periodLabel(type, start, end);
  return {
    period_type: type,
    period_start: start,
    period_end: end,
    label,
    title: `Mileage logbook – ${label}`,
    rows: buildRows(inRange, timeZone),
    summary: summarise(inRange),
    generated_at: now.toISOString(),
  };
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
