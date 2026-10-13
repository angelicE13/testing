// Expense logic: categories, validation and the claimable estimate. No browser APIs.
//
// Car-related expenses are shared by how the car is used: the claimable part is the
// business-use % (from the ATO logbook, or the trips while there is no logbook yet), split
// between ABN and TFN by business km. Expenses not related to the car (clothing, laundry,
// or an "Other" item marked not car-related) are listed with their totals but not split.
import { ValidationError, round1 } from './logic.js';

// group sets the colour and the History filter; car marks expenses that are split by mileage.
export const EXPENSE_CATEGORIES = [
  { key: 'fuel', label: 'Petrol', group: 'car', car: true },
  { key: 'service', label: 'Service', group: 'car', car: true, odometer: true },
  { key: 'repairs', label: 'Repairs', group: 'car', car: true, odometer: true },
  { key: 'parts', label: 'Parts', group: 'car', car: true, odometer: true },
  { key: 'tyres', label: 'Tyres', group: 'car', car: true, odometer: true },
  { key: 'car_wash', label: 'Car wash', group: 'car', car: true },
  { key: 'registration', label: 'Registration', group: 'car', car: true },
  { key: 'insurance', label: 'Insurance', group: 'car', car: true },
  { key: 'tolls_parking', label: 'Tolls & parking', group: 'travel', car: true },
  { key: 'clothing', label: 'Clothing / uniform', group: 'clothing', car: false },
  { key: 'laundry', label: 'Laundry', group: 'clothing', car: false },
  { key: 'other', label: 'Other', group: 'other' }, // name typed in (category_label); car_related chosen
];
export const CATEGORY = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, c]));

/** Display name of an expense's category ("Other" expenses carry their own name). */
export const categoryLabel = (e) => (e.category === 'other' && e.category_label ? e.category_label : CATEGORY[e.category]?.label || e.category);

/** Car-related expenses are split by mileage; others are not. "Other" items default to car-related. */
export const isCarRelated = (e) => (e.category === 'other' ? e.car_related !== false : Boolean(CATEGORY[e.category]?.car));

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
    car_related: cat.key === 'other' ? input.car_related !== false : Boolean(cat.car),
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
 * Totals and the claimable estimate. Only car-related expenses are split by mileage.
 * businessUse: % of car use that is business; abnShare: % of business km that is ABN.
 */
export function summariseExpenses(expenses, { businessUse = 0, abnShare = 0 } = {}) {
  const sum = (list) => round2(list.reduce((a, e) => a + e.amount, 0));
  const total = sum(expenses);
  const carTotal = sum(expenses.filter(isCarRelated));
  const nonCarTotal = round2(total - carTotal);
  const groups = new Map();
  for (const e of expenses) {
    const label = categoryLabel(e);
    const g = groups.get(label) || { label, amount: 0, count: 0, car: isCarRelated(e) };
    g.amount = round2(g.amount + e.amount);
    g.count += 1;
    groups.set(label, g);
  }
  const pctOfTotal = (amount) => (total ? round1((amount / total) * 100) : 0);
  const categories = [...groups.values()].map((g) => ({ ...g, pct: pctOfTotal(g.amount) }))
    .sort((a, b) => (b.car - a.car) || (b.amount - a.amount));
  const claimableTotal = round2((carTotal * businessUse) / 100);
  const abn = round2((claimableTotal * abnShare) / 100);
  const tfn = round2(claimableTotal - abn);
  const abnPct = round1((businessUse * abnShare) / 100);
  return {
    count: expenses.length,
    total,
    carTotal,
    nonCarTotal,
    byCategory: Object.fromEntries(categories.map((c) => [c.label, c.amount])),
    categories,
    businessUse,
    abnShare,
    claimableTotal,
    claimable: { abn, tfn },
    // Split of the car-related expenses: personal = 100 − business-use %; business split ABN/TFN by km.
    split: {
      personal: { pct: round1(100 - businessUse), amount: round2(carTotal - claimableTotal) },
      abn: { pct: abnPct, amount: abn },
      tfn: { pct: round1(businessUse - abnPct), amount: tfn },
    },
  };
}

