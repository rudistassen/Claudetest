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
  const title = `${newsUnread.count} update${newsUnread.count === 1 ? '' : 's'} to read`;
  document.querySelectorAll('[data-news-badge]').forEach((b) => {
    b.hidden = !newsUnread.count;
    b.textContent = newsUnread.count;
    b.title = title;
  });
  document.querySelectorAll('[data-news-dot]').forEach((d) => { d.hidden = !newsUnread.count; d.title = title; });
}
window.addEventListener('news:read', () => showNewsBadge(true));

// Menu sections someone has folded away, remembered in this browser.
const NAV_FOLD_KEY = 'cafe-ops:nav-folded';
function foldedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_FOLD_KEY) ?? '[]')); } catch { return new Set(); }
}

// Pages whose contents depend on the site chosen in the top bar; the site picker only shows on these.
const SITE_PAGES = /^(rota|safety|safety\/report|safety\/setup|wastage|stock|orders|orders\/new|sales|trading|trading\/heatmap|recipes\/performance|admin\/staff|admin\/safety-tasks)$/;

// Short names for the menu across the top.
const TOP_LABELS = { 'Stock and Ordering': 'Stock & Ordering' };

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

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
  const sitePage = SITE_PAGES.test(path);
  // The section the page belongs to, shown as a small coloured label above its title.
  const section = groups.find(([, items]) => items.some(([p]) => p === active))?.[0] ?? null;
  document.body.dataset.section = section ? (NAV_TONES[section] ?? 'setup') : '';
  document.body.style.setProperty('--section-label', section ? JSON.stringify(section) : '""');
  const link = ([p, label, icon]) => `<a href="#/${p}" class="${active === p ? 'active' : ''}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>${p === 'mybrew' ? '<span class="nav-badge" data-news-badge hidden></span>' : ''}</a>`;
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <button class="icon-btn menu-toggle" aria-label="Menu" title="Menu">☰</button>
      <a class="brand" href="#/dashboard" aria-label="BrewView – dashboard">${logo(26)}${isDemo ? ' <span class="demo-pill">Demo</span>' : ''}</a>
      <nav class="topnav" aria-label="Main menu">
        ${groups.map(([heading, items]) => {
          if (!heading) return items.map(([p, label]) => `<a href="#/${p}" class="topnav-btn ${active === p ? 'is-active' : ''}">${label}</a>`).join('');
          const here = items.some(([p]) => p === active);
          const hasNews = items.some(([p]) => p === 'mybrew');
          return `<div class="topnav-group" data-tone="${NAV_TONES[heading] ?? ''}">
            <button type="button" class="topnav-btn ${here ? 'is-active' : ''}" aria-haspopup="true" aria-expanded="false">${esc(TOP_LABELS[heading] ?? heading)}${hasNews ? '<span class="nav-dot" data-news-dot hidden></span>' : ''}<span class="topnav-caret" aria-hidden="true">▾</span></button>
            <div class="topnav-menu ${items.length > 7 ? 'is-wide' : ''}" hidden>
              <p class="topnav-heading">${esc(heading)}</p>
              <div class="topnav-links">${items.map(link).join('')}</div>
            </div>
          </div>`;
        }).join('')}
      </nav>
      <div class="loc-picker">
        ${!sitePage ? '' : state.multiSite ? sitePicker() : `<span class="loc-name">${PIN}${esc(state.location?.name ?? '')}</span>`}
      </div>
      <div class="topnav-group user-menu">
        <button type="button" class="user-btn" aria-haspopup="true" aria-expanded="false" title="${esc(state.user.name)}">
          <span class="avatar" aria-hidden="true">${esc(initials(state.user.name) || '?')}</span><span class="user-name">${esc(state.user.name)}</span><span class="topnav-caret" aria-hidden="true">▾</span>
        </button>
        <div class="topnav-menu topnav-menu-right" hidden>
          <p class="topnav-heading">${esc(state.user.name)}</p>
          <div class="topnav-links">
            <a href="#/account" class="${path === 'account' ? 'active' : ''}"><span class="nav-icon">☺</span><span class="nav-label">My account</span></a>
            <a href="#" data-install ${['prompt', 'ios'].includes(installState()) ? '' : 'hidden'}><span class="nav-icon">⤓</span><span class="nav-label">Install app</span></a>
            <a href="#" id="logout" data-logout><span class="nav-icon">⎋</span><span class="nav-label">Sign out</span></a>
          </div>
        </div>
      </div>
    </header>
    <div class="layout">
      <nav class="sidebar" aria-label="Menu">
        ${groups.map(([heading, items]) => {
          const links = items.map(link).join('');
          if (!heading) return links;
          // The section holding the current page always stays open.
          const open = !folded.has(heading) || items.some(([p]) => p === active);
          return `<div class="nav-group ${open ? '' : 'is-folded'}" data-tone="${NAV_TONES[heading] ?? ''}">
            <button type="button" class="nav-heading nav-toggle" data-group="${esc(heading)}" aria-expanded="${open}">${esc(heading)}<span class="nav-caret" aria-hidden="true">${open ? '▾' : '▸'}</span></button>
            <div class="nav-links">${links}</div>
          </div>`;
        }).join('')}
        <div class="nav-heading"></div>
        <a href="#" data-install ${['prompt', 'ios'].includes(installState()) ? '' : 'hidden'}><span class="nav-icon">⤓</span><span class="nav-label">Install app</span></a>
        <a href="#" data-logout><span class="nav-icon">⎋</span><span class="nav-label">Sign out</span></a>
      </nav>
      <main id="view"></main>
    </div>`;
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
  document.querySelectorAll('[data-install]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); install(); }));
  document.querySelectorAll('[data-logout]').forEach((a) => a.addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    location.hash = '';
    start();
  }));
  wireTopMenus();
  // On phones and smaller tablets ☰ slides the full menu out from the side.
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

// The drop-down menus across the top: click (or tap) a heading to open its pages; with a mouse, pointing at a
// heading opens it too. Escape, clicking elsewhere or picking a page closes it.
let closeTopMenus = () => {};
function wireTopMenus() {
  const groups = [...document.querySelectorAll('.topbar .topnav-group')];
  const hoverable = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  let timer = null;
  const setOpen = (g, open) => {
    const btn = g.querySelector('button');
    g.querySelector('.topnav-menu').hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    g.classList.toggle('is-open', open);
    // Keep the drop-down on screen when its heading is near the right-hand edge.
    const menu = g.querySelector('.topnav-menu');
    menu.style.transform = '';
    if (open) {
      const over = menu.getBoundingClientRect().right - (window.innerWidth - 8);
      if (over > 0) menu.style.transform = `translateX(${-over}px)`;
    }
  };
  const closeAll = (except) => groups.forEach((g) => { if (g !== except) setOpen(g, false); });
  closeTopMenus = () => closeAll();
  let openedAt = 0;
  const openOne = (g) => {
    clearTimeout(timer);
    if (!g.classList.contains('is-open')) openedAt = Date.now();
    closeAll(g);
    setOpen(g, true);
  };
  for (const g of groups) {
    const btn = g.querySelector('button');
    const menu = g.querySelector('.topnav-menu');
    // A click straight after pointing at it (which already opened it) keeps it open rather than shutting it.
    btn.addEventListener('click', () => {
      if (g.classList.contains('is-open') && Date.now() - openedAt > 600) setOpen(g, false);
      else openOne(g);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); openOne(g); menu.querySelector('a:not([hidden])')?.focus(); }
    });
    menu.addEventListener('keydown', (e) => {
      const links = [...menu.querySelectorAll('a:not([hidden])')];
      const i = links.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); setOpen(g, false); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); links[Math.min(links.length - 1, i + 1)]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) btn.focus(); else links[i - 1].focus(); }
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) closeAll(); });
    if (hoverable) {
      g.addEventListener('mouseenter', () => openOne(g));
      g.addEventListener('mouseleave', () => { clearTimeout(timer); timer = setTimeout(() => setOpen(g, false), 220); });
    }
  }
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.topnav-group')) closeTopMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTopMenus(); });

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

// On phones, a table too wide for the screen is shown as a stack of small cards (one per row, each value labelled
// with its column heading) instead of making people scroll sideways. Grids that only make sense as grids are left alone.
const NO_STACK = '.rota, .hm, .grid-table, .matrix, .perm-matrix, .avail-table';
const phoneTables = window.matchMedia('(max-width: 640px)');
function labelCells(table) {
  const heads = [];
  for (const th of table.tHead?.rows[table.tHead.rows.length - 1]?.cells ?? []) {
    for (let i = 0; i < th.colSpan; i++) heads.push(th.textContent.trim());
  }
  for (const row of [...table.tBodies].flatMap((b) => [...b.rows]).concat([...table.tFoot?.rows ?? []])) {
    let col = 0;
    let titled = false;
    for (const cell of row.cells) {
      const label = cell.colSpan === 1 ? heads[col] : '';
      if (label) cell.dataset.label = label; else delete cell.dataset.label;
      cell.classList.toggle('cell-tick', !label && !!cell.querySelector('input[type=checkbox]') && !cell.textContent.trim());
      // The first labelled cell (usually the name) is the card's title.
      cell.classList.toggle('cell-title', !!label && !titled);
      if (label) titled = true;
      col += cell.colSpan;
    }
  }
}
function fitTables() {
  const view = document.getElementById('view');
  if (!view) return;
  view.querySelectorAll('.table-wrap > table').forEach((t) => {
    if (t.matches(NO_STACK) || !t.tHead) return;
    if (!phoneTables.matches) { t.classList.remove('stacked'); return; }
    if (t.classList.contains('stacked')) { labelCells(t); return; }
    const wrap = t.parentElement;
    if (wrap.clientWidth && wrap.scrollWidth - wrap.clientWidth > 4) {
      labelCells(t);
      t.classList.add('stacked');
    }
  });
}
let fitQueued = false;
const queueFit = () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitTables(); });
};
new MutationObserver(queueFit).observe(document.getElementById('app'), { childList: true, subtree: true });
phoneTables.addEventListener('change', () => {
  document.querySelectorAll('table.stacked').forEach((t) => t.classList.remove('stacked'));
  queueFit();
});
document.addEventListener('click', queueFit);

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
