import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { TRIP_TYPE_LABELS } from './db.js';
import { lastCompletedPeriod, localDate, localTime, periodLabel } from './periods.js';

export const PERIOD_TYPES = ['weekly', 'monthly', 'quarterly'];

const round1 = (n) => Math.round(n * 10) / 10;

export function tripsInRange(trips, start, end, timeZone) {
  return trips.filter((t) => {
    const day = localDate(t.start_at, timeZone);
    return day >= start && day <= end;
  });
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

const COLUMNS = [
  ['date', 'Date'], ['start_time', 'Start time'], ['end_date', 'End date'], ['end_time', 'End time'],
  ['category', 'Category'], ['type', 'Type'], ['purpose', 'Purpose / client'],
  ['between_clients', 'Between clients'], ['start_odo', 'Start odometer'], ['end_odo', 'End odometer'],
  ['distance', 'Distance'], ['notes', 'Notes'],
];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote when needed; prefix formula-like text so spreadsheets don't execute it.
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function summaryLines(summary, unit) {
  return [
    ['Total trips', summary.trips],
    [`Total distance (${unit})`, summary.total],
    [`Business (${unit})`, summary.business],
    [`  TFN (${unit})`, summary.tfn],
    [`  ABN (${unit})`, summary.abn],
    [`  Between clients (${unit})`, summary.betweenClients],
    [`Personal (${unit})`, summary.personal],
    ['Business use %', summary.businessPercent],
  ];
}

export function toCsv({ title, rows, summary, unit }) {
  const lines = [csvCell(title), ''];
  lines.push(COLUMNS.map(([, h]) => csvCell(h === 'Distance' ? `Distance (${unit})` : h)).join(','));
  for (const r of rows) lines.push(COLUMNS.map(([k]) => csvCell(r[k])).join(','));
  lines.push('', 'Summary');
  for (const [k, v] of summaryLines(summary, unit)) lines.push(`${csvCell(k)},${csvCell(v)}`);
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel reads UTF-8 (→, accents) correctly
}

export async function writeXlsx(file, { title, rows, summary, unit }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mileage Logbook';
  const ws = wb.addWorksheet('Logbook', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([]);
  const header = ws.addRow(COLUMNS.map(([, h]) => (h === 'Distance' ? `Distance (${unit})` : h)));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  for (const r of rows) ws.addRow(COLUMNS.map(([k]) => r[k]));
  const widths = [12, 10, 12, 10, 11, 18, 44, 15, 15, 15, 12, 30];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  [9, 10, 11].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.0'; });

  const s = wb.addWorksheet('Summary');
  s.addRow([title]).font = { bold: true, size: 14 };
  s.addRow([]);
  for (const line of summaryLines(summary, unit)) s.addRow(line);
  s.getColumn(1).width = 28;
  s.getColumn(2).width = 14;
  await wb.xlsx.writeFile(file);
}

/** Builds CSV + XLSX for a date range and records it in the reports table. */
export async function generateReport(store, config, type, start, end, now = new Date()) {
  const label = periodLabel(type, start, end);
  const trips = tripsInRange(store.allCompletedTrips(), start, end, config.timezone);
  const rows = buildRows(trips, config.timezone);
  const summary = summarise(trips);
  const title = `Mileage logbook – ${label}`;

  const dir = path.join(config.reportsDir, type);
  fs.mkdirSync(dir, { recursive: true });
  const base = `mileage-${type}-${start}_to_${end}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const xlsxPath = path.join(dir, `${base}.xlsx`);
  const data = { title, rows, summary, unit: config.unit };
  fs.writeFileSync(csvPath, toCsv(data));
  await writeXlsx(xlsxPath, data);

  return store.saveReport({
    period_type: type,
    period_start: start,
    period_end: end,
    label,
    csv_path: csvPath,
    xlsx_path: xlsxPath,
    trip_count: summary.trips,
    total_distance: summary.total,
    generated_at: now.toISOString(),
  });
}

/**
 * Generates any weekly/monthly/quarterly report whose period has finished but has no file yet.
 * Safe to call repeatedly: it runs at midnight and on startup to catch up after downtime.
 */
export async function runDueReports(store, config, now = new Date()) {
  if (store.countTrips() === 0) return [];
  const today = localDate(now, config.timezone);
  const created = [];
  for (const type of PERIOD_TYPES) {
    const { start, end } = lastCompletedPeriod(type, today);
    if (!store.findReport(type, start, end)) {
      created.push(await generateReport(store, config, type, start, end, now));
    }
  }
  return created;
}
