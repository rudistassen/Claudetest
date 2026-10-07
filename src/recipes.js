import { badRequest, round2 } from './util.js';

// The 14 allergens UK food businesses must declare (Food Information Regulations 2014).
export const ALLERGENS = [
  ['celery', 'Celery'],
  ['gluten', 'Cereals containing gluten'],
  ['crustaceans', 'Crustaceans'],
  ['eggs', 'Eggs'],
  ['fish', 'Fish'],
  ['lupin', 'Lupin'],
  ['milk', 'Milk'],
  ['molluscs', 'Molluscs'],
  ['mustard', 'Mustard'],
  ['nuts', 'Tree nuts'],
  ['peanuts', 'Peanuts'],
  ['sesame', 'Sesame'],
  ['soya', 'Soya'],
  ['sulphites', 'Sulphur dioxide / sulphites'],
];
export const ALLERGEN_KEYS = ALLERGENS.map(([k]) => k);

export const VAT_RATE = 0.2;
export const TARGET_GP = 70;

export const parseAllergens = (s) => (s ? String(s).split(',').map((a) => a.trim()).filter((a) => ALLERGEN_KEYS.includes(a)) : []);

export function cleanAllergens(value) {
  const list = Array.isArray(value) ? value : parseAllergens(value);
  const unknown = list.filter((a) => !ALLERGEN_KEYS.includes(a));
  if (unknown.length) throw badRequest(`Unknown allergen: ${unknown.join(', ')}`);
  return [...new Set(list)].sort((a, b) => ALLERGEN_KEYS.indexOf(a) - ALLERGEN_KEYS.indexOf(b)).join(',') || null;
}

// Cost of one recipe unit (e.g. one ml) of a product.
export const unitCost = (p) => (p.unit_cost || 0) / (p.units_per_pack || 1);

/**
 * Ingredient lines of the given recipes (or all). A line is a product, or a prepped recipe (sub_recipe_id) measured
 * in that recipe's yield unit. Product lines carry their cost here; prepped-recipe lines are costed by costRecipes.
 */
export function ingredientRows(db, recipeIds = null) {
  const where = recipeIds ? `WHERE ri.recipe_id IN (${recipeIds.map(() => '?').join(', ')})` : '';
  return db.prepare(`
    SELECT ri.id, ri.recipe_id, ri.product_id, ri.sub_recipe_id, ri.quantity, ri.notes, ri.sort_order,
      COALESCE(p.name, sr.name) AS product_name, p.unit, p.unit_cost, p.units_per_pack,
      CASE WHEN ri.sub_recipe_id IS NOT NULL THEN COALESCE(sr.yield_unit, 'portion') ELSE COALESCE(p.recipe_unit, p.unit) END AS recipe_unit,
      p.allergens, COALESCE(p.active, sr.active) AS product_active
    FROM recipe_ingredients ri LEFT JOIN products p ON p.id = ri.product_id LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
    ${where} ORDER BY ri.recipe_id, ri.sort_order, ri.id`).all(...(recipeIds ?? []))
    .map((r) => ({ ...r, line_cost: r.sub_recipe_id ? null : round2(r.quantity * unitCost(r)) }));
}

// How much of a recipe one batch makes: a prepped recipe's yield, or a sold item's portions.
export const batchSize = (r) => (r.kind === 'prep' ? r.yield_quantity || 1 : r.portions || 1);

/**
 * Costs, GP and allergens for recipes, working through prepped recipes used inside them (and the prepped recipes
 * inside those). recipes and rows must include every prepped recipe used. A recipe that ends up inside itself is
 * costed as if that line were free, rather than looping.
 */
