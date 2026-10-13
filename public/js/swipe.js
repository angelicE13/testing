// Swipe gestures for list rows. Markup per row:
//   <div class="swipe" data-id="…">
//     [<button class="swipe-right-action">Repeat</button>]   (revealed by swiping right, optional)
//     <button class="swipe-left-action">Delete</button>      (revealed by swiping left)
//     <button class="swipe-card">…</button>
//   </div>
// Vertical movement still scrolls the page; a tap on the card calls onTap.
const OPEN = 96;

export function attachSwipe(container, { onTap, onLeftAction, onRightAction }) {
  let drag = null;
  let suppressClick = false;

  const setX = (row, x) => {
    const card = row.querySelector('.swipe-card');
    card.style.transform = x ? `translateX(${x}px)` : '';
    row.classList.toggle('open-left', x < 0);
    row.classList.toggle('open-right', x > 0);
  };
  const closeAll = (except) => {
    container.querySelectorAll('.swipe.open-left, .swipe.open-right').forEach((row) => { if (row !== except) setX(row, 0); });
  };
  const offset = (row) => (row.classList.contains('open-left') ? -OPEN : row.classList.contains('open-right') ? OPEN : 0);

  container.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.swipe-card');
    if (!card) return;
    const row = card.parentElement;
    drag = { row, card, x: e.clientX, y: e.clientY, base: offset(row), dx: 0, active: false, canRight: Boolean(row.querySelector('.swipe-right-action')) };
  });

  container.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // scrolling
      if (Math.abs(dx) < 8) return;
      drag.active = true;
      closeAll(drag.row);
      drag.row.classList.add('dragging');
      drag.card.style.transition = 'none';
    }
    drag.dx = dx;
    const max = drag.canRight ? OPEN * 1.4 : 0;
    const x = Math.min(max, Math.max(-OPEN * 1.4, drag.base + dx));
    drag.card.style.transform = `translateX(${x}px)`;
    drag.row.classList.toggle('reveal-right', x > 0);
  });

  const end = () => {
    if (!drag) return;
    const { row, card, active, base, dx } = drag;
    drag = null;
    if (!active) return;
    suppressClick = true;
    row.classList.remove('dragging', 'reveal-right');
    card.style.transition = '';
    const x = base + dx;
    setX(row, x < -OPEN / 2 ? -OPEN : x > OPEN / 2 && row.querySelector('.swipe-right-action') ? OPEN : 0);
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);

  container.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const row = e.target.closest('.swipe');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.closest('.swipe-left-action')) { setX(row, 0); onLeftAction(id); return; }
    if (e.target.closest('.swipe-right-action')) { setX(row, 0); onRightAction?.(id); return; }
    if (!e.target.closest('.swipe-card')) return;
    if (offset(row)) { closeAll(); return; }
    closeAll();
    onTap(id);
  });
}
