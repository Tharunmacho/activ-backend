/**
 * The categories a product may be filed under — the single definition.
 *
 * There were three different lists. The mobile app offered these fourteen
 * (`frontend/src/screens/business/AddProductScreen.tsx`); the website's "Add
 * Product" offered nine of its own ("Fashion", "Home & Garden", "Food &
 * Beverage"…) and its "Edit Product" offered six others again. Only
 * "Electronics" and "Other" appeared in all three.
 *
 * Unlike `businessType`, `category` is a plain required String on the Product
 * schema rather than an enum, so every one of those values saved happily and
 * nothing ever reported a problem. The damage showed up elsewhere: a product
 * created on the website as "Fashion" could not be re-selected in the website's
 * own edit form, because that form did not offer the value — so an unrelated
 * edit silently rewrote the category. Discover's category search and Analytics'
 * category grouping were meanwhile splitting one collection across two
 * vocabularies.
 *
 * Both clients keep a copy, because a dropdown cannot wait on a network
 * round-trip to render. Anything added here has to be added to
 * `website/src/lib/productCategories.ts` too.
 *
 * Deliberately NOT wired to the schema as an enum: existing rows hold values
 * from all three historical lists, and adding the enum would make every one of
 * them fail validation on its next save.
 */
const PRODUCT_CATEGORIES = [
    'Software',
    'Services',
    'Education',
    'Product',
    'Hardware',
    'Electronics',
    'Clothing',
    'Food',
    'Books',
    'Toys',
    'Furniture',
    'Sports',
    'Beauty',
    'Other',
];

/**
 * Match input to a canonical category, or return '' if it is not one of them.
 *
 * Case- and spacing-insensitive, matching `normalizeBusinessType`. It does not
 * map near-misses — "Fashion" does not become "Clothing" — because quietly
 * saving something other than what the user picked is worse than leaving the
 * field for them to set.
 */
const normalizeProductCategory = (value) => {
    const raw = String(value === null || value === undefined ? '' : value)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
    if (!raw) return '';
    return PRODUCT_CATEGORIES.find((category) => category.toLowerCase() === raw) || '';
};

module.exports = { PRODUCT_CATEGORIES, normalizeProductCategory };
