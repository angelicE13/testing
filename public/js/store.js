// Trip and report storage. Works over any adapter with getAll/put/delete/clear —
// IndexedDB on the phone (see idb.js), an in-memory one in tests.
import {
  ValidationError, activeTrip, duePeriods, lastEndOdo, logbookPeriod, makeReport, normaliseTrip, odoWarnings,
} from './logic.js';
import { addDays, localDate } from './periods.js';
import { attachExpenses, normaliseExpense } from './expenses.js';

export class Store {
  constructor(adapter, { timeZone }) {
    this.adapter = adapter;
    this.timeZone = timeZone;
    this.trips = [];
    this.reports = [];
    this.expenses = [];
    this.meta = {};
  }

  async load() {
    this.trips = await this.adapter.getAll('trips');
    this.reports = await this.adapter.getAll('reports');
    this.expenses = await this.adapter.getAll('expenses');
    this.meta = Object.fromEntries((await this.adapter.getAll('meta')).map((m) => [m.key, m.value]));
    return this;
  }

  async setMeta(key, value) {
    this.meta[key] = value;
    await this.adapter.put('meta', { key, value });
  }

  getTrip(id) {
    return this.trips.find((t) => t.id === id) || null;
  }

  activeTrip() {
    return activeTrip(this.trips);
  }

  lastEndOdo(excludeId = null) {
    return lastEndOdo(this.trips, excludeId);
  }

  async createTrip(input) {
    const trip = normaliseTrip(input);
    if (trip.end_odo === null && this.activeTrip()) {
      throw new ValidationError('A trip is already in progress. End it before starting another.');
    }
    const warnings = odoWarnings(this.trips, trip.start_odo);
    const now = new Date().toISOString();
    const row = { ...trip, created_at: now, updated_at: now };
    row.id = await this.adapter.put('trips', row);
    this.trips.push(row);
    return { trip: row, warnings };
  }

  async updateTrip(id, input) {
    const existing = this.getTrip(id);
    if (!existing) throw new ValidationError('Trip not found');
    const row = { ...existing, ...normaliseTrip({ ...existing, ...input }), updated_at: new Date().toISOString() };
    await this.adapter.put('trips', row);
    this.trips[this.trips.indexOf(existing)] = row;
    return { trip: row, warnings: [] };
  }

  /** Finish a trip from either the end odometer or the distance travelled. */
  async endTrip(id, { end_odo, end_at, distance }) {
    const existing = this.getTrip(id);
    if (!existing) throw new ValidationError('Trip not found');
    let endOdo = end_odo;
    if ((endOdo === undefined || endOdo === null || endOdo === '') && distance !== undefined && distance !== '') {
      endOdo = existing.start_odo + Number(distance);
    }
    if (endOdo === undefined || endOdo === null || endOdo === '') {
      throw new ValidationError('Enter the end odometer or distance');
    }
    return this.updateTrip(id, { end_odo: endOdo, end_at: end_at || new Date().toISOString() });
  }

  /** Put back a trip that was just deleted (Undo). */
  async restoreTrip(trip) {
    await this.adapter.put('trips', trip);
    this.trips = [...this.trips.filter((t) => t.id !== trip.id), trip];
  }

  /** Deletes every trip and report on this device (car details and settings are kept). */
  async clearAll() {
    await this.adapter.clear('trips');
    await this.adapter.clear('reports');
    this.trips = [];
    this.reports = [];
  }

  async deleteTrip(id) {
    await this.adapter.delete('trips', id);
    this.trips = this.trips.filter((t) => t.id !== id);
  }

  // ---------- reports ----------

  async generateReport(type, start, end, now = new Date()) {
    const logbook = this.latestLogbook(end);
    const report = makeReport(this.trips, type, start, end, this.timeZone, now, this.meta.car, {
      addExpenses: (r) => attachExpenses(r, this.expenses, logbook),
    });
    const existing = this.reports.find(
      (r) => r.period_type === type && r.period_start === start && r.period_end === end,
    );
    if (existing) report.id = existing.id;
    report.id = await this.adapter.put('reports', report);
    this.reports = [...this.reports.filter((r) => r.id !== report.id), report];
    return report;
  }

  /** Creates every weekly/monthly/quarterly report whose period has finished. Safe to call often. */
  async generateDue(now = new Date()) {
    const today = localDate(now, this.timeZone);
    const created = [];
    for (const p of duePeriods(this.trips, this.reports, today, this.timeZone)) {
      created.push(await this.generateReport(p.type, p.start, p.end, now));
    }
    return created;
  }

  /** Most recent ATO logbook that applies to a period ending on `end` (a logbook is valid for 5 years). */
  latestLogbook(end) {
    const fiveYears = addDays(end, -5 * 365);
    const list = this.reports
      .filter((r) => r.period_type === 'logbook' && r.logbook && r.period_start <= end && r.period_end >= fiveYears)
      .sort((a, b) => (a.logbook.inProgress - b.logbook.inProgress) || (a.period_start < b.period_start ? 1 : -1));
    return list[0] || null;
  }

  // ---------- expenses ----------

  getExpense(id) {
    return this.expenses.find((e) => e.id === id) || null;
  }

  async createExpense(input) {
    const now = new Date().toISOString();
    const row = { ...normaliseExpense(input), created_at: now, updated_at: now };
    row.id = await this.adapter.put('expenses', row);
    this.expenses.push(row);
    return row;
  }

