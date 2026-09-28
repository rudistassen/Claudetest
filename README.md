# Cafe Ops

One web app for running a multi-site cafe business. It works on desktops, tablets and phones, so staff can use it on a tablet behind the counter and managers can use it from anywhere.

## Modules

| Module | What it does |
| --- | --- |
| **Dashboard** | A card for each site showing today's food-safety progress, failed checks, 7-day wastage cost, open orders, last stock take and who is on shift. Admins see all sites at once. |
| **Food safety** | Daily and weekly checklists based on the FSA *Safer Food, Better Business* diary: fridge/freezer/hot-hold/cooking/dishwasher temperatures, opening and closing checks, cleaning, pest control, allergens and probe calibration. A reading outside the safe range is marked as failed, and a corrective action must be recorded. There is a compliance report across all sites with a printable log of failures and actions. Checks can be set up for every site or for a single site (for example "Walk-in fridge 2"). |
| **Rota** | A weekly grid for each site. Click a cell to add a shift. You can copy last week's rota and print it. Hours and labour cost are totalled for each person and each day. Nobody can be double-booked at the same time, even across different sites, and staff can cover shifts at other sites. Staff see the rota and their own upcoming shifts, but not pay rates. |
| **Supplier orders** | Suppliers have order days, lead times and minimum orders. When you build an order, quantities are suggested as *par level minus the last stock count*, and par levels can be set per site. Orders go draft → sent (opens a ready-written email to the supplier) → received (record short or missing items) or cancelled. |
| **Stock takes** | Count stock by category on a phone or tablet. Counts save automatically, and you can search or show only uncounted items. The previous count is shown next to each item, with a running stock value. A manager completes the count. |
| **Wastage** | Staff record waste from the product list (costed automatically) or as a free-text item, with a reason. Reports break wastage down by reason, item and site over any date range, and export to CSV. |
| **Sales (Square)** | Pulls completed orders from your Square account for each linked site. Shows net sales (after discounts, excluding VAT and tips), transactions, average spend and top items, next to **labour %** (rostered wages ÷ net sales) and **wastage %** by day and by site. Sales also appear on the dashboard, in the rota footer and on the wastage page. Managers only. |
| **Trading (Square)** | A dashboard of Square sales next to **actual labour from Square clock-ins** (Timecards). Charts show net sales by day, labour % of sales (clocked vs rostered, against the target), and sales and staff on the clock by hour of the day. Tables show sales per labour hour, hours clocked vs rostered by site, who is clocked in now, and each person's rota vs clock-ins (late starts, missed shifts, clock-ins with no shift). Managers only. |
| **Recipes** | Recipe cards with ingredients, method, shelf life and portions. Each recipe is **costed automatically** from product prices and pack sizes (e.g. a 4L bottle of milk = 4000 ml), with cost per portion and **GP after VAT** (target 70%). **Allergens** come from the ingredients across the UK's 14 allergens, plus any you add by hand and "may contain" warnings. There is an **allergen matrix** with a "free from" filter for the counter. Link a recipe to its Square item to get **menu performance** (units sold, food cost and GP per item) and **theoretical ingredient usage**, and to cost wasted made items (e.g. a toastie) from the recipe. Staff can see recipes and allergens but not costs. Only admins edit recipes, so all sites stay the same. |
| **Setup** | Manage staff (role, home site, position, hourly rate), locations, suppliers, products and food-safety checks. |

## Roles

- **Admin** (owner/ops): all 7 sites, can change settings, and can switch site from the top bar.
- **Manager**: their own site. Can manage the rota, orders, stock takes, staff and site-specific safety checks.
- **Staff**: their own site. Can complete safety checks, record wastage, enter stock counts and view the rota.

## Running it

Requires **Node.js 22.13 or newer**. It uses the SQLite built into Node, so no database server is needed.

```bash
npm install
npm start           # http://localhost:3000
```

