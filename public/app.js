// Mileage Logbook — runs entirely on the phone. Trips are stored in this device's
// IndexedDB; reports are created whenever the app is opened after a period ends.
import { Store, memoryAdapter } from './js/store.js';
import { idbAdapter } from './js/idb.js';
import { addDays, periodContaining, localDate } from './js/periods.js';
import {
  summarise, tripsInRange, byStartDesc, recentClients, comingFromClient, logbookPeriod, UNIT,
  logbookStatus, logbookExpiry, recentBusinessUse, LOGBOOK_CHANGE_POINTS,
} from './js/logic.js';
import {
  backupZip, countReceipts, deliver, readBackup, receiptsZip, reportFile, taxPack,
} from './js/files.js';
import { attachSwipe } from './js/swipe.js';
import { GOOGLE_CLIENT_ID } from './js/config.js';
import { downloadBackup, forgetToken, getToken, hasToken, uploadBackup } from './js/gdrive.js';
import { setupExpenses } from './expenses-ui.js';

let expensesUi;

const TYPES = {
  personal: [
    ['personal_travel', 'Personal travel'],
    ['home', 'Travel to home'],
    ['work', 'Travel to work'],
  ],
  business: [
    ['tfn', 'TFN'],
    ['abn', 'ABN'],
  ],
};
const TYPE_LABEL = {
  personal_travel: 'Personal travel', home: 'Travel to home', work: 'Travel to work',
  tfn: 'Business · TFN', abn: 'Business · ABN',
};

export const APP_VERSION = '2026.10.16-2';
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Australia/Melbourne';
let store;
const state = { lastEndOdo: null, active: null, trips: [], view: 'log' };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }));
const round1 = (n) => Math.round(n * 10) / 10;
const unit = () => UNIT;
const pad = (n) => String(n).padStart(2, '0');