  async updateExpense(id, input) {
    const existing = this.getExpense(id);
    if (!existing) throw new ValidationError('Expense not found');
    const row = { ...existing, ...normaliseExpense({ ...existing, ...input }), updated_at: new Date().toISOString() };
    if (existing.photo_id && existing.photo_id !== row.photo_id) await this.deletePhoto(existing.photo_id);
    await this.adapter.put('expenses', row);
    this.expenses[this.expenses.indexOf(existing)] = row;
    return row;
  }

  /** Deletes the expense but keeps its photo, so Undo can bring both back. */
  async deleteExpense(id) {
    await this.adapter.delete('expenses', id);
    this.expenses = this.expenses.filter((e) => e.id !== id);
  }

  async restoreExpense(expense) {
    await this.adapter.put('expenses', expense);
    this.expenses = [...this.expenses.filter((e) => e.id !== expense.id), expense];
  }

  /** Receipt photos are stored as { id, type, data: ArrayBuffer }. */
  async savePhoto(data, type = 'image/jpeg') {
    return this.adapter.put('photos', { type, data });
  }

  getPhoto(id) {
    return this.adapter.get('photos', id);
  }

  async deletePhoto(id) {
    await this.adapter.delete('photos', id);
  }

  allPhotos() {
    return this.adapter.getAll('photos');
  }

  /** Replaces all receipt photos (when restoring a backup). */
  async replacePhotos(photos) {
    await this.adapter.clear('photos');
    for (const p of photos) await this.adapter.put('photos', p);
  }

  /** Removes photos no expense points to (e.g. after deleting an expense). */
  async prunePhotos() {
    const used = new Set(this.expenses.map((e) => e.photo_id).filter(Boolean));
    for (const p of await this.allPhotos()) if (!used.has(p.id)) await this.deletePhoto(p.id);
  }

  // ---------- clients ----------

  /** Renames a client on every trip. Renaming to an existing name merges the two. */
  async renameClient(from, to) {
    const name = String(to || '').trim();
    if (!name) throw new ValidationError('Enter the new name');
    const same = (v) => v && v.trim().toLowerCase() === from.trim().toLowerCase();
    for (const t of this.trips) {
      const change = {};
      if (same(t.purpose)) change.purpose = name;
      if (same(t.from_client)) change.from_client = name;
      if (same(t.to_client)) change.to_client = name;
      if (Object.keys(change).length) {
        Object.assign(t, change, { updated_at: new Date().toISOString() });
        await this.adapter.put('trips', t);
      }
    }
  }

  /** ATO 12-week logbook starting on the given date (can be made while still in progress). */
  async generateLogbook(start, now = new Date()) {
    const { end } = logbookPeriod(start);
    return this.generateReport('logbook', start, end, now);
  }

  async saveCar(car) {
    const clean = Object.fromEntries(['make', 'model', 'engine', 'rego'].map((k) => [k, String(car[k] || '').trim().slice(0, 60)]));
    await this.setMeta('car', clean);
    return clean;
  }

  async regenerate(id) {
    const r = this.reports.find((x) => x.id === id);
    if (!r) throw new ValidationError('Report not found');
    return this.generateReport(r.period_type, r.period_start, r.period_end);
  }

  async deleteReport(id) {
    await this.adapter.delete('reports', id);
    this.reports = this.reports.filter((r) => r.id !== id);
  }

  listReports() {
    const order = { weekly: 0, monthly: 1, quarterly: 2, financial_year: 3, logbook: 4, custom: 5 };
    return [...this.reports].sort((a, b) => (a.period_end < b.period_end ? 1 : a.period_end > b.period_end ? -1
      : order[a.period_type] - order[b.period_type]));
  }

  // ---------- backup ----------

  exportData() {
    return {
      app: 'mileage-logbook', version: 2, exported_at: new Date().toISOString(),
      trips: this.trips, reports: this.reports, expenses: this.expenses, car: this.meta.car || null,
    };
  }

  /** Replaces everything on this phone with a backup file's contents. */
  async importData(data) {
    if (!data || data.app !== 'mileage-logbook' || !Array.isArray(data.trips)) {
      throw new ValidationError('That file is not a Mileage Logbook backup');
    }
    data.trips.forEach((t) => normaliseTrip(t)); // reject a corrupt file before wiping anything
    await this.adapter.clear('trips');
    await this.adapter.clear('reports');
    for (const t of data.trips) await this.adapter.put('trips', t);
    for (const r of data.reports || []) await this.adapter.put('reports', r);
    if (Array.isArray(data.expenses)) {
      await this.adapter.clear('expenses');
      for (const e of data.expenses) await this.adapter.put('expenses', e);
    }
    if (data.car) await this.setMeta('car', data.car);
    return this.load();
  }
}

/** Simple in-memory adapter (tests, and fallback if IndexedDB is unavailable). */
export function memoryAdapter() {
  const stores = { trips: new Map(), reports: new Map(), meta: new Map(), expenses: new Map(), photos: new Map() };
  const seq = { trips: 0, reports: 0, expenses: 0, photos: 0 };
  return {
    async getAll(name) {
      return [...stores[name].values()].map((v) => structuredClone(v));
    },
    async get(name, key) {
      const v = stores[name].get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(name, value) {
      const key = name === 'meta' ? value.key : value.id ?? ++seq[name];
      if (name !== 'meta') seq[name] = Math.max(seq[name], key);
      stores[name].set(key, structuredClone({ ...value, ...(name === 'meta' ? {} : { id: key }) }));
      return key;
    },
    async delete(name, key) {
      stores[name].delete(key);
    },
    async clear(name) {
      stores[name].clear();
    },
  };
}
