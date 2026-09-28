import { can, reportLocations, requirePerm } from '../auth.js';
import { tx } from '../db.js';
import { ALLERGENS, SALES_MATCH, TARGET_GP, cleanAllergens, enrich, ingredientRows, loadRecipes, unitCost } from '../recipes.js';
import { addDays, badRequest, bool, date, id, notFound, num, round2, str, today } from '../util.js';

const MAX_REPORT_DAYS = 366;

// Staff see recipes, methods and allergens but not costs or margins.
function forViewer(req, recipe) {
  if (can(req.user, 'recipes.costs') || can(req.user, 'recipes.edit')) return recipe;
  const { batch_cost, cost_per_portion, gp, gp_pct, missing_costs, ...rest } = recipe;
  if (rest.ingredients) rest.ingredients = rest.ingredients.map(({ unit_cost, line_cost, ...i }) => i);
  return rest;
}

export function registerRecipeRoutes(router, db) {
  router.get('/recipes/meta', requirePerm('recipes.view', 'recipes.costs', 'recipes.edit'), (_req, res) => res.json({ allergens: ALLERGENS, target_gp: TARGET_GP }));

  router.get('/recipes', requirePerm('recipes.view', 'recipes.costs', 'recipes.edit'), (req, res) => {
    res.json(loadRecipes(db, { activeOnly: !can(req.user, 'recipes.edit') && !can(req.user, 'recipes.costs') }).map((r) => forViewer(req, r)));
  });

  // Square items seen in synced sales, with the recipe each is linked to.
  router.get('/recipes/square-items', requirePerm('recipes.edit'), (_req, res) => {
    const items = db.prepare(`SELECT si.catalog_object_id, si.name, si.variation_name, SUM(si.quantity) AS quantity, SUM(si.net_sales) AS net_sales
      FROM sales_items si WHERE si.date >= ? GROUP BY si.item_key ORDER BY net_sales DESC`).all(addDays(today(), -90));
    const recipes = db.prepare('SELECT id, name, square_catalog_object_id, square_item_name FROM recipes WHERE active = 1').all();
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

    const recipes = new Map(loadRecipes(db, { activeOnly: true }).map((r) => [r.id, r]));
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

    // Theoretical usage: units sold × each ingredient's share of one portion.
    const usage = new Map();
    const lines = ingredientRows(db, items.map((i) => i.recipe_id).length ? items.map((i) => i.recipe_id) : [0]);
    for (const l of lines) {
      const soldQty = items.find((i) => i.recipe_id === l.recipe_id).quantity;
      const r = recipes.get(l.recipe_id);
      const used = (l.quantity / (r.portions || 1)) * soldQty;
      const u = usage.get(l.product_id) ?? { product_id: l.product_id, name: l.product_name, recipe_unit: l.recipe_unit, unit: l.unit, units_per_pack: l.units_per_pack, used: 0, cost: 0 };
      u.used += used;
      u.cost += used * unitCost(l);
      usage.set(l.product_id, u);
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
    const recipe = db.prepare('SELECT * FROM recipes WHERE id = ?').get(Number(req.params.id));
    if (!recipe || (!recipe.active && !can(req.user, 'recipes.edit') && !can(req.user, 'recipes.costs'))) throw notFound('Recipe');
    const ingredients = ingredientRows(db, [recipe.id]);
    res.json(forViewer(req, { ...enrich(recipe, ingredients), ingredients }));
  });

  function recipeBody(b) {
    const r = {
      name: str(b.name, 'name', { required: true, max: 150 }),
      category: str(b.category, 'category', { max: 100 }),
      description: str(b.description, 'description', { max: 1000 }),
      method: str(b.method, 'method', { max: 10000 }),
      portions: num(b.portions, 'portions', { min: 0.01 }) ?? 1,
      selling_price: num(b.selling_price, 'selling_price', { min: 0 }) ?? 0,
      vat_rated: b.vat_rated === undefined ? 1 : bool(b.vat_rated),
      extra_allergens: cleanAllergens(b.extra_allergens ?? []),
      may_contain: cleanAllergens(b.may_contain ?? []),
      shelf_life: str(b.shelf_life, 'shelf_life', { max: 200 }),
      square_catalog_object_id: str(b.square_catalog_object_id, 'square_catalog_object_id', { max: 64 }),
      square_item_name: str(b.square_item_name, 'square_item_name', { max: 150 }),
      active: b.active === undefined ? 1 : bool(b.active),
    };
    const ingredients = (Array.isArray(b.ingredients) ? b.ingredients : []).map((i, n) => ({
      product_id: id(i.product_id, 'product_id', { required: true }),
      quantity: num(i.quantity, 'quantity', { required: true, min: 0 }),
      notes: str(i.notes, 'notes', { max: 200 }),
      sort_order: n,
    }));
    for (const i of ingredients) {
      if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(i.product_id)) throw notFound('Product');
    }
    return { r, ingredients };
  }
  const cols = ['name', 'category', 'description', 'method', 'portions', 'selling_price', 'vat_rated', 'extra_allergens', 'may_contain',
    'shelf_life', 'square_catalog_object_id', 'square_item_name', 'active'];

  function saveIngredients(recipeId, ingredients) {
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
    const ins = db.prepare('INSERT INTO recipe_ingredients (recipe_id, product_id, quantity, notes, sort_order) VALUES (?, ?, ?, ?, ?)');
    for (const i of ingredients) ins.run(recipeId, i.product_id, i.quantity, i.notes, i.sort_order);
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
    if (!db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(recipeId)) throw notFound('Recipe');
    const { r, ingredients } = recipeBody(req.body);
    tx(db, () => {
      db.prepare(`UPDATE recipes SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => r[c]), recipeId);
      saveIngredients(recipeId, ingredients);
    });
    res.json({ id: recipeId });
  });
}