export function expenseRows(expenses) {
  return expenses.map((e) => ({
    date: e.date,
    category: categoryLabel(e),
    car_related: isCarRelated(e) ? 'Yes' : 'No',
    supplier: e.supplier,
    amount: e.amount,
    odometer: e.odometer ?? '',
    receipt: e.photo_id ? receiptName(e) : '',
    notes: e.notes,
  }));
}

export const EXPENSE_COLUMNS = [
  ['date', 'Date'], ['category', 'Category'], ['car_related', 'Car-related'], ['supplier', 'Supplier'], ['amount', 'Amount ($)'],
  ['odometer', 'Odometer'], ['receipt', 'Receipt photo'], ['notes', 'Notes'],
];

const money = (n) => `$${n.toFixed(2)}`;

export function expenseSummaryLines(s) {
  const lines = [['Total spent', money(s.total)]];
  for (const c of s.categories) lines.push([`  ${c.label}${c.car ? '' : ' (not car-related)'}`, money(c.amount)]);
  lines.push(
    ['Car-related expenses (split by mileage)', money(s.carTotal)],
    ['Business-use % applied', `${s.businessUse}%${s.businessUseSource ? ` (${s.businessUseSource})` : ''}`],
    ['Estimated claimable (car-related)', money(s.claimableTotal)],
    ['  ABN (by business km)', `${money(s.claimable.abn)} (${s.abnShare}%)`],
    ['  TFN (by business km)', `${money(s.claimable.tfn)} (${round1(100 - s.abnShare)}%)`],
    ...splitLines(s),
  );
  if (s.nonCarTotal) lines.push(['Not car-related (not split)', money(s.nonCarTotal)]);
  return lines;
}

/** End-of-report split of the car-related expenses: Personal / ABN / TFN, as % and $. */
export function splitLines(s) {
  return [
    ['Split of car-related expenses', money(s.carTotal)],
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

/** Names typed for "Other" expenses, most recent first, with their car-related choice — quick buttons. */
export function customCategories(expenses, limit = 6) {
  const others = expenses.filter((e) => e.category === 'other');
  return recent(others, (e) => e.category_label, limit).map((label) => {
    const last = others.filter((e) => e.category_label.toLowerCase() === label.toLowerCase())
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return { label, car: isCarRelated(last) };
  });
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
  const row = (...v) => v.map(csvCell).join(',');
  const lines = [
    csvCell(report.title),
    csvCell(`Period covered: ${report.period_start} to ${report.period_end}`),
    '',
    'By category',
    row('Category', 'Car-related', 'Items', 'Amount ($)', '% of total'),
    ...s.categories.map((c) => row(c.label, c.car ? 'Yes' : 'No', c.count, c.amount.toFixed(2), c.pct)),
    row('Total expenses', '', s.count, s.total.toFixed(2), s.total ? 100 : 0),
    '',
    'All expenses',
    EXPENSE_COLUMNS.map(([, h]) => csvCell(h)).join(','),
    ...report.expenses.rows.map((r) => EXPENSE_COLUMNS.map(([k]) => csvCell(r[k])).join(',')),
    '',
    'Split of car-related expenses',
    row('', '% of car-related', 'Amount ($)'),
    row('Personal', s.split.personal.pct, s.split.personal.amount.toFixed(2)),
    row('ABN', s.split.abn.pct, s.split.abn.amount.toFixed(2)),
    row('TFN', s.split.tfn.pct, s.split.tfn.amount.toFixed(2)),
    row('Total car-related', s.carTotal ? 100 : 0, s.carTotal.toFixed(2)),
    csvCell(`Based on ${s.businessUse}% business use (${s.businessUseSource}); business split ABN ${s.abnShare}% / TFN ${round1(100 - s.abnShare)}% by business km.`),
  ];
  if (s.nonCarTotal) {
    lines.push('', 'Not car-related (not split)');
    for (const c of s.categories.filter((x) => !x.car)) lines.push(row(c.label, '', c.amount.toFixed(2)));
    lines.push(row('Total not car-related', '', s.nonCarTotal.toFixed(2)));
  }
  lines.push('', row('Total expenses', '', s.total.toFixed(2)));
  return lines;
}
