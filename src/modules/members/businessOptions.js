/**
 * The option lists the Business Creation Account offers, and the schemas
 * enforce.
 *
 * Business information and financial information are both part of a COMPANY
 * now, not of the applicant. A member may trade through more than one company,
 * and constitution, turnover, GSTIN and government registrations are facts
 * about a company rather than about the person who owns it — stored per member
 * they described whichever company happened to be filled in last.
 *
 * `businessTypes.js` holds the type list, because two schemas already share it.
 *
 * Mirrored in `website/src/lib/memberFormOptions.ts`. A value offered on one
 * side and missing from the other is not a cosmetic difference: the enum
 * rejects it after the whole form has been filled in.
 */

/**
 * `constitutionType`. `LLP` is new.
 *
 * It was the one constitution with no home: a limited liability partnership is
 * not a partnership firm and not a private limited company, and the members
 * filing as one had to choose whichever was less wrong.
 */
const CONSTITUTION_TYPES = [
    'OPC',
    'TRUST',
    'SOCIETY',
    'Proprietorship',
    'Partnership',
    'Private Limited',
    'LLP',
];

/**
 * "Registered with government" — which body, asked before the number.
 *
 * Each answer opens its own detail field, because a Udyam number, an export
 * council membership number and "whatever else you are registered with" are
 * three different things and one shared free-text box loses which is which.
 *
 * `NSIC` is the National Small Industries Corporation — the government company
 * that supports MSMEs with registration, tenders and credit. It is a separate
 * answer from `MSME / Udyam`: Udyam is the registration that makes a firm an
 * MSME, NSIC is a body a firm then registers WITH. A member is routinely both,
 * which is why this is a checkbox list and not a pick-one.
 *
 * It is added BEFORE `Other`, which stays last — "any other body" is only
 * meaningful after everything named.
 */
const GOVT_REGISTRATIONS = ['Export Councils', 'MSME / Udyam', 'NSIC', 'Other'];

/**
 * Turnover, as slabs — the lakh ranges first, the crore slabs after them.
 *
 * The crore slabs are an ADDITION, not a replacement. The list started at
 * "Below 1 Lakh" and stopped at "Above 1 Crore", which put a 5-crore trader and
 * a 500-crore manufacturer in one band; the association asked for the top of
 * the range to be broken out. The small end still has to be answerable, so it
 * stays exactly as it was and the new slabs continue upward from where it ends.
 *
 * `Above 1 Crore` is the one range NOT carried over. It is the band the seven
 * slabs below it replace, and offering both would let two members describe the
 * same turnover with two different answers. It stays in the schema enum
 * (`LEGACY_TURNOVER_RANGES`) because rows already hold it.
 *
 * `Other / Manual Entry` exists because a slab list is a simplification and the
 * company it does not fit must still be able to answer — the figure is then
 * typed into `turnoverOther`.
 */
const TURNOVER_SLABS = [
    'Below 1 Lakh',
    '1-5 Lakhs',
    '5-10 Lakhs',
    '10-50 Lakhs',
    '50 Lakhs - 1 Crore',
    '₹1 Crore - ₹10 Crore',
    '₹10 Crore - ₹25 Crore',
    '₹25 Crore - ₹50 Crore',
    '₹51 Crore - ₹100 Crore',
    '₹101 Crore - ₹200 Crore',
    '₹201 Crore - ₹500 Crore',
    'Above ₹500 Crore',
    'Other / Manual Entry',
];

/**
 * The ranges the member-level financial record started with.
 *
 * Only `Above 1 Crore` is unique to this list now — the other five are offered
 * above as well. Kept so rows written before the crore slabs existed still
 * validate: Mongoose checks an enum on every save of the whole document, so
 * dropping a stored value would make an unrelated edit of the same record fail
 * on a field nobody touched.
 */
const LEGACY_TURNOVER_RANGES = [
    'Below 1 Lakh',
    '1-5 Lakhs',
    '5-10 Lakhs',
    '10-50 Lakhs',
    '50 Lakhs - 1 Crore',
    'Above 1 Crore',
];

/** Everything a stored turnover value may be, blank included. */
const ALL_TURNOVER_RANGES = [...new Set([...TURNOVER_SLABS, ...LEGACY_TURNOVER_RANGES, ''])];

/** The government schemes the financial section offers, in its order. */
const GOVT_SCHEMES = [
    'Startup India',
    'MUDRA',
    'Stand-Up India',
    'PMEGP',
    'None',
    'Others',
];

/**
 * The earliest selectable commencement year.
 *
 * A dropdown rather than a free-text box: the year decides the membership band
 * and therefore the price (see MEMBERSHIP PRICING in CLAUDE.md), and a typed
 * `2081` was found out about at the payment step, if at all.
 */
const COMMENCEMENT_YEAR_FLOOR = 1950;

/** 1950 .. this year, newest first — most members type a recent year. */
const commencementYears = (now = new Date()) => {
    const top = now.getFullYear();
    const years = [];
    for (let year = top; year >= COMMENCEMENT_YEAR_FLOOR; year -= 1) years.push(String(year));
    return years;
};

module.exports = {
    CONSTITUTION_TYPES,
    GOVT_REGISTRATIONS,
    TURNOVER_SLABS,
    LEGACY_TURNOVER_RANGES,
    ALL_TURNOVER_RANGES,
    GOVT_SCHEMES,
    COMMENCEMENT_YEAR_FLOOR,
    commencementYears,
};
