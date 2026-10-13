// Expenses tab: quick entry with a receipt photo, list by month, edit/delete.
import {
  CATEGORY, EXPENSE_CATEGORIES, categoryLabel, customCategories, expensesInRange, isCarRelated, recentSuppliers, summariseExpenses,
} from './js/expenses.js';
import { localDate, periodContaining } from './js/periods.js';
import { summarise, tripsInRange } from './js/logic.js';
import { compressPhoto, photoUrl } from './js/photos.js';
import { attachSwipe } from './js/swipe.js';

const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PERIODS = [['monthly', 'Month'], ['quarterly', 'Quarter'], ['financial_year', 'Fin. year']];

export function setupExpenses({ getStore, timeZone, $, $$, esc, prefs, setPref, toast, onChange }) {
  const dialog = $('#expense-dialog');
  const form = $('#expense-form');
  let editing = null; // expense being edited, or null for a new one
  let photo = { id: null, pending: null, url: null }; // pending = newly taken photo not yet saved
  let category = null;
  let otherLabel = '';
  let otherCar = true; // "Other" items: split by mileage?

  // ---------- lists ----------
  const filter = { q: '', group: 'all', month: 'all' };

  function rowsHtml(items) {
    return items.map((e) => `
        <div class="swipe" data-id="${e.id}">
          <button class="swipe-left-action" type="button" tabindex="-1">Delete</button>
          <button class="expense swipe-card ${CATEGORY[e.category].group}" type="button">
            <span class="what">${esc(categoryLabel(e))}${e.supplier ? ` · ${esc(e.supplier)}` : ''}</span>
            <span class="km">${money(e.amount)}</span>
            <span class="meta">${esc(new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
            <span class="meta">${e.photo_id ? '📎 receipt' : '<span class="no-receipt">no receipt</span>'}</span>
          </button>
        </div>`).join('');
  }

  const sorted = (store) => [...store.expenses].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));

  function render() {
    const store = getStore();
    renderSummary(store);
    const all = sorted(store);
    $('#expense-recent').innerHTML = all.length
      ? rowsHtml(all.slice(0, 5))
      : '<p class="empty">No expenses yet. Tap <strong>+ Add expense</strong> and snap the receipt.</p>';
    $('#all-expenses').hidden = all.length <= 5;
    renderHistory();
  }

  /** Full expense history (History tab → Expenses) with search and filters. */
  function renderHistory() {
    const all = sorted(getStore());
    const months = [...new Set(all.map((e) => e.date.slice(0, 7)))];
    if (filter.month !== 'all' && !months.includes(filter.month)) filter.month = 'all';
    $('#expense-month').innerHTML = `<option value="all">All months</option>${months.map((m) => `<option value="${m}" ${m === filter.month ? 'selected' : ''}>${
      new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</option>`).join('')}`;
    $$('#expense-group [data-group]').forEach((b) => b.classList.toggle('on', b.dataset.group === filter.group));
    const q = filter.q.trim().toLowerCase();
    const list = all.filter((e) => (filter.group === 'all' || CATEGORY[e.category].group === filter.group)
      && (filter.month === 'all' || e.date.startsWith(filter.month))
      && (!q || [e.supplier, e.notes, categoryLabel(e)].some((v) => v && v.toLowerCase().includes(q))));
    const total = list.reduce((a, e) => a + e.amount, 0);
    $('#expense-count').textContent = all.length
      ? `${list.length === all.length ? '' : `${list.length} of `}${all.length} expense${all.length === 1 ? '' : 's'} · ${money(total)}` : '';
    const host = $('#expense-list');
    if (!all.length) { host.innerHTML = '<p class="empty">No expenses yet. Add one from the Expenses tab.</p>'; return; }
    if (!list.length) { host.innerHTML = '<p class="empty">No expenses match.</p>'; return; }
    const groups = new Map();
    for (const e of list) {
      const k = e.date.slice(0, 7);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    host.innerHTML = [...groups.entries()].map(([month, items]) => `
      <div class="day"><span>${esc(new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</span>
        <span>${money(items.reduce((a, e) => a + e.amount, 0))}</span></div>
      ${rowsHtml(items)}`).join('');
  }

  $('#expense-search').addEventListener('input', (e) => { filter.q = e.target.value; renderHistory(); });
  $('#expense-month').addEventListener('change', (e) => { filter.month = e.target.value; renderHistory(); });
  $('#expense-group').addEventListener('click', (e) => {
    const b = e.target.closest('[data-group]');
    if (!b) return;
    filter.group = b.dataset.group;
    renderHistory();
  });

  function renderSummary(store) {
    const period = prefs('expensePeriod', 'monthly');
    const today = localDate(new Date(), timeZone);
    const { start, end } = periodContaining(period, today);
    const trips = summarise(tripsInRange(store.trips, start, end, timeZone));
    const logbook = store.latestLogbook(end);
    const businessUse = logbook ? logbook.logbook.businessUsePercent : trips.businessPercent;
    const abnShare = trips.business ? trips.abnPercent : logbook?.summary.abnPercent ?? 0;
    const s = summariseExpenses(expensesInRange(store.expenses, start, end), { businessUse, abnShare });
    $('#expense-summary').innerHTML = `
      <div class="chips period">${PERIODS.map(([k, l]) => `<button type="button" data-period="${k}" class="${k === period ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="big-total">${money(s.total)} <span>spent · ${s.count} item${s.count === 1 ? '' : 's'}</span></div>
      <div class="claim-row"><span>Car-related (split by mileage)</span><strong>${money(s.carTotal)}</strong></div>
      <div class="claim-row sub"><span>Personal ${s.split.personal.pct}%</span><span>${money(s.split.personal.amount)}</span></div>
      <div class="claim-row sub"><span>ABN ${s.split.abn.pct}%</span><span>${money(s.split.abn.amount)}</span></div>
      <div class="claim-row sub"><span>TFN ${s.split.tfn.pct}%</span><span>${money(s.split.tfn.amount)}</span></div>
      ${s.nonCarTotal ? `<div class="claim-row"><span>Not car-related (not split)</span><strong>${money(s.nonCarTotal)}</strong></div>` : ''}
      <p class="muted small">Business use ${businessUse}% ${logbook ? '(ATO logbook)' : '(from your trips — create an ATO logbook in Reports for the real figure)'}.</p>`;
  }

  $('#expense-summary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    setPref('expensePeriod', b.dataset.period);
    renderSummary(getStore());
  });

  for (const list of ['#expense-list', '#expense-recent']) {
    attachSwipe($(list), {
      onTap: (id) => open(getStore().getExpense(id)),
      onLeftAction: (id) => remove(id),
    });
  }

  async function remove(id) {
    const store = getStore();
    const exp = store.getExpense(id);
    if (!exp) return;
    await store.deleteExpense(id);
    render();
    onChange();
    toast('Expense deleted', {
      action: 'Undo',
      onAction: async () => { await store.restoreExpense(exp); render(); onChange(); },
    });
    // The photo is kept until the next app start, so Undo can bring it back.
  }

  // ---------- entry dialog ----------
  function paint() {
    const store = getStore();
    const customs = customCategories(store.expenses);
    $('#cat-grid').innerHTML = [
      ...EXPENSE_CATEGORIES.filter((c) => c.key !== 'other').map((c) => `<button type="button" data-cat="${c.key}" class="cat-${c.group}${c.key === category ? ' on' : ''}">${c.label}</button>`),
      ...customs.map((c) => `<button type="button" data-cat="other" data-label="${esc(c.label)}" data-car="${c.car}" class="cat-other${category === 'other' && otherLabel.toLowerCase() === c.label.toLowerCase() ? ' on' : ''}">${esc(c.label)}</button>`),
      `<button type="button" data-cat="other" data-label="" data-car="true" class="cat-other cat-new${category === 'other' && !customs.some((c) => c.label.toLowerCase() === otherLabel.toLowerCase()) ? ' on' : ''}">Other…</button>`,
    ].join('');
    const isNewOther = category === 'other' && !customs.some((c) => c.label.toLowerCase() === otherLabel.toLowerCase());
    $('#other-row').classList.toggle('hidden', !isNewOther);
    $('#other-car-row').classList.toggle('hidden', category !== 'other');
    form.elements.car_related.checked = otherCar;
    const car = category === 'other' ? otherCar : Boolean(CATEGORY[category]?.car);
    $('#split-note').textContent = !category ? ''
      : car ? 'Car-related: split by your business-use % (mileage) into Personal / ABN / TFN.'
        : 'Not car-related: listed in reports with its total, not split by mileage.';
    $('#odo-row').classList.toggle('hidden', !CATEGORY[category]?.odometer);
    const suppliers = recentSuppliers(store.expenses, category);
    $('#supplier-chips').innerHTML = suppliers.map((n) => `<button type="button" data-supplier="${esc(n)}">${esc(n)}</button>`).join('');
  }

  function showPhoto(url) {
    if (photo.url) URL.revokeObjectURL(photo.url);
    photo.url = url;
    $('#photo-preview').src = url || '';
    $('#photo-preview').classList.toggle('hidden', !url);
    $('#photo-remove').classList.toggle('hidden', !url);
    $('#photo-label-text').textContent = url ? 'Retake / change photo' : '📷 Add receipt photo';
  }

  async function open(exp = null) {
    const store = getStore();
    editing = exp;
    category = exp?.category || null;
    otherLabel = exp?.category === 'other' ? exp.category_label : '';
    otherCar = exp ? isCarRelated(exp) : true;
    photo = { id: exp?.photo_id || null, pending: null, url: null };
    form.reset();
    $('#expense-dialog h2').textContent = exp ? 'Edit expense' : 'Add expense';
    form.elements.amount.value = exp?.amount ?? '';
    form.elements.date.value = exp?.date || localDate(new Date(), timeZone);
    form.elements.supplier.value = exp?.supplier || '';
    form.elements.odometer.value = exp?.odometer ?? '';
    form.elements.notes.value = exp?.notes || '';
    form.elements.other_label.value = otherLabel;
    $('#expense-error').textContent = '';
    $('#expense-delete').classList.toggle('hidden', !exp);
    showPhoto(null);
    if (photo.id) {
      const p = await store.getPhoto(photo.id);
      if (p) showPhoto(photoUrl(p));
    }
    paint();
    dialog.showModal();
    if (!exp) form.elements.amount.focus();
  }

  $('#cat-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    category = b.dataset.cat;
    if (category === 'other') {
      otherLabel = b.dataset.label;
      otherCar = b.dataset.car !== 'false';
      form.elements.other_label.value = otherLabel;
    }
    paint();
    if (category === 'other' && !otherLabel) form.elements.other_label.focus();
  });
  form.elements.other_label.addEventListener('input', (e) => { otherLabel = e.target.value; });
  form.elements.car_related.addEventListener('change', (e) => { otherCar = e.target.checked; paint(); });
  $('#supplier-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-supplier]');
    if (b) form.elements.supplier.value = b.dataset.supplier;
  });

  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      $('#photo-label-text').textContent = 'Processing…';
      photo.pending = await compressPhoto(file);
      showPhoto(photoUrl(photo.pending));
    } catch (err) {
      toast(err.message);
      showPhoto(photo.url);
    }
  });
  $('#photo-remove').addEventListener('click', () => {
    photo.pending = null;
    photo.id = null;
    showPhoto(null);
  });
  $('#photo-preview').addEventListener('click', () => {
    $('#photo-full').src = photo.url;
    $('#photo-viewer').showModal();
  });
  $('#photo-viewer').addEventListener('click', () => $('#photo-viewer').close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const store = getStore();
    const btn = $('#expense-save');
    btn.disabled = true;
    try {
      let photoId = photo.id;
      if (photo.pending) photoId = await store.savePhoto(photo.pending.data, photo.pending.type);
      const body = {
        amount: form.elements.amount.value,
        category,
        category_label: category === 'other' ? form.elements.other_label.value : '',
        car_related: category === 'other' ? otherCar : undefined,
        date: form.elements.date.value,
        supplier: form.elements.supplier.value,
        odometer: CATEGORY[category]?.odometer ? form.elements.odometer.value : null,
        notes: form.elements.notes.value,
        photo_id: photoId,
      };
      if (editing) await store.updateExpense(editing.id, body);
      else await store.createExpense(body);
      dialog.close();
      toast(photoId ? 'Expense saved with receipt' : 'Expense saved — no receipt photo');
      render();
      onChange();
    } catch (err) {
      $('#expense-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#expense-delete').addEventListener('click', async () => {
    const id = editing?.id;
    dialog.close();
    if (id) await remove(id);
  });
  $('#expense-dialog [data-close]').addEventListener('click', () => dialog.close());
  $('#add-expense').addEventListener('click', () => open());

  return { render };
}
