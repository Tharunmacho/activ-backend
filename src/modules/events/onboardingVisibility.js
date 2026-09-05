/**
 * WHICH EVENTS BELONG ON THE ONBOARDING SITE.
 *
 * The onboarding site is the one surface with no viewer: everyone reading it is
 * anonymous, so there is nothing to compare a region, a membership or a role
 * against. Every other listing narrows its results to whoever is asking; this
 * one has to decide, per event, whether it is public content at all.
 *
 * ONE RULE, TWO SHAPES. The grid asks Mongo ("give me the listable ones") and
 * the detail page asks a document ("is this one listable?"). Both questions were
 * answered by their own inline conditions, which is the arrangement that quietly
 * produces a page the list hides and a URL that serves it anyway. They are
 * derived from one predicate here for the reason `regionMatch.multiTargetsViewer`
 * gives about its own twin: a rule that can be walked around by pasting a link
 * is not a rule.
 *
 * TWO WAYS AN EVENT QUALIFIES:
 *
 *   1. It was authored FOR the onboarding site — `channel: 'public'`, which is
 *      what the CMS sends — and is aimed at everybody. This is the marketing
 *      programme and the default path.
 *
 *   2. The super admin explicitly posted it there — `showOnOnboarding: true`,
 *      the "Onboarding website" choice on their Events form. Targeting is kept:
 *      the event is listed with its region and the events page filters by it.
 *      Honouring the targeting here instead would discard the instruction and
 *      leave an editor looking at a control that did nothing.
 *
 * AND ONE WAY IT IS DISQUALIFIED REGARDLESS: `audience: 'paid'`. A members-only
 * event is a membership benefit, and the point of the gate is lost on a page
 * reachable without a membership. Checked by the callers, which already had it.
 *
 * EVERY TEST IS A POSITIVE. Not `channel: { $ne: 'members' }`, which is the
 * tempting spelling, because of the direction each fails in: `$ne` lets through
 * any row that never named a channel — one written by an older build, by a
 * script, or by a path nobody has thought about yet — and that failure lands in
 * public. Requiring a marker means an unmarked row is simply not listed. Events
 * that predate the field were marked by `scripts/backfill-event-channel.js`.
 */

/** The three fields one region was stored in before `targets` existed. */
const LEGACY_FIELDS = ['state', 'district', 'block'];

/**
 * "Aimed at everybody" — as a Mongo clause.
 *
 * Both representations have to say it. The legacy trio is mirrored from the
 * FIRST entry of `targets` only, so an event aimed at four blocks whose first
 * entry was cleared — or one written by a client that sends the list and not the
 * mirror — satisfies the three field clauses while still carrying three regions.
 *
 * `$exists: false` and `null` alongside `''`: these fields were added after the
 * first events were written, so those documents have no such key at all and an
 * equality match on `''` matches none of them.
 */
const untargetedClause = () => ({
    // Either the flag says everyone, or both representations of the region list
    // are empty. Kept as one `$or` so the two halves cannot drift from
    // `isUntargeted`, which answers the same question about a loaded document.
    $or: [{ reachEveryone: true }, { $and: untargetedFieldClauses() }]
});

const untargetedFieldClauses = () => {
    const clauses = LEGACY_FIELDS.map(field => ({
        $or: [{ [field]: '' }, { [field]: { $exists: false } }, { [field]: null }]
    }));

    clauses.push({
        $or: [
            { targets: { $size: 0 } },
            { targets: { $exists: false } },
            { targets: null }
        ]
    });

    // The clauses themselves, not wrapped: the caller decides how to combine
    // them, and double-wrapping produced `{ $and: { $and: [...] } }` — which
    // Mongo reads as a malformed query rather than as a stricter one.
    return clauses;
};

/** The same question, of one already-loaded document. */
const isUntargeted = (doc = {}) => {
    // "Everyone in the association" outranks the list. The regions are
    // remembered but are not narrowing anything, so the event is aimed at
    // nobody in particular — which is exactly what untargeted means here.
    if (doc.reachEveryone === true) return true;

    const list = Array.isArray(doc.targets) ? doc.targets : [];
    if (list.length) return false;
    return LEGACY_FIELDS.every(field => !String(doc[field] || '').trim());
};

/**
 * The clause selecting onboarding-site content, for `Event.find`.
 *
 * Returned as a single `$or` so a caller can push it onto `$and` alongside its
 * own conditions without either being able to overwrite the other — which a
 * top-level `filter.channel = …` could, and did.
 */
const onboardingClause = () => ({
    $or: [
        { showOnOnboarding: true },
        { $and: [{ channel: 'public' }, untargetedClause()] }
    ]
});

/**
 * The same clause, evaluated in memory. Must agree with `onboardingClause`
 * exactly — see the note at the top of this file about why.
 *
 * `doc.channel === 'public'`, NOT `(doc.channel || 'public') === 'public'`.
 * Reading the schema's default into a document that does not carry the field
 * looks like the considerate thing to do and is the one way this predicate can
 * disagree with the clause: `{ channel: 'public' }` does not match a document
 * with no `channel` key, so defaulting here admits — in public, on the detail
 * page — precisely the unmarked row the clause was written to withhold. The
 * unit test in `tests/cms-content.test.js` exists because that is not visible
 * by reading either half on its own.
 *
 * So an unmarked row is not onboarding content, which is the fail-closed answer
 * both halves now give. Real rows have the marker: Mongoose stamps the default
 * on every write, and everything older was stamped by
 * `scripts/backfill-event-channel.js`.
 */
const isOnboardingContent = (doc = {}) => {
    if (doc.showOnOnboarding === true) return true;
    return doc.channel === 'public' && isUntargeted(doc);
};

module.exports = {
    onboardingClause,
    isOnboardingContent,
    isUntargeted,
    untargetedClause
};