function toLocalInput(value) {
  const d = value ? new Date(value) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (s) => (s ? new Date(s).toISOString() : null);
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dayKey = (iso) => toLocalInput(iso).slice(0, 10);

function prefs(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

let toastTimer;
/** Short message at the bottom; optionally with one action button (e.g. Undo). */
function toast(msg, { action, onAction, ms = 3500 } = {}) {
  const el = $('#toast');
  const btn = $('#toast-action');
  $('#toast-text').textContent = msg;
  btn.textContent = action || '';
  btn.hidden = !action;
  btn.onclick = action ? () => { el.classList.remove('show'); onAction(); } : null;
  el.classList.toggle('has-action', Boolean(action));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(ms, 6000) : ms);
}

// ---------- data ----------
function summary() {
  const today = localDate(new Date(), TIME_ZONE);
  const out = {};
  for (const type of ['weekly', 'monthly', 'quarterly', 'financial_year']) {
    const { start, end } = periodContaining(type, today);
    out[type] = summarise(tripsInRange(store.trips, start, end, TIME_ZONE));
  }
  return out;
}

async function refresh() {
  state.active = store.activeTrip();
  state.lastEndOdo = store.lastEndOdo();
  state.trips = [...store.trips].sort(byStartDesc);
  state.summary = summary();
  renderClients();
  renderLog();
  if (state.view === 'history') renderHistory();
}

function renderClients() {
  const names = new Set();
  for (const t of state.trips) {
    if (t.category !== 'business') continue;
    [t.purpose, t.from_client, t.to_client].forEach((n) => n && names.add(n));
  }
  $('#clients').innerHTML = [...names].sort().map((n) => `<option value="${esc(n)}">`).join('');
}

// ---------- trip form ----------
/**
 * Renders the trip form into `host`.
 * mode: 'start' (trip begins now), 'complete' (log a finished trip), 'edit' (existing trip).
 */
function tripForm(host, { mode, trip = null, onSaved, onModeChange }) {
  const isNew = mode !== 'edit';
  const hasEnd = mode === 'complete' || (mode === 'edit' && trip.end_odo !== null);
  const lastEnd = isNew ? state.lastEndOdo : null;
  const f = {
    category: trip?.category || prefs('lastCategory', 'business'),
    tripType: trip?.trip_type || null,
    between: Boolean(trip?.between_clients),
    startAuto: isNew && lastEnd !== null && prefs('startAuto', true),
    autoCompute: prefs('autoCompute', true),
  };
  if (!TYPES[f.category].some(([v]) => v === f.tripType)) f.tripType = TYPES[f.category][0][0];

  host.innerHTML = `
    <form class="card" novalidate>
      ${isNew ? `
        <div class="seg mode">
          <button type="button" data-value="start" class="${mode === 'start' ? 'on' : ''}">Start trip now</button>
          <button type="button" data-value="complete" class="${mode === 'complete' ? 'on' : ''}">Log finished trip</button>
        </div>` : ''}

      <div class="seg category">
        <button type="button" data-value="personal">Personal</button>
        <button type="button" data-value="business">Business</button>
      </div>
      <div class="chips types"></div>

      <div class="business-only">
        <label><span class="purpose-label">Client / purpose</span>
          <input name="purpose" list="clients" autocomplete="off" placeholder="e.g. Smith & Co – site visit" value="${esc(trip?.purpose)}">
        </label>
        <label class="switch">Travel between clients <input type="checkbox" name="between" ${f.between ? 'checked' : ''}></label>
        <div class="between-fields row">
          <label>From client<input name="from_client" list="clients" autocomplete="off" value="${esc(trip?.from_client)}"></label>
          <label>To client<input name="to_client" list="clients" autocomplete="off" value="${esc(trip?.to_client)}"></label>
        </div>
      </div>
      <div class="personal-only">
        <label>Purpose (optional)<input name="personal_purpose" autocomplete="off" value="${esc(trip?.category === 'personal' ? trip.purpose : '')}"></label>
      </div>

      <div class="row dt">
        <label>Start date &amp; time<input type="datetime-local" name="start_at" value="${toLocalInput(trip?.start_at)}" required></label>
        <label><span class="odo-label">Start odometer</span>
          <input type="number" name="start_odo" inputmode="decimal" step="0.1" min="0" value="${trip ? trip.start_odo : lastEnd ?? ''}" required>
        </label>
      </div>
      ${isNew && lastEnd !== null ? `
        <label class="switch">Use last end odometer (${num(lastEnd)})
          <input type="checkbox" name="start_auto" ${f.startAuto ? 'checked' : ''}>
        </label>` : ''}
      <div class="odo-warning"></div>

      ${hasEnd || mode === 'edit' ? `
        <div class="end-fields">
          <div class="row dt">
            <label>End date &amp; time<input type="datetime-local" name="end_at" value="${trip?.end_at || mode === 'complete' ? toLocalInput(trip?.end_at) : ''}"></label>
            <label>End odometer<input type="number" name="end_odo" inputmode="decimal" step="0.1" min="0" value="${trip?.end_odo ?? ''}" ${mode === 'complete' ? 'required' : ''}></label>
          </div>
          <label class="switch">Auto-compute (enter distance or end odometer)
            <input type="checkbox" name="auto_compute" ${f.autoCompute ? 'checked' : ''}>
          </label>
          <label class="distance-field">Total distance (${unit()})
            <input type="number" name="distance" inputmode="decimal" step="0.1" min="0" value="${trip?.distance ?? ''}">
          </label>
          <div class="total"><span>Total</span><strong class="total-value">–</strong></div>
        </div>` : ''}

      <label>Notes (optional)<textarea name="notes" rows="2">${esc(trip?.notes)}</textarea></label>
      <p class="error"></p>
      <button class="btn primary big" type="submit">${{ start: 'Start trip', complete: 'Save trip', edit: 'Save changes' }[mode]}</button>
      ${mode === 'edit' ? '<button class="btn danger big delete" type="button" style="margin-top:8px">Delete trip</button>' : ''}
    </form>`;

  const form = $('form', host);
  const el = (name) => form.elements[name];
  const errorEl = $('.error', form);

  function paint() {
    $$('.seg.category button', form).forEach((b) => b.classList.toggle('on', b.dataset.value === f.category));
    $('.types', form).innerHTML = TYPES[f.category]
      .map(([v, l]) => `<button type="button" data-value="${v}" class="${v === f.tripType ? 'on' : ''}">${l}</button>`)
      .join('');
    const business = f.category === 'business';
    $('.business-only', form).classList.toggle('hidden', !business);
    $('.personal-only', form).classList.toggle('hidden', business);
    $('.between-fields', form).classList.toggle('hidden', !f.between);
    $('.purpose-label', form).textContent = f.between ? 'Purpose (optional)' : 'Client / purpose';
    el('start_odo').readOnly = f.startAuto;
    if (f.startAuto) el('start_odo').value = lastEnd;
    const dist = $('.distance-field', form);
    if (dist) dist.classList.toggle('hidden', !f.autoCompute);
    compute();
  }

  function compute(source) {
    const start = parseFloat(el('start_odo').value);
    const warn = $('.odo-warning', form);
    const ref = isNew ? lastEnd : null;
    warn.innerHTML = '';
    if (ref !== null && Number.isFinite(start) && start !== ref) {
      warn.innerHTML = start < ref
        ? `<div class="warn">Start is ${num(ref - start)} ${unit()} below where the last trip ended (${num(ref)}).</div>`
        : `<div class="warn">${num(start - ref)} ${unit()} not logged since the last trip ended at ${num(ref)}.</div>`;
    }
    if (!el('end_odo')) return;
    const endInput = el('end_odo');
    const distInput = el('distance');
    if (f.autoCompute && source === 'distance' && Number.isFinite(start) && distInput.value !== '') {
      endInput.value = round1(start + parseFloat(distInput.value));
    }
    const end = parseFloat(endInput.value);
    const total = Number.isFinite(start) && Number.isFinite(end) ? round1(end - start) : null;
    if (f.autoCompute && source !== 'distance') distInput.value = total ?? '';
    const totalEl = $('.total-value', form);
    totalEl.textContent = total === null ? '–' : `${num(total)} ${unit()}`;
    totalEl.style.color = total !== null && total < 0 ? 'var(--danger)' : '';
  }

  form.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    if (b.closest('.mode')) return onModeChange?.(b.dataset.value);
    if (b.closest('.category')) {
      f.category = b.dataset.value;
      f.tripType = TYPES[f.category][0][0];
      if (f.category === 'personal') { f.between = false; el('between').checked = false; }
    }
    if (b.closest('.types')) f.tripType = b.dataset.value;
    paint();
  });
  form.addEventListener('input', (e) => {
    const n = e.target.name;
    if (n === 'between') f.between = e.target.checked;
    if (n === 'start_auto') { f.startAuto = e.target.checked; setPref('startAuto', f.startAuto); }
    if (n === 'auto_compute') { f.autoCompute = e.target.checked; setPref('autoCompute', f.autoCompute); }
    if (['between', 'start_auto', 'auto_compute'].includes(n)) return paint();
    if (n === 'distance') return compute('distance');
    if (n === 'start_odo' || n === 'end_odo') compute(n);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const business = f.category === 'business';
    const body = {
      category: f.category,
      trip_type: f.tripType,
      purpose: business ? el('purpose').value : el('personal_purpose').value,
      between_clients: business && f.between,
      from_client: el('from_client').value,
      to_client: el('to_client').value,
      notes: el('notes').value,
      start_at: fromLocalInput(el('start_at').value),
      start_odo: el('start_odo').value,
      start_odo_manual: isNew ? !f.startAuto : Boolean(trip.start_odo_manual),
    };
    if (el('end_odo')) {
      body.end_odo = el('end_odo').value === '' ? null : el('end_odo').value;
      body.end_at = body.end_odo === null ? null : fromLocalInput(el('end_at').value) || new Date().toISOString();
    }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const result = mode === 'edit' ? await store.updateTrip(trip.id, body) : await store.createTrip(body);
      setPref('lastCategory', f.category);
      toast(result.warnings?.length ? result.warnings[0] : { start: 'Trip started', complete: 'Trip saved', edit: 'Changes saved' }[mode]);
      await onSaved?.(result.trip);
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('.delete', form)?.addEventListener('click', async () => {
    if (!confirm('Delete this trip? This cannot be undone.')) return;
    try {
      await store.deleteTrip(trip.id);
      toast('Trip deleted');
      await onSaved?.(null);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  paint();
}

// ---------- Log view (quick, made for the car) ----------
// Start: one tap on where you're going. Finish: type one number, tap Finish.
const QUICK = [
  { key: 'abn', label: 'Business', sub: 'ABN', category: 'business' },
  { key: 'tfn', label: 'Business', sub: 'TFN', category: 'business' },
  { key: 'work', label: 'To work', sub: '', category: 'personal' },
  { key: 'home', label: 'To home', sub: '', category: 'personal' },
  { key: 'personal_travel', label: 'Personal', sub: '', category: 'personal' },
];
const QUICK_LABEL = {
  abn: 'Business · ABN', tfn: 'Business · TFN', personal_travel: 'Personal', work: 'To work', home: 'To home',
};

const PERIODS = [['weekly', 'Week'], ['monthly', 'Month'], ['quarterly', 'Quarter'], ['financial_year', 'Fin. year']];

/** A 100% bar split into two parts, with the numbers written beside it (never colour alone). */
function splitBar(parts) {
  const total = parts.reduce((a, p) => a + p.km, 0);
  const bar = total
    ? parts.filter((p) => p.km > 0).map((p) => `<span class="seg-${p.cls}" style="flex:${p.km}" title="${p.label}: ${num(p.km)} ${unit()} (${p.pct}%)"></span>`).join('')
    : '<span class="seg-empty"></span>';
  return `
    <div class="bar" role="img" aria-label="${parts.map((p) => `${p.label} ${p.pct}%`).join(', ')}">${bar}</div>
    <div class="bar-legend">${parts.map((p) => `
      <span><i class="dot seg-${p.cls}"></i>${p.label} <strong>${p.pct}%</strong> <span class="muted">${num(p.km)} ${unit()}</span></span>`).join('')}
    </div>`;
}

function renderStats() {
  const all = state.summary;
  if (!all) return;
  const period = prefs('breakdownPeriod', 'monthly');
  const s = all[period];
  $('#stats').innerHTML = `
    <div class="card breakdown">
      <div class="chips period">${PERIODS.map(([k, l]) => `<button type="button" data-period="${k}" class="${k === period ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="big-total">${num(s.total)} <span>${unit()} · ${s.trips} trip${s.trips === 1 ? '' : 's'}</span></div>
      <h3>Business vs personal</h3>
      ${splitBar([
        { cls: 'business', label: 'Business', km: s.business, pct: s.businessPercent },
        { cls: 'personal', label: 'Personal', km: s.personal, pct: s.personalPercent },
      ])}
      <h3>Business: ABN vs TFN</h3>
      ${splitBar([
        { cls: 'abn', label: 'ABN', km: s.abn, pct: s.abnPercent },
        { cls: 'tfn', label: 'TFN', km: s.tfn, pct: s.tfnPercent },
      ])}
    </div>`;
  $('#stats .period').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    setPref('breakdownPeriod', b.dataset.period);
    renderStats();
  });
}

/** Starts a trip now (used by the big buttons and the app-icon shortcuts). */
async function startTrip(key, startOdo, manual = false) {
  const q = QUICK.find((x) => x.key === key);
  const startAt = new Date().toISOString();
  const from = q.category === 'business'
    ? comingFromClient(store.trips, Number(startOdo), startAt, TIME_ZONE) : { client: '', type: '' };
  await store.createTrip({
    category: q.category,
    trip_type: q.key,
    start_at: startAt,
    start_odo: startOdo,
    start_odo_manual: manual,
    between_clients: Boolean(from.client),
    from_client: from.client,
    from_type: from.type,
  });
}

/** App-icon shortcuts open the app with ?start=<type> or ?add=expense. */
async function handleShortcut() {
  const params = new URLSearchParams(window.location.search);
  const start = params.get('start');
  const add = params.get('add');
  if (!start && !add) return;
  window.history.replaceState(null, '', window.location.pathname); // so a refresh doesn't repeat it
  if (add === 'expense') {
    show('expenses');
    expensesUi.openNew();
    return;
  }
  if (!QUICK.some((q) => q.key === start)) return;
  if (store.activeTrip()) { toast('A trip is already running — finish it first'); return; }
  const odo = store.lastEndOdo();
  if (odo === null) { toast('Enter the odometer, then tap a trip button'); return; }
  try {
    await startTrip(start, odo);
    toast(`${QUICK_LABEL[start]} trip started — drive safe`);
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

function renderStart() {
  const host = $('#new-trip');
  const odo = state.lastEndOdo;
  const editing = odo === null || state.editOdo;
  host.innerHTML = `
    <div class="quick">
      ${editing ? `
        <label class="odo-box editing">
          <span class="odo-box-head"><span>Odometer now</span>${odo !== null ? '<button class="link" type="button" id="cancel-odo">Cancel</button>' : ''}</span>
          <input type="number" inputmode="decimal" step="0.1" min="0" id="start-odo" value="${odo ?? ''}" placeholder="e.g. 45210">
        </label>`
      : `<button class="odo-box" type="button" id="change-odo" aria-label="Odometer ${num(odo)} ${unit()}. Tap to change">
          <span class="odo-box-head"><span>Odometer</span><span class="odo-hint">✎ Tap to change</span></span>
          <span class="odo-big">${num(odo)} <span>${unit()}</span></span>
        </button>`}
      ${logbookStrip()}
      <h2 class="quick-title">Tap to start a trip</h2>
      <div class="tiles">
        ${QUICK.map((q) => `
          <button class="tile ${q.category}" type="button" data-start="${q.key}">
            ${q.label}${q.sub ? `<small>${q.sub}</small>` : ''}
          </button>`).join('')}
      </div>
      <p class="error" id="start-error"></p>
      <button class="link past" type="button" id="add-past">+ Add a past trip</button>
    </div>`;

  $('#change-odo')?.addEventListener('click', () => {
    state.editOdo = true;
    renderStart();
    $('#start-odo').select();
  });
  $('#cancel-odo')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.editOdo = false;
    renderStart();
  });
  $('#add-past').addEventListener('click', openPast);
  $('#logbook-strip')?.addEventListener('click', () => { setPref('createType', 'logbook'); show('reports'); });
  host.querySelector('.tiles').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-start]');
    if (!b) return;
    const typed = $('#start-odo')?.value;
    const startOdo = editing ? typed : odo;
    if (startOdo === '' || startOdo === undefined) {
      $('#start-error').textContent = 'Enter the odometer first';
      $('#start-odo').focus();
      return;
    }
    try {
      await startTrip(b.dataset.start, startOdo, editing && odo !== null && Number(startOdo) !== odo);
      state.editOdo = false;
      toast('Trip started — drive safe');
      await refresh();
    } catch (err) {
      $('#start-error').textContent = err.message;
    }
  });
}

function renderActive() {
  const host = $('#active-trip');
  const t = state.active;
  if (!t) { host.innerHTML = ''; return; }
  const business = t.category === 'business';
  const client = t.between_clients ? t.to_client : t.purpose;
  const byDistance = prefs('endByDistance', false);
  const clients = recentClients(store.trips).filter((c) => c !== t.from_client);
  const usual = usualDistance(t);
  const hours = (Date.now() - new Date(t.start_at)) / 3600000;

  host.innerHTML = `
    <div class="quick active-trip">
      <div class="trip-head">
        <span class="pulse"></span>
        <div>
          <div class="trip-type">${esc(QUICK_LABEL[t.trip_type])}</div>
          <div class="muted">Started ${esc(dayKey(t.start_at) === dayKey(new Date()) ? time(t.start_at) : `${dayLabel(t.start_at)}, ${time(t.start_at)}`)} · odometer ${num(t.start_odo)}</div>
        </div>
      </div>
      ${hours >= 3 ? `<div class="warn">This trip started ${Math.floor(hours)} hours ago — did you forget to finish it?
        Enter the end odometer below, then fix the end time in <strong>Edit</strong> if needed.</div>` : ''}

      ${business ? `
        <div class="client-box">
          ${t.between_clients ? `
            <div class="from-row">From <strong>${esc(t.from_client)}</strong>
              <button class="link" type="button" id="not-from">not from a client</button></div>` : ''}
          <div class="label">${t.between_clients ? 'To which client?' : 'Which client?'}</div>
          <div class="chips big">
            ${clients.map((c) => `<button type="button" data-client="${esc(c)}" class="${c === client ? 'on' : ''}">${esc(c)}</button>`).join('')}
          </div>
          <input id="client-input" list="clients" autocomplete="off" placeholder="${clients.length ? 'Or type a new client' : 'Type the client name'}"
            value="${client && !clients.includes(client) ? esc(client) : ''}">
        </div>` : ''}

      <div class="end-box">
        <div class="seg end-mode">
          <button type="button" data-mode="odo" class="${byDistance ? '' : 'on'}">End odometer</button>
          <button type="button" data-mode="dist" class="${byDistance ? 'on' : ''}">Trip distance</button>
        </div>
        <input class="big-number" id="end-value" type="number" inputmode="decimal" step="0.1" min="0"
          placeholder="${byDistance ? `${unit()} driven` : `more than ${num(t.start_odo)}`}">
        ${usual ? `<button class="chip-suggest" type="button" id="use-usual">Same as last time: ${num(usual)} ${unit()}</button>` : ''}
        <div class="total-line" id="end-total"></div>
      </div>
      <p class="error" id="end-error"></p>
      <button class="btn primary huge" type="button" id="finish">Finish trip</button>
      <div class="small-actions">
        <button class="link" type="button" id="edit-active">Edit</button>
        <button class="link danger-link" type="button" id="cancel-active">Cancel trip</button>
      </div>
    </div>`;

  const input = $('#end-value');
  const totalEl = $('#end-total');
  const values = () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return null;
    return byDistance ? { end: round1(t.start_odo + v), dist: round1(v) } : { end: round1(v), dist: round1(v - t.start_odo) };
  };
  $('#use-usual')?.addEventListener('click', () => {
    input.value = byDistance ? usual : round1(t.start_odo + usual);
    input.dispatchEvent(new Event('input'));
  });
  input.addEventListener('input', () => {
    $('#end-error').textContent = '';
    const v = values();
    totalEl.textContent = v ? (byDistance ? `Ends at ${num(v.end)}` : `${num(v.dist)} ${unit()}`) : '';
    totalEl.classList.toggle('bad', Boolean(v && v.dist < 0));
  });

  const setClient = async (name) => {
    const n = name.trim();
    if (!n) return;
    const change = t.between_clients ? { to_client: n } : { purpose: n };
    await store.updateTrip(t.id, change);
    state.active = store.activeTrip();
  };

  host.querySelector('.chips')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-client]');
    if (!b) return;
    $$('.chips [data-client]', host).forEach((x) => x.classList.toggle('on', x === b));
    $('#client-input').value = '';
    await setClient(b.dataset.client);
  });
  $('#client-input')?.addEventListener('change', async (e) => {
    $$('.chips [data-client]', host).forEach((x) => x.classList.remove('on'));
    await setClient(e.target.value);
  });
  $('#not-from')?.addEventListener('click', async () => {
    await store.updateTrip(t.id, { between_clients: false, from_client: '', from_type: '', to_client: '', purpose: client || '' });
    await refresh();
  });
  host.querySelector('.end-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    setPref('endByDistance', b.dataset.mode === 'dist');
    renderActive();
    $('#end-value').focus();
  });

  $('#finish').addEventListener('click', async () => {
    const err = $('#end-error');
    err.textContent = '';
    const typed = $('#client-input')?.value;
    if (typed) await setClient(typed);
    const v = values();
    if (!v) { err.textContent = byDistance ? 'Enter the distance' : 'Enter the end odometer'; input.focus(); return; }
    try {
      await store.endTrip(t.id, { end_odo: v.end, end_at: new Date().toISOString() });
      toast(`Logged ${num(v.dist)} ${unit()}`);
      await refresh();
    } catch (e) {
      err.textContent = e.message;
    }
  });
  $('#edit-active').addEventListener('click', () => openEdit(store.activeTrip()));
  $('#cancel-active').addEventListener('click', async () => {
    if (!confirm('Cancel this trip? Nothing will be logged.')) return;
    await store.deleteTrip(t.id);
    await refresh();
  });
}

// Once a week, compare the real odometer with the logbook so missed km are caught early.
const ODO_CHECK_DAYS = 7;

function odoCheckDue() {
  if (!store.trips.length || state.active || state.lastEndOdo === null) return false;
  const since = store.meta.odoCheckAt || store.trips.map((t) => t.created_at).sort()[0];
  return Date.now() - new Date(since) > ODO_CHECK_DAYS * 86400000;
}

function renderOdoCheck() {
  const host = $('#odo-check');
  if (!odoCheckDue()) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="warn odo-check">
      <strong>Weekly odometer check</strong> — what does the car's odometer show right now?
      <div class="odo-check-row">
        <input type="number" inputmode="decimal" step="0.1" min="0" id="odo-check-value" placeholder="${num(state.lastEndOdo)}">
        <button class="btn small primary" type="button" id="odo-check-go">Check</button>
        <button class="link" type="button" id="odo-check-skip">Skip</button>
      </div>
      <div id="odo-check-result"></div>
    </div>`;
  const done = async (msg) => {
    await store.setMeta('odoCheckAt', new Date().toISOString());
    if (msg) toast(msg);
    renderOdoCheck();
  };
  $('#odo-check-skip').addEventListener('click', () => done());
  $('#odo-check-go').addEventListener('click', async () => {
    const reading = parseFloat($('#odo-check-value').value);
    if (!Number.isFinite(reading)) return;
    const diff = round1(reading - state.lastEndOdo);
    const result = $('#odo-check-result');
    if (Math.abs(diff) <= 1) { await done('Odometer matches your logbook 👍'); return; }
    if (diff < 0) {
      result.innerHTML = `<p>That's ${num(-diff)} ${unit()} <em>less</em> than where your last trip ended (${num(state.lastEndOdo)}).
        Check your recent trips in History for a typo.</p><button class="link" type="button" id="odo-ok">OK</button>`;
      $('#odo-ok').addEventListener('click', () => done());
      return;
    }
    result.innerHTML = `<p><strong>${num(diff)} ${unit()}</strong> haven't been logged since your last trip.</p>
      <div class="odo-check-row">
        <button class="btn small" type="button" id="odo-personal">Log as personal</button>
        <button class="btn small" type="button" id="odo-past">Add the trip(s)</button>
        <button class="link" type="button" id="odo-ignore">Ignore</button>
      </div>`;
    $('#odo-personal').addEventListener('click', async () => {
      const now = new Date().toISOString();
      await store.createTrip({
        category: 'personal', trip_type: 'personal_travel', purpose: 'Unlogged travel (weekly odometer check)',
        start_at: now, end_at: now, start_odo: state.lastEndOdo, end_odo: reading,
      });
      await done(`Logged ${num(diff)} ${unit()} as personal`);
      await refresh();
    });
    $('#odo-past').addEventListener('click', async () => { await done(); openPast(); });
    $('#odo-ignore').addEventListener('click', () => done());
  });
}

// ---------- ATO logbook guide ----------
const todayLocal = () => localDate(new Date(), TIME_ZONE);
const prettyDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function currentLogbookStatus() {
  const active = store.activeLogbook();
  return active ? logbookStatus(store.trips, active.start, new Date(), TIME_ZONE) : null;
}

/** Latest logbook report that is finished (not the one being kept now). */
function lastFinishedLogbook() {
  const active = store.activeLogbook();
  return store.reports
    .filter((r) => r.period_type === 'logbook' && r.logbook && r.period_start !== active?.start && r.period_end < todayLocal())
    .sort((a, b) => (a.period_end < b.period_end ? 1 : -1))[0] || null;
}

function logbookStrip() {
  const st = currentLogbookStatus();
  if (!st || st.done) return '';
  return `<button class="logbook-strip" type="button" id="logbook-strip">
      <span>ATO logbook · day ${st.day} of ${st.days} · ${st.businessUse}% business so far</span>
      <span class="strip-bar"><i style="width:${Math.round((st.day / st.days) * 100)}%"></i></span>
    </button>`;
}

const snoozed = (kind) => (store.meta.logbookSnooze?.[kind] || '') > todayLocal();
async function snooze(kind, days) {
  await store.setMeta('logbookSnooze', { ...(store.meta.logbookSnooze || {}), [kind]: addDays(todayLocal(), days) });
  renderLogbookNag();
}

async function startLogbookToday() {
  await store.startLogbook(todayLocal());
  toast('12-week ATO logbook started — just log your trips as usual');
  await refresh();
}

function renderLogbookNag() {
  const host = $('#logbook-nag');
  const banner = (text, actions) => {
    host.innerHTML = `<div class="warn logbook-nag"><div>${text}</div><div class="nag-actions">${actions}</div></div>`;
  };
  host.innerHTML = '';
  if (!store.trips.length) return;
  const st = currentLogbookStatus();
  if (st?.done) {
    banner(`<strong>Your 12-week ATO logbook is complete</strong> — ${st.businessUse}% business use. Finalise it to lock in the figure.`,
      '<button class="btn small primary" type="button" data-lb="finalise">Finalise logbook</button>');
  } else if (!st) {
    const last = lastFinishedLogbook();
    if (last) {
      const expiry = logbookExpiry(last.period_end);
      const recent = recentBusinessUse(store.trips, todayLocal(), TIME_ZONE);
      const change = Math.abs(recent.businessPercent - last.logbook.businessUsePercent);
      if (todayLocal() >= addDays(expiry, -60) && !snoozed('expiry')) {
        banner(`<strong>Your ATO logbook expires ${prettyDay(expiry)}.</strong> Start a new 12-week logbook to keep claiming with the logbook method.`,
          '<button class="btn small primary" type="button" data-lb="start">Start today</button><button class="link" type="button" data-lb="snooze-expiry">Later</button>');
      } else if (recent.total >= 300 && change > LOGBOOK_CHANGE_POINTS && !snoozed('change')) {
        banner(`<strong>Your car use has changed.</strong> Business use over the last 12 weeks is ${recent.businessPercent}% vs ${last.logbook.businessUsePercent}% in your logbook. If your work travel has changed, the ATO expects a new logbook.`,
          '<button class="btn small primary" type="button" data-lb="start">Start new logbook</button><button class="link" type="button" data-lb="snooze-change">Dismiss</button>');
      }
    } else if (store.trips.length >= 3 && !snoozed('start')) {
      banner('<strong>Start your 12-week ATO logbook</strong> — you need one to claim car costs with the logbook method. Just keep logging trips as usual.',
        '<button class="btn small primary" type="button" data-lb="start">Start today</button><button class="link" type="button" data-lb="snooze-start">Later</button>');
    }
  }
}

$('#logbook-nag').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lb]');
  if (!b) return;
  const act = b.dataset.lb;
  try {
    if (act === 'start') await startLogbookToday();
    else if (act === 'finalise') {
      const r = await store.finaliseLogbook();
      toast(`Logbook finalised: ${r.logbook.businessUsePercent}% business use. It's in Reports.`);
      await refresh();
    } else if (act === 'snooze-start') await snooze('start', 14);
    else if (act === 'snooze-expiry') await snooze('expiry', 14);
    else if (act === 'snooze-change') await snooze('change', 30);
  } catch (err) {
    toast(err.message);
  }
});

function renderLogbookStatus() {
  const st = currentLogbookStatus();
  const last = lastFinishedLogbook();
  let html = '';
  if (st) {
    html = `<p class="status-line"><strong>Current logbook:</strong> ${prettyDay(st.start)} – ${prettyDay(st.end)}
      · ${st.done ? 'complete' : `day ${st.day} of ${st.days}`} · ${st.businessUse}% business so far
      <button class="link danger-link" type="button" id="cancel-logbook">Cancel it</button></p>`;
  } else if (last) {
    html = `<p class="status-line"><strong>Logbook in use:</strong> ${prettyDay(last.period_start)} – ${prettyDay(last.period_end)}
      · ${last.logbook.businessUsePercent}% business · valid until ${prettyDay(logbookExpiry(last.period_end))}</p>`;
  }
  $('#logbook-status').innerHTML = html;
  $('#cancel-logbook')?.addEventListener('click', async () => {
    if (!confirm('Cancel the current 12-week logbook? Your trips are kept.')) return;
    await store.cancelLogbook();
    toast('Logbook cancelled');
    renderLogbookStatus();
    renderReports();
  });
}

function renderLog() {
  renderStats();
  renderBackupNag();
  renderLogbookNag();
  renderOdoCheck();
  renderActive();
  if (state.active) $('#new-trip').innerHTML = '';
  else renderStart();
}

function openPast() {
  const dialog = $('#edit-dialog');
  $('#edit-dialog h2').textContent = 'Add a past trip';
  tripForm($('#edit-form'), {
    mode: 'complete',
    onSaved: async () => { dialog.close(); await refresh(); },
  });
  dialog.showModal();
}

// ---------- History view ----------
const historyFilter = { q: '', type: 'all', month: 'all' };

function filteredTrips() {
  const q = historyFilter.q.trim().toLowerCase();
  return state.trips.filter((t) => {
    if (historyFilter.type === 'personal' ? t.category !== 'personal' : historyFilter.type !== 'all' && t.trip_type !== historyFilter.type) return false;
    if (historyFilter.month !== 'all' && dayKey(t.start_at).slice(0, 7) !== historyFilter.month) return false;
    if (q && ![t.purpose, t.from_client, t.to_client, t.notes, TYPE_LABEL[t.trip_type]].some((v) => v && v.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderHistory() {
  const host = $('#history');
  const n = state.trips.length;
  $('#history-filters').hidden = n < 2;
  const months = [...new Set(state.trips.map((t) => dayKey(t.start_at).slice(0, 7)))];
  if (historyFilter.month !== 'all' && !months.includes(historyFilter.month)) historyFilter.month = 'all';
  $('#history-month').innerHTML = `<option value="all">All months</option>${months.map((m) => `<option value="${m}" ${m === historyFilter.month ? 'selected' : ''}>${
    new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</option>`).join('')}`;
  $$('#history-type [data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === historyFilter.type));
  const list = filteredTrips();
  const km = round1(list.reduce((a, t) => a + (t.distance || 0), 0));
  $('#history-count').textContent = !n ? '' : list.length === n ? `${n} trip${n === 1 ? '' : 's'} · ${num(km)} ${unit()}`
    : `${list.length} of ${n} trips · ${num(km)} ${unit()}`;
  $('#clear-all').hidden = !n;
  $('#swipe-hint').hidden = !n;
  if (!n) {
    host.innerHTML = '<p class="empty">No trips yet. Log your first one from the Log tab.</p>';
    return;
  }
  if (!list.length) {
    host.innerHTML = '<p class="empty">No trips match.</p>';
    return;
  }
  const groups = new Map();
  for (const t of list) {
    const k = dayKey(t.start_at);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  host.innerHTML = [...groups.values()].map((list) => {
    const total = round1(list.reduce((a, t) => a + (t.distance || 0), 0));
    return `
      <div class="day"><span>${esc(dayLabel(list[0].start_at))}</span><span>${num(total)} ${unit()}</span></div>
      ${list.map((t) => {
        const what = t.between_clients ? `${t.from_client} → ${t.to_client}` : t.purpose || TYPE_LABEL[t.trip_type];
        const end = t.end_odo === null ? 'in progress' : `${num(t.start_odo)} → ${num(t.end_odo)}`;
        return `
          <div class="swipe" data-id="${t.id}">
            ${t.end_odo !== null ? '<button class="swipe-right-action" type="button" tabindex="-1">Repeat</button>' : ''}
            <button class="swipe-left-action" type="button" tabindex="-1">Delete</button>
            <button class="trip swipe-card ${t.category}" type="button">
              <span class="what">${esc(what)}</span>
              <span class="km">${t.distance === null ? '…' : `${num(t.distance)} ${unit()}`}</span>
              <span class="meta">${esc(TYPE_LABEL[t.trip_type])} · ${esc(time(t.start_at))}${t.end_at ? `–${esc(time(t.end_at))}` : ''}</span>
              <span class="meta">${end}</span>
            </button>
          </div>`;
      }).join('')}`;
  }).join('');
}

async function deleteWithUndo(id) {
  const trip = store.getTrip(id);
  if (!trip) return;
  await store.deleteTrip(id);
  await refresh();
  renderHistory();
  toast('Trip deleted', {
    action: 'Undo',
    onAction: async () => {
      await store.restoreTrip(trip);
      await refresh();
      renderHistory();
    },
  });
}

function showHistoryPane() {
  const pane = prefs('historyPane', 'mileage');
  $$('#history-switch [data-hist]').forEach((b) => b.classList.toggle('on', b.dataset.hist === pane));
  $('#hist-mileage').classList.toggle('hidden', pane !== 'mileage');
  $('#hist-expenses').classList.toggle('hidden', pane !== 'expenses');
}
$('#history-switch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hist]');
  if (!b) return;
  setPref('historyPane', b.dataset.hist);
  showHistoryPane();
  window.scrollTo(0, 0);
});
$('#all-expenses').addEventListener('click', () => { setPref('historyPane', 'expenses'); show('history'); });

$('#history-search').addEventListener('input', (e) => { historyFilter.q = e.target.value; renderHistory(); });
$('#history-month').addEventListener('change', (e) => { historyFilter.month = e.target.value; renderHistory(); });
$('#history-type').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  historyFilter.type = b.dataset.type;
  renderHistory();
});

/** Start a new trip like an earlier one: same type and client, starting now from the current odometer. */
async function repeatTrip(id) {
  const t = store.getTrip(id);
  if (!t) return;
  if (store.activeTrip()) { toast('Finish the current trip first'); return; }
  const startOdo = store.lastEndOdo() ?? t.end_odo;
  const startAt = new Date().toISOString();
  const destination = t.between_clients ? t.to_client : t.purpose;
  const from = t.category === 'business' ? comingFromClient(store.trips, startOdo, startAt, TIME_ZONE) : { client: '', type: '' };
  const between = Boolean(from.client) && from.client !== destination;
  try {
    await store.createTrip({
      category: t.category,
      trip_type: t.trip_type,
      start_at: startAt,
      start_odo: startOdo,
      purpose: between ? '' : destination,
      between_clients: between,
      from_client: between ? from.client : '',
      from_type: between ? from.type : '',
      to_client: between ? destination : '',
    });
    toast('Trip started — drive safe');
    show('log');
  } catch (err) {
    toast(err.message);
  }
}

/** Distance of the last finished trip with the same type, destination and starting client. */
function usualDistance(t) {
  const dest = (x) => (x.between_clients ? x.to_client : x.purpose) || '';
  const match = [...store.trips].sort(byStartDesc).find((x) => x.id !== t.id && x.end_odo !== null
    && x.trip_type === t.trip_type && dest(x) === dest(t) && (x.from_client || '') === (t.from_client || ''));
  return match ? match.distance : null;
}

attachSwipe($('#history'), {
  onTap: (id) => openEdit(state.trips.find((t) => t.id === id)),
  onLeftAction: (id) => deleteWithUndo(id),
  onRightAction: (id) => repeatTrip(id),
});

// Clear everything (asks first, offers a backup)
$('#clear-all').addEventListener('click', () => {
  const n = store.trips.length;
  $('#clear-count').textContent = `${n} trip${n === 1 ? '' : 's'}`;
  $('#clear-dialog').showModal();
});

$('#clear-dialog').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-clear]');
  if (!b) return;
  const dialog = $('#clear-dialog');
  if (b.dataset.clear === 'cancel') { dialog.close(); return; }
  if (b.dataset.clear === 'backup') {
    const result = await backup();
    if (result === 'cancelled') { toast('Backup cancelled — nothing was deleted'); dialog.close(); return; }
  }
  dialog.close();
  await store.clearAll();
  await refresh();
  renderHistory();
  toast('All trips cleared');
});

function openEdit(trip) {
  const dialog = $('#edit-dialog');
  $('#edit-dialog h2').textContent = 'Edit trip';
  tripForm($('#edit-form'), {
    mode: 'edit',
    trip,
    onSaved: async () => { dialog.close(); await refresh(); },
  });
  dialog.showModal();
}
$('#edit-dialog [data-close]').addEventListener('click', () => $('#edit-dialog').close());

// ---------- Reports view ----------
const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const REPORT_BADGE = {
  weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', financial_year: 'Fin. year', logbook: 'ATO logbook', custom: 'Custom', expenses: 'Expenses',
};

function renderReports() {
  const reports = store.listReports();
  const types = Object.keys(REPORT_BADGE).filter((k) => reports.some((r) => r.period_type === k));
  let filter = prefs('reportFilter', 'all');
  if (filter !== 'all' && !types.includes(filter)) filter = 'all';

  $('#report-filter').innerHTML = types.length > 1
    ? [['all', 'All'], ...types.map((k) => [k, REPORT_BADGE[k]])]
      .map(([k, l]) => `<button type="button" data-filter="${k}" class="${k === filter ? 'on' : ''}">${l}</button>`).join('')
    : '';

  const host = $('#reports');
  if (!reports.length) {
    host.innerHTML = '<p class="empty small-empty">No reports yet. They appear here automatically after each week, month, quarter and financial year with trips.</p>';
    return;
  }
  const shown = reports.filter((r) => filter === 'all' || r.period_type === filter);
  host.innerHTML = shown.map((r) => {
    const s = r.summary;
    const receipts = countReceipts(store, r.period_start, r.period_end);
    if (r.period_type === 'expenses') {
      const x = r.expenses.summary;
      return `
      <div class="report-row">
        <div class="report-main">
          <div class="report-title"><strong>${esc(r.label)}</strong>${filter === 'all' ? `<span class="badge">${REPORT_BADGE.expenses}</span>` : ''}</div>
          <div class="muted">${money(x.total)} · ${x.count} item${x.count === 1 ? '' : 's'} · ${x.categories.length} categor${x.categories.length === 1 ? 'y' : 'ies'}</div>
          <div class="muted">Car-related ${money(x.carTotal)}: Personal ${x.split.personal.pct}% · ABN ${x.split.abn.pct}% · TFN ${x.split.tfn.pct}%</div>
          ${x.nonCarTotal ? `<div class="muted">Not car-related (not split) ${money(x.nonCarTotal)}</div>` : ''}
        </div>
        <div class="actions">
          <button class="btn small" type="button" data-file="xlsx" data-id="${r.id}">Excel</button>
          <button class="btn small" type="button" data-file="csv" data-id="${r.id}">CSV</button>
          ${receipts ? `<button class="btn small" type="button" data-receipts="${r.id}">Receipts (${receipts})</button>` : ''}
          <button class="btn small" type="button" data-regen="${r.id}" title="Rebuild with latest expenses" aria-label="Rebuild report">↻</button>
        </div>
      </div>`;
    }
    return `
      <div class="report-row">
        <div class="report-main">
          <div class="report-title"><strong>${esc(r.label)}</strong>${filter === 'all' ? `<span class="badge">${REPORT_BADGE[r.period_type]}</span>` : ''}</div>
          <div class="muted">${num(s.total)} ${unit()} · Business ${s.businessPercent}% (ABN ${s.abnPercent}% · TFN ${s.tfnPercent}%) · Personal ${s.personalPercent}%</div>
          ${r.logbook ? `<div class="muted"><strong>ATO business-use ${r.logbook.businessUsePercent}%</strong>${r.logbook.inProgress ? ` · day ${r.logbook.daysElapsed} of 84` : ''}</div>` : ''}
          ${r.expenses?.summary.count ? `<div class="muted">Expenses ${money(r.expenses.summary.total)} · est. claimable ABN ${money(r.expenses.summary.claimable.abn)} · TFN ${money(r.expenses.summary.claimable.tfn)}</div>` : ''}
        </div>
        <div class="actions">
          <button class="btn small" type="button" data-file="xlsx" data-id="${r.id}">Excel</button>
          <button class="btn small" type="button" data-file="csv" data-id="${r.id}">CSV</button>
          ${receipts ? `<button class="btn small" type="button" data-receipts="${r.id}">Receipts (${receipts})</button>` : ''}
          <button class="btn small" type="button" data-regen="${r.id}" title="Rebuild with latest trips" aria-label="Rebuild report">↻</button>
        </div>
      </div>`;
  }).join('');
}

$('#report-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  setPref('reportFilter', b.dataset.filter);
  renderReports();
});

$('#create-type').addEventListener('click', (e) => {
  const b = e.target.closest('[data-create]');
  if (!b) return;
  setPref('createType', b.dataset.create);
  showCreatePanel();
});

function showCreatePanel() {
  const type = prefs('createType', 'range');
  $$('#create-type [data-create]').forEach((x) => x.classList.toggle('on', x.dataset.create === type));
  $$('[data-panel]').forEach((f) => f.classList.toggle('hidden', f.dataset.panel !== type));
}

$('#reports').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.receipts) {
      const report = store.reports.find((r) => r.id === Number(b.dataset.receipts));
      await deliver(await receiptsZip(store, report));
    } else if (b.dataset.file) {
      const report = store.reports.find((r) => r.id === Number(b.dataset.id));
      await deliver(await reportFile(report, b.dataset.file));
    } else if (b.dataset.regen) {
      await store.regenerate(Number(b.dataset.regen));
      toast('Report rebuilt with your latest trips');
      renderReports();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$('#custom-report').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const from = fd.get('from');
  const to = fd.get('to');
  if (!from || !to || from > to) return toast('Choose a valid date range');
  setPref('reportFilter', 'all');
  try {
    const report = await store.generateReport('custom', from, to);
    renderReports();
    await deliver(await reportFile(report, 'xlsx'));
  } catch (err) {
    toast(err.message);
  }
  return undefined;
});

