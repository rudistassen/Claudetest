import { api, esc } from './lib.js';

// The guided tour: shown once, the first time someone signs in (and again from "Take the tour" in the menu). Each
// step lights up part of the page with a card explaining it; a step whose part isn't on this person's screen (they
// can't use it, or it's tucked away on a phone) is skipped, or shown as a card on its own.

let running = null;

const visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
};
const find = (sels) => (sels ?? []).map((s) => document.querySelector(s)).find(visible) ?? null;
// Waits for a page to draw its part (up to `ms`).
const waitFor = (sels, ms) => new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    const el = find(sels);
    if (el || Date.now() - started > ms) resolve(el);
    else setTimeout(tick, 100);
  };
  tick();
});

function stepsFor(state) {
  const first = (state.user?.name ?? '').split(' ')[0];
  const can = (...p) => p.some((x) => state.can(x));
  const manager = can('rota.publish', 'sales.view', 'leave.manage');
  return [
    { title: `Welcome to Atlas${first ? `, ${first}` : ''}! 👋`, text: 'Here’s a quick tour of the bits you’ll use most. It takes about a minute, and you can skip it any time.' },
    { go: 'mybrew', sels: ['.tabbar a[href="#/mybrew"]', '.topnav a[href="#/mybrew"]'], title: 'My Atlas is your home', text: 'Your shifts, your to-do list and the latest news, all in one place. Tap here any time to come back.' },
    { sels: ['.mb-shortcuts'], title: 'Shortcuts', text: 'Your next shift, open shifts you could pick up, time off, checks and more – one tap away.', optional: true },
    { sels: ['.mb-inbox'], title: 'Notifications 🔔', text: 'Everything Atlas tells you about – rota published, shift changes, holiday answers – lives here, with a button to the right page.', optional: true },
    { sels: ['#mb-push:not([hidden])'], title: 'Get them on your phone', text: 'Tap “Turn on notifications on this phone” so you never miss a rota or an open shift. On an iPhone, add Atlas to your Home Screen first.', optional: true },
    { go: 'rota', sels: ['.tabbar a[href="#/rota"]', '.topnav-btn[href="#/hub/rota-menu"]'], title: 'The rota', text: 'See who’s on and when. Your own shifts are under My shifts on My Atlas.', optional: true, need: () => can('rota.view', 'rota.edit') },
    { sels: ['.pd-datebar', '.week-nav'], title: 'Change the day or week', text: 'Use the arrows to move around, or tap the date to jump to one.', optional: true, need: () => can('rota.view', 'rota.edit') },
    { sels: ['.tabbar a[href="#/safety"]', '.topnav-btn[href="#/hub/trail"]'], title: 'Trail checks ✅', text: 'Your site’s food safety checks. Record readings and tick off each check – My Atlas tells you how many are left today.', optional: true },
    { go: 'timeoff', sels: ['#request'], title: 'Need a day off? 🌴', text: 'Request holiday here. You’ll get a notification when it’s approved. Use My availability to say when you can and can’t work.', optional: true },
    manager ? { title: 'For managers', text: 'Sales budget, Requests and Rota changes are under Rota → Admin, and your reports are under Reporting. The Manager Guide walks through your week.' } : null,
    { sels: ['.tabbar-menu', '.user-btn'], title: 'Everything else', text: 'The menu has everything else you can use, plus your account, notifications and “Take the tour”.' },
    { title: 'You’re all set! 🎉', text: 'That’s the tour. If you get stuck, the Staff Guide has the details, or ask your manager.', end: true },
  ].filter(Boolean).filter((s) => !s.need || s.need());
}

/** Starts the tour. navigate(path) changes page. Marks it done for this person when finished or skipped. */
export async function startTour(state, navigate) {
  if (running) return;
  const steps = stepsFor(state);
  const root = document.createElement('div');
  root.className = 'tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Guided tour');
  root.innerHTML = '<div class="tour-spot" hidden></div><div class="tour-card" tabindex="-1"></div>';
  document.body.append(root);
  document.body.classList.remove('nav-open');
  const spot = root.querySelector('.tour-spot');
  const card = root.querySelector('.tour-card');
  let i = 0;
  let target = null;
  let finished = false;
  let turn = 0; // each move to a step; a slower earlier one that finishes late is ignored

  const finish = async () => {
    if (finished) return;
    finished = true;
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', onKey);
    root.remove();
    running = null;
    if (state.user) state.user.tour_done_at = new Date().toISOString();
    api('/auth/tour', { method: 'POST' }).catch(() => {});
  };
  // Puts the light on the step's part, and the card beside it (under it, or above when there's no room).
  function place() {
    if (finished) return;
    const pad = 6;
    const r = target && visible(target) ? target.getBoundingClientRect() : null;
    root.classList.toggle('is-center', !r);
    spot.hidden = !r;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(360, vw - 24);
    card.style.width = `${cw}px`;
    if (!r) {
      card.style.left = `${(vw - cw) / 2}px`;
      card.style.top = `${Math.max(16, (vh - card.offsetHeight) / 2)}px`;
      return;
    }
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const below = r.bottom + pad + 12;
    const ch = card.offsetHeight;
    const top = below + ch < vh - 8 ? below : Math.max(8, r.top - pad - 12 - ch);
    card.style.top = `${top}px`;
    card.style.left = `${Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12)}px`;
  }
  async function show(n, dir = 1) {
    if (n < 0) return;
    if (n >= steps.length) { finish(); return; }
    const mine = ++turn;
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    i = n;
    const s = steps[i];
    const moving = s.go && !location.hash.startsWith(`#/${s.go}`);
    if (moving) navigate(s.go);
    // A new page may take a moment to draw; on the same page the part is there already, or not at all.
    target = s.sels ? await waitFor(s.sels, moving ? 3000 : 400) : null;
    if (finished || mine !== turn) return;
    if (!target && s.optional) { show(i + dir, dir); return; }
    if (target && !target.closest('.tabbar, .topbar')) target.scrollIntoView({ block: 'center', behavior: 'instant' });
    card.innerHTML = `
      <div class="tour-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${steps.length}" aria-valuenow="${i + 1}"><span style="width:${((i + 1) / steps.length) * 100}%"></span></div>
      <h2>${esc(s.title)}</h2>
      <p>${esc(s.text)}</p>
      <div class="tour-actions">
        ${s.end ? '' : '<button type="button" class="link-btn tour-skip">Skip tour</button>'}
        <span class="tour-gap"></span>
        ${i > 0 && !s.end ? '<button type="button" class="btn btn-small tour-back">Back</button>' : ''}
        <button type="button" class="btn btn-small btn-primary tour-next">${s.end ? 'Let’s go' : i === 0 ? 'Show me' : 'Next'}</button>
      </div>`;
    card.querySelector('.tour-next').addEventListener('click', () => show(i + 1));
    card.querySelector('.tour-back')?.addEventListener('click', () => show(i - 1, -1));
    card.querySelector('.tour-skip')?.addEventListener('click', finish);
    place();
    requestAnimationFrame(place);
    card.querySelector('.tour-next').focus();
  }
  const onKey = (e) => {
    if (e.key === 'Escape') finish();
    else if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1, -1);
  };
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('keydown', onKey);
  running = show(0);
  await running;
}

/** Starts the tour for someone who hasn't seen it, once they're signed in. */
export function maybeStartTour(state, navigate) {
  if (!state.user || state.user.tour_done_at || running || document.querySelector('.tour')) return;
  setTimeout(() => startTour(state, navigate), 600);
}
