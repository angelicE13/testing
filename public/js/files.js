// Turns a stored report into a CSV or Excel file and hands it to the phone
// (share sheet: Save to Files, Mail, Drive…) or downloads it on a computer.
import { COLUMNS, fileBase, summaryLines, toCsv } from './logic.js';

async function xlsxBlob(report) {
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
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export async function reportFile(report, format) {
  const name = `${fileBase(report)}.${format}`;
  const blob = format === 'csv'
    ? new Blob([toCsv(report)], { type: 'text/csv' })
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
