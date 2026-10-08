import { can, reportLocations, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { ALLERGENS, SALES_MATCH, TARGET_GP, cleanAllergens, loadRecipes, productUsage, unitCost } from '../recipes.js';
import { addDays, badRequest, bool, date, id, notFound, num, oneOf, round2, str, today } from '../util.js';

const MAX_REPORT_DAYS = 366;

// Staff see recipes, methods and allergens but not costs or margins.
function forViewer(req, recipe) {
  if (can(req.user, 'recipes.costs') || can(req.user, 'recipes.edit')) return recipe;
  const { batch_cost, cost_per_portion, cost_per_unit, gp, gp_pct, missing_costs, ...rest } = recipe;
  if (rest.ingredients) rest.ingredients = rest.ingredients.map(({ unit_cost, line_cost, sub_cost_per_unit, ...i }) => i);
  return rest;
}

export function registerRecipeRoutes(router, db) {
  router.get('/recipes/meta', requirePerm('recipes.view', 'recipes.costs', 'recipes.edit'), (_req, res) => res.json({ allergens: ALLERGENS, target_gp: TARGET_GP }));

  router.get('/recipes', requirePerm('recipes.view', 'recipes.costs', 'recipes.edit'), (req, res) => {
    res.json(loadRecipes(db, { activeOnly: !can(req.user, 'recipes.edit') && !can(req.user, 'recipes.costs') }).map((r) => forViewer(req, r)));
  });

  // Square items: everything in the Square Items library (with its SKU, price and category) and anything else seen in
  // synced sales, best sellers first, with the recipe each is linked to.
  router.get('/recipes/square-items', requirePerm('recipes.edit'), (_req, res) => {
    const sold = db.prepare(`SELECT si.catalog_object_id, si.name, si.variation_name, SUM(si.quantity) AS quantity, SUM(si.net_sales) AS net_sales
      FROM sales_items si WHERE si.date >= ? GROUP BY si.item_key`).all(addDays(today(), -90));
    const soldById = new Map(sold.filter((i) => i.catalog_object_id).map((i) => [i.catalog_object_id, i]));
    const catalog = db.prepare('SELECT * FROM square_catalog ORDER BY item_name, variation_name').all();
    const inCatalog = new Set(catalog.map((c) => c.variation_id));
    const items = [
      ...catalog.map((c) => ({ catalog_object_id: c.variation_id, name: c.item_name, variation_name: c.variation_name, sku: c.sku, price: c.price, category: c.category_name,
        quantity: soldById.get(c.variation_id)?.quantity ?? 0, net_sales: soldById.get(c.variation_id)?.net_sales ?? 0 })),
      ...sold.filter((i) => !i.catalog_object_id || !inCatalog.has(i.catalog_object_id)).map((i) => ({ ...i, sku: null, price: null, category: null })),
    ].sort((a, b) => b.net_sales - a.net_sales || a.name.localeCompare(b.name));
    const recipes = db.prepare(`SELECT id, name, square_catalog_object_id, square_item_name FROM recipes WHERE active = 1 AND kind = 'sold'`).all();
    res.json(items.map((i) => {
      const linked = recipes.find((r) => (r.square_catalog_object_id
        ? r.square_catalog_object_id === i.catalog_object_id
        : r.square_item_name && r.square_item_name.toLowerCase() === i.name.toLowerCase()));
      return { ...i, quantity: round2(i.quantity), net_sales: round2(i.net_sales), recipe: linked ? { id: linked.id, name: linked.name } : null };
    }));
  });

  /**
   * Menu performance for a period: what each linked recipe sold, its food cost and GP, plus the
   * ingredients those sales should have used (theoretical usage). Admins may omit location_id for all sites.
   */
  router.get('/recipes/performance', requirePerm('recipes.costs'), (req, res) => {
    const to = date(req.query.to, 'to') ?? today();
    const from = date(req.query.from, 'from') ?? addDays(to, -6);
    if (from > to) throw badRequest('from must be before to');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_REPORT_DAYS) throw badRequest(`Reports are limited to ${MAX_REPORT_DAYS} days`);
    const ids = reportLocations(req, req.query.location_id).map((l) => l.id);
    const locFilter = `AND si.location_id IN (${ids.map(() => '?').join(', ')})`;
    const params = [from, to, ...ids];

    const recipes = new Map(loadRecipes(db).map((r) => [r.id, r]));
    const sold = db.prepare(`SELECT r.id AS recipe_id, SUM(si.quantity) AS quantity, SUM(si.net_sales) AS net_sales
      FROM recipes r JOIN sales_items si ON ${SALES_MATCH}
      WHERE r.active = 1 AND si.date BETWEEN ? AND ? ${locFilter} GROUP BY r.id`).all(...params);

    const items = sold.map((s) => {
      const r = recipes.get(s.recipe_id);
      const foodCost = s.quantity * r.cost_per_portion;
      return {
        recipe_id: r.id, name: r.name, category: r.category, quantity: round2(s.quantity), net_sales: round2(s.net_sales),
        cost_per_portion: r.cost_per_portion, food_cost: round2(foodCost), gp: round2(s.net_sales - foodCost),
        gp_pct: s.net_sales > 0 ? round2(((s.net_sales - foodCost) / s.net_sales) * 100) : null,
      };
    }).sort((a, b) => b.net_sales - a.net_sales);

    const unlinked = db.prepare(`SELECT si.name, si.variation_name, SUM(si.quantity) AS quantity, SUM(si.net_sales) AS net_sales
      FROM sales_items si WHERE si.date BETWEEN ? AND ? ${locFilter}
      AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.active = 1 AND ${SALES_MATCH})
      GROUP BY si.item_key ORDER BY net_sales DESC LIMIT 20`).all(...params)
      .map((u) => ({ ...u, quantity: round2(u.quantity), net_sales: round2(u.net_sales) }));

    // Theoretical usage: units sold × each ingredient's share of one portion, working through prepped recipes down
    // to the products they're made from.
    const usage = new Map();
    for (const item of items) {
      const r = recipes.get(item.recipe_id);
      for (const { line: l, used } of productUsage(recipes, r.id, item.quantity / (r.portions || 1))) {
        const u = usage.get(l.product_id) ?? { product_id: l.product_id, name: l.product_name, recipe_unit: l.recipe_unit, unit: l.unit, units_per_pack: l.units_per_pack, used: 0, cost: 0 };
        u.used += used;
        u.cost += used * unitCost(l);
        usage.set(l.product_id, u);
      }
    }

    const sales = items.reduce((s, i) => s + i.net_sales, 0);
    const food = items.reduce((s, i) => s + i.food_cost, 0);
    res.json({
      from,
      to,
      totals: { net_sales: round2(sales), food_cost: round2(food), gp: round2(sales - food), gp_pct: sales > 0 ? round2(((sales - food) / sales) * 100) : null },
      items,
      unlinked,
      usage: [...usage.values()].map((u) => ({ ...u, used: round2(u.used), packs: round2(u.used / (u.units_per_pack || 1)), cost: round2(u.cost) }))
        .sort((a, b) => b.cost - a.cost),
    });
  });

  router.get('/recipes/:id', requirePerm('recipes.view', 'recipes.costs', 'recipes.edit'), (req, res) => {
    const recipe = loadRecipes(db).find((r) => r.id === Number(req.params.id));
    if (!recipe || (!recipe.active && !can(req.user, 'recipes.edit') && !can(req.user, 'recipes.costs'))) throw notFound('Recipe');
    res.json(forViewer(req, recipe));
  });

  // A sold item (on the menu, linked to Square sales) or a prepped recipe (made in a batch with a yield, and used in
  // other recipes). recipeId is the recipe being saved, so it can't end up inside itself.
  function recipeBody(b, recipeId = null) {
    const kind = oneOf(b.kind ?? 'sold', 'kind', ['sold', 'prep'], { required: true });
    const prep = kind === 'prep';
    const r = {
      kind,
      yield_quantity: prep ? num(b.yield_quantity, 'Yield', { required: true, min: 0.0001 }) : null,
      yield_unit: prep ? str(b.yield_unit, 'Yield unit', { required: true, max: 30 }) : null,
      // Prepped recipes can be counted in stock takes (the default).
      in_stock_takes: prep ? (b.in_stock_takes === undefined ? 1 : bool(b.in_stock_takes)) : 0,
      name: str(b.name, 'name', { required: true, max: 150 }),
      category: str(b.category, 'category', { max: 100 }),
      description: str(b.description, 'description', { max: 1000 }),
      method: str(b.method, 'method', { max: 10000 }),
      portions: num(b.portions, 'portions', { min: 0.01 }) ?? 1,
      selling_price: prep ? 0 : num(b.selling_price, 'selling_price', { min: 0 }) ?? 0,
      vat_rated: b.vat_rated === undefined ? 1 : bool(b.vat_rated),
      extra_allergens: cleanAllergens(b.extra_allergens ?? []),
      may_contain: cleanAllergens(b.may_contain ?? []),
      shelf_life: str(b.shelf_life, 'shelf_life', { max: 200 }),
      square_catalog_object_id: prep ? null : str(b.square_catalog_object_id, 'square_catalog_object_id', { max: 64 }),
      square_item_name: prep ? null : str(b.square_item_name, 'square_item_name', { max: 150 }),
      sku: prep ? null : str(b.sku, 'sku', { max: 100 }),
      active: b.active === undefined ? 1 : bool(b.active),
    };
    // Each line is a product or a prepped recipe.
    const ingredients = (Array.isArray(b.ingredients) ? b.ingredients : []).map((i, n) => {
      const sub = id(i.sub_recipe_id, 'sub_recipe_id');
      return {
        product_id: sub ? null : id(i.product_id, 'product_id', { required: true }),
        sub_recipe_id: sub,
        quantity: num(i.quantity, 'quantity', { required: true, min: 0 }),
        notes: str(i.notes, 'notes', { max: 200 }),
        sort_order: n,
      };
    });
    for (const i of ingredients) {
      if (i.product_id && !db.prepare('SELECT 1 FROM products WHERE id = ?').get(i.product_id)) throw notFound('Product');
      if (i.sub_recipe_id) {
        const sub = db.prepare('SELECT id, name, kind FROM recipes WHERE id = ?').get(i.sub_recipe_id);
        if (!sub) throw notFound('Prepped recipe');
        if (sub.kind !== 'prep') throw badRequest(`${sub.name} is a sold item – only prepped recipes can go into other recipes`);
        if (recipeId && (sub.id === recipeId || usesRecipe(sub.id, recipeId))) throw badRequest(`${sub.name} already uses this recipe, so it can’t go into it`);
      }
    }
    return { r, ingredients };
  }
  // Whether a recipe has another inside it, at any depth.
  function usesRecipe(recipeId, targetId, seen = new Set()) {
    if (seen.has(recipeId)) return false;
    seen.add(recipeId);
    return db.prepare('SELECT sub_recipe_id FROM recipe_ingredients WHERE recipe_id = ? AND sub_recipe_id IS NOT NULL').all(recipeId)
      .some((l) => l.sub_recipe_id === targetId || usesRecipe(l.sub_recipe_id, targetId, seen));
  }
  const cols = ['kind', 'yield_quantity', 'yield_unit', 'in_stock_takes', 'name', 'category', 'description', 'method', 'portions', 'selling_price', 'vat_rated', 'extra_allergens', 'may_contain',
    'shelf_life', 'square_catalog_object_id', 'square_item_name', 'sku', 'active'];

  function saveIngredients(recipeId, ingredients) {
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
    const ins = db.prepare('INSERT INTO recipe_ingredients (recipe_id, product_id, sub_recipe_id, quantity, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    for (const i of ingredients) ins.run(recipeId, i.product_id, i.sub_recipe_id, i.quantity, i.notes, i.sort_order);
  }

  router.post('/recipes', requirePerm('recipes.edit'), (req, res) => {
    const { r, ingredients } = recipeBody(req.body);
    const recipeId = tx(db, () => {
      const created = db.prepare(`INSERT INTO recipes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => r[c]));
      saveIngredients(created.lastInsertRowid, ingredients);
      return Number(created.lastInsertRowid);
    });
    res.status(201).json({ id: recipeId });
  });

  router.put('/recipes/:id', requirePerm('recipes.edit'), (req, res) => {
    const recipeId = Number(req.params.id);
    const existing = db.prepare('SELECT kind FROM recipes WHERE id = ?').get(recipeId);
    if (!existing) throw notFound('Recipe');
    const { r, ingredients } = recipeBody(req.body, recipeId);
    // A prepped recipe used in others stays a prepped recipe.
    if (existing.kind === 'prep' && r.kind !== 'prep' && db.prepare('SELECT 1 FROM recipe_ingredients WHERE sub_recipe_id = ?').get(recipeId)) {
      throw badRequest('This prepped recipe is used in other recipes, so it can’t become a sold item');
    }
    tx(db, () => {
      db.prepare(`UPDATE recipes SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => r[c]), recipeId);
      saveIngredients(recipeId, ingredients);
    });
    res.json({ id: recipeId });
  });
}
