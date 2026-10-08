# Atlas

One web app for running a multi-site cafe business. It works on desktops, tablets and phones, so staff can use it on a tablet behind the counter and managers can use it from anywhere.

## Modules

| Module | What it does |
| --- | --- |
| **Dashboard** | For people who can see sales, a **Sales & labour by site** panel: net sales, orders and labour % (clocked from Square where available, otherwise rostered) for every site, today or over the last 7 days, with bars, the labour target and a group total. Then a card for each site: gross sales, net sales and labour cost today so far, each against the same weekday last week up to the same time; who has clocked in (from Square) and for how long; 7-day wastage, open orders and the last stock take; and the daily and weekly Trail checks at the bottom. People who can't see sales see who is rostered on instead. Admins see all sites at once. |
| **Trail** | Food-safety checks: daily and weekly checklists based on the FSA *Safer Food, Better Business* diary: fridge/freezer/hot-hold/cooking/dishwasher temperatures, opening and closing checks, cleaning, pest control, allergens and probe calibration. A reading outside the safe range is marked as failed, and a corrective action must be recorded. There is a compliance report across all sites with a printable log of failures and actions. Under **Trail → Set up**, each site’s checks can be managed one site at a time: add a check for that site (admins can add one for every site), change a shared check for just that site (with **Use the shared version** to undo), turn a shared check off at one site, and edit, turn off or delete a site’s own checks. A check with past records is turned off rather than deleted, so the history is kept. |
| **My Atlas** | Each person's own page (first under **Team**): their details (role, access, sites, pay rate), their next shifts, holiday booked and waiting, and the **news feed** – announcements, policy updates, events and reminders posted under **Setup → News**. Posts can include **photos and short videos** (up to 10 per post; photos are resized automatically, videos up to 25 MB), go to every site or chosen sites, can be pinned, and policy updates can ask people to tap **I've read this**; Setup → News shows who has and hasn't. The menu shows a red count of updates waiting to be read. **Company documents** (handbooks, policies, guides and forms – PDF, Word, Excel, PowerPoint, text or pictures up to 20 MB) are listed on My Atlas too, shared with every site or chosen sites from **Setup → Documents**. Posting needs the "My Atlas news" permission (given to managers). |
| **Rota** | Opens on **today**: a timeline of the day's shifts, site by site, with a Day/Week toggle. For managers, each site shows **forecast sales** (that weekday's average over the last 8 weeks, leaving out bank holidays and closed days) and the rota's **labour %** against it, updating as shifts are added. Publish the whole week, one site, one day, or **just one shift**. The week view is a weekly grid for each site. Click a cell to add a shift. You can copy last week's rota and print it. Hours and labour cost are totalled for each person and each day. Nobody can be double-booked at the same time, even across different sites, and staff can cover shifts at other sites. Admins can switch to **All sites** to see every site's rota at once, grouped by the site people are rostered at (each site's own staff plus anyone covering there that week), and each shift has a **Site** so anyone can be put on at another café (shifts at another site show greyed out on their home site's rota). Changes are a **draft** until someone with the *Publish the rota* permission clicks **Publish**: editors see new, changed and removed shifts marked (with what staff currently see), can discard them, and everyone else keeps seeing the last published rota, including on the dashboard and in their upcoming shifts. Labour figures on the Trading and Sales pages use the published rota. Staff see the rota and their own upcoming shifts, but not pay rates. A **My shifts** button shows just your own published shifts for the week, at every site, with hours and who else is on. |
| **Time off** | Everyone can **request holiday** (whole days, with a note) and cancel it, and set their **usual availability** for each day of the week (any time, only between two times, or not available) with a note. People with *Approve holiday requests* approve or decline requests from staff at their sites (never their own), see who's on the rota during a requested holiday, and see the team's availability. Approved holiday shows on the rota and blocks shifts on those days; requested holiday and availability show as hints, and adding a shift outside someone's availability gives a warning. The dashboard shows how many requests are waiting. |
| **Supplier orders** | Suppliers have order days, lead times and minimum orders. When you build an order, quantities are suggested as *par level minus the last stock count*, and par levels can be set per site. Orders go draft → sent (opens a ready-written email to the supplier) → received (record short or missing items) or cancelled. |
| **Stock takes** | Count stock by category on a phone or tablet. Counts save automatically, and you can search or show only uncounted items. The previous count is shown next to each item, with a running stock value. A manager completes the count. |
| **Wastage** | Staff record waste from the product list (costed automatically) or as a free-text item, with a reason. Reports break wastage down by reason, item and site over any date range, and export to CSV. |
| **Sales (Square)** | Pulls completed orders from your Square account for each linked site. Shows net sales (after discounts, excluding VAT and tips), transactions, average spend and top items, next to **labour %** (rostered wages ÷ net sales) and **wastage %** by day and by site. Sales also appear on the dashboard, in the rota footer and on the wastage page. Managers only. |
| **Trading (Square)** | A dashboard of Square sales next to **actual labour from Square clock-ins** (Timecards). Charts show net sales by day, labour % of sales (clocked vs rostered, against the target), and sales and staff on the clock by hour of the day. Tables show sales per labour hour, hours clocked vs rostered by site, who is clocked in now, and each person's rota vs clock-ins (late starts, missed shifts, clock-ins with no shift). A **Labour heatmap** tab shows labour % for every day of the week × hour of the day (clocked or rostered, blue under target through red over), with the hours where labour runs highest and the labour cost in hours with no sales. Managers only. |
| **Recipes** | Recipe cards with ingredients, method, shelf life and portions. Each recipe is **costed automatically** from product prices and pack sizes (e.g. a 4L bottle of milk = 4000 ml), with cost per portion and **GP after VAT** (target 70%). **Allergens** come from the ingredients across the UK's 14 allergens, plus any you add by hand and "may contain" warnings. There is an **allergen matrix** with a "free from" filter for the counter. Link a recipe to its Square item to get **menu performance** (units sold, food cost and GP per item) and **theoretical ingredient usage**, and to cost wasted made items (e.g. a toastie) from the recipe. Staff can see recipes and allergens but not costs. Only admins edit recipes, so all sites stay the same. |
| **Setup** | Manage staff (access, home site, hourly rate), permission sets, locations, suppliers, products and food-safety checks. | **Products → Import** adds or updates products in bulk from an Excel or CSV file (or rows pasted from Excel), with a preview of every change first: products are matched by SKU then name, blank cells leave values as they are, and new suppliers are added. **Export** downloads every product in the same layout, to edit in Excel and import back. **Staff** has a search box and tick boxes: tick people (or tick the header box to select everyone shown) and **Edit selected** to change their role, home site, access, hourly rate or active status in one go – only the fields you change are updated, and if anyone can't be changed, nobody is. Each person's **Role** (e.g. Kitchen, Front of house) groups the rota: **View: site, then role** or **View: role, then site**.

## Roles and permissions

- **Admin** (owner/ops): everything at every site. Admins aren't limited by a permission set, so you can't lock yourself out.
- **Sites:** everyone can work with **every site** by default. On the Staff page you can limit someone to **only the sites you tick** (their home site is always included). Anyone with more than one site gets the site picker in the top bar and the "All sites" views (dashboard, rota, sales, trading, wastage, compliance report). People who manage staff can only give others sites they have themselves.
- **Everyone else** (not admins) can do what their **permission set** allows, at the sites they can work with. Sets are managed by admins under **Setup → Permissions**: tick what each set allows, area by area (Trail, rota, wastage, stock takes, orders, recipes, sales & trading, staff, suppliers & products). Give each person a set with the **Access** box on the Staff page.
- Two sets are built in and match the old roles: **Manager** (runs their site: rota, orders, stock, staff and sales) and **Staff** (food-safety checks, wastage, stock counts, the rota and recipes). People without a set get the one for their role. Built-in sets can be changed but not deleted, and a set can't be deleted while anyone uses it.
- People who can manage staff can only give others access they have themselves, and only admins can give someone access to manage staff.

## Running it

**On Windows, the easy way:** install [Node.js](https://nodejs.org) (the LTS version), then double-click `start-windows.bat` in this folder. The first time, it sets the app up and asks for your Square access token (it's saved in `square-token.txt` next to it, which is never committed; delete that file to change the token). It then opens the app in your browser. Keep the black window open while you use the app.

To update to the latest version, close the app and double-click `update-windows.bat`. It backs up `data/cafe.db` to `data/cafe-backup.db`, downloads the latest code and installs it, keeping your data and Square token.

**From a terminal:**

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
| `SQUARE_SYNC_MINUTES` | `5` | How often today's and yesterday's sales are refreshed |
| `SQUARE_API_VERSION` | `2025-01-23` | Square API version header |

`npm run seed` **deletes** the database and recreates it.

## Connecting Square

1. Sign in at [developer.squareup.com](https://developer.squareup.com) with the Square account that owns your locations, and create an application (e.g. "Atlas").
2. Open the app, switch to **Production** and copy the **access token**. It gives read access to your orders, locations, team members and timecards (the token needs `ORDERS_READ`, `MERCHANT_PROFILE_READ`, `EMPLOYEES_READ`, `TIMECARDS_READ` and `ITEMS_READ` – the last one gives each item's category, for **Reporting → Par levels** has two tiles. **Create a new par level report**: pick a Square category, then a site. Pick the sales dates the averages come from (the last 6 full weeks to start with, or quick picks for the last 4, 6, 8 or 12 weeks). Each item in that category shows its average sold on each day of the week (Monday to Sunday) over those dates – days the site didn't trade are left out – with a row under it to budget the par level for each day. **Fill budget with average sold** puts in each day's average rounded up, to adjust from. **Save par levels** asks for a name and saves just the budgeted levels. **View saved par levels** lists the saved reports; each opens to its par levels, to print, change (saving the changes or as a new report) or delete. Categories come from Square's Items library, read with each Square sync (at most hourly).

## Phone notifications

Staff turn notifications on themselves on **My Atlas → Phone notifications** (on an iPhone, Atlas must be added to the Home Screen and opened from there), and choose which they get: the rota published, their shifts changing, open shifts, shift drop and holiday decisions, and news; and for managers, holiday and shift drop requests, someone not clocked in 15 minutes after their shift starts (sites with Square clock-ins), new events enquiries and new job applications.

Everything someone is notified about is also kept on their **Notifications** page (the 🔔 button on My Atlas, or the menu under their name) for 60 days. Tapping a notification on the phone opens that page, with a button to the page it's about.

They're on as soon as Atlas starts: it makes its own notification keys the first time and keeps them in its database. (To use your own instead, set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` – `npm run push-keys` makes a pair – and don't change them afterwards, or phones would need turning on again.)

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

The app is one Node process plus one SQLite file, so it runs on any platform with a persistent disk (Railway, Render, Fly.io, a small VPS). For example on **Railway**:

1. New project → **Deploy from GitHub repo** → pick this repository (and the branch to run, under the service's Settings → Source).
2. Add a **Volume** to the service, mounted at `/data`.
3. Add these **Variables**: `DB_PATH=/data/cafe.db`, `SEED_DEMO=false`, `ADMIN_EMAIL=you@yourcafe.co.uk`, `ADMIN_PASSWORD=<a strong password>`, `SQUARE_ACCESS_TOKEN=<your token>`.
4. Under **Settings → Networking**, click **Generate Domain** to get a web address (HTTPS is included).

On start-up the app creates your admin account from `ADMIN_EMAIL`/`ADMIN_PASSWORD` if it doesn't exist yet (also when the platform started the app once before these were set; an existing account is left alone). With `SEED_DEMO=false`, any account still using the demo password is switched off on start-up. `PORT` is set by the platform. On Railway, Render and Fly.io the app trusts the platform's proxy automatically, so the session cookie is marked `Secure`; elsewhere set `TRUST_PROXY=1` when running behind a reverse proxy. Failed sign-ins are limited to 10 per account and 20 per address every 15 minutes. Back up the database file regularly.

## Project layout

```
src/
  index.js          start-up, first-run seeding
  server.js         Express app and error handling
  db.js             schema
  auth.js           passwords, sessions, permission and location checks
  permissions.js    the permission catalogue and built-in Manager/Staff sets
  seed.js           demo data and default food-safety checks
  square.js         Square API client, order and timecard summarising, sales + clock-in sync
  team.js           importing Square Team members as staff
  cleanup.js        removing sites and staff that aren't in Square
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
