import { api, esc, fmtDate, money, openModal, showError } from '../lib.js';

// Rota → Analyse this week's rota (admins): Claude compares the week's rota – published and draft – with forecast
// sales and the usual trade hour by hour, and suggests where labour could be saved. Nothing changes on the rota;
// "Show on rota" highlights the shifts a suggestion is about.

const KIND = {
  cut_shift: 'Drop a shift', shorten_shift: 'Shorten', start_later: 'Start later', finish_earlier: 'Finish earlier',
  move_shift: 'Move', cheaper_cover: 'Cheaper cover', other: 'Idea',
};
const CONFIDENCE = { high: 'Strong case', medium: 'Worth a look', low: 'Maybe' };
// Shifts to highlight when the rota is next drawn.
export const flaggedShifts = new Set();

const tone = (p, target) => (p === null ? '' : p > target + 5 ? 'ra-bad' : p > target ? 'ra-warn' : 'ra-good');
const pctText = (p) => (p === null ? '–' : `${Math.round(p * 10) / 10}%`);

/** location: a site id or 'all'; week: its Monday; onShow: redraw the rota (with flaggedShifts highlighted). */
export async function openRotaAnalysis({ location, week, onShow }) {
  const waiting = openModal({
    title: '📊 Analysing this week’s rota',
    body: `<p class="ri-reading"><span class="ri-spinner" aria-hidden="true"></span> Claude is comparing every shift with your forecast sales and usual trade by the hour – this can take a minute or two…</p>
      <p class="muted small">It looks at the rota as it stands, including draft changes that aren’t published yet. Nothing on the rota is changed.</p>`,
  });
  let r;
  try {
    r = await api('/rota/analyse', { method: 'POST', body: { location_id: location, week } });
  } catch (err) {
    waiting.close();
    showError(err);
    return;
  }
  waiting.close();
  const day = (d) => (d ? fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' }) : 'All week');
  const draftNote = (s) => (Math.abs(s.labour_cost - s.published_labour_cost) >= 1
    ? `<small class="muted">Published rota: ${money(s.published_labour_cost)} · with draft changes: ${money(s.labour_cost)}</small>` : '');
  const { form, close } = openModal({
    title: `📊 Rota analysis – w/c ${fmtDate(week, { day: 'numeric', month: 'long' })}`,
    wide: true,
    body: `<div class="ra">
      ${r.demo ? '<p class="notice">Demo – these suggestions come from simple rules. In the live app Claude reviews the rota.</p>' : ''}
      <p class="ra-headline">${esc(r.headline)}</p>
      <div class="ra-kpis">
        <div class="ra-kpi"><span>Possible saving</span><strong>${money(r.total_saving)}</strong><small>if you made every change below</small></div>
        ${r.sites.map((s) => `<div class="ra-kpi"><span>${esc(s.name)}</span><strong class="${tone(s.labour_pct, r.target_pct)}">${pctText(s.labour_pct)}</strong>
          <small>labour vs ${money(s.forecast_net_sales)} forecast net sales (target ${r.target_pct}%)</small>${draftNote(s)}</div>`).join('')}
      </div>
      <h3>Suggestions</h3>
      ${r.recommendations.length ? `<ol class="ra-list">${r.recommendations.map((x, i) => `<li class="ra-rec">
        <div class="ra-rec-head"><span class="ra-kind">${esc(KIND[x.kind] ?? 'Idea')}</span>
          <strong>${esc(x.title)}</strong>
          ${x.saving ? `<span class="ra-save">save ${money(x.saving)}</span>` : ''}</div>
        <p>${esc(x.reason)}</p>
        <small class="muted">${esc([x.site, day(x.date), CONFIDENCE[x.confidence]].filter(Boolean).join(' · '))}</small>
        ${x.shift_ids.length ? `<button type="button" class="btn btn-small" data-show="${i}">Show on rota</button>` : ''}
      </li>`).join('')}</ol>` : '<p class="muted">No savings to suggest – the rota already looks lean against the forecast.</p>'}
      ${r.watch_outs.length ? `<h3>Watch out for</h3><ul class="ra-watch">${r.watch_outs.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="muted small">These are suggestions only – nothing has been changed. Savings use each person’s hourly cost. Forecasts are the average of recent weeks (or your sales budget where set), so check for events, weather and bookings before you cut.</p>
    </div>`,
  });
  form.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
    const x = r.recommendations[Number(b.dataset.show)];
    flaggedShifts.clear();
    x.shift_ids.forEach((id) => flaggedShifts.add(id));
    close();
    onShow();
  }));
}
