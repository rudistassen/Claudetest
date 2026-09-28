import { api, esc, isDemo, showError } from './lib.js';
import * as admin from './views/admin.js';
import * as dashboard from './views/dashboard.js';
import * as login from './views/login.js';
import * as orders from './views/orders.js';
import * as recipes from './views/recipes.js';
import * as rota from './views/rota.js';
import * as safety from './views/safety.js';
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
  [/^admin\/safety-tasks$/, admin.renderSafetyTasks, ['safety.manage']],
  [/^admin\/square$/, admin.renderSquare, 'admin'],
  [/^account$/, admin.renderAccount],
];

const allowed = (who) => !who || (who === 'admin' ? state.isAdmin : state.can(...who));

function navItems() {
  return [
    ['dashboard', 'Dashboard', '▦'],
    ['safety', 'Food safety', '✓', SAFETY],
    ['rota', 'Rota', '◷', ROTA],
    ['timeoff', 'Time off', '☀'],
    ['wastage', 'Wastage', '⌫', WASTAGE],
    ['stock', 'Stock takes', '☰', STOCK],
    ['recipes', 'Recipes', '✎', RECIPES],
    ['trading', 'Trading', '◔', ['sales.view']],
    ['sales', 'Sales', '£', ['sales.view']],
    ['orders', 'Orders', '⇄', ['orders.manage']],
  ].filter(([, , , who]) => allowed(who));
}

function adminItems() {
  return [
    ['admin/staff', 'Staff', ['staff.manage']],
    ['admin/permissions', 'Permissions', 'admin'],
    ['admin/locations', 'Locations', 'admin'],
    ['admin/square', 'Square', 'admin'],
    ['admin/suppliers', 'Suppliers', SUPPLIERS],
    ['admin/products', 'Products', SUPPLIERS],
    ['admin/safety-tasks', 'Safety checks', ['safety.manage']],
  ].filter(([, , who]) => allowed(who));
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

function renderShell() {
  const { path } = parseHash();
  const top = path.split('/')[0] || 'dashboard';
  const locOptions = state.locations.filter((l) => l.active)
    .map((l) => `<option value="${l.id}" ${l.id === state.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <button class="icon-btn menu-toggle" aria-label="Menu">☰</button>
      <a class="brand" href="#/dashboard">Cafe Ops${isDemo ? ' <span class="demo-pill">Demo</span>' : ''}</a>
      <div class="loc-picker">
        ${state.multiSite
          ? `<select id="location-select" aria-label="Location">${locOptions}</select>`
          : `<span class="loc-name">${esc(state.location?.name ?? '')}</span>`}
      </div>
      <a class="user-link" href="#/account">${esc(state.user.name)}</a>
    </header>
    <div class="layout">
      <nav class="sidebar">
        ${navItems().map(([p, label, icon]) => `<a href="#/${p}" class="${top === p ? 'active' : ''}"><span class="nav-icon">${icon}</span>${label}</a>`).join('')}
        ${adminItems().length ? `<div class="nav-heading">Setup</div>` : ''}
        ${adminItems().map(([p, label]) => `<a href="#/${p}" class="${path === p ? 'active' : ''}">${label}</a>`).join('')}
        <div class="nav-heading"></div>
        <a href="#" id="logout">Sign out</a>
      </nav>
      <main id="view"></main>
    </div>`;
  document.getElementById('location-select')?.addEventListener('change', (e) => {
    state.locationId = Number(e.target.value);
    try { localStorage.setItem(LOCATION_KEY, String(state.locationId)); } catch { /* storage unavailable */ }
    route();
  });
  document.getElementById('logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    location.hash = '';
    start();
  });
  document.querySelector('.menu-toggle').addEventListener('click', () => {
    placeNav();
    document.body.classList.toggle('nav-open');
  });
  document.querySelector('.sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
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
  } catch {
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
start();
