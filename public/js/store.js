// Trip and report storage. Works over any adapter with getAll/put/delete/clear —
// IndexedDB on the phone (see idb.js), an in-memory one in tests.
import {
  ValidationError, activeTrip, duePeriods, lastEndOdo, logbookPeriod, makeReport, normaliseTrip, odoWarnings,
} from './logic.js';
import { localDate } from './periods.js';

export class Store {
  constructor(adapter, { timeZone }) {
    this.adapter = adapter;
    this.timeZone = timeZone;
    this.trips = [];
    this.reports = [];
    this.meta = {};
  }

  async load() {
    this.trips = await this.adapter.getAll('trips');
    this.reports = await this.adapter.getAll('reports');
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
    const report = makeReport(this.trips, type, start, end, this.timeZone, now, this.meta.car);
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
    return { app: 'mileage-logbook', version: 1, exported_at: new Date().toISOString(), trips: this.trips, reports: this.reports };
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
    return this.load();
  }
}

/** Simple in-memory adapter (tests, and fallback if IndexedDB is unavailable). */
export function memoryAdapter() {
  const stores = { trips: new Map(), reports: new Map(), meta: new Map() };
  const seq = { trips: 0, reports: 0 };
  return {
    async getAll(name) {
      return [...stores[name].values()].map((v) => structuredClone(v));
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