export function costRecipes(recipes, rows) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const lines = new Map();
  for (const l of rows) lines.set(l.recipe_id, [...(lines.get(l.recipe_id) ?? []), l]);
  const done = new Map();
  const working = new Set();
  const calc = (id) => {
    if (done.has(id)) return done.get(id);
    const recipe = byId.get(id);
    if (!recipe || working.has(id)) return null;
    working.add(id);
    let batchCost = 0;
    const fromIngredients = new Map();
    const mayContain = new Set(parseAllergens(recipe.may_contain));
    const missing = new Set();
    const ingredients = (lines.get(id) ?? []).map((i) => {
      if (!i.sub_recipe_id) {
        const cost = i.quantity * unitCost(i);
        batchCost += cost;
        if (!i.unit_cost) missing.add(i.product_name);
        for (const a of parseAllergens(i.allergens)) fromIngredients.set(a, [...(fromIngredients.get(a) ?? []), i.product_name]);
        return i;
      }
      const sub = calc(i.sub_recipe_id);
      const cost = sub ? i.quantity * sub.cost_per_unit : 0;
      batchCost += cost;
      if (sub) {
        for (const a of sub.allergens) fromIngredients.set(a, [...(fromIngredients.get(a) ?? []), i.product_name]);
        for (const a of sub.may_contain_list) mayContain.add(a);
        for (const m of sub.missing_costs) missing.add(`${m} (in ${i.product_name})`);
      }
      return { ...i, line_cost: round2(cost), sub_cost_per_unit: sub ? sub.cost_per_unit : null };
    });
    const costPerUnit = batchCost / batchSize(recipe);
    const prep = recipe.kind === 'prep';
    const netPrice = prep ? 0 : recipe.vat_rated ? recipe.selling_price / (1 + VAT_RATE) : recipe.selling_price;
    const allergens = new Set([...fromIngredients.keys(), ...parseAllergens(recipe.extra_allergens)]);
    const out = {
      ...recipe,
      ingredients,
      batch_cost: round2(batchCost),
      // Prepped recipes: the cost of one yield unit (e.g. one g of sauce), unrounded so small amounts add up right.
      cost_per_unit: costPerUnit,
      cost_per_portion: round2(costPerUnit),
      net_price: round2(netPrice),
      gp: prep ? null : round2(netPrice - costPerUnit),
      gp_pct: !prep && netPrice > 0 ? round2(((netPrice - costPerUnit) / netPrice) * 100) : null,
      allergens: ALLERGEN_KEYS.filter((a) => allergens.has(a)),
      allergen_sources: Object.fromEntries(fromIngredients),
      may_contain_list: ALLERGEN_KEYS.filter((a) => mayContain.has(a)),
      ingredient_count: ingredients.length,
      missing_costs: [...missing],
    };
    working.delete(id);
    done.set(id, out);
    return out;
  };
  for (const r of recipes) calc(r.id);
  // Where each prepped recipe is used.
  for (const r of done.values()) {
    r.used_in = r.kind === 'prep' ? rows.filter((l) => l.sub_recipe_id === r.id).map((l) => byId.get(l.recipe_id))
      .filter(Boolean).map((u) => ({ id: u.id, name: u.name, kind: u.kind })) : [];
  }
  return done;
}

/** Every recipe (or just active ones), costed. Each includes its ingredient lines. */
export function loadRecipes(db, { activeOnly = false } = {}) {
  const all = db.prepare('SELECT * FROM recipes ORDER BY active DESC, category, name').all();
  const costed = costRecipes(all, ingredientRows(db));
  return all.filter((r) => !activeOnly || r.active).map((r) => costed.get(r.id));
}

/**
 * The products that go into a quantity of a recipe, working through any prepped recipes in it:
 * [{ line (the product's ingredient row), used (in its recipe unit) }].
 */
export function productUsage(costed, recipeId, batches, depth = 0) {
  const r = costed.get(recipeId);
  if (!r || depth > 20) return [];
  return r.ingredients.flatMap((l) => (l.sub_recipe_id
    ? productUsage(costed, l.sub_recipe_id, (l.quantity * batches) / batchSize(costed.get(l.sub_recipe_id) ?? {}), depth + 1)
    : [{ line: l, used: l.quantity * batches }]));
}

// SQL condition matching a Square sales line to a recipe: by catalog id, or by item name if no id was linked.
export const SALES_MATCH = `r.kind = 'sold' AND (
  (r.square_catalog_object_id IS NOT NULL AND si.catalog_object_id = r.square_catalog_object_id)
  OR (r.square_catalog_object_id IS NULL AND r.square_item_name IS NOT NULL AND lower(si.name) = lower(r.square_item_name))
)`;
