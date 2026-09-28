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
import * as wastage from './views/wastage.js';

const LOCATION_KEY = 'cafe-ops:location';

export const state = {
  user: null,
  locations: [],
  locationId: null,
  get isAdmin() { return this.user?.role === 'admin'; },
  get isManager() { return this.user?.role === 'admin' || this.user?.role === 'manager'; },
  get location() { return this.locations.find((l) => l.id === this.locationId); },
};

// [pattern, view, required role]
const ROUTES = [
  [/^$/, dashboard.render],
  [/^dashboard$/, dashboard.render],
  [/^safety$/, safety.renderChecklist],
  [/^safety\/report$/, safety.renderReport],
  [/^rota$/, rota.render],
  [/^wastage$/, wastage.render],
  [/^stock$/, stock.renderList],
  [/^stock\/(\d+)$/, stock.renderTake],
  [/^recipes$/, recipes.renderList],
  [/^recipes\/allergens$/, recipes.renderAllergens],
  [/^recipes\/performance$/, recipes.renderPerformance, 'manager'],
  [/^recipes\/new$/, recipes.renderEdit, 'admin'],
  [/^recipes\/(\d+)\/edit$/, recipes.renderEdit, 'admin'],
  [/^recipes\/(\d+)$/, recipes.renderRecipe],
  [/^sales$/, sales.render, 'manager'],
  [/^orders$/, orders.renderList, 'manager'],
  [/^orders\/new$/, orders.renderNew, 'manager'],
  [/^orders\/(\d+)$/, orders.renderOrder, 'manager'],
  [/^admin\/staff$/, admin.renderStaff, 'manager'],
  [/^admin\/locations$/, admin.renderLocations, 'admin'],
  [/^admin\/suppliers$/, admin.renderSuppliers, 'manager'],
  [/^admin\/products$/, admin.renderProducts, 'manager'],
  [/^admin\/safety-tasks$/, admin.renderSafetyTasks, 'manager'],
  [/^admin\/square$/, admin.renderSquare, 'admin'],
  [/^account$/, admin.renderAccount],
];

function navItems() {
  const items = [
    ['dashboard', 'Dashboard', '▦'],
    ['safety', 'Food safety', '✓'],
    ['rota', 'Rota', '◷'],
    ['wastage', 'Wastage', '⌫'],
    ['stock', 'Stock takes', '☰'],
    ['recipes', 'Recipes', '✎'],
  ];
  if (state.isManager) items.push(['sales', 'Sales', '£'], ['orders', 'Orders', '⇄']);
  return items;
}

function adminItems() {
  if (!state.isManager) return [];
  const items = [['admin/staff', 'Staff']];
  if (state.isAdmin) items.push(['admin/locations', 'Locations'], ['admin/square', 'Square']);
  items.push(['admin/suppliers', 'Suppliers'], ['admin/products', 'Products'], ['admin/safety-tasks', 'Safety checks']);
  return items;
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
        ${state.isAdmin
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
  document.querySelector('.menu-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
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
  if ((match.role === 'manager' && !state.isManager) || (match.role === 'admin' && !state.isAdmin)) {
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
  state.locationId = state.user.location_id
    ?? (active.some((l) => l.id === saved) ? saved : active[0]?.id ?? null);
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

window.addEventListener('hashchange', route);
window.addEventListener('auth:expired', () => { if (state.user) { state.user = null; start(); } });
start();
