// Calendar helpers. Dates are handled as 'YYYY-MM-DD' strings in the user's time zone,
// so "Monday 12 AM" means midnight where the user lives, not on the server.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

/** 'YYYY-MM-DD' for the instant in the given zone. */
export function localDate(date, timeZone) {
  const p = parts(new Date(date), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'HH:MM' (24h) for the instant in the given zone. */
export function localTime(date, timeZone) {
  const p = parts(new Date(date), timeZone);
  return `${p.hour}:${p.minute}`;
}

const toUtc = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);

export function addDays(s, n) {
  const d = toUtc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

function firstOfMonth(y, m) {
  // m is 1-based and may overflow either way
  return fmt(new Date(Date.UTC(y, m - 1, 1)));
}

/** Period containing the given local date. */
export function periodContaining(type, day) {
  const d = toUtc(day);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (type === 'weekly') {
    const start = addDays(day, -((d.getUTCDay() + 6) % 7)); // back to Monday
    return { start, end: addDays(start, 6) };
  }
  if (type === 'monthly') {
    return { start: firstOfMonth(y, m), end: addDays(firstOfMonth(y, m + 1), -1) };
  }
  if (type === 'quarterly') {
    const qm = Math.floor((m - 1) / 3) * 3 + 1;
    return { start: firstOfMonth(y, qm), end: addDays(firstOfMonth(y, qm + 3), -1) };
  }
  throw new Error(`Unknown period type: ${type}`);
}

/** The most recent fully finished period before the given local date. */
export function lastCompletedPeriod(type, today) {
  const current = periodContaining(type, today);
  return periodContaining(type, addDays(current.start, -1));
}

function prettyDate(s) {
  const d = toUtc(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Australian financial year quarter (FY starts 1 July). */
export function financialQuarter(start) {
  const d = toUtc(start);
  const m = d.getUTCMonth() + 1;
  const y = d.getUTCFullYear();
  const fyEnd = m >= 7 ? y + 1 : y;
  const q = Math.floor(((m + 5) % 12) / 3) + 1;
  return `FY${fyEnd - 1}-${String(fyEnd).slice(2)} Q${q}`;
}

export function periodLabel(type, start, end) {
  const d = toUtc(start);
  if (type === 'weekly') return `Week ${prettyDate(start)} – ${prettyDate(end)}`;
  if (type === 'monthly') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (type === 'quarterly') {
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    return `Q${q} ${d.getUTCFullYear()} (${financialQuarter(start)})`;
  }
  return `${prettyDate(start)} – ${prettyDate(end)}`;
}
