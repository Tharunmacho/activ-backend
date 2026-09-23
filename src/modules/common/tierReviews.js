const { normalizeStatus } = require('./applicationStatus');

/**
 * ==========================================================================
 * ONE APPLICATION, THREE VERDICTS
 * ==========================================================================
 *
 * The Block, District and State admin of the applicant's own region each hold
 * their OWN decision on the file. All three see it from the moment it is
 * submitted — that part is unchanged, and it is the geofence and only the
 * geofence that decides who sees it — but a decision one of them records is
 * theirs alone. The District's card says "Approved" when the DISTRICT approved,
 * never because the State did.
 *
 * WHAT THIS REPLACED, and the reported symptom that ended it: one shared
 * verdict, written by whoever acted first. The State admin approved an
 * applicant and the District admin's Hub showed the row as "Approved" — the
 * District had decided nothing, and their screen told them, and anyone reading
 * over their shoulder, that they had.
 *
 * ==========================================================================
 * ONLY THE STATE'S APPROVAL MAKES SOMEBODY A MEMBER
 * ==========================================================================
 *
 * The three verdicts are not equal, and pretending they were is what the old
 * single-verdict model did wrong in the other direction — it let a Block admin
 * create a member.
 *
 *   - **Block and District verdicts are endorsements.** Recorded, shown to
 *     every tier and to the Super Admin, and they decide nothing. A District
 *     rejection does NOT close the file: it is an objection on the record that
 *     the State admin reads before they act.
 *   - **The State's verdict is the application's outcome.** Approving it writes
 *     the member's documents; rejecting it ends the application.
 *   - **The Super Admin acts as the State**, because otherwise a region with no
 *     state admin would have nobody at all who could grant a membership, and
 *     `unstaffedTiers` would be reporting a queue that nothing could clear.
 *
 * So a tier is never waiting for another tier's turn — there are no turns — and
 * the two lower tiers can record their view before or after the State has acted.
 *
 * ==========================================================================
 * THE STORED `status` IS STILL THE OUTCOME. NOTHING HERE DERIVES IT.
 * ==========================================================================
 *
 * `application.status` remains the single source of truth for "is this person a
 * member", and `decide()` writes it only for the State and the Super Admin.
 * Deriving the outcome from the review slots instead would be a live hazard:
 * applications approved under the previous build were approved by whichever
 * tier got there first, their member documents exist, and a derivation that
 * asked "has the state slot been signed?" would answer no and un-approve a
 * member who has already paid.
 *
 * That is also why the fallback below never invents a verdict for a tier that
 * has none. A legacy row approved by the District reads as: District approved,
 * Block and State still to record theirs, outcome Approved. All three of those
 * are true — and the State's seat staying open on it is the point, because
 * under this rule a District approval never made anybody a member and the
 * State has still to say so.
 *
 * Every function here is pure and takes a plain object, so it is unit-testable
 * without a database and safe to call on a lean() document.
 */

/** The three geofenced tiers, smallest patch first. */
const TIER_ORDER = ['block', 'district', 'state'];

const DECISION = {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected'
};

/** How each tier signs a decision, and the reverse lookup. */
const TIER_ACTOR = {
    block: 'BlockAdmin',
    district: 'DistrictAdmin',
    state: 'StateAdmin',
    super: 'SuperAdmin'
};

const ACTOR_TIER = {
    BlockAdmin: 'block',
    DistrictAdmin: 'district',
    StateAdmin: 'state',
    SuperAdmin: 'super'
};

const TIER_LABELS = { block: 'Block', district: 'District', state: 'State', super: 'Super' };

/**
 * The tier whose verdict IS the application's outcome.
 *
 * Named rather than written as `'state'` in six places: it is a policy choice,
 * not a fact about the data, and the association may yet move it.
 */
const DECIDING_TIER = 'state';