// ---------- clients ----------
function clientCounts() {
  const counts = new Map();
  for (const t of store.trips) {
    if (t.category !== 'business') continue;
    for (const n of new Set([t.purpose, t.from_client, t.to_client].filter(Boolean))) counts.set(n, (counts.get(n) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderClientList() {
  const list = clientCounts();
  $('#clients-summary').textContent = list.length ? String(list.length) : 'none yet';
  $('#client-list').innerHTML = list.length
    ? list.map(([name, n]) => `
      <div class="client-row"><span>${esc(name)} <span class="muted">· ${n} trip${n === 1 ? '' : 's'}</span></span>
        <button class="link" type="button" data-rename="${esc(name)}">Rename</button></div>`).join('')
    : '<p class="muted">Clients appear here after your first business trip.</p>';
}

$('#client-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rename]');
  if (!b) return;
  const from = b.dataset.rename;
  const to = prompt(`Rename "${from}" to:`, from);
  if (to === null || to.trim() === from) return;
  try {
    await store.renameClient(from, to);
    toast(`Renamed to "${to.trim()}" — rebuild (↻) reports to update them`);
    renderClientList();
    await refresh();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- car details, ATO logbook, financial year ----------
function renderReportForms() {
  const car = store.meta.car || {};
  const f = $('#car-form');
  for (const k of ['make', 'model', 'engine', 'rego']) f.elements[k].value = car[k] || '';
  $('#car-summary').textContent = [car.make, car.model, car.rego].filter(Boolean).join(' · ') || 'not set';
  showCreatePanel();

  const lb = $('#logbook-form');
  if (!lb.elements.start.value) lb.elements.start.value = localDate(new Date(), TIME_ZONE);
  showLogbookEnd();

  const today = localDate(new Date(), TIME_ZONE);
  const current = Number(periodContaining('financial_year', today).start.slice(0, 4));
  const first = store.trips.length
    ? Number(periodContaining('financial_year', store.trips.map((t) => localDate(t.start_at, TIME_ZONE)).sort()[0]).start.slice(0, 4))
    : current;
  const options = Array.from({ length: current - first + 1 }, (_, i) => current - i)
    .map((y) => `<option value="${y}">FY${y}-${String(y + 1).slice(2)} (Jul ${y} – Jun ${y + 1})</option>`).join('');
  $('#tax-form').elements.fy.innerHTML = options;
  const mf = $('#method-form');
  const keep = mf.elements.fy.value;
  mf.elements.fy.innerHTML = options;
  if (keep) mf.elements.fy.value = keep;
  renderMethod();
  const sel = $('#fy-form').elements.fy;
  sel.innerHTML = Array.from({ length: current - first + 1 }, (_, i) => current - i)
    .map((y) => `<option value="${y}">FY${y}-${String(y + 1).slice(2)} (Jul ${y} – Jun ${y + 1})</option>`).join('');
}

function showLogbookEnd() {
  const start = $('#logbook-form').elements.start.value;
  $('#logbook-end').textContent = start ? `Runs 12 weeks: ${start} to ${logbookPeriod(start).end}` : '';
}
$('#logbook-form').elements.start.addEventListener('input', showLogbookEnd);

$('#car-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await store.saveCar(Object.fromEntries(fd));
  renderReportForms();
  e.target.closest('details').open = false;
  toast('Car details saved — rebuild (↻) older reports to include them');
});

$('#logbook-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const start = e.target.elements.start.value;
  if (!start) return toast('Choose the start date');
  try {
    const running = logbookPeriod(start).end >= todayLocal() && start <= todayLocal();
    if (running && store.activeLogbook() && store.activeLogbook().start !== start
      && !confirm('Replace the logbook you are keeping now with this one?')) return undefined;
    const report = running ? await store.startLogbook(start) : await store.generateLogbook(start);
    setPref('reportFilter', 'all');
    renderReports();
    renderLogbookStatus();
    if (running) toast('Logbook started — progress shows on the Log tab');
    await deliver(await reportFile(report, 'xlsx'));
  } catch (err) {
    toast(err.message);
  }
  return undefined;
});

$('#fy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const y = Number(e.target.elements.fy.value);
  try {
    const report = await store.generateReport('financial_year', `${y}-07-01`, `${y + 1}-06-30`);
    setPref('reportFilter', 'all');
    renderReports();
    await deliver(await reportFile(report, 'xlsx'));
  } catch (err) {
    toast(err.message);
  }
});

// ---------- logbook vs cents per km ----------
function renderMethod() {
  const f = $('#method-form');
  const fy = Number(f.elements.fy.value);
  if (!fy) return;
  const saved = store.fyInputs(fy);
  if (document.activeElement !== f.elements.rate) f.elements.rate.value = saved.rate;
  if (document.activeElement !== f.elements.depreciation) f.elements.depreciation.value = saved.depreciation;
  const c = store.methodComparison(fy);
  const win = (k) => (c.better === k ? ' class="win"' : '');
  $('#method-result').innerHTML = `
    <table class="method-table">
      <thead><tr><th></th><th${win('logbook')}>Logbook</th><th${win('cents')}>Cents per km</th></tr></thead>
      <tbody>
        <tr class="how"><td>How</td><td>${money(c.logbook.base)}<br>× ${c.logbook.businessUse}%</td>
          <td>${num(c.cents.km)} km${c.cents.capped ? ' (cap)' : ''}<br>× ${c.cents.rate ? `$${c.cents.rate}` : '?'}</td></tr>
        <tr><td>ABN</td><td>${money(c.logbook.abn)}</td><td>${c.cents.total === null ? '—' : money(c.cents.abn)}</td></tr>
        <tr><td>TFN</td><td>${money(c.logbook.tfn)}</td><td>${c.cents.total === null ? '—' : money(c.cents.tfn)}</td></tr>
        <tr class="sum-row"><td>Total</td><td${win('logbook')}>${money(c.logbook.total)}</td><td${win('cents')}>${c.cents.total === null ? '—' : money(c.cents.total)}</td></tr>
      </tbody>
    </table>
    <p class="method-verdict">${c.better === null ? 'Enter the cents-per-km rate to compare.'
      : c.better === 'equal' ? 'Both methods give the same claim.'
        : `<strong>${c.better === 'logbook' ? 'Logbook' : 'Cents per km'}</strong> claims ${money(c.difference)} more.`}</p>
    <p class="muted small">Logbook: car running costs ${money(c.logbook.carCosts)}${c.logbook.depreciation ? ` + depreciation ${money(c.logbook.depreciation)}` : ''},
      business use ${c.logbook.businessUse}% (${esc(c.source)}).
      ${c.tolls.business ? `Tolls & parking (${money(c.tolls.business)} business share) are claimed on top under either method.` : ''}
      Estimates only — confirm with your accountant.</p>`;
}

$('#method-form').addEventListener('change', async (e) => {
  const f = $('#method-form');
  if (e.target.name === 'rate' || e.target.name === 'depreciation') {
    await store.saveFyInputs(Number(f.elements.fy.value), { rate: f.elements.rate.value, depreciation: f.elements.depreciation.value });
  }
  renderMethod();
});
$('#method-form').addEventListener('submit', (e) => e.preventDefault());

$('#expense-report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = e.target.elements.from.value;
  const to = e.target.elements.to.value;
  if (!from || !to || from > to) { toast('Choose a valid date range'); return; }
  try {
    const report = await store.generateReport('expenses', from, to);
    setPref('reportFilter', 'all');
    renderReports();
    await deliver(await reportFile(report, 'xlsx'));
  } catch (err) {
    toast(err.message);
  }
});

$('#tax-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const y = Number(e.target.elements.fy.value);
  const btn = $('button[type=submit]', e.target);
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const fyReport = await store.generateReport('financial_year', `${y}-07-01`, `${y + 1}-06-30`);
    renderReports();
    await deliver(await taxPack(store, fyReport, store.latestLogbook(fyReport.period_end)));
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create tax pack';
  }
});

