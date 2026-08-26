/**
 * The business types a company may have — the single definition.
 *
 * There were five different lists. Two Mongoose schemas agreed on these four;
 * the website offered eight in one screen ("Manufacturer", "Wholesaler",
 * "Retailer", "Distributor", "Exporter", "Importer", "Other") and nine
 * lowercase ones in another ("retail", "wholesale", "technology", "food"…),
 * and the mobile app offered these four. Only the mobile app could ever save.
 *
 * Every other value was rejected by the enum at write time, which is a bad
 * place to find out: the user has filled in the whole form, the logo is
 * uploaded, and the answer comes back as a server error. A dropdown must not
 * offer a choice the database refuses.
 *
 * Both clients keep a copy of this list, because a dropdown cannot wait on a
 * network round-trip to render. Anything added here has to be added there —
 * `website/src/lib/businessTypes.ts` and
 * `frontend/src/constants/businessTypes.ts` both name this file.
 */
const BUSINESS_TYPES = ['Manufacturing', 'Trader', 'Service Provider', 'Others'];

/**
 * Match input to a canonical type, or return '' if it is not one of them.
 *
 * Case- and spacing-insensitive so that "service provider" and
 * "Service  Provider" are the same choice. It deliberately does NOT map
 * near-misses: "Wholesaler" is not silently rewritten to "Trader", because
 * quietly saving something other than what the user picked is worse than
 * telling them the choice is not available.
 */
const normalizeBusinessType = (value) => {
    const raw = String(value === null || value === undefined ? '' : value)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
    if (!raw) return '';
    return BUSINESS_TYPES.find((type) => type.toLowerCase() === raw) || '';
};

/** The message shown when a value is not one of the four. */
const businessTypeError = (value) =>
    `"${String(value || '').trim()}" is not a valid business type. Choose one of: ${BUSINESS_TYPES.join(', ')}.`;

module.exports = { BUSINESS_TYPES, normalizeBusinessType, businessTypeError };
