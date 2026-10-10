import { api, esc, fmtDate, openModal, toast } from '../lib.js';
import { toBase64 } from './mybrew.js';

// Rota → Read a rota (admins): upload a photo or PDF of a rota, Claude reads it, and every shift it found is shown
// for checking – who, where, when, and anything it's unsure of – before the ticked ones are added as drafts.

const MAX_MB = 10;
const STATUS = {
  ready: ['✓ Ready to add', 'ri-ready'],
  check: ['⚠ Check this', 'ri-check'],
  clash: ['✕ Double-booked', 'ri-clash'],
  holiday: ['✕ On holiday', 'ri-clash'],
  exists: ['= Already on the rota', 'ri-exists'],
};
// Shifts just added from a rota, highlighted when the rota is drawn.
export const justImported = new Set();

// Big photos are scaled down (longest side 2400px) so they upload quickly but stay sharp enough to read.
async function prepare(file) {
  if (file.type === 'application/pdf' || file.size < 3 * 1024 * 1024) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That photo couldn’t be opened – use a JPEG, PNG or PDF')); i.src = url; });
    const scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Opens the upload step. location: a site id or 'all'; week: its Monday; onDone: redraw the rota. */
export function openRotaImport({ location, week, onDone }) {
  const { form } = openModal({
    title: '✨ Read a rota with Claude',
    body: `<p>Upload a photo or PDF of a rota – printed, handwritten or a spreadsheet. Claude reads it, matches the names to your team and shows you every shift it found for <strong>w/c ${esc(fmtDate(week, { day: 'numeric', month: 'long' }))}</strong>.</p>
      <p class="muted small">Nothing is added until you’ve checked it. Shifts go in as drafts, so staff don’t see them until you publish.</p>
      <label class="ri-drop"><input type="file" name="file" accept="image/*,application/pdf" required>
        <span class="ri-drop-text">📄 Choose a photo or PDF</span><span class="ri-file muted small"></span></label>
      <p class="ri-reading" hidden><span class="ri-spinner" aria-hidden="true"></span> Claude is reading your rota – this can take up to a minute…</p>`,
    submitLabel: 'Read the rota',
    onSubmit: async (_v, f) => {
      const file = f.querySelector('[name=file]').files[0];
      if (!file) throw new Error('Choose a photo or PDF of the rota');
      if (!/^image\/|application\/pdf/.test(file.type)) throw new Error('Choose a photo (JPEG, PNG) or a PDF');
      if (file.size > MAX_MB * 1024 * 1024 * 3) throw new Error(`That file is too big – keep it under ${MAX_MB} MB`);
      f.querySelector('.ri-reading').hidden = false;
      const ready = await prepare(file);
      if (ready.size > MAX_MB * 1024 * 1024) throw new Error(`That file is too big – keep it under ${MAX_MB} MB`);
      const reading = await api('/rota/import/read', { method: 'POST', body: { file_name: ready.name, media_type: ready.type, data: await toBase64(ready), location_id: location, week } });
      setTimeout(() => review(reading, onDone), 0);
    },
  });
  const input = form.querySelector('[name=file]');
  input.addEventListener('change', () => { form.querySelector('.ri-file').textContent = input.files[0]?.name ?? ''; });
}

function review(reading, onDone) {
  const { proposals, team, sites } = reading;
  if (!proposals.length) {
    openModal({ title: 'No shifts found', body: `<p>Claude couldn’t find any shifts on that rota.</p>${reading.notes ? `<p class="notice">${esc(reading.notes)}</p>` : ''}` });
    return;
  }
  const count = (st) => proposals.filter((p) => st.includes(p.status)).length;
  const days = [...new Set(proposals.map((p) => p.date))].sort();
  const options = (list, chosen, blank) => `${blank ? `<option value="">${blank}</option>` : ''}${list.map((o) => `<option value="${o.id}" ${o.id === chosen ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}`;
  const row = (p) => {
    const [label, tone] = STATUS[p.status] ?? STATUS.check;
    return `<li class="ri-row ${tone}" data-key="${p.key}">
      <label class="ri-tick"><input type="checkbox" data-tick ${p.status === 'ready' ? 'checked' : ''} ${p.status === 'exists' ? 'disabled' : ''} aria-label="Add this shift"></label>
      <div class="ri-fields">
        <select data-f="user_id" aria-label="Person" class="${p.user_id ? '' : 'ri-missing'}">${options(team, p.user_id, 'Choose who…')}</select>
        ${sites.length > 1 ? `<select data-f="location_id" aria-label="Site" class="${p.location_id ? '' : 'ri-missing'}">${options(sites, p.location_id, 'Choose a site…')}</select>` : ''}
        <span class="ri-times"><input type="time" data-f="start_time" value="${esc(/^\d\d:\d\d$/.test(p.start_time) ? p.start_time : '')}" aria-label="Start"> – <input type="time" data-f="end_time" value="${esc(/^\d\d:\d\d$/.test(p.end_time) ? p.end_time : '')}" aria-label="End">
          <input type="number" data-f="break_minutes" value="${p.break_minutes || 0}" min="0" max="600" step="5" aria-label="Break minutes" title="Break (minutes)"><small>min break</small></span>
      </div>
      <div class="ri-about"><span class="ri-status">${label}</span>
        ${p.problem ? `<small>${esc(p.problem)}</small>` : ''}
        <small class="muted">Read as “${esc(p.written_as)}”${p.position ? ` · ${esc(p.position)}` : ''}${p.notes ? ` · ${esc(p.notes)}` : ''}</small></div>
    </li>`;
  };
  const { form } = openModal({
    title: `Claude found ${proposals.length} shift${proposals.length === 1 ? '' : 's'}`,
    wide: true,
    body: `<div class="ri-summary">
        <span class="ri-chip ri-ready">✓ ${count(['ready'])} ready</span>
        ${count(['check']) ? `<span class="ri-chip ri-check">⚠ ${count(['check'])} to check</span>` : ''}
        ${count(['clash', 'holiday']) ? `<span class="ri-chip ri-clash">✕ ${count(['clash', 'holiday'])} won’t fit</span>` : ''}
        ${count(['exists']) ? `<span class="ri-chip ri-exists">= ${count(['exists'])} already on the rota</span>` : ''}
      </div>
      ${reading.demo ? '<p class="notice">Demo – this is a pretend reading. In the live app Claude reads the rota you upload.</p>' : ''}
      ${reading.notes ? `<p class="notice">🗒 Claude’s notes: ${esc(reading.notes)}</p>` : ''}
      <p class="muted small">Ticked shifts will be added as drafts. Fix anything marked ⚠ (choose the person, site or times), then tick it. Double-booked shifts are skipped unless you change them.</p>
      ${days.map((d) => `<section class="ri-day"><h3>${/^\d{4}-\d{2}-\d{2}$/.test(d) ? esc(fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })) : 'Day not clear'}</h3>
        <ul class="ri-list">${proposals.filter((p) => p.date === d).map(row).join('')}</ul></section>`).join('')}`,
    submitLabel: 'Add ticked shifts',
    onSubmit: async (_v, f) => {
      const picked = [...f.querySelectorAll('.ri-row')].filter((li) => li.querySelector('[data-tick]').checked).map((li) => {
        const p = proposals.find((x) => x.key === Number(li.dataset.key));
        const val = (k) => li.querySelector(`[data-f="${k}"]`)?.value;
        return { ...p, user_id: Number(val('user_id')) || null, location_id: sites.length > 1 ? Number(val('location_id')) || null : p.location_id ?? sites[0]?.id,
          start_time: val('start_time'), end_time: val('end_time'), break_minutes: Number(val('break_minutes')) || 0 };
      });
      if (!picked.length) throw new Error('Tick the shifts to add');
      const missing = picked.find((p) => !p.user_id || !p.location_id || !p.start_time || !p.end_time);
      if (missing) throw new Error(`Choose the person, site and times for every ticked shift (“${missing.written_as}”)`);
      const r = await api('/rota/import/apply', { method: 'POST', body: { shifts: picked } });
      r.ids.forEach((id) => justImported.add(id));
      toast(`Added ${r.added} shift${r.added === 1 ? '' : 's'} as drafts – highlighted on the rota. Check them, then publish.${r.skipped.length ? ` ${r.skipped.length} skipped: ${r.skipped.map((s) => s.problem).slice(0, 2).join('; ')}` : ''}`);
      onDone();
    },
  });
  // Choosing the person or times for a row ticks it.
  form.querySelectorAll('.ri-row').forEach((li) => li.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
    const tick = li.querySelector('[data-tick]');
    if (!tick.disabled) tick.checked = true;
    li.querySelectorAll('select').forEach((s) => s.classList.toggle('ri-missing', !s.value));
  })));
}