// ---------- backup ----------
// Every night at 10pm (or the next time the app is opened after that):
//  1. an automatic copy is kept inside the app, replacing the previous night's copy;
//  2. a reminder offers a one-tap backup file. It always has the same name, so saving it
//     to the same folder replaces the previous file instead of piling up copies.
const BACKUP_HOUR = 22;
const BACKUP_FILE = 'mileage-backup.zip';

/** The most recent 10pm that has passed. */
function lastBackupTime(now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), BACKUP_HOUR);
  if (now < t) t.setDate(t.getDate() - 1);
  return t;
}

const before = (iso, t) => !iso || new Date(iso) < t;

/** Due once a 10pm has passed since a trip was added or changed and no backup has been saved since. */
function backupDue() {
  const t = lastBackupTime();
  const last = store.meta.lastBackupAt;
  const unsavedBefore10pm = [...store.trips, ...store.expenses].some((x) => {
    const changed = x.updated_at || x.created_at;
    return (!last || changed > last) && new Date(changed) < t;
  });
  return unsavedBefore10pm && before(store.meta.backupSnoozedAt, t);
}

async function nightlySnapshot() {
  if (!(store.trips.length || store.expenses.length) || !before(store.meta.snapshotAt, lastBackupTime())) return;
  await store.setMeta('snapshot', structuredClone(store.exportData()));
  await store.setMeta('snapshotAt', new Date().toISOString());
}

