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

`npm run seed` **deletes** the database and recreates it.

## Tests

```bash
npm test
```

The API tests cover login, site and role permissions, rota clash detection and week copying, suggested order quantities, the order lifecycle, stock-take completion, wastage costing and reports, and food-safety range checks and compliance.

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
  routes/           admin, rota, ordering, stock (stock takes + wastage), safety (+ dashboard)
public/
  index.html, css/, js/app.js (router), js/views/*   no build step
test/api.test.js
```

## Ideas for next steps

- Holiday/leave requests and staff availability on the rota; export hours to payroll
- Emailing orders straight from the server (SMTP), plus supplier price updates
- Theoretical stock (deliveries − sales − wastage) and variance against counts, using an EPOS integration
- Photo uploads for wastage and failed safety checks
- Reminders or push notifications for overdue checks
- Allergen and recipe management, and a temperature-probe (Bluetooth) integration
