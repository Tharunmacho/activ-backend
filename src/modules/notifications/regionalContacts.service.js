const config = require('../../config');
const logger = require('../../config/logger');
const adminRepository = require('../admin/admin.repository');
const { regionPattern } = require('../common/regionMatch');

/**
 * Who a member's message should reach, for the region they registered in.
 *
 * This is the lookup behind two features that would otherwise be decoration:
 * the `Reply-To` on every lifecycle email, and the answer the WhatsApp bot
 * gives to "HELP". Both need the same thing — the real, live administrator
 * responsible for this applicant's block, district and state — so both read it
 * from here rather than each deriving an address from a region name.
 *
 * WHY NOT JUST BUILD `block.<name>@activ.org.in` FROM THE REGION STRING. Because
 * that address is a guess about a mailbox, and the whole point of the header is
 * that a reply reaches a person. An applicant in a block whose admin signs in as
 * `r.kumar@activ.org.in` gets a reply routed to a mailbox that may never have
 * been created. The admin collections already hold the address that account
 * authenticates with, which is by definition an inbox somebody reads. The
 * derived pattern stays as the fallback for a region with nobody in it, because
 * a plausible address on a support desk beats no `Reply-To` at all.
 *
 * ESCALATION IS THE POINT, NOT AN EDGE CASE. There is deliberately no
 * requirement in this platform that a parent admin exists (see the admin-first
 * region architecture in CLAUDE.md): a block can be staffed with no district
 * admin above it, and a state can be staffed with nothing beneath it. So
 * "nearest contact" walks OUTWARD — block, then district, then state, then the
 * support desk — exactly as `tierRouting.effectiveTier` walks an application
 * outward to the first tier that can actually review it. A member is never told
 * to contact nobody.
 *
 * REGION MATCHING IS `regionPattern`, NOT `toLowerCase()`. Region names are free
 * text a Super Admin typed. "Tamil Nadu" and "tamil  nadu" are one place to a
 * person and two strings to a comparison; the shared anchored, whitespace-
 * tolerant, metacharacter-escaped pattern is what the geofence itself uses, and
 * using anything else here would route a reply to a different region's admin
 * than the one whose queue the application is actually sitting in.
 */

/** Outward, never inward — see the note above. */
const TIER_ORDER = ['block', 'district', 'state'];

const ROLE_FOR_TIER = {
    block: 'block_admin',
    district: 'district_admin',
    state: 'state_admin'
};

const TIER_LABEL = {
    block: 'Block',
    district: 'District',
    state: 'State'
};

/**
 * A region name as an email local-part: `Thiruvallur` -> `thiruvallur`.
 *
 * Only used for the derived fallback address. Returns '' for a name that has no
 * alphanumerics left after stripping, so a region called `—` cannot produce
 * `block.@activ.org.in`, which is not a deliverable address and which some
 * SMTP servers reject outright rather than bouncing.
 */
const slug = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** The derived `block.ambattur@activ.org.in` form. '' when unusable. */
const derivedAddress = (tier, regionName) => {
    const local = slug(regionName);
    if (!local) return '';
    return `${tier}.${local}@${config.email.regionDomain}`;
};

/**
 * Does this admin row govern this region?
 *
 * An admin governs a region when every level they NAME matches. A state admin
 * names only a state, and governs every district and block inside it; a block
 * admin names all three. The levels an admin leaves blank are levels they do not
 * narrow to — the same rule `buildGeoFilter` applies on the dashboard side, so
 * the admin this returns is the same admin whose queue the file is in.
 */
const governs = (admin = {}, region = {}) => {
    for (const field of TIER_ORDER) {
        const claimed = String(admin[field] || '').trim();
        if (!claimed) continue;

        const pattern = regionPattern(region[field]);
        // The admin narrows to a region the applicant has not given. That is a
        // non-match, not a wildcard: an applicant with no district recorded is
        // not inside any one district's patch.
        if (!pattern) return false;
        if (!pattern.test(claimed)) return false;
    }
    return true;
};

/**
 * Every active, real admin who governs this region, keyed by tier.
 *
 * `findActive` reads the roster cache the admin dashboards already keep warm, so
 * this costs nothing on the request path in the normal case. It is also the
 * filtered roster — the ~7,700-row legacy scaffold is excluded unless a
 * deployment opts in — which matters here as much as it does for coverage: a
 * placeholder account sharing one bcrypt hash across the country is not somebody
 * who reads mail, and routing an applicant's reply to it would be worse than the
 * derived address.
 *
 * Never throws. A notification is a side effect of an approval or a payment, and
 * an unreachable admin database must degrade to "no named contact" rather than
 * turn a completed action into a 500.
 */
const adminsForRegion = async(region = {}) => {
    const found = { block: [], district: [], state: [] };

    let roster = [];
    try {
        roster = await adminRepository.findActive();
    } catch (error) {
        logger.warn('Regional contact lookup could not read the admin roster', {
            error: error && error.message
        });
        return found;
    }

    for (const admin of roster || []) {
        const tier = TIER_ORDER.find((t) => ROLE_FOR_TIER[t] === admin.role);
        if (!tier) continue;              // super admins are not a regional contact
        if (!admin.email) continue;       // an address is the whole product here
        if (!governs(admin, region)) continue;

        found[tier].push(admin);
    }

    return found;
};