/** Tiers that may write the outcome — the deciding tier, and the Super Admin. */
const decidesOutcome = (tier) => tier === DECIDING_TIER || tier === 'super';

/**
 * ==========================================================================
 * A HIGHER TIER'S APPROVAL CARRIES THE ONES BELOW IT
 * ==========================================================================
 *
 * The State approving settles the District's step and the Block's; the District
 * approving settles the Block's. A Super Admin settles all three.
 *
 * WHY: the tiers are an authority hierarchy, not three independent opinions.
 * Once the State has approved an applicant, asking their Block Admin to approve
 * the same applicant is asking for a decision that can no longer change
 * anything — and leaving it outstanding showed a block admin a live
 * Approve / Reject pair on a file that was already settled above them. That is
 * the screen this came from.
 *
 * WHAT IT DOES NOT DO: overwrite a decision a tier actually made. A Block that
 * has already REJECTED keeps its rejection — that objection is a real thing
 * somebody recorded, and erasing it to tidy up the hierarchy would delete the
 * one piece of evidence that the tiers disagreed. The outcome is unaffected
 * either way, because only the State's verdict grants the membership.
 *
 * APPROVALS ONLY. A rejection does not cascade: a State rejection already ends
 * the application through `status`, and stamping "rejected" into the Block's
 * slot would put words in the mouth of a tier that never looked at the file.
 */
const TIERS_BELOW = {
    super: ['state', 'district', 'block'],
    state: ['district', 'block'],
    district: ['block'],
    block: [],
};

const tiersBelow = (tier) => (TIERS_BELOW[tier] || []).slice();

const EMPTY_VERDICT = Object.freeze({
    decision: DECISION.PENDING,
    adminType: '',
    decidedAt: null,
    reason: ''
});

/**
 * The tier that signed the stored outcome, for a row with no review slots.
 *
 * `approvedBy` / `rejectedBy` carry it on anything decided under the parallel
 * build. Older rows predate those fields, and under the sequential workflow the
 * last tier to stamp a timestamp was the one that signed off — so the
 * timestamps are a true answer for exactly the rows that need them.
 */
const legacyDeciderTier = (application = {}) => {
    const status = normalizeStatus(application.status);

    if (status === 'Rejected') {
        return ACTOR_TIER[String(application.rejectedBy?.adminType || '')] || '';
    }
    if (status !== 'Approved') return '';

    const stamped = ACTOR_TIER[String(application.approvedBy?.adminType || '')];
    if (stamped) return stamped;
    if (application.stateApprovedAt) return 'state';
    if (application.districtApprovedAt) return 'district';
    if (application.blockApprovedAt) return 'block';
    return '';
};

/**
 * A tier's own legacy approval, from the timestamp it stamped.
 *
 * `blockApprovedAt` and `districtApprovedAt` are trustworthy: under BOTH
 * previous workflows they were written only when that tier itself acted, and
 * `reviewedBy.<tier>Admin` carries who.
 *
 * `stateApprovedAt` IS NOT, and is deliberately absent here. The parallel build
 * stamped it on every approval whoever made it — "it is what the member screens
 * read as the approval date" — so treating it as the State's own verdict would
 * credit the State with every decision a Block or District admin ever made.
 * That is the exact bug this whole module exists to stop. The State's legacy
 * verdict comes from `approvedBy.adminType` alone, via `legacyDeciderTier`.
 */
const legacyTierStamp = (application = {}, tier = '') => {
    const at = tier === 'block' ? application.blockApprovedAt
        : tier === 'district' ? application.districtApprovedAt
            : null;
    if (!at) return null;

    return {
        decision: DECISION.APPROVED,
        adminId: (application.reviewedBy || {})[`${tier}Admin`] || null,
        adminType: TIER_ACTOR[tier],
        decidedAt: at,
        reason: ''
    };
};

const normalizeDecision = (value) => {
    const decision = String(value || '').toLowerCase();
    return decision === DECISION.APPROVED || decision === DECISION.REJECTED
        ? decision
        : DECISION.PENDING;
};

