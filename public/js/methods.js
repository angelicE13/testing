// Logbook method vs cents-per-km method for one financial year. No browser APIs.
//
// Logbook: (car running costs + depreciation) × business-use %.
// Cents per km: business km (capped at 5,000 per car) × the ATO rate for that year.
// Tolls and parking are claimed on top under either method, so they're shown separately
// and don't change which method is better. Both claims split ABN/TFN by business km.
import { round1 } from './logic.js';
import { CATEGORY, expensesInRange, isCarRelated } from './expenses.js';

export const CENTS_PER_KM_CAP = 5000;
const round2 = (n) => Math.round(n * 100) / 100;

export function compareMethods({ carCosts, tolls = 0, depreciation = 0, businessUse, abnShare, businessKm, rate }) {
  const split = (total) => {
    const abn = round2((total * abnShare) / 100);
    return { abn, tfn: round2(total - abn) };
  };
  const logbookBase = round2(carCosts + depreciation);
  const logbookTotal = round2((logbookBase * businessUse) / 100);
  const km = round1(Math.min(businessKm, CENTS_PER_KM_CAP));
  const centsTotal = rate ? round2(km * rate) : null;
  let better = null;
  if (centsTotal !== null) better = logbookTotal > centsTotal ? 'logbook' : centsTotal > logbookTotal ? 'cents' : 'equal';
  return {
    logbook: { carCosts: round2(carCosts), depreciation: round2(depreciation), base: logbookBase, businessUse, total: logbookTotal, ...split(logbookTotal) },
    cents: { businessKm: round1(businessKm), km, capped: businessKm > CENTS_PER_KM_CAP, rate: rate || null, total: centsTotal, ...(centsTotal === null ? {} : split(centsTotal)) },
    tolls: { total: round2(tolls), business: round2((tolls * businessUse) / 100) },
    abnShare,
    better,
    difference: centsTotal === null ? null : round2(Math.abs(logbookTotal - centsTotal)),
  };
}

/** Pulls the year's figures together from trips, expenses and the ATO logbook. */
export function comparisonInputs({ tripSummary, expenses, start, end, logbook, rate, depreciation }) {
  const list = expensesInRange(expenses, start, end).filter(isCarRelated);
  const tolls = round2(list.filter((e) => CATEGORY[e.category]?.key === 'tolls_parking').reduce((a, e) => a + e.amount, 0));
  const carCosts = round2(list.reduce((a, e) => a + e.amount, 0) - tolls);
  const businessUse = logbook ? logbook.logbook.businessUsePercent : tripSummary.businessPercent;
  return {
    carCosts,
    tolls,
    depreciation: Number(depreciation) || 0,
    businessUse,
    businessUseSource: logbook ? `ATO logbook from ${logbook.period_start}` : 'estimate from trips — no ATO logbook yet',
    abnShare: tripSummary.business ? tripSummary.abnPercent : logbook?.summary.abnPercent ?? 0,
    businessKm: tripSummary.business,
    rate: Number(rate) || null,
  };
}

const money = (n) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);

export function methodLines(c, source) {
  const lines = [
    ['LOGBOOK METHOD', ''],
    ['  Car running costs', money(c.logbook.carCosts)],
    ['  Depreciation', money(c.logbook.depreciation)],
    ['  Business-use %', `${c.logbook.businessUse}%${source ? ` (${source})` : ''}`],
    ['  Claim', money(c.logbook.total)],
    ['    ABN / TFN', `${money(c.logbook.abn)} / ${money(c.logbook.tfn)}`],
    ['CENTS PER KM METHOD', ''],
    ['  Business km', `${c.cents.businessKm}${c.cents.capped ? ` (capped at ${CENTS_PER_KM_CAP})` : ''}`],
    ['  Rate per km', c.cents.rate ? `$${c.cents.rate}` : 'not entered'],
    ['  Claim', money(c.cents.total)],
  ];
  if (c.cents.total !== null) lines.push(['    ABN / TFN', `${money(c.cents.abn)} / ${money(c.cents.tfn)}`]);
  lines.push(['Tolls & parking (business share, claimed on top of either)', money(c.tolls.business)]);
  lines.push(['RESULT', c.better === null ? 'Enter the cents-per-km rate to compare'
    : c.better === 'equal' ? 'Both methods give the same claim'
      : `${c.better === 'logbook' ? 'Logbook' : 'Cents per km'} is higher by ${money(c.difference)}`]);
  return lines;
}
