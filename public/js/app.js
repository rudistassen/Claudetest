import { api, esc, isDemo, showError } from './lib.js';
import { logo } from './logo.js';
import { install, installState, setUpInstall } from './install.js';
import * as admin from './views/admin.js';
import * as dashboard from './views/dashboard.js';
import * as login from './views/login.js';
import * as orders from './views/orders.js';
import * as recipes from './views/recipes.js';
import * as rota from './views/rota.js';
import * as safety from './views/safety.js';
import * as reports from './views/reports.js';
import * as invoices from './views/invoices.js';
import * as mybrew from './views/mybrew.js';
import * as sales from './views/sales.js';
import * as stock from './views/stock.js';
import * as timeoff from './views/timeoff.js';
import * as trading from './views/trading.js';
import * as wastage from './views/wastage.js';

const LOCATION_KEY = 'cafe-ops:location';

export const state = {
  user: null,
  locations: [],
  locationId: null,
  get isAdmin() { return this.user?.role === 'admin'; },
  // Whether this person can work with more than one site (site picker, "All sites" views).
  get multiSite() { return this.locations.filter((l) => l.active).length > 1; },
  // Admins can do everything; everyone else has the permissions of their permission set.
  can(...perms) { return this.user?.role === 'admin' || perms.some((p) => this.user?.permissions?.includes(p)); },
  get location() { return this.locations.find((l) => l.id === this.locationId); },
};

// [pattern, view, who can open it: 'admin', or a list of permissions (any one is enough)]
const SAFETY = ['safety.complete', 'safety.manage', 'safety.report'];
const ROTA = ['rota.view', 'rota.edit'];
const WASTAGE = ['wastage.record', 'wastage.reports', 'wastage.manage'];
const STOCK = ['stock.count', 'stock.complete'];
const RECIPES = ['recipes.view', 'recipes.costs', 'recipes.edit'];
const SUPPLIERS = ['orders.manage', 'setup.products'];
const ROUTES = [
  [/^$/, dashboard.render],
  [/^dashboard$/, dashboard.render],
  [/^safety$/, safety.renderChecklist, SAFETY],
  [/^safety\/report$/, safety.renderReport, ['safety.report']],
  [/^safety\/setup$/, safety.renderSetup, ['safety.manage']],
  [/^rota$/, rota.render, ROTA],
  [/^timeoff$/, timeoff.render],
  [/^wastage$/, wastage.render, WASTAGE],
  [/^stock$/, stock.renderList, STOCK],
  [/^stock\/(\d+)$/, stock.renderTake, STOCK],
  [/^recipes$/, recipes.renderList, RECIPES],
  [/^recipes\/allergens$/, recipes.renderAllergens, RECIPES],
  [/^recipes\/performance$/, recipes.renderPerformance, ['recipes.costs']],
  [/^recipes\/new$/, recipes.renderEdit, ['recipes.edit']],
  [/^recipes\/(\d+)\/edit$/, recipes.renderEdit, ['recipes.edit']],
  [/^recipes\/(\d+)$/, recipes.renderRecipe, RECIPES],
  [/^sales$/, sales.render, ['sales.view']],
  [/^trading$/, trading.render, ['sales.view']],
  [/^trading\/heatmap$/, trading.renderHeatmap, ['sales.view']],
  [/^orders$/, orders.renderList, ['orders.manage']],
  [/^orders\/new$/, orders.renderNew, ['orders.manage']],
  [/^orders\/(\d+)$/, orders.renderOrder, ['orders.manage']],
  [/^admin\/staff$/, admin.renderStaff, ['staff.manage']],
  [/^admin\/permissions$/, admin.renderPermissions, 'admin'],
  [/^admin\/locations$/, admin.renderLocations, 'admin'],
  [/^admin\/suppliers$/, admin.renderSuppliers, SUPPLIERS],
  [/^admin\/products$/, admin.renderProducts, SUPPLIERS],
  [/^admin\/safety-tasks$/, safety.renderSetup, ['safety.manage']],
  [/^admin\/square$/, admin.renderSquare, 'admin'],
  [/^mybrew$/, mybrew.renderMyBrew],
  [/^admin\/news$/, mybrew.renderNewsSetup, ['news.manage']],
  [/^admin\/documents$/, mybrew.renderDocumentsSetup, ['news.manage']],
  [/^invoices$/, invoices.renderList, ['orders.manage']],
  [/^invoices\/(\d+)$/, invoices.renderInvoice, ['orders.manage']],
  [/^admin\/email-reports$/, reports.renderEmailReports, 'admin'],
  [/^account$/, admin.renderAccount],
];

