import { addDays, api, esc, fmtDate, fmtDateTime, money, qs, showError, todayISO, toast, weekStart } from '../lib.js';

// Rota → Sales budget: for a week, each site's forecast net sales for each day (a guide – the average for that weekday
// over recent weeks) and a budget to set for each day (e.g. higher on a Saturday with an event on). Where a budget is
// set, the rota and Rota costs use it instead of the forecast, for labour % and the labour budget.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const whole = (n) => (n === null || n === undefined ? '–' : `£${Math.round(n).toLocaleString('en-GB')}`);

export async function render(ctx) {
  const { el, query, stale, navigate } = ctx;
  const week = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(query.week ?? '') ? query.week : todayISO());
  const data = await api(`/sales-budgets${qs({ week })}`);
  if (stale()) return;
  const thisWeek = weekStart(todayISO());
  const weekEnd = addDays(week, 6);
  const go = (w) => navigate(`rota/budget${qs({ week: w === thisWeek ? undefined : w })}`);
  const used = (s, i, budget = s.budget[i]) => (budget ?? s.forecast[i]);

  // On a phone the days run down the page (one row each), so the budget boxes are big enough to type in.
  const phone = window.matchMedia('(max-width: 700px)').matches;
  const input = (s, b, i) => `<input class="qty-input sb-input" type="number" min="0" step="1" inputmode="decimal" data-day="${i}" value="${b ?? ''}" placeholder="${s.forecast[i] === null ? '' : Math.round(s.forecast[i])}" aria-label="${esc(s.name)} sales budget ${DAYS[i]}">`;
  const forecastWeek = (s) => (s.forecast.some((f) => f !== null) ? whole(s.forecast.reduce((t, f) => t + (f ?? 0), 0)) : '–');
  const phoneTable = (s) => `<ul class="sb-days">${data.days.map((d, i) => `<li class="sb-day">
        <div class="sb-day-info"><strong>${DAYS[i]} <span>${fmtDate(d.date, { day: 'numeric', month: 'short' })}</span></strong>
          ${d.bank_holiday ? `<small class="bank-hol">${esc(d.bank_holiday)}</small>` : ''}
          <small>Forecast ${whole(s.forecast[i])}</small><small>Labour <span data-labour="${i}"></span></small></div>
        <label class="sb-day-input"><span aria-hidden="true">£</span>${input(s, s.budget[i], i)}</label>
      </li>`).join('')}</ul>
    <dl class="sb-totals">
      <div><dt>Week budget</dt><dd class="sb-week"></dd></div>
      <div><dt>Forecast</dt><dd>${forecastWeek(s)}</dd></div>
      <div><dt>Labour ${data.target_pct}%</dt><dd data-labour="week"></dd></div>
    </dl>`;
  const siteCard = (s) => `<section class="card sb-site" data-site="${s.id}">
    <header class="sb-head"><h2>${esc(s.name)}</h2>
      <div class="actions"><button type="button" class="btn btn-small" data-copy="${s.id}" title="Start the budget from the forecast, to change the days you know will be different">Copy forecast into budget</button>
        <button type="button" class="btn btn-small btn-ghost" data-clear="${s.id}">Clear</button></div></header>
    ${phone ? phoneTable(s) : `<div class="table-wrap"><table class="sb-table">
      <thead><tr><th></th>${data.days.map((d, i) => `<th class="num">${DAYS[i]}<small>${fmtDate(d.date, { day: 'numeric', month: 'short' })}</small>${d.bank_holiday ? `<small class="bank-hol">${esc(d.bank_holiday)}</small>` : ''}</th>`).join('')}<th class="num">Week</th></tr></thead>
      <tbody>
        <tr class="sb-forecast"><th>Forecast net sales<small>average for the day</small></th>${s.forecast.map((f) => `<td class="num">${whole(f)}</td>`).join('')}<td class="num">${forecastWeek(s)}</td></tr>
        <tr class="sb-budget"><th>Sales budget (net)<small>leave blank to use the forecast</small></th>${s.budget.map((b, i) => `<td class="num">${input(s, b, i)}</td>`).join('')}<td class="num sb-week"></td></tr>
        <tr class="sb-labour"><th>Labour budget<small>${data.target_pct}% of the sales above</small></th>${s.budget.map((_, i) => `<td class="num" data-labour="${i}"></td>`).join('')}<td class="num" data-labour="week"></td></tr>
      </tbody>
    </table></div>`}
    ${phone ? '<p class="muted small">All net sales. Leave a day blank to use the forecast.</p>' : ''}
    <footer class="sb-foot"><span class="sb-status small"></span>
      <button type="button" class="btn btn-small btn-primary" data-publish="${s.id}">Publish ${esc(s.name)}</button></footer>
  </section>`;

  el.innerHTML = `<div class="page-head"><h1>Sales budget</h1></div>
    <div class="week-nav">
      <label class="btn week-pick" title="Pick a week"><span aria-hidden="true">📅</span><span class="sr-only">Pick a week</span>
        <input type="date" id="week-pick" value="${week}" aria-label="Pick a week"></label>
      <div class="week-step">
        <button class="btn btn-ghost" data-week="-7" aria-label="Previous week">‹</button>
        <strong>${fmtDate(week, { day: 'numeric', month: 'short' })} – ${fmtDate(weekEnd, { day: 'numeric', month: 'short', year: 'numeric' })}</strong>
        <button class="btn btn-ghost" data-week="7" aria-label="Next week">›</button>
      </div>
      ${week !== thisWeek ? `<button class="btn btn-small btn-ghost" data-week="0">${week < thisWeek ? 'Back to this week' : 'This week'}</button>` : ''}
    </div>
    <${phone ? 'details class="sb-intro"><summary>How the sales budget works</summary><p class="muted">' : 'p class="muted">'}The forecast is a guide: each weekday’s average <strong>net sales</strong> (after discounts, excluding VAT) over the ${data.forecast_weeks} weeks to ${fmtDate(data.forecast_to)}, leaving out bank holidays and days with no sales.
      Set a budget for any day you know will be different – an event on a Saturday, say. Once you publish a site’s budget, the rota uses it (for labour % and the ${data.target_pct}% labour budget), and the forecast for days left blank. Publish one site at a time, or every site with changes using Publish budget.</p>${phone ? '</details>' : ''}
    <form id="sb-form">
      ${data.sites.map(siteCard).join('')}
      <div class="actions sb-save"><span class="topbar-gap"></span><a class="btn" href="#/rota${qs({ view: 'week', week })}">Open this week’s rota</a><button type="submit" class="btn btn-primary">Publish budget</button></div>
    </form>`;

  const form = el.querySelector('#sb-form');
  const site = (card) => data.sites.find((s) => s.id === Number(card.dataset.site));
  const valuesOf = (card) => [...card.querySelectorAll('.sb-input')].map((i) => (i.value === '' ? null : Number(i.value)));
  const isChanged = (card) => valuesOf(card).some((v, i) => v !== (site(card).budget[i] ?? null));
  // Publishes some sites' budgets (the rota uses them from then on), keeping anything typed for the others.
  const publish = async (cards) => {
    await api('/sales-budgets', { method: 'PUT', body: { week, sites: cards.map((card) => ({ id: Number(card.dataset.site), budget: valuesOf(card) })) } });
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    for (const card of cards) Object.assign(site(card), { budget: valuesOf(card), updated_by: ctx.state.user.name, updated_at: now });
    cards.forEach(refresh);
  };
  const refresh = (card) => {
    const s = site(card);
    const inputs = [...card.querySelectorAll('.sb-input')];
    const vals = inputs.map((i, d) => used(s, d, i.value === '' ? null : Number(i.value)));
    const week = vals.some((v) => v !== null && v !== undefined) ? vals.reduce((t, v) => t + (v ?? 0), 0) : null;
    const budgeted = inputs.filter((i) => i.value !== '').length;
    card.querySelector('.sb-week').innerHTML = `${whole(week)}${budgeted && budgeted < 7 ? '<small>incl. forecast</small>' : ''}`;
    vals.forEach((v, d) => { card.querySelector(`[data-labour="${d}"]`).textContent = v === null || v === undefined ? '–' : money(v * data.target_pct / 100); });
    card.querySelector('[data-labour="week"]').textContent = week === null ? '–' : money(week * data.target_pct / 100);
    inputs.forEach((i) => i.closest('td, .sb-day-input')?.classList.toggle('is-set', i.value !== ''));
    // Published or not: the rota only uses a budget once it's published.
    const changed = isChanged(card);
    card.classList.toggle('is-changed', changed);
    card.querySelector('.sb-status').innerHTML = changed ? '<strong class="tone-warn">● Not published yet</strong> – the rota uses the last published budget until you publish'
      : s.updated_at ? `<span class="muted">✓ Published by ${esc(s.updated_by ?? 'someone')} · ${fmtDateTime(s.updated_at)}</span>`
        : '<span class="muted">No budget published – the rota uses the forecast</span>';
    card.querySelector('[data-publish]').disabled = !changed;
  };
  form.querySelectorAll('.sb-site').forEach(refresh);
  form.addEventListener('input', (e) => { if (e.target.matches('.sb-input')) refresh(e.target.closest('.sb-site')); });
  form.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const card = b.closest('.sb-site');
    const s = site(card);
    card.querySelectorAll('.sb-input').forEach((i, d) => { if (s.forecast[d] !== null) i.value = Math.round(s.forecast[d]); });
    refresh(card);
  }));
  form.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
    const card = b.closest('.sb-site');
    card.querySelectorAll('.sb-input').forEach((i) => { i.value = ''; });
    refresh(card);
  }));
  form.querySelectorAll('[data-publish]').forEach((b) => b.addEventListener('click', async () => {
    const card = b.closest('.sb-site');
    b.disabled = true;
    try { await publish([card]); toast(`${site(card).name}’s budget is published – the rota now uses it`); } catch (err) { showError(err); refresh(card); }
  }));
  // Publish budget: every site with changes.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cards = [...form.querySelectorAll('.sb-site')].filter(isChanged);
    if (!cards.length) { toast('Nothing new to publish'); return; }
    try {
      await publish(cards);
      toast(cards.length === 1 ? `${site(cards[0]).name}’s budget is published – the rota now uses it` : `Published the budget for ${cards.length} sites – the rota now uses it`);
    } catch (err) { showError(err); }
  });
  el.querySelectorAll('[data-week]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.week);
    go(n ? addDays(week, n) : thisWeek);
  }));
  const layout = window.matchMedia('(max-width: 700px)');
  const relayout = () => { if (!el.isConnected) layout.removeEventListener('change', relayout); else if (layout.matches !== phone) ctx.rerender(); };
  layout.addEventListener('change', relayout);
  const pick = el.querySelector('#week-pick');
  pick.addEventListener('click', () => { try { pick.showPicker(); } catch { /* the browser opens its own picker */ } });
  pick.addEventListener('change', () => { if (pick.value) go(weekStart(pick.value)); });
}
