// Expense logic: categories, validation and the claimable estimate. No browser APIs.
//
// Every expense is shared by how the car is used: the claimable part is the business-use %
// (from the ATO logbook, or the trips while there is no logbook yet), and that part is split
// between ABN and TFN by business km.
import { ValidationError, round1 } from './logic.js';

// group only sets the colour and the History filter.
export const EXPENSE_CATEGORIES = [
  { key: 'fuel', label: 'Petrol', group: 'car' },
  { key: 'service', label: 'Service', group: 'car', odometer: true },
  { key: 'repairs', label: 'Repairs', group: 'car', odometer: true },
  { key: 'parts', label: 'Parts', group: 'car', odometer: true },
  { key: 'tyres', label: 'Tyres', group: 'car', odometer: true },
  { key: 'car_wash', label: 'Car wash', group: 'car' },
  { key: 'registration', label: 'Registration', group: 'car' },
  { key: 'insurance', label: 'Insurance', group: 'car' },
  { key: 'tolls_parking', label: 'Tolls & parking', group: 'travel' },
  { key: 'clothing', label: 'Clothing / uniform', group: 'clothing' },
  { key: 'laundry', label: 'Laundry', group: 'clothing' },
  { key: 'other', label: 'Other', group: 'other' }, // the name is typed in (category_label)
];
export const CATEGORY = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, c]));

/** Display name of an expense's category ("Other" expenses carry their own name). */
export const categoryLabel = (e) => (e.category === 'other' && e.category_label ? e.category_label : CATEGORY[e.category]?.label || e.category);

const round2 = (n) => Math.round(n * 100) / 100;
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function normaliseExpense(input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Enter the amount');
  const cat = CATEGORY[input.category];
  if (!cat) throw new ValidationError('Choose a category');
  const label = cat.key === 'other' ? text(input.category_label, 40) : '';
  if (cat.key === 'other' && !label) throw new ValidationError('Type what the expense is for');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new ValidationError('Choose the date');
  const odo = input.odometer === '' || input.odometer === null || input.odometer === undefined ? null : Number(input.odometer);
  if (odo !== null && (!Number.isFinite(odo) || odo < 0)) throw new ValidationError('Odometer must be a positive number');
  return {
    date: input.date,
    amount: round2(amount),
    category: cat.key,
    category_label: label,
    supplier: text(input.supplier),
    notes: text(input.notes),
    odometer: odo === null ? null : round1(odo),
    photo_id: input.photo_id ?? null,
  };
}

export function expensesInRange(expenses, start, end) {
  return expenses.filter((e) => e.date >= start && e.date <= end).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
}

/**
 * Totals and the claimable estimate.
 * businessUse: % of car use that is business; abnShare: % of business km that is ABN.
 */
export function summariseExpenses(expenses, { businessUse = 0, abnShare = 0 } = {}) {
  const total = round2(expenses.reduce((a, e) => a + e.amount, 0));
  const byCategory = {};
  for (const e of expenses) {
    const k = categoryLabel(e);
    byCategory[k] = round2((byCategory[k] || 0) + e.amount);
  }
  const claimableTotal = round2((total * businessUse) / 100);
  const abn = round2((claimableTotal * abnShare) / 100);
  const tfn = round2(claimableTotal - abn);
  const pctOfTotal = (amount) => (total ? round1((amount / total) * 100) : 0);
  const categories = Object.entries(byCategory)
    .map(([label, amount]) => ({ label, amount, count: expenses.filter((e) => categoryLabel(e) === label).length, pct: pctOfTotal(amount) }))
    .sort((a, b) => b.amount - a.amount);
  const abnPct = round1((businessUse * abnShare) / 100);
  return {
    count: expenses.length,
    total,
    byCategory,
    categories,
    businessUse,
    abnShare,
    claimableTotal,
    claimable: { abn, tfn },
    // How the total splits by car use: personal = 100 − business-use %; business split ABN/TFN by km.
    split: {
      personal: { pct: round1(100 - businessUse), amount: round2(total - claimableTotal) },
      abn: { pct: abnPct, amount: abn },
      tfn: { pct: round1(businessUse - abnPct), amount: tfn },
    },
  };
}

export function expenseRows(expenses) {
  return expenses.map((e) => ({
    date: e.date,
    category: categoryLabel(e),
    supplier: e.supplier,
    amount: e.amount,
    odometer: e.odometer ?? '',
    receipt: e.photo_id ? receiptName(e) : '',
    notes: e.notes,
  }));
}

export const EXPENSE_COLUMNS = [
  ['date', 'Date'], ['category', 'Category'], ['supplier', 'Supplier'], ['amount', 'Amount ($)'],
  ['odometer', 'Odometer'], ['receipt', 'Receipt photo'], ['notes', 'Notes'],
];

const money = (n) => `$${n.toFixed(2)}`;

