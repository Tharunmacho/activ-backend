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
const FIELDS = ['state', 'district', 'block'];

const audienceClause = (member = {}, { depth = FIELDS.length } = {}) => {
    const clauses = FIELDS.slice(0, depth).map((field) => {
        const pattern = regionPattern(member[field]);
        const anyone = [{ [field]: '' }, { [field]: { $exists: false } }, { [field]: null }];

        return { $or: pattern ? anyone.concat([{ [field]: pattern }]) : anyone };
    });

    return { $and: clauses };
};

/**
 * How many levels of targeting a viewer is held to.
 *
 * A MEMBER stands in one block, and content aimed at any other block is not
 * theirs — all three levels must match. An ADMIN supervises everything beneath
 * them, and that is the whole difference: a notice aimed at one block inside a
 * district IS the district admin's business, because approving and monitoring
 * that block is their job. Holding them to the member's rule hid exactly the
 * content they are responsible for — a district admin could not see the event
 * their own blocks were invited to.
 *
 * So the levels below an admin's own tier are left unconstrained: a state admin
 * matches on state alone and sees every district and block within it; a district
 * admin matches on state and district; a block admin, like a member, on all
 * three, because there is nothing beneath a block.
 */
const VIEWER_DEPTH = { state_admin: 1, district_admin: 2 };

const viewerDepth = (viewer = {}) => VIEWER_DEPTH[String(viewer.role || '')] || FIELDS.length;

/** The audience clause for whoever is asking, member or supervising admin. */
const viewerClause = (viewer = {}) => audienceClause(viewer, { depth: viewerDepth(viewer) });

/** Does one already-loaded document target this member? The in-memory twin. */
const targetsMember = (doc = {}, member = {}, { depth = FIELDS.length } = {}) =>
    FIELDS.slice(0, depth).every((field) => {
        const target = String(doc[field] || '').trim();
        if (!target) return true;

        const pattern = regionPattern(member[field]);
        return pattern ? pattern.test(target) : false;
    });

/** The in-memory twin of the clause above — same depth rule, one document. */
const targetsViewer = (doc = {}, viewer = {}) => targetsMember(doc, viewer, { depth: viewerDepth(viewer) });

/**
 * The same question, asked of content that carries a LIST of targets.
 *
 * `audienceClause` above matches one set of region fields on the document. This
 * matches an array of them: the content reaches a viewer when ANY entry does,
 * which is what makes one event announceable to eight blocks without being
 * posted eight times.
 *
 * Three cases, and all three have to be in one `$or` because a single
 * collection holds all three at once:
 *
 *   1. rows written before `targets` existed — no such field at all
 *   2. rows aimed at everywhere — `targets: []`
 *   3. rows with a list
 *
 * Cases 1 and 2 are answered by the legacy top-level fields, which every write
 * mirrors from the first target, so a row in case 3 also satisfies the legacy
 * branch for its first region. That overlap is harmless: `$or` is a union, and
 * the first target is a member of the list anyway.
 *
 * The `$elemMatch` matters and a plain dotted path would be WRONG. Querying
 * `{'targets.state': 'Tamil Nadu', 'targets.district': 'Ariyalur'}` matches a
 * document where one entry supplies the state and a DIFFERENT entry supplies
 * the district — so an event aimed at all of Kerala plus one Tamil Nadu
 * district would be delivered to every district in Tamil Nadu. `$elemMatch`
 * requires one single entry to satisfy the whole clause.
 */
const multiTargetClause = (viewer = {}, { depth = FIELDS.length } = {}) => {
    const perField = FIELDS.slice(0, depth).map((field) => {
        const pattern = regionPattern(viewer[field]);
        const anyone = [{ [field]: '' }, { [field]: { $exists: false } }, { [field]: null }];

        return { $or: pattern ? anyone.concat([{ [field]: pattern }]) : anyone };
    });

    return {
        $or: [
            // No list: the top-level fields are the whole answer.
            {
                $and: [
                    { $or: [{ targets: { $size: 0 } }, { targets: { $exists: false } }, { targets: null }] },
                    ...perField
                ]
            },
            // A list: one entry matching in full is enough.
            { targets: { $elemMatch: { $and: perField } } }
        ]
    };
};

/** The clause for whoever is asking, against multi-target content. */
const multiTargetViewerClause = (viewer = {}) =>
    multiTargetClause(viewer, { depth: viewerDepth(viewer) });

/**
 * The in-memory twin of the clause above — one already-loaded document.
 *
 * Used to close a direct link that the list query would have filtered out. It
 * must agree with `multiTargetClause` exactly: a document the list hides and
 * this one admits is a targeting rule that can be walked around by pasting a
 * URL.
 */
const multiTargetsViewer = (doc = {}, viewer = {}) => {
    const depth = viewerDepth(viewer);
    const list = Array.isArray(doc.targets) ? doc.targets : [];

    // No list: fall back to the legacy fields, exactly as the clause does.
    if (!list.length) return targetsMember(doc, viewer, { depth });

    return list.some((target) => targetsMember(target || {}, viewer, { depth }));
};

/** How specific a target is — used to sort the most local notice to the top. */
const targetDepth = (doc = {}) =>
    ['state', 'district', 'block'].filter((field) => String(doc[field] || '').trim()).length;

/** "Tamil Nadu › Sivaganga" — how a target reads to a person. Empty for all. */
const targetLabel = (doc = {}) =>
    [doc.state, doc.district, doc.block]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' › ');

/**
 * A whole list of targets, as one line.
 *
 * "Tamil Nadu › Ariyalur › Andimadam, Kerala" — each scope in the same
 * breadcrumb form, joined with commas. Empty for an event aimed at everyone,
 * which every caller renders as "Everywhere" rather than as a blank.
 *
 * Falls back to the legacy single fields when there is no list, so one function
 * labels every row in the collection whichever era it was written in.
 */
const targetsLabel = (doc = {}) => {
    const list = Array.isArray(doc.targets) ? doc.targets : [];
    if (!list.length) return targetLabel(doc);

    return list
        .map((target) => targetLabel(target || {}))
        .filter(Boolean)
        .join(', ');
};

module.exports = {
    escapeRegex,
    regionPattern,
    audienceClause,
    viewerClause,
    viewerDepth,
    targetsMember,
    targetsViewer,
    multiTargetClause,
    multiTargetViewerClause,
    multiTargetsViewer,
    targetDepth,
    targetLabel,
    targetsLabel
};
