import { api, chooseSite, esc, isDemo, qs, showError } from './lib.js';
import { logo } from './logo.js';
import { install, installState, setUpInstall } from './install.js';
import * as admin from './views/admin.js';
import * as breaks from './views/breaks.js';
import * as rotalog from './views/rotalog.js';
import * as rotacosts from './views/rotacosts.js';
import * as reviews from './views/reviews.js';
import * as openorders from './views/openorders.js';
import * as sickness from './views/sickness.js';
import * as paymentlinks from './views/paymentlinks.js';
import * as dashboard from './views/dashboard.js';
import * as login from './views/login.js';
import { renderSetPassword } from './views/password.js';
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
  [/^dashboard$/, dashboard.render, ['dashboard.view']],
  [/^safety$/, safety.renderChecklist, SAFETY],
  [/^safety\/report$/, safety.renderReport, ['safety.report']],
  [/^safety\/setup$/, safety.renderSetup, ['safety.manage']],
  [/^rota$/, rota.render, ROTA],
  [/^rota\/log$/, rotalog.render, ['rota.edit', 'rota.publish']],
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
  [/^breaks$/, breaks.render, ['sales.view', 'staff.manage']],
  [/^rota-costs$/, rotacosts.render, ['sales.view']],
  [/^reviews$/, reviews.render, ['sales.view']],
  [/^open-orders$/, openorders.render, ['sales.view']],
  [/^sickness$/, sickness.renderReport, ['rota.edit', 'staff.manage']],
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
  [/^admin\/payment-links$/, paymentlinks.render, ['payments.send']],
  [/^mybrew$/, mybrew.renderMyBrew],
  [/^admin\/news$/, mybrew.renderNewsSetup, ['news.manage']],
  [/^admin\/documents$/, mybrew.renderDocumentsSetup, ['news.manage']],
  [/^invoices$/, invoices.renderList, ['orders.manage']],
  [/^invoices\/(\d+)$/, invoices.renderInvoice, ['orders.manage']],
  [/^admin\/email-reports$/, reports.renderEmailReports, 'admin'],
  [/^account$/, admin.renderAccount],
  [/^hub\/([\w-]+)$/, renderHub],
  [/^documents$/, mybrew.renderDocuments],
];

// Where Brewly opens: the dashboard, or My Brew for people who can't see it.
const home = () => (state.can('dashboard.view') ? 'dashboard' : 'mybrew');

const allowed = (who) => !who || (who === 'admin' ? state.isAdmin : state.can(...who));

