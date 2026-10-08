import { addDays, api, confirmDialog, esc, fmtDate, openModal, qs, showError, toast, todayISO, weekStart } from '../lib.js';

// Time off → My availability: a month calendar where staff say when they can't work (or can), all day or between
// times, plus repeating patterns (every 1, 2 or 4 weeks). Anything set for a day replaces the pattern that day.
// Managers can pick someone they look after and change theirs. It all shows on the rota.

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const range = (a) => (a.all_day ? 'All day' : `${a.from_time}–${a.to_time}`);
const chip = (a, attrs = '') => `<button type="button" class="av-chip av-${a.kind}" ${attrs}
  title="${a.kind === 'unavailable' ? 'Unavailable' : 'Available'} ${range(a).toLowerCase()}${a.source === 'pattern' ? ' – from a repeating pattern' : ''}">
  ${a.kind === 'unavailable' ? '✕' : '✓'} ${range(a)}${a.source === 'pattern' ? ' <span class="av-repeat" aria-label="repeating">↻</span>' : ''}</button>`;
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
const monthLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const addMonths = (iso, n) => { const d = new Date(`${monthStart(iso)}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

/**
 * The "Create availability" window: unavailable or available, all day or one or more times. done({ kind, all_day,
 * ranges }) saves it (and may throw to show an error).
 */
export function availabilityDialog({ title, subtitle, done }) {
  const timeRow = (from = '', to = '') => `<div class="av-range"><input type="time" name="from" value="${from}" aria-label="From"> <span>–</span>
    <input type="time" name="to" value="${to}" aria-label="Until"> <button type="button" class="icon-btn av-range-remove" aria-label="Remove these times">×</button></div>`;
  const { form } = openModal({
    title,
    submitLabel: 'Add',
    body: `${subtitle ? `<p class="muted av-sub">${esc(subtitle)}</p>` : ''}
      <div class="av-kind" role="radiogroup" aria-label="Unavailable or available">
        <label class="av-pick av-pick-unavailable"><input type="radio" name="kind" value="unavailable" checked> ✕ Unavailable</label>
        <label class="av-pick av-pick-available"><input type="radio" name="kind" value="available"> ✓ Available</label>
      </div>
      <label class="av-allday"><span>All day</span><input type="checkbox" name="all_day" role="switch"></label>
      <div class="av-ranges">${timeRow()}</div>
      <button type="button" class="btn btn-small btn-ghost av-add-range">+ Add another time</button>
      <p class="muted small">Available is optional – it just tells your manager when suits you best.</p>`,
    onSubmit: async () => {
      const allDay = form.all_day.checked;
      const ranges = allDay ? [] : [...form.querySelectorAll('.av-range')].map((r) => ({ from_time: r.querySelector('[name=from]').value, to_time: r.querySelector('[name=to]').value }))
        .filter((r) => r.from_time || r.to_time);
      if (!allDay && !ranges.length) throw new Error('Turn on All day, or enter the times');
      if (ranges.some((r) => !r.from_time || !r.to_time)) throw new Error('Enter both times, or remove the empty row');
      await done({ kind: form.querySelector('[name=kind]:checked').value, all_day: allDay, ranges });
    },
  });
  const ranges = form.querySelector('.av-ranges');
  const sync = () => {
    const allDay = form.all_day.checked;
    ranges.hidden = allDay;
    form.querySelector('.av-add-range').hidden = allDay;
    ranges.querySelectorAll('.av-range-remove').forEach((b) => { b.hidden = ranges.children.length === 1; });
  };
  form.all_day.addEventListener('change', sync);
  form.querySelector('.av-add-range').addEventListener('click', () => { ranges.insertAdjacentHTML('beforeend', timeRow()); sync(); ranges.lastElementChild.querySelector('input').focus(); });
  ranges.addEventListener('click', (e) => { if (e.target.closest('.av-range-remove')) { e.target.closest('.av-range').remove(); sync(); } });
  sync();
  form.querySelector('[name=from]').focus();
}

// --- The month calendar ---

export async function renderAvailability(ctx, tabsHtml) {
  const { el, state, query, navigate, rerender } = ctx;
  if (query.pattern) return renderPattern(ctx, tabsHtml);
  const month = /^\d{4}-\d{2}$/.test(query.month ?? '') ? `${query.month}-01` : monthStart(todayISO());
  const from = weekStart(month);
  const last = addDays(addMonths(month, 1), -1);
  const to = addDays(weekStart(last), 6);
  const data = await api(`/availability/calendar${qs({ user_id: query.user, from, to })}`);
  if (ctx.stale()) return;
  const userId = data.user.id;
  const me = userId === state.user.id;
  const go = (extra) => navigate(`timeoff${qs({ tab: 'availability', user: me ? undefined : userId, month: month.slice(0, 7), ...extra })}`);
  const today = todayISO();
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const describe = (p) => {
    const by = new Map();
    for (const s of p.slots) {
      const k = `${p.weeks > 1 ? `Week ${s.week + 1} ` : ''}${WEEKDAYS[s.weekday]}`;
      by.set(k, [...(by.get(k) ?? []), `${s.kind === 'unavailable' ? '✕' : '✓'} ${range(s)}`]);
    }
    return [...by].map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · ');
  };

  el.innerHTML = `
    <div class="page-head"><h1>Time off</h1></div>
    ${tabsHtml}
    <div class="av-head">
      ${data.people ? `<select id="av-person" aria-label="Whose availability">${data.people.map((p) => `<option value="${p.id}" ${p.id === userId ? 'selected' : ''}>${esc(p.name)}${p.id === state.user.id ? ' (You)' : ''}</option>`).join('')}</select>` : `<strong>${esc(data.user.name)} (You)</strong>`}
      <div class="av-month">
        <button class="btn" data-month="-1" aria-label="Previous month">‹</button>
        <strong>${monthLabel(month)}</strong>
        <button class="btn" data-month="1" aria-label="Next month">›</button>
        ${month !== monthStart(today) ? '<button class="btn btn-ghost" data-month="0">This month</button>' : ''}
      </div>
      <button class="btn btn-primary" id="av-pattern-new">+ Create repeating pattern</button>
    </div>
    <p class="muted small">Tap a day to say when ${me ? 'you can’t' : `${esc(data.user.name)} can’t`} work (or can). It shows on the rota for whoever plans it. ↻ = from a repeating pattern; anything set on a day replaces the pattern that day. For a holiday, use My holiday.</p>
    <div class="av-cal" role="grid" aria-label="${monthLabel(month)}">
      ${WEEKDAYS.map((w) => `<div class="av-dow" role="columnheader">${w}</div>`).join('')}
      ${days.map((d) => {
        const list = data.days[d] ?? [];
        const inMonth = d.slice(0, 7) === month.slice(0, 7);
        const past = d < today;
        return `<div class="av-day ${inMonth ? '' : 'is-out'} ${d === today ? 'is-today' : ''} ${past ? 'is-past' : ''}" role="gridcell" data-date="${d}">
          <span class="av-num">${Number(d.slice(8))}</span>
          <div class="av-chips">${list.map((a, i) => chip(a, `data-entry="${d}|${i}"`)).join('')}</div>
          ${past ? '' : `<button type="button" class="av-add" data-add="${d}" aria-label="Add availability for ${fmtDate(d)}">+</button>`}
        </div>`;
      }).join('')}
    </div>
    <section class="card">
      <h2>Repeating patterns</h2>
      ${data.patterns.length ? `<ul class="plain-list av-patterns">${data.patterns.map((p) => `<li>
        <div><strong>Every ${p.weeks === 1 ? 'week' : `${p.weeks} weeks`}</strong> from ${fmtDate(p.start_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${p.end_date ? ` to ${fmtDate(p.end_date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}` : ' · no end date'}
          <small class="muted">${esc(describe(p))}</small></div>
        <span><button class="btn btn-small" data-edit-pattern="${p.id}">Edit</button> <button class="btn btn-small btn-ghost" data-del-pattern="${p.id}">Delete</button></span></li>`).join('')}</ul>`
        : '<p class="muted">None yet. Use “Create repeating pattern” for things that happen every week, like college on Tuesdays.</p>'}
    </section>
    <form class="card" id="av-note">
      <label class="field"><span>Anything else ${me ? 'your manager' : 'the rota planner'} should know (optional)</span>
        <textarea name="note" rows="2" maxlength="500" placeholder="e.g. school run until 9:15 on weekdays">${esc(data.note ?? '')}</textarea></label>
      <button class="btn btn-small" type="submit">Save note</button>
    </form>`;

  el.querySelector('#av-person')?.addEventListener('change', (e) => navigate(`timeoff${qs({ tab: 'availability', user: Number(e.target.value) === state.user.id ? undefined : e.target.value, month: month.slice(0, 7) })}`));
  el.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.month);
    go({ month: (n ? addMonths(month, n) : monthStart(today)).slice(0, 7) });
  }));
  el.querySelector('#av-pattern-new').addEventListener('click', () => go({ pattern: 'new' }));
  el.querySelectorAll('[data-edit-pattern]').forEach((b) => b.addEventListener('click', () => go({ pattern: b.dataset.editPattern })));
  el.querySelectorAll('[data-del-pattern]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmDialog('Delete this repeating pattern? Days you’ve set one by one stay as they are.', { confirmLabel: 'Delete' })) return;
    try { await api(`/availability/patterns/${b.dataset.delPattern}`, { method: 'DELETE' }); toast('Pattern deleted'); rerender(); } catch (err) { showError(err); }
  }));
  const addFor = (d) => availabilityDialog({
    title: 'Create availability',
    subtitle: fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
    done: async (v) => {
      await api('/availability/days', { method: 'POST', body: { user_id: userId, date: d, ...v } });
      toast('Availability saved');
      rerender();
    },
  });
  el.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addFor(b.dataset.add)));
  // Tapping something already set: remove it, or (for a repeating one) change just that day.
  el.querySelectorAll('[data-entry]').forEach((b) => b.addEventListener('click', () => {
    const [d, i] = b.dataset.entry.split('|');
    const a = data.days[d][Number(i)];
    const when = fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
    const fromPattern = a.source === 'pattern';
    const { form } = openModal({
      title: `${a.kind === 'unavailable' ? 'Unavailable' : 'Available'} · ${range(a)}`,
      body: `<p>${when}</p>${fromPattern ? '<p class="muted">This comes from a repeating pattern. Changing just this day replaces the pattern for that day only.</p>' : ''}
        <div class="actions">${fromPattern ? '<button type="button" class="btn" data-act="change">Change just this day</button><button type="button" class="btn btn-ghost" data-act="free">Free on this day</button>'
          : '<button type="button" class="btn" data-act="remove">Remove</button>'}${!fromPattern && data.days[d].some((x) => x.source === 'day') ? '<button type="button" class="btn btn-ghost" data-act="clear">Clear this day</button>' : ''}</div>`,
    });
    form.querySelectorAll('[data-act]').forEach((x) => x.addEventListener('click', async () => {
      try {
        if (x.dataset.act !== 'change') document.getElementById('modal-root').innerHTML = '';
        if (x.dataset.act === 'remove') { await api(`/availability/days/${a.id}`, { method: 'DELETE' }); toast('Removed'); rerender(); }
        else if (x.dataset.act === 'clear') { await api('/availability/days/clear', { method: 'POST', body: { user_id: userId, date: d } }); toast('Day cleared'); rerender(); }
        else if (x.dataset.act === 'free') {
          await api('/availability/days', { method: 'POST', body: { user_id: userId, date: d, kind: 'available', all_day: true } });
          toast(`Marked as available all day on ${fmtDate(d)}`);
          rerender();
        } else addFor(d);
      } catch (err) { showError(err); }
    }));
  }));
  el.querySelector('#av-note').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/availability/note', { method: 'PUT', body: { user_id: userId, note: e.target.note.value } }); toast('Note saved'); } catch (err) { showError(err); }
  });
}

// --- Creating or changing a repeating pattern ---

async function renderPattern(ctx, tabsHtml) {
  const { el, state, query, navigate } = ctx;
  const data = await api(`/availability/calendar${qs({ user_id: query.user })}`);
  if (ctx.stale()) return;
  const existing = query.pattern === 'new' ? null : data.patterns.find((p) => String(p.id) === query.pattern);
  const me = data.user.id === state.user.id;
  const back = () => navigate(`timeoff${qs({ tab: 'availability', user: me ? undefined : data.user.id, month: query.month })}`);
  const start = { start_date: existing?.start_date ?? todayISO(), end_date: existing?.end_date ?? '', weeks: existing?.weeks ?? 1, slots: (existing?.slots ?? []).map((s) => ({ ...s })) };
  const p = { ...start, slots: start.slots.map((s) => ({ ...s })) };

  el.innerHTML = `
    <div class="page-head"><h1>Repeating pattern – ${esc(data.user.name)}</h1></div>
    ${tabsHtml}
    <div class="av-pattern-top">
      <label class="field"><span>From</span><input type="date" id="pt-from" value="${p.start_date}" required></label>
      <label class="field"><span>To <small class="muted">(optional)</small></span><input type="date" id="pt-to" value="${p.end_date}"></label>
      <div class="field"><span>Frequency</span><div class="seg" role="group" aria-label="Repeats every">
        ${[1, 2, 4].map((w) => `<button type="button" data-weeks="${w}">${w} week${w === 1 ? '' : 's'}</button>`).join('')}</div></div>
    </div>
    <div id="pt-weeks"></div>
    <p class="form-error" hidden></p>
    <div class="actions">
      <button class="btn btn-primary" id="pt-save">${existing ? 'Save pattern' : 'Create pattern'}</button>
      <button class="btn btn-ghost" id="pt-cancel">Cancel</button>
      <button class="link-btn" id="pt-reset">Reset</button>
    </div>`;
  const weeksBox = el.querySelector('#pt-weeks');
  const draw = () => {
    el.querySelectorAll('[data-weeks]').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.weeks) === p.weeks));
    weeksBox.innerHTML = Array.from({ length: p.weeks }, (_, w) => `<h3 class="group-title">Week ${w + 1}</h3>
      <div class="av-cal av-cal-week">
        ${WEEKDAYS.map((d) => `<div class="av-dow">${d}</div>`).join('')}
        ${WEEKDAYS.map((_, wd) => `<div class="av-day">
          <div class="av-chips">${p.slots.map((s, i) => [s, i]).filter(([s]) => s.week === w && s.weekday === wd).map(([s, i]) => chip(s, `data-slot="${i}"`)).join('')}</div>
          <button type="button" class="av-add" data-slot-add="${w}|${wd}" aria-label="Add to week ${w + 1} ${LONG_DAYS[wd]}">+</button></div>`).join('')}
      </div>`).join('');
    weeksBox.querySelectorAll('[data-slot-add]').forEach((b) => b.addEventListener('click', () => {
      const [w, wd] = b.dataset.slotAdd.split('|').map(Number);
      availabilityDialog({
        title: 'Add to the pattern',
        subtitle: `${p.weeks > 1 ? `Week ${w + 1}, ` : ''}every ${LONG_DAYS[wd]}`,
        done: async (v) => {
          if (v.all_day) p.slots = p.slots.filter((s) => !(s.week === w && s.weekday === wd));
          else p.slots = p.slots.filter((s) => !(s.week === w && s.weekday === wd && s.all_day));
          for (const r of v.all_day ? [{}] : v.ranges) p.slots.push({ week: w, weekday: wd, kind: v.kind, all_day: v.all_day, from_time: r.from_time ?? null, to_time: r.to_time ?? null });
          draw();
        },
      });
    }));
    weeksBox.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
      p.slots.splice(Number(b.dataset.slot), 1);
      draw();
    }));
  };
  el.querySelectorAll('[data-weeks]').forEach((b) => b.addEventListener('click', () => {
    p.weeks = Number(b.dataset.weeks);
    p.slots = p.slots.filter((s) => s.week < p.weeks);
    draw();
  }));
  el.querySelector('#pt-reset').addEventListener('click', () => {
    Object.assign(p, { ...start, slots: start.slots.map((s) => ({ ...s })) });
    el.querySelector('#pt-from').value = p.start_date;
    el.querySelector('#pt-to').value = p.end_date;
    draw();
  });
  el.querySelector('#pt-cancel').addEventListener('click', back);
  el.querySelector('#pt-save').addEventListener('click', async () => {
    const err = el.querySelector('.form-error');
    err.hidden = true;
    const body = { user_id: data.user.id, start_date: el.querySelector('#pt-from').value, end_date: el.querySelector('#pt-to').value || null, weeks: p.weeks, slots: p.slots };
    try {
      await api(existing ? `/availability/patterns/${existing.id}` : '/availability/patterns', { method: existing ? 'PUT' : 'POST', body });
      toast(existing ? 'Pattern saved' : 'Pattern created');
      back();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  draw();
  if (!p.slots.length) weeksBox.insertAdjacentHTML('beforebegin', '<p class="muted small" id="pt-hint">Tap + on a day to add when you’re unavailable (or available) every week. Tap something you’ve added to remove it.</p>');
}

// --- Team availability (managers): the next two weeks ---

export async function renderTeam(ctx, tabsHtml) {
  const { el } = ctx;
  const data = await api('/availability');
  if (ctx.stale()) return;
  const dates = [];
  for (let d = data.from; d <= data.to; d = addDays(d, 1)) dates.push(d);
  const onHoliday = (p, d) => p.holiday.some((h) => h.start_date <= d && h.end_date >= d);
  let site = null;
  el.innerHTML = `
    <div class="page-head"><h1>Time off</h1></div>
    ${tabsHtml}
    <section class="card">
      <h2>Availability · next two weeks</h2>
      <div class="table-wrap"><table class="avail-table av-team">
        <thead><tr><th>Person</th>${dates.map((d) => `<th>${fmtDate(d, { weekday: 'short' })}<small>${fmtDate(d, { day: 'numeric', month: 'short' })}</small></th>`).join('')}</tr></thead>
        <tbody>${data.people.map((p) => {
          const group = p.location_name !== site ? `<tr class="avail-group"><th colspan="${dates.length + 1}">${esc(p.location_name ?? 'No home site')}</th></tr>` : '';
          site = p.location_name;
          return `${group}<tr><th><a href="#/timeoff${qs({ tab: 'availability', user: p.id })}">${esc(p.name)}</a>${p.note ? `<small>${esc(p.note)}</small>` : ''}</th>
            ${dates.map((d) => `<td>${onHoliday(p, d) ? '<span class="av-chip av-holiday">Holiday</span>' : (p.days[d] ?? []).map((a) => chip(a, 'disabled')).join('')}</td>`).join('')}</tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="muted small">Everyone sets this under Time off → My availability (tap a name to see or change theirs). Blank = nothing said, so available. It’s shown on the rota too.</p>
    </section>`;
}