The first start creates `data/cafe.db` and loads demo data (7 sites, staff, suppliers, products, this week's rota):

| Login | Password |
| --- | --- |
| `admin@cafe.local` | `changeme123` |
| `manager1@cafe.local` … `manager7@cafe.local` | `changeme123` |
| `staff1@cafe.local` … `staff7@cafe.local` | `changeme123` |

To start with your real business instead of demo data:

```bash
SEED_DEMO=false ADMIN_EMAIL=you@yourcafe.co.uk ADMIN_PASSWORD='a-strong-password' npm run seed
npm start
```

Then sign in and add your locations, staff, suppliers and products under **Setup**. The standard food-safety checks are always included.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/cafe.db` | SQLite database file |
| `TZ_BUSINESS` | `Europe/London` | Time zone used to decide what "today" is |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | demo values | First admin account (only used when the database is empty) |
| `SEED_DEMO` | `true` | Set to `false` to skip demo data |
| `SQUARE_ACCESS_TOKEN` | – | Square access token; turns on the Square integration |
| `SQUARE_ENVIRONMENT` | `production` | `sandbox` to use a Square sandbox token and test data |
| `SQUARE_SYNC_MINUTES` | `30` | How often today's and yesterday's sales are refreshed |
| `SQUARE_API_VERSION` | `2025-01-23` | Square API version header |

`npm run seed` **deletes** the database and recreates it.

## Connecting Square

1. Sign in at [developer.squareup.com](https://developer.squareup.com) with the Square account that owns your locations, and create an application (e.g. "Cafe Ops").
2. Open the app, switch to **Production** and copy the **access token**. It gives read access to your orders, locations, team members and timecards (the token needs `ORDERS_READ`, `MERCHANT_PROFILE_READ`, `EMPLOYEES_READ` and `TIMECARDS_READ`). Treat it like a password.
3. Start Cafe Ops with it set, e.g. `SQUARE_ACCESS_TOKEN=EAAA... npm start`. The token is only read from the environment and is never stored in the database or shown in the app.
4. In Cafe Ops go to **Setup → Square**. Link each site to its Square location, or use **Add as new site** to create sites straight from Square.
5. Click **Import sales** to backfill history (up to 92 days per run). After that, sales and clock-ins refresh automatically every 30 minutes. The first automatic run backfills the last 28 days.
6. Staff clock in and out on Square (Square Team / Timecards). Each Square team member is matched to a Cafe Ops user by **email address**, then by name, so use the same email in both. If the token can't read timecards, sales still sync and the reason is shown on the Trading page and in the sync history.

How the numbers are worked out:
- **Net sales** = line-item totals after discounts, minus VAT (UK Square prices include VAT), minus itemised returns. Tips and service charges are excluded. Only `COMPLETED` orders are counted, and each is assigned to a business day by its close time in UK time.
- **Labour %** = rostered hours × each person's hourly rate ÷ net sales. For today it only counts hours worked up to now, and days with no Square sales are left out. The colours are green at 30% or below and amber up to 35%. Change `LABOUR_TARGET` in `public/js/views/sales.js` if your target differs.
- **Clocked labour** = paid hours on each Square timecard (unpaid breaks removed; still-open timecards count up to now) × the wage set on the job in Square, or the person's hourly rate in Cafe Ops if Square has none. Each timecard counts on the day it started.
- **Sales per labour hour** = net sales ÷ clocked hours, on days that have both. **Staff on the clock** by hour is paid clocked hours in that hour, averaged over the days with sales.
- Re-importing a period replaces what was stored for it, so it is safe to run again after refunds or late edits.

## Standalone demo

```bash
npm run build:demo   # writes dist/cafe-ops-demo.html
```

This produces one self-contained HTML file (about 1.4 MB) that runs the whole app in the browser. The real server routes run against an in-page SQLite database (sql.js), with demo data for 7 sites and a pretend Square account (sales, plus clock-ins that follow the demo rota). Open it straight from disk, or host it anywhere as a static file, to show people the app. Nothing is saved, and it resets when reloaded.

## Tests

```bash
npm test
```

The Square tests run against a local mock of Square's Locations, Orders, Team and Labor APIs: pagination, request format, VAT, returns, UK time zone day boundaries, idempotent re-syncs, timecard breaks and wages, team member matching, the trading dashboard figures, and sales still syncing when the token can't read timecards. The API tests cover login, site and role permissions, rota clash detection and week copying, suggested order quantities, the order lifecycle, stock-take completion, wastage costing and reports, and food-safety range checks and compliance.

## Deploying

The app is one Node process plus one SQLite file, so it runs on any small VPS or platform with a persistent disk (Render, Railway, Fly.io, a DigitalOcean droplet, etc.). Put it behind HTTPS (the session cookie is marked `Secure` when served over HTTPS) and back up `data/cafe.db` regularly.

## Project layout

```
src/
  index.js          start-up, first-run seeding
  server.js         Express app and error handling
  db.js             schema
  auth.js           passwords, sessions, role/location checks
  seed.js           demo data and default food-safety checks
  square.js         Square API client, order and timecard summarising, sales + clock-in sync
  metrics.js        sales / rostered and clocked labour / wastage per site per day and hour
  routes/           admin, rota, ordering, stock (stock takes + wastage), safety (+ dashboard), sales (+ Square setup), trading
public/
  index.html, css/, js/app.js (router), js/charts.js (SVG charts), js/views/*   no build step
test/api.test.js, test/square.test.js
```

## Ideas for next steps

- Holiday/leave requests and staff availability on the rota; export hours to payroll
- Emailing orders straight from the server (SMTP), plus supplier price updates
- Recipes that link Square menu items to stock products, giving theoretical stock (deliveries − sales − wastage), variance against counts, and smarter order suggestions
- Photo uploads for wastage and failed safety checks
- Reminders or push notifications for overdue checks
- Allergen and recipe management, and a temperature-probe (Bluetooth) integration
