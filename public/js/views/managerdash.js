import { addDays, api, esc, fmtDate, money, qs, siteScope, todayISO } from '../lib.js';
import { ROSTER, shortName } from './dashboard.js';

// Manager Dashboard: one site's day at a glance for the person running it – how today's trading and labour are
// going, who's in, and a "Needs you" list of everything waiting on them (requests, checks, the rota, orders, stock,
// training, reviews and enquiries), each linking to where it's done. The HQ Dashboard is every site side by side.

const TARGET = 30;
const mondayOf = (d) => { const day = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; return addDays(d, -day); };
const pctText = (p) => (p === null || p === undefined ? '–' : `${Math.round(p * 10) / 10}%`);
const daysSince = (sqlUtc) => Math.floor((Date.now() - Date.parse(`${sqlUtc.replace(' ', 'T')}Z`)) / 86400000);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Labour against the target, in words as well as colour.
const labourTone = (p) => (p === null || p === undefined ? ['', ''] : p > TARGET + 5 ? ['md-bad', 'over target'] : p > TARGET ? ['md-warn', 'just over target'] : ['md-good', 'on target']);

export async function render(ctx) {
  const { el, state, query, stale, navigate } = ctx;
  // Always one site: the one picked at the top (?scope=), otherwise their home site – not whichever site they last
  // looked at elsewhere in Atlas.
  const home = state.locations.some((l) => l.id === state.user.location_id && l.active) ? state.user.location_id : state.locationId;
  const picked = Number(query.scope);
  const site = picked && state.locations.some((l) => l.id === picked && l.active) ? picked : home;
  // Picking a site here also makes it the chosen site for the rest of Atlas, as the site pickers elsewhere do.
  if (picked === site && site !== state.locationId) siteScope(state, String(site), 'site');
  const can = (...p) => p.some((x) => state.can(x));
  const today = todayISO();
  const week = mondayOf(today);
  const nextWeek = addDays(week, 7);
  const loc = { location_id: site };

  const want = {
    day: api(`/dashboard${qs(loc)}`),
    costs: can('sales.view') ? api(`/reports/rota-costs${qs({ ...loc, week })}`) : null,
    rota: can('rota.edit') ? api(`/rota${qs({ ...loc, week })}`) : null,
    rotaNext: can('rota.edit') ? api(`/rota${qs({ ...loc, week: nextWeek })}`) : null,
    leave: can('leave.manage') ? api('/leave/pending-count') : null,
    drops: can('rota.publish') ? api('/shift-drops') : null,
    designs: can('people.manage') ? api('/training/designs') : null,
    assigned: can('people.manage') ? api(`/training/assignments${qs(loc)}`) : null,
    reviews: can('people.manage') ? api(`/performance${qs(loc)}`) : null,
    events: can('events.manage') ? api('/events/unread') : null,
  };
  // Each part loads on its own: one that fails just leaves its bit out.
  const keys = Object.keys(want);
  const settled = await Promise.allSettled(keys.map((k) => want[k]));
  if (stale()) return;
  const got = Object.fromEntries(keys.map((k, i) => [k, settled[i].status === 'fulfilled' ? settled[i].value : null]));
  const card = got.day?.locations?.[0] ?? null;
  const siteName = card?.name ?? state.locations.find((l) => l.id === site)?.name ?? 'Your site';
  const hour = new Date().getHours();

  // ---- Needs you ----
  const needs = [];
  const add = (tone, icon, text, href) => needs.push({ tone, icon, text, href });
  if (card) {
    const daily = card.daily;
    if (daily.fails) add('bad', '✕', `${plural(daily.fails, 'check')} failed today`, '#/safety');
    const left = daily.due - daily.done;
    if (left > 0) add(hour >= 15 ? 'bad' : 'warn', '✓', `${plural(left, 'daily check')} still to do today (${daily.done} of ${daily.due} done)`, '#/safety');
    const weeklyLeft = card.weekly.due - card.weekly.done;
    if (weeklyLeft > 0) add('warn', '✓', `${plural(weeklyLeft, 'weekly check')} still to do this week`, '#/safety');
    for (const p of card.roster ?? []) {
      if (p.status === 'late') add('bad', '⏰', `${shortName(p.name)} hasn’t clocked in – shift started at ${p.rota.split('–')[0]}`, '#/dashboard');
      if (p.status === 'missed') add('bad', '⏰', `${shortName(p.name)} didn’t clock in for ${p.rota}`, '#/dashboard');
    }
    if (card.orders_draft) add('warn', '🧾', `${plural(card.orders_draft, 'draft order')} not sent yet`, '#/orders');
    if (card.stock_take_in_progress) add('warn', '📦', 'A stock take is in progress – finish it off', '#/stock');
    else if (!card.last_stock_take) add('warn', '📦', 'No stock take done yet', '#/stock');
    else if (daysSince(card.last_stock_take) >= 7) add('warn', '📦', `Last stock take was ${daysSince(card.last_stock_take)} days ago`, '#/stock');
  }
  const pendingLeave = got.leave?.count ?? 0;
  if (pendingLeave) add('warn', '☀', `${plural(pendingLeave, 'holiday request')} to approve`, '#/rota/requests');
  const drops = (got.drops?.to_approve ?? []).filter((d) => d.location_id === site);
  const pickUps = drops.filter((d) => d.kind === 'claim' || d.status === 'claim_pending').length;
  if (drops.length - pickUps) add('warn', '⇄', `${plural(drops.length - pickUps, 'shift drop request')} to decide`, '#/rota/requests');
  if (pickUps) add('warn', '✋', `${plural(pickUps, 'shift pick-up')} to approve`, '#/rota/requests');
  if (got.rota?.unpublished) add('warn', '◷', `${plural(got.rota.unpublished, 'rota change')} this week not published yet`, `#/rota${qs({ week })}`);
  if (got.rotaNext) {
    if (!got.rotaNext.shifts.length) add(new Date().getDay() >= 4 || new Date().getDay() === 0 ? 'bad' : 'warn', '◷', 'Next week’s rota hasn’t been started', `#/rota${qs({ week: nextWeek })}`);
    else if (got.rotaNext.unpublished) add('warn', '◷', `Next week’s rota has ${plural(got.rotaNext.unpublished, 'change')} not published yet`, `#/rota${qs({ week: nextWeek })}`);
  }
  const signoffs = (got.designs?.signoffs ?? []).filter((w) => !w.location_id || w.location_id === site).length;
  if (signoffs) add('warn', '🎓', `${plural(signoffs, 'training sign-off')} waiting for you`, '#/people/training/elearning');
  const lateTraining = (got.assigned?.people ?? []).filter((p) => p.courses.some((c) => c.status !== 'done' && c.status !== 'awaiting_signoff' && c.due_on && c.due_on < today)).length;
  if (lateTraining) add('bad', '🎓', `${plural(lateTraining, 'person', 'people')} overdue on training`, '#/people/training/assign?show=late');
  const lateReviews = (got.reviews ?? []).filter((p) => p.overdue).length;
  if (lateReviews) add('warn', '★', `${plural(lateReviews, 'review')} overdue`, '#/people/performance');
  if (got.events?.count) add('warn', '✉', `${plural(got.events.count, 'event enquiry', 'event enquiries')} to read`, '#/events/enquiries');
  needs.sort((a, b) => (a.tone === 'bad' ? 0 : 1) - (b.tone === 'bad' ? 0 : 1));

  // ---- Today's numbers ----
  const tiles = [];
  if (card && card.gross_today !== undefined) {
    const now = card.gross_today ?? 0;
    const then = card.last_week?.gross;
    const diff = then ? Math.round(((now - then) / then) * 100) : null;
    tiles.push(`<div class="md-tile"><span>Sales today</span><strong>${money(now)}</strong>
      <small>${diff === null ? 'nothing to compare with last week' : `${diff >= 0 ? '▲' : '▼'} ${Math.abs(diff)}% ${diff >= 0 ? 'up on' : 'down on'} this time last week`}</small></div>`);
    const [tone, word] = labourTone(card.labour_pct_today);
    tiles.push(`<div class="md-tile"><span>Labour today</span><strong class="${tone}">${pctText(card.labour_pct_today)}</strong>
      <small>${card.labour_pct_today === null ? 'no sales yet today' : `${word} · ${money(card.labour_cost_today)} ${card.labour_basis === 'clocked' ? 'clocked' : 'rostered'} so far`}</small></div>`);
  }
  if (got.costs) {
    const t = got.costs.totals;
    const [tone, word] = labourTone(t.labour_pct);
    tiles.push(`<div class="md-tile"><span>This week’s rota</span><strong class="${tone}">${pctText(t.labour_pct)}</strong>
      <small>${t.labour_pct === null ? 'no forecast yet' : `${word} · ${money(t.cost)} vs ${money(t.sales_budget)} ${t.budgeted ? 'budget' : 'forecast'}`}</small></div>`);
  }
  if (card) {
    const d = card.daily;
    tiles.push(`<div class="md-tile"><span>Checks today</span><strong class="${d.fails ? 'md-bad' : d.done >= d.due ? 'md-good' : ''}">${d.done} / ${d.due}</strong>
      <small>${d.fails ? `${plural(d.fails, 'failed check')}` : d.done >= d.due ? 'all done' : `${d.due - d.done} to go`}</small></div>`);
  }

  // ---- This week, day by day (labour % of forecast on the rota) ----
  const weekRow = got.costs ? `<section class="card md-week"><h2>This week on the rota</h2>
      <p class="muted small">Rota cost as a share of each day’s forecast sales (target ${TARGET}%).</p>
      <ol class="md-days">${got.costs.days.map((d) => {
        const [tone, word] = labourTone(d.labour_pct);
        return `<li class="${d.date === today ? 'is-today' : ''}"><a href="#/rota${qs({ view: 'day', day: d.date })}">
          <span>${fmtDate(d.date, { weekday: 'short' })}</span><strong class="${tone}">${pctText(d.labour_pct)}</strong>
          <small>${d.labour_pct === null ? 'no forecast' : word}</small><small class="muted">${money(d.cost)}</small></a></li>`;
      }).join('')}</ol></section>` : '';

  // ---- Who's on today ----
  const roster = card?.roster ?? null;
  const onToday = roster ? (roster.length ? `<table class="md-roster"><tbody>${roster.map((p) => {
      const [label, tone] = ROSTER[p.status] ?? ['', ''];
      return `<tr class="roster-row ${tone}"><td><strong>${esc(shortName(p.name))}</strong></td><td>${esc(p.rota ?? '–')}</td><td>${p.clock ? esc(p.clock) : '<span class="muted">–</span>'}</td><td><span class="roster-status">${label}</span></td></tr>`;
    }).join('')}</tbody></table>` : '<p class="muted">Nobody on the rota today.</p>')
    : card?.shifts_today?.length ? `<ul class="md-shifts">${card.shifts_today.map((s) => `<li><strong>${esc(shortName(s.name))}</strong> ${s.start_time}–${s.end_time}${s.sick ? ' <span class="muted">(sick)</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">Nobody on the rota today.</p>';

  el.innerHTML = `<div class="hip md">
    <div class="page-head"><h1 class="hub-title">Manager Dashboard</h1>
      ${state.multiSite ? `<form class="filters" id="md-site"><select name="scope" aria-label="Site">${state.locations.filter((l) => l.active).map((l) => `<option value="${l.id}" ${l.id === site ? 'selected' : ''}>${esc(l.name)}${l.id === state.user.location_id ? ' (home)' : ''}</option>`).join('')}</select></form>` : ''}</div>
    <p class="md-hello">${esc(siteName)} · ${fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    ${tiles.length ? `<div class="md-tiles">${tiles.join('')}</div>` : ''}
    <div class="md-grid">
      <section class="card md-needs"><h2>Needs you ${needs.length ? `<span class="badge">${needs.length}</span>` : ''}</h2>
        ${needs.length ? `<ul class="md-list">${needs.map((n) => `<li class="md-row-${n.tone}"><a href="${n.href}"><span class="md-icon" aria-hidden="true">${n.icon}</span>
          <span>${esc(n.text)}</span><span class="md-flag">${n.tone === 'bad' ? 'Urgent' : 'To do'}</span><span class="md-go" aria-hidden="true">›</span></a></li>`).join('')}</ul>`
          : '<p class="md-clear">✨ All clear – nothing waiting on you right now.</p>'}
      </section>
      <section class="card md-today"><h2>On today</h2>${onToday}
        ${card ? `<p class="muted small md-more">Wastage this week: ${money(card.wastage_7d)}${card.orders_sent ? ` · ${plural(card.orders_sent, 'order')} waiting for delivery` : ''}</p>` : ''}</section>
    </div>
    ${weekRow}
    ${state.can('dashboard.view') ? '<p class="muted small">Want every site side by side? <a href="#/dashboard">Open the HQ Dashboard</a>.</p>' : ''}
  </div>`;

  const form = el.querySelector('#md-site');
  form?.addEventListener('change', () => navigate(`manager${qs({ scope: form.scope.value })}`));
  form?.addEventListener('submit', (e) => { e.preventDefault(); navigate(`manager${qs({ scope: form.scope.value })}`); });
}
