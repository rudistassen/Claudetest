// Permission sets: named groups of permissions that staff are assigned to (Setup → Permissions). Admins can do
// everything at every site and aren't restricted by a set; everyone else works at their home site with the
// permissions of their set. Users without a set get the built-in set for their role (Manager or Staff).

export const PERMISSION_AREAS = [
  ['Dashboards', [
    ['dashboard.view', 'See the HQ Dashboard (every site they can access, side by side; sales and labour figures also need “See sales”)'],
    ['dashboard.manager', 'See the Manager Dashboard (their site’s day and everything waiting on them; opens on their home site)'],
  ]],
  ['Trail', [
    ['safety.complete', 'Complete Trail checks'],
    ['safety.manage', 'Set up their site’s checks and clear completed ones'],
    ['safety.report', 'See the compliance report'],
  ]],
  ['Rota', [
    ['rota.view', 'See the rota'],
    ['rota.edit', 'Add, change and copy shifts, and mark people as sick'],
    ['rota.publish', 'Publish the rota so staff can see it, and open shifts up for anyone to pick up'],
    ['rota.approve', 'Approve or decline shift drops and pick-ups'],
    ['rota.budget', 'Set the sales budget each site’s rota is planned against'],
    ['rota.ai', 'Use Claude on the rota: read a rota from a photo or PDF, and analyse the week against forecast sales'],
  ]],
  ['Holiday & availability', [
    ['leave.manage', 'Approve or decline holiday requests'],
    ['leave.edit', 'Add, change and take off other people’s holiday'],
    ['availability.view', 'See everyone’s availability (and change it for them)'],
  ]],
  ['Wastage', [
    ['wastage.record', 'Record wastage'],
    ['wastage.reports', 'See wastage reports and export them'],
    ['wastage.manage', 'Delete anyone’s wastage entries'],
  ]],
  ['Stock takes', [
    ['stock.count', 'Start stock takes and count stock'],
    ['stock.complete', 'Complete or discard stock takes'],
  ]],
  ['Orders & invoices', [
    ['orders.manage', 'Create, send and receive supplier orders, prep orders and product par levels'],
    ['invoices.manage', 'Upload and check supplier invoices, use the invoice inbox and send invoices to Xero'],
  ]],
  ['Recipes', [
    ['recipes.view', 'See recipes and allergens'],
    ['recipes.costs', 'See recipe costs, GP and menu performance'],
    ['recipes.edit', 'Create and edit recipes'],
  ]],
  ['Sales & trading', [
    ['sales.view', 'See sales, labour costs and the Sales, Trading and Rota costs pages'],
    ['sales.sync', 'Sync sales from Square (up to a week at a time)'],
    ['reviews.view', 'See Google reviews'],
    ['payments.send', 'Create and send Square payment links to customers (e.g. deposits)'],
  ]],
  ['Staff', [
    ['staff.manage', 'Add and edit staff at their site'],
    ['staff.pay', 'See and change pay rates'],
    ['timecards.move', 'Move a clock-in to another site they manage (changes the timecard in Square too)'],
    ['timecards.breaks', 'Add, change and remove breaks on clock-ins (changes the timecard in Square too, so it affects pay)'],
    ['staff.log', 'See the Staff log: sign-ins and every change people make'],
  ]],
  ['People', [
    ['people.recruitment', 'Recruitment: jobs, candidates and the careers inbox'],
    ['people.training', 'Learning & development: training records, online courses, giving courses to people and signing them off'],
    ['people.performance', 'Performance: one-to-ones, probation reviews and appraisals'],
    ['people.areas', 'Areas: who is trained to work in each area'],
  ]],
  ['Events', [
    ['events.manage', 'See and answer event enquiries from the events inbox'],
    ['events.calendar', 'See the events calendar'],
  ]],
  ['My Atlas news & documents', [
    ['news.manage', 'Post staff news and policy updates, and see who has read them'],
    ['documents.manage', 'Share company documents'],
  ]],
  ['Suppliers & products', [
    ['setup.products', 'Add and edit suppliers and products'],
  ]],
];

/**
 * What each permission was split from (or added alongside), so a set that had the old one gets the new ones too and
 * nobody loses access when permissions are made finer. Applied once, when the database is upgraded (see db.js).
 */
export const PERMISSION_SPLITS = {
  'rota.publish': ['rota.approve'],
  'sales.view': ['rota.budget', 'reviews.view'],
  'leave.manage': ['leave.edit', 'availability.view'],
  'orders.manage': ['invoices.manage'],
  'staff.manage': ['staff.pay'],
  'events.manage': ['events.calendar'],
  'news.manage': ['documents.manage'],
  'people.manage': ['people.recruitment', 'people.training', 'people.performance', 'people.areas'],
};

export const ALL_PERMISSIONS = PERMISSION_AREAS.flatMap(([, perms]) => perms.map(([key]) => key));

// What the Manager and Staff roles could do before permission sets existed.
export const DEFAULT_SETS = [
  {
    built_in: 'manager',
    name: 'Manager',
    description: 'Runs a site: rota, orders, stock, staff and sales for their own site.',
    permissions: ALL_PERMISSIONS.filter((p) => !['recipes.edit', 'setup.products', 'payments.send', 'rota.ai', 'staff.log'].includes(p)),
  },
  {
    built_in: 'staff',
    name: 'Staff',
    description: 'Works in a site: food-safety checks, wastage, stock counts, the rota and recipes.',
    permissions: ['safety.complete', 'rota.view', 'wastage.record', 'wastage.reports', 'stock.count', 'recipes.view'],
  },
];

/** Creates the built-in Manager and Staff sets if they don't exist yet. */
export function ensureDefaultSets(db) {
  const insert = db.prepare('INSERT INTO permission_sets (name, description, permissions, built_in) VALUES (?, ?, ?, ?)');
  for (const s of DEFAULT_SETS) {
    if (db.prepare('SELECT 1 FROM permission_sets WHERE built_in = ?').get(s.built_in)) continue;
    let name = s.name;
    for (let n = 2; db.prepare('SELECT 1 FROM permission_sets WHERE name = ?').get(name); n++) name = `${s.name} ${n}`;
    insert.run(name, s.description, JSON.stringify(s.permissions), s.built_in);
  }
}

/** Keeps only known permissions, in catalogue order. */
export function cleanPermissions(list) {
  const wanted = new Set(Array.isArray(list) ? list : []);
  return ALL_PERMISSIONS.filter((p) => wanted.has(p));
}

export const parsePermissions = (json) => {
  try { return cleanPermissions(JSON.parse(json ?? '[]')); } catch { return []; }
};

/**
 * The role stored alongside a set, used for sorting (managers first on the rota) and as the fallback set.
 * Anyone who can manage staff or edit the rota counts as a manager.
 */
export const roleForPermissions = (perms) => (perms.includes('staff.manage') || perms.includes('rota.edit') ? 'manager' : 'staff');
