// Mileage Logbook — runs entirely on the phone. Trips are stored in this device's
// IndexedDB; reports are created whenever the app is opened after a period ends.
import { Store, memoryAdapter } from './js/store.js';
import { idbAdapter } from './js/idb.js';
import { periodContaining, localDate } from './js/periods.js';
import { summarise, tripsInRange, byStartDesc, recentClients, comingFromClient, UNIT } from './js/logic.js';
import { deliver, reportFile } from './js/files.js';

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

export const APP_VERSION = '2026.10.13-4';
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
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- data ----------
function summary() {
  const today = localDate(new Date(), TIME_ZONE);
  const out = {};
  for (const type of ['weekly', 'monthly', 'quarterly']) {
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
  { key: 'personal_travel', label: 'Personal', sub: '', category: 'personal' },
  { key: 'work', label: 'To work', sub: '', category: 'personal' },
  { key: 'home', label: 'To home', sub: '', category: 'personal' },
];
const QUICK_LABEL = {
  abn: 'Business · ABN', tfn: 'Business · TFN', personal_travel: 'Personal', work: 'To work', home: 'To home',
};

function renderStats() {
  const s = state.summary;
  if (!s) return;
  const tile = (k, d) => `
    <div class="stat"><div class="k">${k}</div><div class="v">${num(d.total)}</div>
    <div class="s">${unit()} · ${d.businessPercent}% business</div></div>`;
  $('#stats').innerHTML = tile('This week', s.weekly) + tile('This month', s.monthly) + tile('Quarter', s.quarterly);
}

function renderStart() {
  const host = $('#new-trip');
  const odo = state.lastEndOdo;
  const editing = odo === null || state.editOdo;
  host.innerHTML = `
    <div class="quick">
      <div class="odo-line">
        ${editing ? `
          <label class="odo-edit">Odometer now
            <input type="number" inputmode="decimal" step="0.1" min="0" id="start-odo" value="${odo ?? ''}" placeholder="e.g. 45210">
          </label>`
        : `<span>Odometer <strong>${num(odo)}</strong></span>
           <button class="link" type="button" id="change-odo">Change</button>`}
      </div>
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
  $('#add-past').addEventListener('click', openPast);
  host.querySelector('.tiles').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-start]');
    if (!b) return;
    const q = QUICK.find((x) => x.key === b.dataset.start);
    const typed = $('#start-odo')?.value;
    const startOdo = editing ? typed : odo;
    if (startOdo === '' || startOdo === undefined) {
      $('#start-error').textContent = 'Enter the odometer first';
      $('#start-odo').focus();
      return;
    }
    const startAt = new Date().toISOString();
    const from = q.category === 'business' ? comingFromClient(store.trips, Number(startOdo), startAt, TIME_ZONE) : '';
    try {
      await store.createTrip({
        category: q.category,
        trip_type: q.key,
        start_at: startAt,
        start_odo: startOdo,
        start_odo_manual: editing && odo !== null && Number(startOdo) !== odo,
        between_clients: Boolean(from),
        from_client: from,
      });
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

  host.innerHTML = `
    <div class="quick active-trip">
      <div class="trip-head">
        <span class="pulse"></span>
        <div>
          <div class="trip-type">${esc(QUICK_LABEL[t.trip_type])}</div>
          <div class="muted">Started ${esc(time(t.start_at))} · odometer ${num(t.start_odo)}</div>
        </div>
      </div>

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
    await store.updateTrip(t.id, { between_clients: false, from_client: '', to_client: '', purpose: client || '' });
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

function renderLog() {
  renderStats();
  renderBackupNag();
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
function renderHistory() {
  const host = $('#history');
  if (!state.trips.length) {
    host.innerHTML = '<p class="empty">No trips yet. Log your first one from the Log tab.</p>';
    return;
  }
  const groups = new Map();
  for (const t of state.trips) {
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
          <button class="trip ${t.category}" type="button" data-id="${t.id}">
            <span class="what">${esc(what)}</span>
            <span class="km">${t.distance === null ? '…' : `${num(t.distance)} ${unit()}`}</span>
            <span class="meta">${esc(TYPE_LABEL[t.trip_type])} · ${esc(time(t.start_at))}${t.end_at ? `–${esc(time(t.end_at))}` : ''}</span>
            <span class="meta">${end}</span>
          </button>`;
      }).join('')}`;
  }).join('');
}

$('#history').addEventListener('click', (e) => {
  const b = e.target.closest('.trip');
  if (b) openEdit(state.trips.find((t) => t.id === Number(b.dataset.id)));
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
function renderReports() {
  const reports = store.listReports();
  const host = $('#reports');
  if (!reports.length) {
    host.innerHTML = '<p class="empty">No reports yet. They appear here once a week, month or quarter with trips has ended.</p>';
    return;
  }
  host.innerHTML = reports.map((r) => `
    <div class="card report">
      <div>
        <span class="badge">${esc(r.period_type)}</span>
        <div><strong>${esc(r.label)}</strong></div>
        <div class="muted">${r.summary.trips} trip${r.summary.trips === 1 ? '' : 's'} · ${num(r.summary.total)} ${unit()} · ${r.summary.businessPercent}% business</div>
        <div class="muted">Made ${esc(new Date(r.generated_at).toLocaleString())}</div>
      </div>
      <div class="actions">
        <button class="btn small" type="button" data-file="xlsx" data-id="${r.id}">Excel</button>
        <button class="btn small" type="button" data-file="csv" data-id="${r.id}">CSV</button>
        <button class="btn small" type="button" data-regen="${r.id}" title="Rebuild with latest edits" aria-label="Rebuild report">↻</button>
      </div>
    </div>`).join('');
}

$('#reports').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.file) {
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
  try {
    const report = await store.generateReport('custom', from, to);
    renderReports();
    await deliver(await reportFile(report, 'xlsx'));
  } catch (err) {
    toast(err.message);
  }
  return undefined;
});

// ---------- backup ----------
const BACKUP_NAG_DAYS = 14;

function daysSinceBackup() {
  const last = store.meta.lastBackupAt;
  return last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
}

function renderBackupNag() {
  const host = $('#backup-nag');
  const days = daysSinceBackup();
  const due = store.trips.length >= 3 && (days === null || days >= BACKUP_NAG_DAYS);
  host.innerHTML = due
    ? `<div class="warn">Your trips are saved only on this phone. ${days === null ? 'You haven\'t made a backup yet.' : `Last backup was ${days} days ago.`}
       <button class="link" type="button" data-backup>Back up now</button></div>`
    : '';
}

function renderBackupInfo() {
  const days = daysSinceBackup();
  $('#backup-info').textContent = `${store.trips.length} trips on this phone. ${
    days === null ? 'No backup made yet.' : `Last backup ${days === 0 ? 'today' : `${days} day(s) ago`}.`}`;
}

async function backup() {
  const data = JSON.stringify(store.exportData(), null, 1);
  const file = new File([data], `mileage-backup-${localDate(new Date(), TIME_ZONE)}.json`, { type: 'application/json' });
  const result = await deliver(file);
  if (result !== 'cancelled') {
    await store.setMeta('lastBackupAt', new Date().toISOString());
    toast('Backup saved');
  }
  renderBackupInfo();
  renderBackupNag();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-backup]')) backup().catch((err) => toast(err.message));
});

$('#restore').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm('Replace ALL trips on this phone with the backup? This cannot be undone.')) return;
  try {
    await store.importData(JSON.parse(await file.text()));
    toast(`Restored ${store.trips.length} trips`);
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
    refresh();
  }
});

// ---------- navigation ----------
const TITLES = { log: 'Log trip', history: 'History', reports: 'Reports' };

function show(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#title').textContent = TITLES[view];
  if (view === 'history') renderHistory();
  if (view === 'reports') { renderReports(); renderBackupInfo(); }
  if (view === 'log') refresh();
  window.scrollTo(0, 0);
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) show(b.dataset.view);
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
  // Ask the browser not to clear our data when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});

  $('#tz').textContent = TIME_ZONE.replace(/_/g, ' ');
  $('#version').textContent = `Version ${APP_VERSION}`;
  const now = new Date();
  $('#custom-report [name=from]').value = toLocalInput(new Date(now.getFullYear(), now.getMonth(), 1)).slice(0, 10);
  $('#custom-report [name=to]').value = toLocalInput(now).slice(0, 10);

  show('log');
  await checkDueReports();
  scheduleMidnightCheck();
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