function daysSinceBackup() {
  const last = store.meta.lastBackupAt;
  return last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
}

function renderBackupNag() {
  $('#backup-nag').innerHTML = backupDue()
    ? `<div class="warn">Time for tonight's backup.
       <span>${driveOn()
        ? '<button class="link" type="button" data-backup-drive>Back up to Google Drive</button>'
        : '<button class="link" type="button" data-backup>Save backup</button>'}
       <button class="link" type="button" id="snooze-backup">Later</button></span></div>`
    : '';
  $('#snooze-backup')?.addEventListener('click', async () => {
    await store.setMeta('backupSnoozedAt', new Date().toISOString());
    renderBackupNag();
  });
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function renderBackupInfo() {
  const days = daysSinceBackup();
  $('#backup-summary').textContent = days === null ? 'never' : days === 0 ? 'today' : `${days}d ago`;
  $('#backup-info').textContent = `${store.trips.length} trip${store.trips.length === 1 ? '' : 's'} on this phone. ${
    days === null ? 'No backup file saved yet.' : `Last backup file ${days === 0 ? 'today' : `${days} day(s) ago`}.`}`;
  const snap = store.meta.snapshot;
  $('#snapshot-info').textContent = snap
    ? `Nightly copy kept inside the app: ${when(store.meta.snapshotAt)} (${snap.trips.length} trip${snap.trips.length === 1 ? '' : 's'}).`
    : 'The app keeps a copy of your trips each night at 10pm (or the next time you open it).';
  $('#restore-snapshot').hidden = !snap;
}

async function backup() {
  const result = await deliver(await backupZip(store, BACKUP_FILE));
  if (result !== 'cancelled') {
    await store.setMeta('lastBackupAt', new Date().toISOString());
    toast('Backup saved');
  }
  renderBackupInfo();
  renderBackupNag();
  return result;
}

// ---------- Google Drive backup ----------
const driveClientId = () => store.meta.gdriveClientId ?? GOOGLE_CLIENT_ID;
const driveOn = () => Boolean(driveClientId());

/** Uploads mileage-backup.zip to Drive. interactive=false only uses a still-valid sign-in. */
async function backupToDrive({ interactive = true } = {}) {
  const token = await getToken(driveClientId(), { interactive });
  if (!token) return false;
  await uploadBackup(token, await backupZip(store, BACKUP_FILE));
  const now = new Date().toISOString();
  await store.setMeta('lastBackupAt', now);
  await store.setMeta('lastDriveBackupAt', now);
  renderBackupInfo();
  renderBackupNag();
  renderDrive();
  return true;
}

/** At 10pm / on open: back up to Drive silently if signed in within the last hour. */
async function autoDriveBackup() {
  if (!driveOn() || !hasToken() || !backupDue()) return;
  try {
    if (await backupToDrive({ interactive: false })) toast('Backed up to Google Drive');
  } catch { /* the reminder banner stays, one tap retries */ }
}

function renderDrive() {
  const on = driveOn();
  $('#gdrive-setup').classList.toggle('hidden', on);
  $('#gdrive-ready').classList.toggle('hidden', !on);
  $('#gdrive-client').value = store.meta.gdriveClientId || '';
  const last = store.meta.lastDriveBackupAt;
  $('#gdrive-info').textContent = `${last ? `Last Drive backup: ${when(last)}.` : 'No Drive backup yet.'} `
    + 'Each backup replaces the previous one in "Mileage Logbook backups" in your Drive.';
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = old; }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-backup-drive]');
  if (b) withBusy(b, 'Backing up…', async () => { await backupToDrive(); toast('Backed up to Google Drive'); });
});