/**
 * One tier's own verdict on this application.
 *
 * Reads the stored slot first. Falls back to the legacy attribution ONLY for
 * the tier that actually signed the stored outcome — never for the other two,
 * who genuinely have not decided. A Super Admin decision is attributed to the
 * deciding tier's slot, because that is the seat they were filling.
 */
const tierVerdict = (application = {}, tier = '', { carried = true } = {}) => {
    if (!TIER_ORDER.includes(tier)) return Object.assign({}, EMPTY_VERDICT);

    const stored = (application.reviews || {})[tier];
    if (stored && normalizeDecision(stored.decision) !== DECISION.PENDING) {
        return {
            decision: normalizeDecision(stored.decision),
            adminId: stored.adminId || null,
            adminType: String(stored.adminType || ''),
            decidedAt: stored.decidedAt || null,
            reason: String(stored.reason || ''),
            /** True when a higher tier's approval carried this one. */
            auto: stored.auto === true
        };
    }

    // A timestamp only that tier could have written.
    const stamped = legacyTierStamp(application, tier);
    if (stamped) return stamped;

    /*
     * CARRIED BY A HIGHER TIER — derived, not just stored.
     *
     * `decide()` writes these slots when the approval happens, but rows decided
     * BEFORE the cascade existed have no such slot, and the association should
     * not have to wait for a migration to see the right answer. Deriving it
     * here covers both: a stored slot is preferred (it carries who and when),
     * and this is what an older row falls back to.
     *
     * Only above, never below: a Block approval says nothing about the District.
     * And only from an APPROVAL — `tierVerdict` on the higher tier returns
     * `rejected` for a rejection, which this ignores, because a rejection ends
     * the application through `status` rather than speaking for anybody else.
     */
    for (const higher of carried ? TIER_ORDER.slice(TIER_ORDER.indexOf(tier) + 1) : []) {
        const above = (application.reviews || {})[higher];
        const decided = above && normalizeDecision(above.decision) === DECISION.APPROVED
            ? above
            : null;
        if (!decided) continue;
        return {
            decision: DECISION.APPROVED,
            adminId: decided.adminId || null,
            adminType: String(decided.adminType || TIER_ACTOR[higher] || ''),
            decidedAt: decided.decidedAt || null,
            reason: '',
            auto: true
        };
    }

    const status = normalizeStatus(application.status);

    /*
     * A LEGACY DECISION BELONGS TO THE TIER THAT ACTUALLY MADE IT — AND TO NO
     * OTHER, THE STATE'S SEAT INCLUDED.
     *
     * The previous build let any tier write the outcome, so the collection
     * holds rows stamped `Approved` by a District admin. The State never
     * decided those, and the State's seat must stay open on them: THE STATE IS
     * THE ONLY TIER WHOSE APPROVAL MAKES SOMEBODY A MEMBER, so a row nobody in
     * the State has signed is a row the State still owes a verdict on.
     *
     * This briefly read the other way — the seat was treated as taken the
     * moment ANY outcome existed — to stop a State admin being offered a Reject
     * button on somebody already carrying a member profile. That was the wrong
     * cure: it showed the State "Approved" for a decision a District had made.
     * The profile is protected on the WRITE path instead, where
     * `createMemberProfile` upserts (so a State approval over an existing
     * profile updates it rather than duplicating it) and a rejection that would
     * orphan one is refused with a sentence.
     */
    const decider = legacyDeciderTier(application);
    const seat = decider === 'super' ? DECIDING_TIER : decider;
    if (!seat || seat !== tier) return Object.assign({}, EMPTY_VERDICT);

    const source = status === 'Rejected' ? application.rejectedBy : application.approvedBy;

    return {
        decision: status === 'Rejected' ? DECISION.REJECTED : DECISION.APPROVED,
        adminId: source?.adminId || (application.reviewedBy || {})[`${tier}Admin`] || null,
        adminType: String(source?.adminType || TIER_ACTOR[seat] || TIER_ACTOR[tier] || ''),
        decidedAt: source?.rejectedAt || source?.approvedAt
            || application.stateApprovedAt || application.districtApprovedAt
            || application.blockApprovedAt || null,
        reason: status === 'Rejected' ? String(application.rejectionReason || '') : ''
    };
};

