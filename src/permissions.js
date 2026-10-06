// Permission sets: named groups of permissions that staff are assigned to (Setup → Permissions). Admins can do
// everything at every site and aren't restricted by a set; everyone else works at their home site with the
// permissions of their set. Users without a set get the built-in set for their role (Manager or Staff).

export const PERMISSION_AREAS = [
  ['Dashboard', [
    ['dashboard.view', 'See the dashboard (each site’s day at a glance; sales and labour figures also need “See sales”)'],
  ]],
  ['Trail', [
    ['safety.complete', 'Complete Trail checks'],
    ['safety.manage', 'Set up their site’s checks and clear completed ones'],
    ['safety.report', 'See the compliance report'],
  ]],
  ['Rota', [
    ['rota.view', 'See the rota'],
    ['rota.edit', 'Add, change and copy shifts'],
    ['rota.publish', 'Publish the rota so staff can see it'],
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
  ['Orders', [
    ['orders.manage', 'Create, send and receive supplier orders, set par levels, and upload supplier invoices'],
  ]],
  ['Recipes', [
    ['recipes.view', 'See recipes and allergens'],
    ['recipes.costs', 'See recipe costs, GP and menu performance'],
    ['recipes.edit', 'Create and edit recipes'],
  ]],
  ['Sales & trading', [
    ['sales.view', 'See sales, labour costs and the Sales and Trading pages'],
    ['sales.sync', 'Sync sales from Square (up to a week at a time)'],
    ['payments.send', 'Create and send Square payment links to customers (e.g. deposits)'],
  ]],
  ['Staff', [
    ['staff.manage', 'Add and edit staff at their site, and see pay rates'],
    ['timecards.move', 'Move a clock-in to another site they manage (changes the timecard in Square too)'],
    ['timecards.breaks', 'Add, change and remove breaks on clock-ins (changes the timecard in Square too, so it affects pay)'],
  ]],
  ['My Brew news & documents', [
    ['news.manage', 'Post staff news and policy updates, see who has read them, and share company documents'],
  ]],
  ['Holiday & availability', [
    ['leave.manage', 'Approve holiday requests and see everyone’s availability'],
  ]],
  ['Suppliers & products', [
    ['setup.products', 'Add and edit suppliers and products'],
  ]],
];

export const ALL_PERMISSIONS = PERMISSION_AREAS.flatMap(([, perms]) => perms.map(([key]) => key));

// What the Manager and Staff roles could do before permission sets existed.
export const DEFAULT_SETS = [
  {
    built_in: 'manager',
    name: 'Manager',
    description: 'Runs a site: rota, orders, stock, staff and sales for their own site.',
    permissions: ALL_PERMISSIONS.filter((p) => !['recipes.edit', 'setup.products', 'payments.send'].includes(p)),
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
