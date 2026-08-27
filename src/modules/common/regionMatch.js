/**
 * Matching a member's region against content that was targeted at a region.
 *
 * This is the mirror image of `buildGeoFilter` in `admin.service.js`. That one
 * asks "which applications fall inside this admin's patch"; this one asks
 * "which notices were aimed at the patch this member is standing in" — the
 * filter is on the CONTENT's region field, and an empty field means the content
 * was aimed at everyone.
 *
 * Written here rather than imported from the admin service because the two have
 * opposite defaults, and merging them would need a flag at every call site. An
 * application with no block belongs to no block admin; an announcement with no
 * block belongs to every member.
 *
 * Region names are free text typed by a Super Admin (see the admin-first region
 * architecture note in CLAUDE.md), so "Tamil Nadu" and "tamil  nadu" are the
 * same place to a person and two different strings to Mongo. Matching is
 * anchored, case-insensitive and tolerant of repeated whitespace, and regex
 * metacharacters are escaped — a district legitimately named "Sivaganga (South)"
 * would otherwise compile as a capture group and match nothing.
 */

const METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

const escapeRegex = (value) => String(value === null || value === undefined ? '' : value)
    .trim()
    .replace(METACHARACTERS, '\\$&');

/**
 * An anchored, case-insensitive pattern for one region name, tolerant of the
 * runs of whitespace that free-text entry produces. `null` for an empty name,
 * so callers can tell "no region given" from "a region that matches nothing".
 */
const regionPattern = (value) => {
    const escaped = escapeRegex(value).replace(/\s+/g, '\\s+');
    if (!escaped) return null;
    return new RegExp('^' + escaped + '$', 'i');
};

/**
 * The Mongo clause selecting content aimed at this member.
 *
 * For each of state/district/block the content matches when its field is
 * absent, empty, or names the member's own region. A member whose profile has
 * no district still sees everything targeted at their state, and sees nothing
 * targeted at a specific district — which is right: a notice for one district
 * is not for someone whose district is unknown.
 */
const audienceClause = (member = {}) => {
    const clauses = ['state', 'district', 'block'].map((field) => {
        const pattern = regionPattern(member[field]);
        const anyone = [{ [field]: '' }, { [field]: { $exists: false } }, { [field]: null }];

        return { $or: pattern ? anyone.concat([{ [field]: pattern }]) : anyone };
    });

    return { $and: clauses };
};

/** Does one already-loaded document target this member? The in-memory twin. */
const targetsMember = (doc = {}, member = {}) =>
    ['state', 'district', 'block'].every((field) => {
        const target = String(doc[field] || '').trim();
        if (!target) return true;

        const pattern = regionPattern(member[field]);
        return pattern ? pattern.test(target) : false;
    });

/** How specific a target is — used to sort the most local notice to the top. */
const targetDepth = (doc = {}) =>
    ['state', 'district', 'block'].filter((field) => String(doc[field] || '').trim()).length;

/** "Tamil Nadu › Sivaganga" — how a target reads to a person. Empty for all. */
const targetLabel = (doc = {}) =>
    [doc.state, doc.district, doc.block]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' › ');

module.exports = {
    escapeRegex,
    regionPattern,
    audienceClause,
    targetsMember,
    targetDepth,
    targetLabel
};
