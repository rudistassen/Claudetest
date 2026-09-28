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

/** Ingredients of the given recipes (or all), with each line's cost. */
export function ingredientRows(db, recipeIds = null) {
  const where = recipeIds ? `WHERE ri.recipe_id IN (${recipeIds.map(() => '?').join(', ')})` : '';
  return db.prepare(`
    SELECT ri.id, ri.recipe_id, ri.product_id, ri.quantity, ri.notes, ri.sort_order,
      p.name AS product_name, p.unit, p.unit_cost, p.units_per_pack, COALESCE(p.recipe_unit, p.unit) AS recipe_unit,
      p.allergens, p.active AS product_active
    FROM recipe_ingredients ri JOIN products p ON p.id = ri.product_id
    ${where} ORDER BY ri.recipe_id, ri.sort_order, ri.id`).all(...(recipeIds ?? []))
    .map((r) => ({ ...r, line_cost: round2(r.quantity * unitCost(r)) }));
}

/** Adds cost, GP and allergen information to recipe rows. */
export function enrich(recipe, ingredients) {
  const batchCost = ingredients.reduce((s, i) => s + i.quantity * unitCost(i), 0);
  const costPerPortion = batchCost / (recipe.portions || 1);
  const netPrice = recipe.vat_rated ? recipe.selling_price / (1 + VAT_RATE) : recipe.selling_price;
  const fromIngredients = new Map();
  for (const i of ingredients) {
    for (const a of parseAllergens(i.allergens)) fromIngredients.set(a, [...(fromIngredients.get(a) ?? []), i.product_name]);
  }
  const allergens = new Set([...fromIngredients.keys(), ...parseAllergens(recipe.extra_allergens)]);
  return {
    ...recipe,
    batch_cost: round2(batchCost),
    cost_per_portion: round2(costPerPortion),
    net_price: round2(netPrice),
    gp: round2(netPrice - costPerPortion),
    gp_pct: netPrice > 0 ? round2(((netPrice - costPerPortion) / netPrice) * 100) : null,
    allergens: ALLERGEN_KEYS.filter((a) => allergens.has(a)),
    allergen_sources: Object.fromEntries(fromIngredients),
    may_contain_list: parseAllergens(recipe.may_contain),
    ingredient_count: ingredients.length,
    missing_costs: ingredients.filter((i) => !i.unit_cost).map((i) => i.product_name),
  };
}

export function loadRecipes(db, { activeOnly = false } = {}) {
  const recipes = db.prepare(`SELECT * FROM recipes ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY active DESC, category, name`).all();
  const byRecipe = new Map();
  for (const i of ingredientRows(db)) byRecipe.set(i.recipe_id, [...(byRecipe.get(i.recipe_id) ?? []), i]);
  return recipes.map((r) => enrich(r, byRecipe.get(r.id) ?? []));
}

// SQL condition matching a Square sales line to a recipe: by catalog id, or by item name if no id was linked.
export const SALES_MATCH = `(
  (r.square_catalog_object_id IS NOT NULL AND si.catalog_object_id = r.square_catalog_object_id)
  OR (r.square_catalog_object_id IS NULL AND r.square_item_name IS NOT NULL AND lower(si.name) = lower(r.square_item_name))
)`;
