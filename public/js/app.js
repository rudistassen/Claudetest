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
  [/^account$/, admin.renderAccount],
];

const allowed = (who) => !who || (who === 'admin' ? state.isAdmin : state.can(...who));

// The side menu: Dashboard, then headed groups. Items someone can't use are hidden, and so is a group left empty.
function navGroups() {
  return [
    [null, [['dashboard', 'Dashboard', '▦']]],
    ['Team', [
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
    ]],
    ['Reporting', [
      ['trading', 'Trading', '◔', ['sales.view']],
      ['sales', 'Sales', '£', ['sales.view']],
    ]],
    ['Setup', [
      ['recipes', 'Recipes', '', RECIPES],
      ['admin/staff', 'Staff', '', ['staff.manage']],
      ['admin/permissions', 'Permissions', '', 'admin'],
      ['admin/locations', 'Locations', '', 'admin'],
      ['admin/square', 'Square', '', 'admin'],
      ['admin/suppliers', 'Suppliers', '', SUPPLIERS],
      ['admin/products', 'Products', '', SUPPLIERS],
      ['safety/setup', 'Trail checks', '', ['safety.manage']],
    ]],
  ].map(([heading, items]) => [heading, items.filter(([, , , who]) => allowed(who))]).filter(([, items]) => items.length);
}

// Menu sections someone has folded away, remembered in this browser.
const NAV_FOLD_KEY = 'cafe-ops:nav-folded';
function foldedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_FOLD_KEY) ?? '[]')); } catch { return new Set(); }
}

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

function renderShell() {
  const { path } = parseHash();
  const groups = navGroups();
  const active = activeItem(path, groups.flatMap(([, items]) => items));
  const folded = foldedGroups();
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
        ${groups.map(([heading, items]) => {
          const links = items.map(([p, label, icon]) => `<a href="#/${p}" class="${active === p ? 'active' : ''}">${icon ? `<span class="nav-icon">${icon}</span>` : ''}${label}</a>`).join('');
          if (!heading) return links;
          // The section holding the current page always stays open.
          const open = !folded.has(heading) || items.some(([p]) => p === active);
          return `<div class="nav-group ${open ? '' : 'is-folded'}">
            <button type="button" class="nav-heading nav-toggle" data-group="${esc(heading)}" aria-expanded="${open}">${esc(heading)}<span class="nav-caret" aria-hidden="true">${open ? '▾' : '▸'}</span></button>
            <div class="nav-links">${links}</div>
          </div>`;
        }).join('')}
        <div class="nav-heading"></div>
        <a href="#" id="logout">Sign out</a>
      </nav>
      <main id="view"></main>
    </div>`;
  document.getElementById('location-select')?.addEventListener('change', (e) => {
    state.locationId = Number(e.target.value);
    try { localStorage.setItem(LOCATION_KEY, String(state.locationId)); } catch { /* storage unavailable */ }
    // A page that picks its own site (the rota) follows the site chosen here.
    const { path, query } = parseHash();
    if (query.site) {
      navigate(`${path}?${new URLSearchParams({ ...query, site: String(state.locationId) })}`);
      return;
    }
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
