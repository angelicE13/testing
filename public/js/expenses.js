// Expense logic: categories, validation and the claimable estimate. No browser APIs.
import { ValidationError, round1 } from './logic.js';

/**
 * group decides how the claim is worked out:
 *  car      – running costs; claimable = business-use % from the ATO logbook, split ABN/TFN by km
 *  travel   – tolls & parking for a work trip; claimable in full for the ABN/TFN chosen
 *  clothing – uniform/protective clothing & its laundry; claimable for ABN/TFN if eligible
 */
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
];
export const CATEGORY = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, c]));
export const APPLIES_TO = { abn: 'ABN', tfn: 'TFN', personal: 'Personal' };

const round2 = (n) => Math.round(n * 100) / 100;
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

export function normaliseExpense(input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Enter the amount');
  const cat = CATEGORY[input.category];
  if (!cat) throw new ValidationError('Choose a category');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new ValidationError('Choose the date');
  // Car running costs are shared by business-use %, so they aren't tagged to one income.
  const appliesTo = cat.group === 'car' ? 'car' : input.applies_to;
  if (cat.group !== 'car' && !APPLIES_TO[appliesTo]) throw new ValidationError('Choose ABN, TFN or Personal');
  const odo = input.odometer === '' || input.odometer === null || input.odometer === undefined ? null : Number(input.odometer);
  if (odo !== null && (!Number.isFinite(odo) || odo < 0)) throw new ValidationError('Odometer must be a positive number');
  return {
    date: input.date,
    amount: round2(amount),
    category: cat.key,
    applies_to: appliesTo,
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
 * Totals and the claimable estimate for a set of expenses.
 * businessUse: % of car use that is business (ATO logbook); abnShare: % of business km that is ABN.
 */
export function summariseExpenses(expenses, { businessUse = 0, abnShare = 0 } = {}) {
  const sum = (list) => round2(list.reduce((a, e) => a + e.amount, 0));
  const byCategory = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, sum(expenses.filter((e) => e.category === c.key))]));
  const car = expenses.filter((e) => CATEGORY[e.category].group === 'car');
  const other = expenses.filter((e) => CATEGORY[e.category].group !== 'car');
  const carTotal = sum(car);
  const carClaimable = round2((carTotal * businessUse) / 100);
  const carAbn = round2((carClaimable * abnShare) / 100);
  const carTfn = round2(carClaimable - carAbn);
  const otherFor = (who, group) => sum(other.filter((e) => e.applies_to === who && (!group || CATEGORY[e.category].group === group)));
  return {
    count: expenses.length,
    total: sum(expenses),
    byCategory,
    carTotal,
    businessUse,
    abnShare,
    carClaimable,
    claimable: {
      abn: round2(carAbn + otherFor('abn')),
      tfn: round2(carTfn + otherFor('tfn')),
    },
    parts: {
      carAbn,
      carTfn,
      tollsAbn: otherFor('abn', 'travel'),
      tollsTfn: otherFor('tfn', 'travel'),
      clothingAbn: otherFor('abn', 'clothing'),
      clothingTfn: otherFor('tfn', 'clothing'),
    },
  };
}

export function expenseRows(expenses) {
  return expenses.map((e) => ({
    date: e.date,
    category: CATEGORY[e.category].label,
    applies_to: e.applies_to === 'car' ? 'Car (business-use %)' : APPLIES_TO[e.applies_to],
    supplier: e.supplier,
    amount: e.amount,
    odometer: e.odometer ?? '',
    receipt: e.photo_id ? receiptName(e) : '',
    notes: e.notes,
  }));
}

export const EXPENSE_COLUMNS = [
  ['date', 'Date'], ['category', 'Category'], ['applies_to', 'For'], ['supplier', 'Supplier'],
  ['amount', 'Amount ($)'], ['odometer', 'Odometer'], ['receipt', 'Receipt photo'], ['notes', 'Notes'],
];

const money = (n) => `$${n.toFixed(2)}`;

export function expenseSummaryLines(s) {
  const lines = [['Total spent', money(s.total)]];
  for (const c of EXPENSE_CATEGORIES) if (s.byCategory[c.key]) lines.push([`  ${c.label}`, money(s.byCategory[c.key])]);
  lines.push(
    ['Car running costs', money(s.carTotal)],
    ['Business-use % applied', `${s.businessUse}%${s.businessUseSource ? ` (${s.businessUseSource})` : ''}`],
    ['Car costs claimable', money(s.carClaimable)],
    ['  ABN share (by business km)', `${money(s.parts.carAbn)} (${s.abnShare}%)`],
    ['  TFN share (by business km)', `${money(s.parts.carTfn)} (${round1(100 - s.abnShare)}%)`],
    ['Tolls & parking — ABN / TFN', `${money(s.parts.tollsAbn)} / ${money(s.parts.tollsTfn)}`],
    ['Clothing & laundry — ABN / TFN (if eligible)', `${money(s.parts.clothingAbn)} / ${money(s.parts.clothingTfn)}`],
    ['Estimated claimable — ABN', money(s.claimable.abn)],
    ['Estimated claimable — TFN', money(s.claimable.tfn)],
  );
  return lines;
}

const safe = (s) => String(s || '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** File name for a receipt photo, e.g. 2026-10-14_Petrol_BP_45.20.jpg */
export function receiptName(e) {
  return [e.date, safe(CATEGORY[e.category].label), safe(e.supplier), e.amount.toFixed(2)].filter(Boolean).join('_') + `_${e.id}.jpg`;
}

/** Suppliers used before, most recent first. */
export function recentSuppliers(expenses, category = null, limit = 6) {
  const seen = new Set();
  const out = [];
  for (const e of [...expenses].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    if (!e.supplier || (category && e.category !== category)) continue;
    const k = e.supplier.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(e.supplier); }
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
