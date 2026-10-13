// Turns a stored report into a CSV or Excel file and hands it to the phone
// (share sheet: Save to Files, Mail, Drive…) or downloads it on a computer.
import { COLUMNS, csvCell, fileBase, summaryLines, toCsv } from './logic.js';
import {
  EXPENSE_COLUMNS, expenseReportCsvLines, expensesCsvLines, expensesInRange, expenseSummaryLines, receiptName,
} from './expenses.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
const styleHeader = (row) => { row.font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.fill = HEADER_FILL; };

/** Stand-alone expense report: by category, every expense, and the Personal/ABN/TFN split at the end. */
async function expenseXlsxBlob(report) {
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Mileage Logbook';
  const s = report.expenses.summary;
  const ws = wb.addWorksheet('Expense report');
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([`Period covered: ${report.period_start} to ${report.period_end}`]).font = { italic: true };
  const car = report.car;
  if (car) ws.addRow([`Car: ${[car.make, car.model].filter(Boolean).join(' ')} · Rego ${car.rego || '-'}`]);
  ws.addRow([]);
  ws.addRow(['By category']).font = { bold: true, size: 12 };
  styleHeader(ws.addRow(['Category', 'Car-related', 'Items', 'Amount', '% of total']));
  for (const c of s.categories) ws.addRow([c.label, c.car ? 'Yes' : 'No', c.count, c.amount, c.pct / 100]);
  ws.addRow(['Total expenses', '', s.count, s.total, s.total ? 1 : 0]).font = { bold: true };
  ws.addRow([]);
  ws.addRow([`Split of car-related expenses (by mileage)`]).font = { bold: true, size: 12 };
  styleHeader(ws.addRow(['', '', '', 'Amount', '% of car-related']));
  ws.addRow(['Personal', '', '', s.split.personal.amount, s.split.personal.pct / 100]);
  ws.addRow(['ABN', '', '', s.split.abn.amount, s.split.abn.pct / 100]);
  ws.addRow(['TFN', '', '', s.split.tfn.amount, s.split.tfn.pct / 100]);
  ws.addRow(['Total car-related', '', '', s.carTotal, s.carTotal ? 1 : 0]).font = { bold: true };
  ws.addRow([`Based on ${s.businessUse}% business use (${s.businessUseSource}); business part split ABN ${s.abnShare}% / TFN ${Math.round((100 - s.abnShare) * 10) / 10}% by business km.`]).font = { italic: true, color: { argb: 'FF5F6B7A' } };
  if (s.nonCarTotal) {
    ws.addRow([]);
    ws.addRow(['Not car-related (not split)']).font = { bold: true, size: 12 };
    styleHeader(ws.addRow(['Category', '', 'Items', 'Amount', '']));
    for (const c of s.categories.filter((x) => !x.car)) ws.addRow([c.label, '', c.count, c.amount]);
    ws.addRow(['Total not car-related', '', '', s.nonCarTotal]).font = { bold: true };
  }
  ws.addRow([]);
  ws.addRow(['TOTAL EXPENSES', '', s.count, s.total]).font = { bold: true, size: 12 };
  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 8;
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 16;
  ws.getColumn(4).numFmt = '$#,##0.00';
  ws.getColumn(5).numFmt = '0.0%';

  const x = wb.addWorksheet('All expenses', { views: [{ state: 'frozen', ySplit: 2 }] });
  x.addRow([`${report.title} (period covered: ${report.period_start} to ${report.period_end})`]).font = { bold: true };
  styleHeader(x.addRow(EXPENSE_COLUMNS.map(([, l]) => l)));
  for (const r of report.expenses.rows) x.addRow(EXPENSE_COLUMNS.map(([k]) => r[k]));
  [12, 20, 12, 22, 12, 12, 44, 30].forEach((w, i) => { x.getColumn(i + 1).width = w; });
  x.getColumn(5).numFmt = '$#,##0.00';
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_TYPE });
}

