import { DatabaseSync } from 'node:sqlite';

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  start_odo REAL NOT NULL,
  end_odo REAL,
  distance REAL,
  category TEXT NOT NULL CHECK (category IN ('personal', 'business')),
  trip_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  between_clients INTEGER NOT NULL DEFAULT 0,
  from_client TEXT NOT NULL DEFAULT '',
  to_client TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  start_odo_manual INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trips_start_at ON trips (start_at);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  label TEXT NOT NULL,
  csv_path TEXT NOT NULL,
  xlsx_path TEXT NOT NULL,
  trip_count INTEGER NOT NULL,
  total_distance REAL NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE (period_type, period_start, period_end)
);
`;

export class ValidationError extends Error {}

const round1 = (n) => Math.round(n * 10) / 10;

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

/** Validates and normalises a trip payload. Returns the row to store. */
export function normaliseTrip(input) {
  const category = input.category;
  if (!CATEGORIES[category]) throw new ValidationError('category must be personal or business');
  const tripType = input.trip_type;
  if (!CATEGORIES[category].includes(tripType)) {
    throw new ValidationError(`trip_type must be one of: ${CATEGORIES[category].join(', ')}`);
  }

  const startOdo = toNumber(input.start_odo, 'Start odometer', { required: true });
  const endOdo = toNumber(input.end_odo, 'End odometer');
  if (endOdo !== null && endOdo < startOdo) {
    throw new ValidationError('End odometer cannot be lower than start odometer');
  }

  const startAt = toIso(input.start_at, 'Start date/time', { required: true });
  const endAt = toIso(input.end_at, 'End date/time') ?? (endOdo !== null ? startAt : null);
  if (endAt && endAt < startAt) throw new ValidationError('End time cannot be before start time');
  if (endOdo === null && input.end_at) throw new ValidationError('End odometer is required to finish a trip');

  const isBusiness = category === 'business';
  const purpose = text(input.purpose);
  const betweenClients = isBusiness && Boolean(input.between_clients);
  const fromClient = betweenClients ? text(input.from_client) : '';
  const toClient = betweenClients ? text(input.to_client) : '';
  if (isBusiness && !purpose && !betweenClients) {
    throw new ValidationError('Business trips need a purpose or client name');
  }
  if (betweenClients && (!fromClient || !toClient)) {
    throw new ValidationError('Enter both the "from" and "to" client for travel between clients');
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
    between_clients: betweenClients ? 1 : 0,
    from_client: fromClient,
    to_client: toClient,
    notes: text(input.notes),
    start_odo_manual: input.start_odo_manual ? 1 : 0,
  };
}

const FIELDS = [
  'start_at', 'end_at', 'start_odo', 'end_odo', 'distance', 'category', 'trip_type', 'purpose',
  'between_clients', 'from_client', 'to_client', 'notes', 'start_odo_manual',
];

const plain = (row) => (row ? { ...row } : null);

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  getTrip(id) {
    return plain(this.db.prepare('SELECT * FROM trips WHERE id = ?').get(id));
  }

  listTrips({ limit = 200, offset = 0 } = {}) {
    return this.db
      .prepare('SELECT * FROM trips ORDER BY start_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, offset)
      .map(plain);
  }

  allCompletedTrips() {
    return this.db
      .prepare('SELECT * FROM trips WHERE end_odo IS NOT NULL ORDER BY start_at ASC, id ASC')
      .all()
      .map(plain);
  }

  countTrips() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM trips').get().n;
  }

  activeTrip() {
    return plain(
      this.db.prepare('SELECT * FROM trips WHERE end_odo IS NULL ORDER BY start_at DESC LIMIT 1').get(),
    );
  }

  /** End odometer of the most recent finished trip (optionally ignoring one trip being edited). */
  lastEndOdo(excludeId = null) {
    const row = this.db
      .prepare(
        `SELECT end_odo FROM trips WHERE end_odo IS NOT NULL AND id IS NOT ?
         ORDER BY start_at DESC, id DESC LIMIT 1`,
      )
      .get(excludeId);
    return row ? row.end_odo : null;
  }

  /** Non-blocking warnings about odometer continuity. */
  odoWarnings(trip, excludeId = null) {
    const warnings = [];
    const last = this.lastEndOdo(excludeId);
    if (last === null) return warnings;
    if (trip.start_odo < last) {
      warnings.push(`Start odometer is ${round1(last - trip.start_odo)} below the last trip's end (${last}).`);
    } else if (trip.start_odo > last) {
      warnings.push(`${round1(trip.start_odo - last)} unlogged since the last trip ended at ${last}.`);
    }
    return warnings;
  }

  createTrip(input) {
    const trip = normaliseTrip(input);
    if (trip.end_odo === null && this.activeTrip()) {
      throw new ValidationError('A trip is already in progress. End it before starting another.');
    }
    const warnings = this.odoWarnings(trip);
    const now = new Date().toISOString();
    const cols = [...FIELDS, 'created_at', 'updated_at'];
    const result = this.db
      .prepare(`INSERT INTO trips (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...FIELDS.map((f) => trip[f]), now, now);
    return { trip: this.getTrip(Number(result.lastInsertRowid)), warnings };
  }

  updateTrip(id, input) {
    const existing = this.getTrip(id);
    if (!existing) return null;
    const trip = normaliseTrip({ ...existing, ...input });
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE trips SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...FIELDS.map((f) => trip[f]), now, id);
    return { trip: this.getTrip(id), warnings: [] };
  }

  endTrip(id, { end_odo, end_at, distance }) {
    const existing = this.getTrip(id);
    if (!existing) return null;
    let endOdo = end_odo;
    if ((endOdo === undefined || endOdo === null || endOdo === '') && distance !== undefined && distance !== '') {
      endOdo = existing.start_odo + Number(distance);
    }
    return this.updateTrip(id, { end_odo: endOdo, end_at: end_at || new Date().toISOString() });
  }

  deleteTrip(id) {
    return this.db.prepare('DELETE FROM trips WHERE id = ?').run(id).changes > 0;
  }

  listReports() {
    return this.db
      .prepare('SELECT * FROM reports ORDER BY period_start DESC, period_type ASC, id DESC')
      .all()
      .map(plain);
  }

  getReport(id) {
    return plain(this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id));
  }

  findReport(type, start, end) {
    return plain(
      this.db
        .prepare('SELECT * FROM reports WHERE period_type = ? AND period_start = ? AND period_end = ?')
        .get(type, start, end),
    );
  }

  saveReport(r) {
    this.db
      .prepare(
        `INSERT INTO reports (period_type, period_start, period_end, label, csv_path, xlsx_path,
           trip_count, total_distance, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (period_type, period_start, period_end) DO UPDATE SET
           label = excluded.label, csv_path = excluded.csv_path, xlsx_path = excluded.xlsx_path,
           trip_count = excluded.trip_count, total_distance = excluded.total_distance,
           generated_at = excluded.generated_at`,
      )
      .run(r.period_type, r.period_start, r.period_end, r.label, r.csv_path, r.xlsx_path,
        r.trip_count, r.total_distance, r.generated_at);
    return this.findReport(r.period_type, r.period_start, r.period_end);
  }
}