// The side menu: Dashboard, then headed groups. Items someone can't use are hidden, and so is a group left empty.
function navGroups() {
  return [
    [null, [['dashboard', 'Dashboard', '▦', ['dashboard.view']], ['mybrew', 'My Brew', '☕']]],
    ['Rota', [
      ['rota', 'Rota', '◷', ROTA],
      ['rota/log', 'Rota changes', '⟲', ['rota.edit', 'rota.publish']],
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
      ['open-orders', 'Open orders', '◌', ['sales.view']],
      ['rota-costs', 'Rota costs', '⚖', ['sales.view']],
      ['breaks', 'Breaks', '☕', ['sales.view', 'staff.manage']],
      ['sickness', 'Sickness', '✚', ['rota.edit', 'staff.manage']],
      ['reviews', 'Reviews', '★', ['sales.view']],
    ]],
    ['Setup', [
      ['recipes', 'Recipes', '≡', RECIPES],
      ['admin/staff', 'Staff', '☺', ['staff.manage']],
      ['admin/permissions', 'Permissions', '⚿', 'admin'],
      ['admin/locations', 'Locations', '⌂', 'admin'],
      ['admin/square', 'Square', '▢', 'admin'],
      ['admin/payment-links', 'Payment links', '£', ['payments.send']],
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
const NAV_TONES = { Rota: 'team', Trail: 'trail', 'Stock and Ordering': 'stock', Reporting: 'reporting' };

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

// Short names for the menu across the top.
const TOP_LABELS = { 'Stock and Ordering': 'Stock & Ordering' };

// Menu sections that open a page of tiles (one per page in the section) instead of a drop-down list.
const HUBS = { 'Stock and Ordering': 'stock-ordering' };
// The line under each page's name on its tile.
const TILE_NOTES = {
  stock: 'Count stock and see past stock takes',
  wastage: 'Record what’s thrown away and see the cost',
  orders: 'Create, send and receive supplier orders',
  invoices: 'Upload and check supplier invoices',
};

// A section's page of tiles (see HUBS).
function renderHub({ el, params }) {
  const heading = Object.keys(HUBS).find((h) => HUBS[h] === params[0]);
  const items = navGroups().find(([h]) => h === heading)?.[1] ?? [];
  if (!heading || !items.length) {
    el.innerHTML = '<div class="empty">You do not have access to this page.</div>';
    return;
  }
  el.innerHTML = `
    <div class="page-head"><h1>${esc(TOP_LABELS[heading] ?? heading)}</h1></div>
    <div class="hub-tiles">${items.map(([p, label, ic]) => `<a class="hub-tile" href="#/${p}">
      <span class="hub-icon" aria-hidden="true">${ic}</span>
      <span class="hub-text"><strong>${esc(label)}</strong>${TILE_NOTES[p] ? `<small>${esc(TILE_NOTES[p])}</small>` : ''}</span>
      <span class="hub-go" aria-hidden="true">›</span></a>`).join('')}</div>`;
}

// Line icons for the bar along the bottom on phones.
const ICON = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  rota: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  checks: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m8 12 3 3 5-6"/>',
  timeoff: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  mybrew: '<path d="M4 8h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2.5v3M12 2.5v3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

// The phone icon bar: home, the everyday pages this person can use, then the full menu.
function tabBar(items, active) {
  const has = (p) => items.some(([q]) => q === p);
  const tabs = [state.can('dashboard.view') ? ['dashboard', 'Home', 'home'] : null, has('rota') ? ['rota', 'Rota', 'rota'] : null, has('safety') ? ['safety', 'Checks', 'checks'] : ['timeoff', 'Time off', 'timeoff'], ['mybrew', 'My Brew', 'mybrew']].filter(Boolean);
  return `<nav class="tabbar" aria-label="Quick links">
    ${tabs.map(([p, label, ic]) => `<a href="#/${p}" class="${active === p ? 'is-on' : ''}" ${active === p ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${p === 'mybrew' ? '<span class="nav-badge" data-news-badge hidden></span>' : ''}</a>`).join('')}
    <button type="button" class="tabbar-menu">${icon('menu')}<span>Menu</span></button>
  </nav>`;
}

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

function renderShell() {
  const { path } = parseHash();
  const groups = navGroups();
  const active = activeItem(path, groups.flatMap(([, items]) => items));
  const folded = foldedGroups();
  // The section the page belongs to, shown as a small coloured label above its title.
  const section = groups.find(([, items]) => items.some(([p]) => p === active))?.[0] ?? null;
  document.body.dataset.section = section ? (NAV_TONES[section] ?? 'setup') : '';
  document.body.style.setProperty('--section-label', section ? JSON.stringify(section) : '""');
  const link = ([p, label, icon]) => `<a href="#/${p}" class="${active === p ? 'active' : ''}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>${p === 'mybrew' ? '<span class="nav-badge" data-news-badge hidden></span>' : ''}</a>`;
  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <button class="icon-btn menu-toggle" aria-label="Menu" title="Menu">☰</button>
      <a class="brand" href="#/${home()}" aria-label="Brewly – home">${logo(26)}${isDemo ? ' <span class="demo-pill">Demo</span>' : ''}</a>
      <nav class="topnav" aria-label="Main menu">
        ${groups.map(([heading, items]) => {
          if (!heading) return items.map(([p, label]) => `<a href="#/${p}" class="topnav-btn ${active === p ? 'is-active' : ''}">${label}${p === 'mybrew' ? '<span class="nav-dot" data-news-dot hidden></span>' : ''}</a>`).join('');
          const here = items.some(([p]) => p === active) || path === `hub/${HUBS[heading]}`;
          if (HUBS[heading]) return `<a href="#/hub/${HUBS[heading]}" class="topnav-btn ${here ? 'is-active' : ''}">${esc(TOP_LABELS[heading] ?? heading)}</a>`;
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
      <span class="topbar-gap"></span>
      <div class="topnav-group user-menu">
        <button type="button" class="user-btn" aria-haspopup="true" aria-expanded="false" title="${esc(state.user.name)}">
          <span class="ring" aria-hidden="true"><span class="avatar">${esc(initials(state.user.name) || '?')}</span></span><span class="user-name">${esc(state.user.name)}</span><span class="topnav-caret" aria-hidden="true">▾</span>
        </button>
        <div class="topnav-menu topnav-menu-right" hidden>
          <p class="topnav-heading">${esc(state.user.name)}</p>
          <div class="topnav-links">
            <a href="#/account" class="${path === 'account' ? 'active' : ''}"><span class="nav-icon">☺</span><span class="nav-label">My account</span></a>
            <a href="#/documents" class="${path === 'documents' ? 'active' : ''}"><span class="nav-icon">❐</span><span class="nav-label">Company documents</span></a>
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
          if (HUBS[heading]) {
            const here = items.some(([p]) => p === active) || path === `hub/${HUBS[heading]}`;
            return `<div class="nav-group" data-tone="${NAV_TONES[heading] ?? ''}"><a href="#/hub/${HUBS[heading]}" class="nav-hub ${here ? 'active' : ''}"><span class="nav-icon">▦</span><span class="nav-label">${esc(TOP_LABELS[heading] ?? heading)}</span><span class="nav-caret" aria-hidden="true">›</span></a></div>`;
          }
          // The section holding the current page always stays open.
          const open = !folded.has(heading) || items.some(([p]) => p === active);
          return `<div class="nav-group ${open ? '' : 'is-folded'}" data-tone="${NAV_TONES[heading] ?? ''}">
            <button type="button" class="nav-heading nav-toggle" data-group="${esc(heading)}" aria-expanded="${open}">${esc(heading)}<span class="nav-caret" aria-hidden="true">${open ? '▾' : '▸'}</span></button>
            <div class="nav-links">${links}</div>
          </div>`;
        }).join('')}
        <div class="nav-heading"></div>
        <a href="#/documents" class="${path === 'documents' ? 'active' : ''}"><span class="nav-icon">❐</span><span class="nav-label">Company documents</span></a>
        <a href="#" data-install ${['prompt', 'ios'].includes(installState()) ? '' : 'hidden'}><span class="nav-icon">⤓</span><span class="nav-label">Install app</span></a>
        <a href="#" data-logout><span class="nav-icon">⎋</span><span class="nav-label">Sign out</span></a>
      </nav>
      <main id="view"></main>
    </div>
    ${tabBar(groups.flatMap(([, items]) => items), active)}`;
  showNewsBadge();
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
  document.querySelectorAll('.menu-toggle, .tabbar-menu').forEach((b) => b.addEventListener('click', () => {
    placeNav();
    document.body.classList.toggle('nav-open');
  }));
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

// The site drop-downs on pages (see siteFilter and sitePicker in lib.js).
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches?.('select[data-site-pick]')) {
    chooseSite(state, Number(t.value));
    route();
  } else if (t.matches?.('select[data-site-scope]')) {
    const form = t.closest('form');
    if (form) form.requestSubmit();
    else {
      const { path, query } = parseHash();
      navigate(`${path}${qs({ ...query, scope: t.value })}`);
    }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTopMenus(); });

let routeSeq = 0;

export async function route() {
  const { path, query } = parseHash();
  if (path === 'set-password') return start();
  if (!state.user) return;
  renderShell();
  const el = document.getElementById('view');
  const match = ROUTES.map(([re, view, role]) => ({ m: path.match(re), view, role })).find((r) => r.m);
  if (!match) {
    el.innerHTML = '<div class="empty">Page not found.</div>';
    return;
  }
  // People who can't see the dashboard start on My Brew.
  if (match.view === dashboard.render && !state.can('dashboard.view')) {
    window.location.replace('#/mybrew');
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
  // An invite or password reset link: choose a password first (even if someone else is signed in on this device).
  const link = parseHash();
  if (link.path === 'set-password') {
    renderSetPassword(document.getElementById('app'), link.query.token, async (user, invite) => {
      state.user = user;
      history.replaceState(null, '', `${location.pathname}${location.search}#/${invite ? 'mybrew' : ''}`);
      await loadLocations();
      route();
    });
    return;
  }
  try {
    state.user = (await api('/auth/me')).user;
  } catch (err) {
    // No connection (e.g. the installed app opened offline): say so, rather than asking them to sign in again.
    if (!navigator.onLine || err instanceof TypeError) {
      document.getElementById('app').innerHTML = `<div class="login-wrap"><div class="card login offline-card">
        <h1 class="login-logo" aria-label="Brewly">${logo(40)}</h1>
        <p><strong>You’re offline.</strong> Brewly needs an internet connection – check your Wi-Fi or mobile data.</p>
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
const NO_STACK = '.rota, .hm, .grid-table, .matrix, .perm-matrix, .avail-table, .whos-in-table, .open-orders';
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