async function xlsxBlob(report) {
  if (report.period_type === 'expenses') return expenseXlsxBlob(report);
  const { ExcelJS } = window;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mileage Logbook';
  const ws = wb.addWorksheet('Logbook', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  const car = report.car;
  ws.addRow([car ? `Car: ${[car.make, car.model].filter(Boolean).join(' ')} · ${car.engine || '-'} · Rego ${car.rego || '-'}` : '']);
  const header = ws.addRow(COLUMNS.map(([, h]) => h));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  for (const r of report.rows) ws.addRow(COLUMNS.map(([k]) => r[k]));
  [12, 10, 12, 10, 11, 18, 44, 15, 15, 15, 14, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  [9, 10, 11].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.0'; });

  const s = wb.addWorksheet('Summary');
  s.addRow([report.title]).font = { bold: true, size: 14 };
  s.addRow([]);
  for (const line of summaryLines(report)) s.addRow(line);
  s.getColumn(1).width = 34;
  s.getColumn(2).width = 28;

  if (report.expenses) {
    const x = wb.addWorksheet('Expenses', { views: [{ state: 'frozen', ySplit: 2 }] });
    x.addRow([`Expenses – ${report.label}`]).font = { bold: true, size: 14 };
    const h = x.addRow(EXPENSE_COLUMNS.map(([, l]) => l));
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
    for (const r of report.expenses.rows) x.addRow(EXPENSE_COLUMNS.map(([k]) => r[k]));
    [12, 20, 12, 22, 12, 12, 44, 30].forEach((w, i) => { x.getColumn(i + 1).width = w; });
    x.getColumn(5).numFmt = '$#,##0.00';
    s.addRow([]);
    s.addRow(['Expenses']).font = { bold: true, size: 12 };
    for (const line of expenseSummaryLines(report.expenses.summary)) s.addRow(line);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export async function reportFile(report, format) {
  const name = `${report.period_type === 'expenses' ? `expense-report-${report.period_start}_to_${report.period_end}` : fileBase(report)}.${format}`;
  const csvText = report.period_type === 'expenses'
    ? `\uFEFF${expenseReportCsvLines(report, csvCell).join('\r\n')}\r\n`
    : toCsv(report) + expensesCsvLines(report, csvCell).map((l) => `${l}\r\n`).join('');
  const blob = format === 'csv'
    ? new Blob([csvText], { type: 'text/csv' })
    : await xlsxBlob(report);
  return new File([blob], name, { type: blob.type });
}

/** Opens the share sheet where supported (phones), otherwise downloads. */
export async function deliver(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

// ---------- zip files (receipts, backup, tax pack) ----------

const zipBlob = (zip) => zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });

/** Adds the receipt photos of the expenses in a report's period to a zip folder. Returns how many. */
async function addReceipts(zip, store, start, end, folder = '') {
  let n = 0;
  for (const e of expensesInRange(store.expenses, start, end)) {
    if (!e.photo_id) continue;
    const photo = await store.getPhoto(e.photo_id);
    if (!photo) continue;
    zip.file(`${folder}${receiptName(e)}`, photo.data);
    n += 1;
  }
  return n;
}

export function countReceipts(store, start, end) {
  return expensesInRange(store.expenses, start, end).filter((e) => e.photo_id).length;
}

export async function receiptsZip(store, report) {
  const zip = new window.JSZip();
  await addReceipts(zip, store, report.period_start, report.period_end);
  return new File([await zipBlob(zip)], `receipts-${report.period_start}_to_${report.period_end}.zip`, { type: 'application/zip' });
}

/** Everything on this phone: data.json plus receipt photos. */
export async function backupZip(store, name) {
  const zip = new window.JSZip();
  zip.file('data.json', JSON.stringify(store.exportData(), null, 1));
  const photos = await store.allPhotos();
  for (const p of photos) zip.file(`photos/${p.id}.jpg`, p.data);
  return new File([await zipBlob(zip)], name, { type: 'application/zip' });
}

/** Reads a backup (.zip with photos, or an older .json) → { data, photos: [{id, type, data}] }. */
export async function readBackup(file) {
  if (/\.json$/i.test(file.name) || file.type === 'application/json') {
    return { data: JSON.parse(await file.text()), photos: [] };
  }
  const zip = await window.JSZip.loadAsync(file);
  const json = zip.file('data.json');
  if (!json) throw new Error('That file is not a Mileage Logbook backup');
  const data = JSON.parse(await json.async('string'));
  const photos = [];
  for (const f of zip.file(/^photos\/\d+\.jpg$/)) {
    photos.push({ id: Number(f.name.match(/(\d+)\.jpg$/)[1]), type: 'image/jpeg', data: await f.async('arraybuffer') });
  }
  return { data, photos };
}

/**
 * Tax-time bundle for a financial year: mileage + expenses workbook, the ATO logbook in use,
 * a short summary and every receipt photo — ready to send to an accountant.
 */
export async function taxPack(store, fyReport, logbook) {
  const zip = new window.JSZip();
  const fy = fyReport.label.split(' ')[0]; // e.g. FY2025-26
  zip.file(`${fy} mileage and expenses.xlsx`, await xlsxBlob(fyReport));
  if (logbook) zip.file(`ATO logbook ${logbook.period_start} to ${logbook.period_end}.xlsx`, await xlsxBlob(logbook));
  const n = await addReceipts(zip, store, fyReport.period_start, fyReport.period_end, 'Receipts/');
  const s = fyReport.summary;
  const x = fyReport.expenses?.summary;
  const lines = [
    `Tax pack – ${fyReport.label}`,
    `Made ${new Date().toLocaleString()}`,
    '',
    'MILEAGE',
    ...summaryLines(fyReport).map(([k, v]) => `${k}: ${v}`),
    '',
    logbook
      ? `ATO logbook: ${logbook.period_start} to ${logbook.period_end}, business-use ${logbook.logbook.businessUsePercent}%${logbook.logbook.inProgress ? ' (still in progress)' : ''}`
      : 'ATO logbook: none created yet — the logbook method needs a 12-week logbook.',
    '',
    'EXPENSES',
    ...(x ? expenseSummaryLines(x).map(([k, v]) => `${k}: ${v}`) : ['No expenses']),
    '',
    `Receipt photos included: ${n}`,
    `Trips: ${s.trips} · Business ${s.businessPercent}% (ABN ${s.abnPercent}% / TFN ${s.tfnPercent}%) · Personal ${s.personalPercent}%`,
    '',
    'Estimates only — your accountant decides what is claimable.',
  ];
  zip.file('Summary.txt', lines.join('\r\n'));
  return new File([await zipBlob(zip)], `Tax pack ${fy}.zip`, { type: 'application/zip' });
}