/**
 * One contact per tier, plus the nearest one — the shape both callers want.
 *
 * `nearest` is what the `Reply-To` header and the WhatsApp "HELP" reply use. The
 * per-tier entries are what the Super Admin oversight screen shows and what an
 * email footer can list, so a member can see the whole chain above them rather
 * than only the rung they were routed to.
 *
 * A tier with several admins resolves to the FIRST one. They share one queue by
 * construction — nothing in this platform is assigned to an admin id, everything
 * is geofenced by region string — so any of them is a correct answer, and
 * `coAdmins` records that there are others rather than pretending there is one.
 *
 * @returns {Promise<{
 *   region: object,
 *   contacts: object,
 *   nearest: object|null,
 *   replyTo: string,
 *   fromName: string
 * }>}
 */
const resolveForRegion = async(region = {}) => {
    const clean = {
        state: String(region.state || '').trim(),
        district: String(region.district || '').trim(),
        block: String(region.block || '').trim()
    };

    const byTier = await adminsForRegion(clean);
    const contacts = {};

    for (const tier of TIER_ORDER) {
        const list = byTier[tier] || [];
        const regionName = clean[tier];
        const first = list[0] || null;

        // A tier the applicant has not named is not a rung on their chain.
        if (!regionName && !first) continue;

        contacts[tier] = {
            tier,
            tierLabel: TIER_LABEL[tier],
            regionName,
            /** The account's own address when staffed; the derived one otherwise. */
            email: (first && first.email) || derivedAddress(tier, regionName),
            /** True only when a real account backs that address. */
            staffed: !!first,
            name: (first && first.fullName) || '',
            phone: (first && first.phoneNumber) || '',
            coAdmins: Math.max(0, list.length - 1)
        };
    }

    /*
     * Outward to the first STAFFED tier.
     *
     * `staffed`, not merely present: falling back to a derived address at the
     * block when a real district admin exists one rung out would route the reply
     * to a mailbox nobody has created, past a person who would have read it.
     */
    const nearest = TIER_ORDER
        .map((tier) => contacts[tier])
        .find((entry) => entry && entry.staffed)
        // Nothing staffed anywhere: the most specific derived address the
        // applicant's own region supports, so the reply at least carries the
        // region it came from.
        || TIER_ORDER.map((tier) => contacts[tier]).find((entry) => entry && entry.email)
        || null;

    /**
     * The display name that goes in front of the From address.
     *
     * This is where the region is stated when `EMAIL_USE_REGIONAL_FROM` is off,
     * which is the default and the case that works without any alias
     * verification. "ACTIV Coimbatore District Office" beside a verified
     * `events@activ.org.in` tells the applicant who is writing without asking
     * the mail provider to accept an address it has never heard of.
     */
    const fromName = nearest && nearest.regionName
        ? `ACTIV ${nearest.regionName} ${nearest.tierLabel} Office`
        : config.email.fromName;

    return {
        region: clean,
        contacts,
        nearest,
        replyTo: (nearest && nearest.email) || config.email.supportAddress,
        fromName
    };
};

/**
 * The same answer, from an application document.
 *
 * An application carries its region at the top level AND, on older rows, inside
 * `data.personalDetails` / `data.personal` — the same three paths `buildGeoFilter`
 * has to search. Reading only the top level returns an empty region for legacy
 * applications, and an empty region resolves to the support desk: correct-looking
 * behaviour that quietly stops routing anyone to their own admin.
 */
const resolveForApplication = async(application = {}) => {
    const data = application.data || {};
    const personal = data.personalDetails || data.personal || {};

    return resolveForRegion({
        state: application.state || personal.state || '',
        district: application.district || personal.district || '',
        block: application.block || personal.block || ''
    });
};

/**
 * How the chain reads in a WhatsApp reply or an email footer.
 *
 * The admin's NAME is dropped when it already says the same thing as the office
 * line. Real accounts in this database are named things like "Ariyalur Block
 * Admin", which rendered as "Ariyalur Block Admin — Ariyalur Block Admin": on
 * those rows the name field is doing the job of a label, and printing both makes
 * the reply look broken rather than informative. A person's actual name still
 * appears, because it does not collide.
 */
const formatContact = (entry) => {
    if (!entry) return '';

    const office = `${entry.regionName ? `${entry.regionName} ${entry.tierLabel}` : entry.tierLabel} Admin`;

    const normalise = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const who = entry.name && normalise(entry.name) !== normalise(office) ? `${entry.name} — ` : '';

    const phone = entry.phone ? `\nPhone: ${entry.phone}` : '';

    return `${who}${office}\nEmail: ${entry.email}${phone}`;
};

module.exports = {
    TIER_ORDER,
    TIER_LABEL,
    slug,
    derivedAddress,
    governs,
    adminsForRegion,
    resolveForRegion,
    resolveForApplication,
    formatContact
};