/** All three verdicts, keyed by tier — what a card needs to show the others'. */
const tierVerdicts = (application = {}) => ({
    block: tierVerdict(application, 'block'),
    district: tierVerdict(application, 'district'),
    state: tierVerdict(application, 'state')
});

/**
 * Has this tier already recorded a verdict?
 *
 * The ONLY thing that closes a tier's buttons. Not the outcome: a District
 * admin may still record their view of an applicant the State has already
 * approved, which is the whole point of separating the three.
 */
const hasTierDecided = (application = {}, tier = '') =>
    tierVerdict(application, tier).decision !== DECISION.PENDING;

/**
 * Has this tier decided FOR ITSELF — ignoring anything carried down to it?
 *
 * `decide()` needs this and `hasTierDecided` would give it the wrong answer.
 * The cascade loop writes the acting tier's slot first and then asks, of each
 * tier below, "has this one already spoken?". With the carried derivation in
 * play that question answers YES the moment the higher slot lands — the
 * derivation is already reporting the lower tier as approved — so the loop
 * skips every tier and NOTHING IS PERSISTED.
 *
 * The reads stayed correct, which is what made it quiet: the derivation
 * produced the right answer on the way out while `auto` was never stored and
 * the audit trail recorded nothing. Caught by running the same test against a
 * second server and diffing the documents rather than the responses.
 */
const hasOwnVerdict = (application = {}, tier = '') =>
    tierVerdict(application, tier, { carried: false }).decision !== DECISION.PENDING;

/**
 * May `tier` act on this application?
 *
 * Region membership is NOT asked here — the caller has already established it,
 * by the geofenced query that produced the row or by `assertWithinScope` before
 * the write. This answers only "is there a verdict of YOURS still outstanding".
 *
 * The Super Admin fills the deciding seat, so they are done once that seat is
 * signed — including when a state admin signed it.
 */
const canTierAct = (application = {}, tier = '') => {
    if (tier === 'super') return !hasTierDecided(application, DECIDING_TIER);
    if (!TIER_ORDER.includes(tier)) return false;
    return !hasTierDecided(application, tier);
};

/** The tiers with a verdict still outstanding. */
const reviewingTiers = (application = {}) =>
    TIER_ORDER.filter(tier => !hasTierDecided(application, tier));

/**
 * What the other tiers have recorded, for the note on a tier's own card.
 *
 * ==========================================================================
 * NAMED BY WHO SIGNED IT, NOT BY WHICH SLOT HOLDS IT.
 * ==========================================================================
 *
 * These are not always the same, and the difference was visible on live data
 * the first time this was run against it. An applicant approved under the
 * previous build by a DISTRICT admin fills the deciding seat — the State's —
 * because the outcome exists and no later verdict can unwrite it. Reading the
 * label off the slot printed "State approved" on the Block admin's card for a
 * decision the State never made.
 *
 * `adminType` on the verdict is who actually signed, so that is what names it.
 * Deduplicated by signer, or Tharun's card would have read "District approved ·
 * District approved" — once from the district's own slot and once from the
 * deciding seat that same decision closed.
 *
 * Widest-first, the same order the Hub's tier cards read in, so a reader is not
 * asked to hold two orderings.
 */