const allowed = (who) => !who || (who === 'admin' ? state.isAdmin : state.can(...who));

// The side menu: Dashboard, then headed groups. Items someone can't use are hidden, and so is a group left empty.
function navGroups() {
  return [
    [null, [['dashboard', 'Dashboard', '▦']]],
    ['Team', [
      ['mybrew', 'My Brew', '☕'],
      ['rota', 'Rota', '◷', ROTA],
      ['timeoff', 'Time off', '☀'],
    ]],
    ['Trail', [
      ['safety', 'Checklist', '✓', SAFETY],
      ['safety/report', 'Compliance', '▤', ['safety.report']],
    ]],
    ['Stock and Ordering', [
      ['stock', 'Stock takes', '☰', STOCK],
      ['wastage', 'Wastage', '⌫', WASTAGE],
      ['orders', 'Ordering', '⇄', ['orders.manage']],
      ['invoices', 'Invoices', '⎘', ['orders.manage']],
    ]],
    ['Reporting', [
      ['trading', 'Trading', '◔', ['sales.view']],
      ['sales', 'Sales', '£', ['sales.view']],
    ]],
    ['Setup', [
      ['recipes', 'Recipes', '≡', RECIPES],
      ['admin/staff', 'Staff', '☺', ['staff.manage']],
      ['admin/permissions', 'Permissions', '⚿', 'admin'],
      ['admin/locations', 'Locations', '⌂', 'admin'],
      ['admin/square', 'Square', '▢', 'admin'],
      ['admin/email-reports', 'Email reports', '✉', 'admin'],
      ['admin/news', 'News', '✎', ['news.manage']],
      ['admin/documents', 'Documents', '❐', ['news.manage']],
      ['admin/suppliers', 'Suppliers', '⚑', SUPPLIERS],
      ['admin/products', 'Products', '▥', SUPPLIERS],
      ['safety/setup', 'Trail checks', '☑', ['safety.manage']],
    ]],
  ].map(([heading, items]) => [heading, items.filter(([, , , who]) => allowed(who))]).filter(([, items]) => items.length);
}

// Each menu section's colour.
const NAV_TONES = { Team: 'team', Trail: 'trail', 'Stock and Ordering': 'stock', Reporting: 'reporting' };

// The number of news posts waiting for this person to confirm they've read them, shown on My Brew in the menu.
let newsUnread = { count: 0, at: 0, user: null };
async function showNewsBadge(force = false) {
  if (force || newsUnread.user !== state.user?.id || Date.now() - newsUnread.at > 60000) {
    try { newsUnread = { count: (await api('/news/unread')).count, at: Date.now(), user: state.user?.id }; } catch { return; }
  }
  const b = document.getElementById('news-badge');
  if (!b) return;
  b.hidden = !newsUnread.count;
  b.textContent = newsUnread.count;
  b.title = `${newsUnread.count} update${newsUnread.count === 1 ? '' : 's'} to read`;
}
window.addEventListener('news:read', () => showNewsBadge(true));

// Menu sections someone has folded away, remembered in this browser.
const NAV_FOLD_KEY = 'cafe-ops:nav-folded';
function foldedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_FOLD_KEY) ?? '[]')); } catch { return new Set(); }
}

// Whether the side menu is shrunk to a slim strip of icons (computers and tablets), remembered in this browser.
// Until someone chooses, it starts slim on smaller screens so pages get the room.
const NAV_RAIL_KEY = 'cafe-ops:nav-rail';
function navRail() {
  try {
    const saved = localStorage.getItem(NAV_RAIL_KEY);
    if (saved !== null) return saved === '1';
  } catch { /* storage unavailable */ }
  return window.innerWidth < 1100;
}
const phoneNav = () => window.matchMedia('(max-width: 800px)').matches;

// The menu item for a page: the longest item path that is the page or a parent of it (recipes/12 → Recipes).
function activeItem(path, items) {
  const p = path || 'dashboard';
  return items.map(([i]) => i).filter((i) => p === i || p.startsWith(`${i}/`)).sort((x, y) => y.length - x.length)[0];
}