$('#gdrive-backup').addEventListener('click', (e) => withBusy(e.target, 'Backing up…', async () => {
  await backupToDrive();
  toast('Backed up to Google Drive');
}));

$('#gdrive-restore').addEventListener('click', (e) => withBusy(e.target, 'Looking…', async () => {
  const token = await getToken(driveClientId());
  const found = await downloadBackup(token, BACKUP_FILE);
  if (!found) { toast('No backup found in your Google Drive yet'); return; }
  if (!confirm(`Replace ALL trips and expenses on this device with the Drive backup from ${when(found.modifiedTime)}?`)) return;
  const { data, photos } = await readBackup(found.file);
  await store.importData(data);
  await store.replacePhotos(photos);
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  toast(`Restored ${n(store.trips.length, 'trip')} and ${n(store.expenses.length, 'expense')} from Google Drive`);
  expensesUi.render();
  renderBackupInfo();
  await refresh();
}));

$('#gdrive-save-client').addEventListener('click', async () => {
  const id = $('#gdrive-client').value.trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) { toast('That doesn\'t look like a Google client ID (…apps.googleusercontent.com)'); return; }
  await store.setMeta('gdriveClientId', id);
  renderDrive();
  renderBackupNag();
  toast('Saved — tap "Back up to Drive now" and sign in to Google');
});