export function expenseSummaryLines(s) {
  const lines = [['Total spent', money(s.total)]];
  for (const [label, amount] of Object.entries(s.byCategory)) lines.push([`  ${label}`, money(amount)]);
  lines.push(
    ['Business-use % applied', `${s.businessUse}%${s.businessUseSource ? ` (${s.businessUseSource})` : ''}`],
    ['Estimated claimable', money(s.claimableTotal)],
    ['  ABN (by business km)', `${money(s.claimable.abn)} (${s.abnShare}%)`],
    ['  TFN (by business km)', `${money(s.claimable.tfn)} (${round1(100 - s.abnShare)}%)`],
    ...splitLines(s),
  );
  return lines;
}

/** End-of-report split of the total: Personal / ABN / TFN, as % and $. */
export function splitLines(s) {
  return [
    ['Split of total expenses', money(s.total)],
    ['  Personal', `${s.split.personal.pct}% · ${money(s.split.personal.amount)}`],
    ['  ABN', `${s.split.abn.pct}% · ${money(s.split.abn.amount)}`],
    ['  TFN', `${s.split.tfn.pct}% · ${money(s.split.tfn.amount)}`],
  ];
}

const safe = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** File name for a receipt photo, e.g. 2026-10-14_Petrol_BP_45.20_12.jpg */
export function receiptName(e) {
  return [e.date, safe(categoryLabel(e)), safe(e.supplier), e.amount.toFixed(2)].filter(Boolean).join('_') + `_${e.id}.jpg`;
}

/** Suppliers used before (for the category, if given), most recent first. */
export function recentSuppliers(expenses, category = null, limit = 6) {
  return recent(expenses.filter((e) => !category || e.category === category), (e) => e.supplier, limit);
}

/** Names typed for "Other" expenses, most recent first — shown as quick buttons. */
export function customCategories(expenses, limit = 6) {
  return recent(expenses.filter((e) => e.category === 'other'), (e) => e.category_label, limit);
}

function recent(list, pick, limit) {
  const seen = new Set();
  const out = [];
  for (const e of [...list].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const v = pick(e);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out.slice(0, limit);
}

/**
 * Adds an expenses section to a mileage report. Business-use % comes from the ATO logbook
 * (the one given, or the report itself if it is a logbook); without one it falls back to
 * the business % of the trips in the report period, marked as an estimate.
 */
export function attachExpenses(report, expenses, logbook = null) {
  const list = expensesInRange(expenses, report.period_start, report.period_end);
  const s = report.summary;
  let businessUse;
  let source;
  if (report.logbook) {
    businessUse = report.logbook.businessUsePercent;
    source = 'this ATO logbook';
  } else if (logbook) {
    businessUse = logbook.logbook.businessUsePercent;
    source = `ATO logbook from ${logbook.period_start}`;
  } else {
    businessUse = s.businessPercent;
    source = 'estimate from these trips — no ATO logbook yet';
  }
  const abnShare = s.business ? s.abnPercent : logbook?.summary.business ? logbook.summary.abnPercent : 0;
  const summary = summariseExpenses(list, { businessUse, abnShare });
  summary.businessUseSource = source;
  report.expenses = { rows: expenseRows(list), summary };
}

/** CSV lines for a report's expenses (appended after the mileage section). */
export function expensesCsvLines(report, csvCell) {
  if (!report.expenses) return [];
  const lines = ['', 'Expenses', EXPENSE_COLUMNS.map(([, h]) => csvCell(h)).join(',')];
  for (const r of report.expenses.rows) lines.push(EXPENSE_COLUMNS.map(([k]) => csvCell(r[k])).join(','));
  lines.push('', 'Expenses summary');
  for (const [k, v] of expenseSummaryLines(report.expenses.summary)) lines.push(`${csvCell(k)},${csvCell(v)}`);
  return lines;
}

/** CSV for a stand-alone expense report: by category, every expense, then the split. */
export function expenseReportCsvLines(report, csvCell) {
  const s = report.expenses.summary;
  const lines = [
    csvCell(report.title),
    csvCell(`Period covered: ${report.period_start} to ${report.period_end}`),
    '',
    'By category',
    ['Category', 'Items', 'Amount ($)', '% of total'].map(csvCell).join(','),
    ...s.categories.map((c) => [c.label, c.count, c.amount.toFixed(2), c.pct].map(csvCell).join(',')),
    ['Total', s.count, s.total.toFixed(2), s.total ? 100 : 0].map(csvCell).join(','),
    '',
    'All expenses',
    EXPENSE_COLUMNS.map(([, h]) => csvCell(h)).join(','),
    ...report.expenses.rows.map((r) => EXPENSE_COLUMNS.map(([k]) => csvCell(r[k])).join(',')),
    '',
    'Split of total expenses',
    ['', '% of total', 'Amount ($)'].map(csvCell).join(','),
    ...['personal', 'abn', 'tfn'].map((k) => [k === 'personal' ? 'Personal' : k.toUpperCase(), s.split[k].pct, s.split[k].amount.toFixed(2)].map(csvCell).join(',')),
    ['Total', 100, s.total.toFixed(2)].map(csvCell).join(','),
    csvCell(`Based on ${s.businessUse}% business use (${s.businessUseSource}); business split ABN ${s.abnShare}% / TFN ${round1(100 - s.abnShare)}% by business km.`),
  ];
  return lines;
}