const otherTierVerdicts = (application = {}, tier = '') => {
    const all = tierVerdicts(application);
    const seen = new Set();
    const rows = [];

    for (const slot of ['state', 'district', 'block']) {
        const verdict = all[slot];
        if (verdict.decision === DECISION.PENDING) continue;

        // Who signed it. Falls back to the slot when nothing named an admin —
        // an old row with no attribution at all, where the seat is the only
        // honest answer available.
        const signer = ACTOR_TIER[verdict.adminType] || slot;
        // A Super Admin signed as themselves; say so rather than crediting a
        // tier admin who was not involved.
        const label = TIER_LABELS[signer] === 'Super' ? 'ACTIV Head Office' : TIER_LABELS[signer];

        if (signer === tier || seen.has(signer)) continue;
        seen.add(signer);

        rows.push({
            tier: signer,
            slot,
            label,
            decision: verdict.decision,
            decidedAt: verdict.decidedAt
        });
    }

    return rows;
};

/**
 * One line for a tier's card naming what everybody else has said.
 *
 * Empty when nobody else has, so the card prints nothing rather than a row of
 * "no decision" placeholders — the Approve and Reject buttons underneath
 * already say that no decision has been made.
 */
const endorsementLine = (application = {}, tier = '') => {
    const others = otherTierVerdicts(application, tier);
    if (!others.length) return '';

    return others
        .map(o => `${o.label} ${o.decision === DECISION.APPROVED ? 'approved' : 'rejected'}`)
        .join(' · ');
};

/**
 * ==========================================================================
 * WRITE EVERY LEGACY VERDICT INTO ITS OWN SLOT, BEFORE ANYTHING OVERWRITES IT.
 * ==========================================================================
 *
 * Called by `decide()` on the document it is about to save. Every slot that is
 * still empty but has legacy evidence behind it is filled in from that
 * evidence; slots with a verdict already are left alone.
 *
 * THIS IS NOT TIDINESS. `approvedBy` holds ONE decision, and under the previous
 * build it was whichever tier acted. When the State later approves such a row,
 * `commitFinalApproval` overwrites `approvedBy` with the State's own — and the
 * only record that a District admin had approved is gone.
 *
 * That is not hypothetical. It happened to a live applicant the first time a
 * State approval was run over a District-approved row: the District's decision
 * of 15:56 was erased at 16:30, and only `reviewedBy.districtAdmin` and
 * `districtApprovedAt` survived to reconstruct it from.
 *
 * Doing it here, on the way into a write, means no separate migration and no
 * document is touched that nothing was writing to anyway.
 */
const materialiseLegacyVerdicts = (application) => {
    if (!application) return application;
    if (!application.reviews) application.reviews = {};

    let changed = false;
    for (const tier of TIER_ORDER) {
        const stored = application.reviews[tier];
        if (stored && normalizeDecision(stored.decision) !== DECISION.PENDING) continue;

        const verdict = tierVerdict(application, tier);
        if (verdict.decision === DECISION.PENDING) continue;

        application.reviews[tier] = {
            decision: verdict.decision,
            adminId: verdict.adminId
                || (application.reviews[tier] || {}).adminId
                || (application.reviewedBy || {})[`${tier}Admin`]
                || null,
            adminType: verdict.adminType || TIER_ACTOR[tier],
            decidedAt: verdict.decidedAt || null,
            reason: verdict.reason || ''
        };
        changed = true;
    }

    if (changed && typeof application.markModified === 'function') {
        application.markModified('reviews');
    }
    return application;
};

module.exports = {
    TIERS_BELOW,
    tiersBelow,
    materialiseLegacyVerdicts,
    legacyTierStamp,
    TIER_ORDER,
    TIER_LABELS,
    TIER_ACTOR,
    ACTOR_TIER,
    DECISION,
    DECIDING_TIER,
    decidesOutcome,
    legacyDeciderTier,
    tierVerdict,
    tierVerdicts,
    hasTierDecided,
    hasOwnVerdict,
    canTierAct,
    reviewingTiers,
    otherTierVerdicts,
    endorsementLine
};