$('#gdrive-change').addEventListener('click', () => {
  $('#gdrive-setup').classList.remove('hidden');
  $('#gdrive-ready').classList.add('hidden');
});

$('#gdrive-disconnect').addEventListener('click', async () => {
  if (!confirm('Turn off Google Drive backup on this device? Your backup stays in your Drive.')) return;
  forgetToken();
  await store.setMeta('gdriveClientId', '');
  renderDrive();
  renderBackupNag();
});

$('#restore-snapshot').addEventListener('click', async () => {
  const snap = store.meta.snapshot;
  if (!snap) return;
  if (!confirm(`Go back to the nightly copy from ${when(store.meta.snapshotAt)}? Trips added or changed since then will be lost.`)) return;
  await store.importData(snap);
  toast(`Restored ${store.trips.length} trips`);
  expensesUi.render();
  renderBackupInfo();
  await refresh();
});

// While the app is open, run the nightly backup at 10pm.
function scheduleBackupCheck() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), BACKUP_HOUR, 0, 5);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    nightlySnapshot().finally(() => { renderBackupNag(); autoDriveBackup(); scheduleBackupCheck(); });
  }, next - now);
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-backup]')) backup().catch((err) => toast(err.message));
});

$('#restore').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm('Replace ALL trips and expenses on this phone with the backup? This cannot be undone.')) return;
  try {
    const { data, photos } = await readBackup(file);
    await store.importData(data);
    if (photos.length || data.version >= 2) await store.replacePhotos(photos);
    toast(`Restored ${store.trips.length} trips and ${store.expenses.length} expenses`);
    expensesUi.render();
    renderBackupInfo();
    await refresh();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'That file is not a valid backup' : err.message);
  }
});