export function navigate(path) {
  if (location.hash === `#/${path}`) route();
  else location.hash = `#/${path}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
}

const PIN = '<svg class="pin" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';

// The site picker in the top bar: a compact button that opens a searchable list of sites.
function sitePicker() {
  const sites = state.locations.filter((l) => l.active);
  return `<div class="site-picker">
    <button type="button" class="site-btn" id="site-btn" aria-haspopup="listbox" aria-expanded="false" title="Change site">
      ${PIN}<span class="site-btn-name">${esc(state.location?.name ?? 'Choose a site')}</span><span class="site-caret" aria-hidden="true">▾</span>
    </button>
    <div class="site-menu" id="site-menu" hidden>
      ${sites.length > 5 ? '<input type="search" class="site-search" placeholder="Find a site…" aria-label="Find a site" autocomplete="off">' : ''}
      <ul role="listbox" aria-label="Sites">
        ${sites.map((l) => `<li role="option" tabindex="-1" data-site-id="${l.id}" aria-selected="${l.id === state.locationId}">
          <span class="site-tick" aria-hidden="true">${l.id === state.locationId ? '✓' : ''}</span>
          <span class="site-opt-name">${esc(l.name)}</span>
          ${l.id === state.user.location_id ? '<span class="site-home">Your site</span>' : ''}</li>`).join('')}
      </ul>
      <p class="site-none" hidden>No site matches</p>
    </div>
  </div>`;
}

function wireSitePicker(onPick) {
  const btn = document.getElementById('site-btn');
  if (!btn) return;
  const menu = document.getElementById('site-menu');
  const search = menu.querySelector('.site-search');
  const items = () => [...menu.querySelectorAll('li')].filter((li) => !li.hidden);
  const close = (focusButton = false) => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
    if (focusButton) btn.focus();
  };
  const outside = (e) => { if (!e.target.closest('.site-picker')) close(); };
  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside);
    if (search) { search.value = ''; filter(); search.focus(); } else (menu.querySelector('[aria-selected="true"]') ?? items()[0])?.focus();
  };
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    menu.querySelectorAll('li').forEach((li) => { li.hidden = !!q && !li.textContent.toLowerCase().includes(q); });
    menu.querySelector('.site-none').hidden = items().length > 0;
  };
  const pick = (li) => {
    close(true);
    const id = Number(li.dataset.siteId);
    if (id !== state.locationId) onPick(id);
  };
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } });
  search?.addEventListener('input', filter);
  menu.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) pick(li); });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[Math.min(list.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) (search ?? list[0])?.focus(); else list[i - 1].focus(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const target = i >= 0 ? list[i] : list[0];
      if (target) pick(target);
    }
  });
}

function renderShell() {
  const { path } = parseHash();
  const groups = navGroups();
  const active = activeItem(path, groups.flatMap(([, items]) => items));
  const folded = foldedGroups();
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <button class="icon-btn menu-toggle" aria-label="Show or hide the menu" title="Show or hide the menu">☰</button>
      <a class="brand" href="#/dashboard" aria-label="BrewView – dashboard">${logo(26)}${isDemo ? ' <span class="demo-pill">Demo</span>' : ''}</a>
      <div class="loc-picker">
        ${state.multiSite ? sitePicker() : `<span class="loc-name">${PIN}${esc(state.location?.name ?? '')}</span>`}
      </div>
      <a class="user-link" href="#/account">${esc(state.user.name)}</a>
    </header>
    <div class="layout">
      <nav class="sidebar">
        ${groups.map(([heading, items]) => {
          const links = items.map(([p, label, icon]) => `<a href="#/${p}" class="${active === p ? 'active' : ''}" title="${esc(label)}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>${p === 'mybrew' ? '<span class="nav-badge" id="news-badge" hidden></span>' : ''}</a>`).join('');
          if (!heading) return links;
          // The section holding the current page always stays open.
          const open = !folded.has(heading) || items.some(([p]) => p === active);
          return `<div class="nav-group ${open ? '' : 'is-folded'}" data-tone="${NAV_TONES[heading] ?? ''}">
            <button type="button" class="nav-heading nav-toggle" data-group="${esc(heading)}" aria-expanded="${open}">${esc(heading)}<span class="nav-caret" aria-hidden="true">${open ? '▾' : '▸'}</span></button>
            <div class="nav-links">${links}</div>
          </div>`;
        }).join('')}
        <div class="nav-heading"></div>
        <a href="#" id="install-app" title="Install app" data-install ${['prompt', 'ios'].includes(installState()) ? '' : 'hidden'}><span class="nav-icon">⤓</span><span class="nav-label">Install app</span></a>
        <a href="#" id="logout" title="Sign out"><span class="nav-icon">⎋</span><span class="nav-label">Sign out</span></a>
      </nav>
      <main id="view"></main>
    </div>`;
  document.body.classList.toggle('nav-rail', navRail());
  showNewsBadge();
  wireSitePicker((id) => {
    state.locationId = id;
    try { localStorage.setItem(LOCATION_KEY, String(state.locationId)); } catch { /* storage unavailable */ }
    // A page that picks its own site (the rota) follows the site chosen here.
    const { path, query } = parseHash();
    if (query.site) {
      navigate(`${path}?${new URLSearchParams({ ...query, site: String(state.locationId) })}`);
      return;
    }
    route();
  });
  document.getElementById('install-app').addEventListener('click', (e) => { e.preventDefault(); install(); });
  document.getElementById('logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    location.hash = '';
    start();
  });
  // On phones ☰ slides the menu out; on bigger screens it switches between the full menu and the slim icon strip.
  document.querySelector('.menu-toggle').addEventListener('click', () => {
    if (phoneNav()) {
      placeNav();
      document.body.classList.toggle('nav-open');
      return;
    }
    const rail = document.body.classList.toggle('nav-rail');
    try { localStorage.setItem(NAV_RAIL_KEY, rail ? '1' : '0'); } catch { /* storage unavailable */ }
  });
  document.querySelector('.sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
  document.querySelectorAll('.nav-toggle').forEach((b) => b.addEventListener('click', () => {
    const group = b.closest('.nav-group');
    const open = group.classList.toggle('is-folded') === false;
    b.setAttribute('aria-expanded', String(open));
    b.querySelector('.nav-caret').textContent = open ? '▾' : '▸';
    const folded = foldedGroups();
    if (open) folded.delete(b.dataset.group); else folded.add(b.dataset.group);
    try { localStorage.setItem(NAV_FOLD_KEY, JSON.stringify([...folded])); } catch { /* storage unavailable */ }
  }));
}

let routeSeq = 0;

export async function route() {
  if (!state.user) return;
  const { path, query } = parseHash();
  renderShell();
  const el = document.getElementById('view');
  const match = ROUTES.map(([re, view, role]) => ({ m: path.match(re), view, role })).find((r) => r.m);
  if (!match) {
    el.innerHTML = '<div class="empty">Page not found.</div>';
    return;
  }
  if (!allowed(match.role)) {
    el.innerHTML = '<div class="empty">You do not have access to this page.</div>';
    return;
  }
  const seq = ++routeSeq;
  el.innerHTML = '<div class="loading">Loading…</div>';
  const ctx = {
    el,
    state,
    params: match.m.slice(1),
    query,
    navigate,
    rerender: () => route(),
    stale: () => seq !== routeSeq,
  };
  try {
    await match.view(ctx);
  } catch (err) {
    if (seq !== routeSeq) return;
    el.innerHTML = `<div class="empty">Could not load this page: ${esc(err.message)}</div>`;
    showError(err);
  }
}

export async function loadLocations() {
  state.locations = await api('/locations');
  let saved = null;
  try { saved = Number(localStorage.getItem(LOCATION_KEY)); } catch { /* storage unavailable */ }
  const active = state.locations.filter((l) => l.active);
  // The site picked last time, else their home site, else the first site they can access.
  const pick = (id) => active.some((l) => l.id === id);
  state.locationId = (pick(saved) ? saved : null) ?? (pick(state.user.location_id) ? state.user.location_id : active[0]?.id ?? null);
}

async function start() {
  try {
    state.user = (await api('/auth/me')).user;
  } catch (err) {
    // No connection (e.g. the installed app opened offline): say so, rather than asking them to sign in again.
    if (!navigator.onLine || err instanceof TypeError) {
      document.getElementById('app').innerHTML = `<div class="login-wrap"><div class="card login offline-card">
        <h1 class="login-logo" aria-label="BrewView">${logo(40)}</h1>
        <p><strong>You’re offline.</strong> BrewView needs an internet connection – check your Wi-Fi or mobile data.</p>
        <button class="btn btn-primary btn-block" id="retry">Try again</button></div></div>`;
      document.getElementById('retry').addEventListener('click', start);
      window.addEventListener('online', start, { once: true });
      return;
    }
    state.user = null;
  }
  if (!state.user) {
    login.render(document.getElementById('app'), async (user) => {
      state.user = user;
      await loadLocations();
      route();
    });
    return;
  }
  await loadLocations();
  route();
}

// On phones the menu slides out just below the green bar, which sits lower while the logo band is in view.
function placeNav() {
  const bar = document.querySelector('.topbar');
  if (bar) document.body.style.setProperty('--nav-top', `${Math.max(0, bar.getBoundingClientRect().bottom)}px`);
}
window.addEventListener('scroll', placeNav, { passive: true });
window.addEventListener('resize', placeNav);

window.addEventListener('hashchange', route);
window.addEventListener('auth:expired', () => { if (state.user) { state.user = null; start(); } });
setUpInstall();
start();