// ---------- automatic reports ----------
async function checkDueReports() {
  const created = await store.generateDue();
  if (created.length) {
    toast(`${created.length} new report${created.length > 1 ? 's' : ''} ready in Reports`);
    if (state.view === 'reports') renderReports();
  }
}

// If the app is left open past midnight, check again then.
function scheduleMidnightCheck() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => { checkDueReports().finally(scheduleMidnightCheck); refresh(); }, next - now);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store) {
    checkDueReports().catch(() => {});
    nightlySnapshot().catch(() => {});
    autoDriveBackup();
    refresh();
  }
});

// ---------- navigation ----------
const TITLES = { log: 'Log trip', expenses: 'Expenses', history: 'History', reports: 'Reports' };

function show(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#title').textContent = TITLES[view];
  if (view === 'history') { renderHistory(); expensesUi.render(); showHistoryPane(); }
  if (view === 'expenses') expensesUi.render();
  if (view === 'reports') { renderReports(); renderReportForms(); renderLogbookStatus(); renderClientList(); renderBackupInfo(); renderDrive(); }
  if (view === 'log') refresh();
  window.scrollTo(0, 0);
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) show(b.dataset.view);
});

window.addEventListener('db-blocked', () => {
  $('#new-trip').innerHTML = `<div class="warn">The app is updating, but it's also open in another tab or window.
    Close the other Mileage tabs/windows — this page continues automatically.</div>`;
});

async function init() {
  let adapter;
  try {
    adapter = await idbAdapter();
  } catch {
    adapter = memoryAdapter();
    toast('This browser cannot store data — trips will be lost when you close it.');
  }
  store = await new Store(adapter, { timeZone: TIME_ZONE }).load();
  store.prunePhotos().catch(() => {}); // receipts of expenses deleted last session
  expensesUi = setupExpenses({
    getStore: () => store, timeZone: TIME_ZONE, $, $$, esc, prefs, setPref, toast,
    onChange: () => renderBackupNag(),
  });
  // Ask the browser not to clear our data when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});

  $('#tz').textContent = TIME_ZONE.replace(/_/g, ' ');
  $('#version').textContent = `Version ${APP_VERSION}`;
  const now = new Date();
  $('#custom-report [name=from]').value = toLocalInput(new Date(now.getFullYear(), now.getMonth(), 1)).slice(0, 10);
  $('#custom-report [name=to]').value = toLocalInput(now).slice(0, 10);
  $('#expense-report-form [name=from]').value = $('#custom-report [name=from]').value;
  $('#expense-report-form [name=to]').value = $('#custom-report [name=to]').value;

  show('log');
  await nightlySnapshot().catch(() => {});
  await checkDueReports();
  scheduleMidnightCheck();
  scheduleBackupCheck();
  await handleShortcut();
  autoDriveBackup();
}

init().catch((err) => toast(err.message));

if ('serviceWorker' in navigator) {
  // When a new version has been installed, reload once so it's used straight away.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded && !$('#edit-dialog').open) {
      reloaded = true;
      window.location.reload();
    }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update();
        });
      })
      .catch(() => {});
  });
}
