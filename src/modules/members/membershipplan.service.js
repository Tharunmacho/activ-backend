const MembershipPlan = require('./membershipplan.model');
const { PLANS: FROZEN } = require('../payment/membershipPlans');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');
const mongoose = require('mongoose');

/**
 * Membership pricing, owned by the Super Admin.
 *
 * WHAT CHANGED AND WHY IT MATTERS. The price of a membership used to live in a
 * frozen object literal (`payment/membershipPlans.js`) — three business tiers
 * and one aspirant tier, at fixed amounts. Nothing in the product could change
 * them: raising the aspirant fee meant a code change and a deploy. The
 * association sets its own fees, so the fees belong in the database and on a
 * screen.
 *
 * Two decisions come out of that, and they are separate:
 *
 *   1. WHAT IT COSTS — the amount on each plan, edited in Super Admin.
 *   2. WHICH PLAN AN APPLICANT IS OFFERED — resolved from how long their
 *      company has traded, against the bands on those same plans.
 *
 * The second is the part that used to be missing. An applicant was shown all
 * three business tiers and left to pick, which is not a choice the association
 * intends them to have: a company trading two years is a Starter member, and
 * offering them the ₹20,000 tier invites a payment that has to be refunded.
 * `resolveForMember` returns the ONE plan their commencement year earns them —
 * unless the Super Admin has switched `showAllPlans` on, which restores the
 * old behaviour for anyone who wants it.
 *
 * UNITS. The collection stores `amountPaise`, and everything above this file
 * speaks rupees. Paise because money in a floating-point field is money that
 * eventually rounds wrong, and rupees at the edges because that is what an
 * editor types and what the gateway is handed. The conversion happens here and
 * nowhere else.
 */

/** The settings that are about the plan LIST rather than about one plan. */
const settingsSchema = new mongoose.Schema({
    /**
     * Singleton. A fixed `_id` rather than "the first document found", because
     * two concurrent first-writes would otherwise create two settings rows and
     * whichever one a later read happened to sort first would win.
     */
    _id: { type: String, default: 'membership' },

    /**
     * Offer every plan instead of the one the applicant's band earns them.
     *
     * OFF by default, because that is the behaviour the association asked for:
     * the band decides, and the applicant sees their own price. It exists
     * because the opposite is a legitimate choice — an association that wants
     * members to pick a tier freely turns this on and the screen goes back to
     * showing all of them, with no code change and no different screen.
     */
    showAllPlans: { type: Boolean, default: false }
}, { collection: 'membershipSettings', timestamps: true });

const MembershipSettings = mongoose.models.MembershipSettings
    || mongoose.model('MembershipSettings', settingsSchema);

const SETTINGS_ID = 'membership';

const rupees = (paise) => Math.round(Number(paise || 0) / 100);
const paise = (value) => Math.round(Number(value || 0) * 100);

const str = (value) => String(value === null || value === undefined ? '' : value).trim();

/**
 * The bands the frozen table implied, made explicit.
 *
 * Used only to seed an empty collection, so the platform starts with exactly
 * the plans and prices it had before this file existed. After the first seed
 * the database is the authority and this is never consulted again.
 */
const SEED_BANDS = {
    basic: { minYears: 0, maxYears: 5, order: 1 },
    intermediate: { minYears: 5, maxYears: 10, order: 2, popular: true },
    ideal: { minYears: 10, maxYears: null, order: 3 },
    aspirant: { minYears: 0, maxYears: null, order: 4 }
};

const SEED_FEATURES = {
    basic: [
        'Compliance and documentation guidance',
        'Access to networking forums',
        'Standard email support'
    ],
    intermediate: [
        'Everything in Starter',
        'Priority listing in the member directory',
        'Invitations to regional business meets'
    ],
    ideal: [
        'Everything in Professional',
        'Speaking slots at association events',
        'Direct introductions to partner organisations'
    ],
    aspirant: [
        'Association updates and event invitations',
        'Access to the member directory',
        'Guidance on starting a business'
    ]
};

/**
 * Fill an empty collection from the frozen table, once.
 *
 * WITHOUT THIS the first deploy would show an applicant no plans at all — the
 * price authority would have moved to a collection nobody had written yet, and
 * the membership screen would be empty with nothing to explain it.
 *
 * Only ever INSERTS, and only keys that are absent. It cannot overwrite a price
 * the Super Admin has set: once a key exists here, the frozen table is dead to
 * it. That is what makes this safe to run on every read.
 */
const ensureSeeded = async() => {
    const existing = await MembershipPlan.find({}, { key: 1 }).lean().catch(() => []);
    const known = new Set((existing || []).map((row) => str(row.key).toLowerCase()).filter(Boolean));

    const missing = Object.values(FROZEN).filter((plan) => !known.has(plan.id));
    if (!missing.length) return;

    const docs = missing.map((plan) => {
        const band = SEED_BANDS[plan.id] || { minYears: 0, maxYears: null, order: 99 };

        return {
            key: plan.id,
            name: plan.name,
            audience: plan.forBusiness ? 'business' : 'aspirant',
            memberType: plan.membershipType || 'annual',
            minYears: band.minYears,
            maxYears: band.maxYears,
            popular: !!band.popular,
            tagline: '',
            amountPaise: paise(plan.amount),
            entitlements: SEED_FEATURES[plan.id] || [],
            displayOrder: band.order,
            isActive: true
        };
    });

    // `insertMany` unordered: two workers booting at once both compute the same
    // missing set, and the loser should skip the duplicates rather than fail the
    // request that triggered the seed.
    await MembershipPlan.insertMany(docs, { ordered: false })
        .then(() => logger.info(`Seeded ${docs.length} membership plan(s) from the built-in table`))
        .catch((err) => {
            if (err && err.code === 11000) return;   // raced; the rows exist
            logger.warn('Membership plan seed failed: ' + err.message);
        });
};

/** The API shape of one plan. Rupees, and the band as a readable label. */
const toPlan = (doc = {}) => ({
    id: String(doc._id || ''),
    key: str(doc.key),
    name: doc.name || '',
    description: doc.tagline || '',
    price: rupees(doc.amountPaise),
    audience: doc.audience === 'aspirant' ? 'aspirant' : 'business',
    minYears: Number(doc.minYears || 0),
    maxYears: doc.maxYears === null || doc.maxYears === undefined ? null : Number(doc.maxYears),
    experience: bandLabel(doc),
    features: Array.isArray(doc.entitlements) ? doc.entitlements.filter(Boolean) : [],
    popular: doc.popular === true,
    active: doc.isActive !== false,
    order: Number(doc.displayOrder || 0)
});

/**
 * "0 – 5 years", "10+ years", "Student / Aspirant".
 *
 * Derived from the numbers rather than stored beside them, so a Super Admin who
 * moves a band cannot leave a label behind saying the old one. That is the
 * failure this platform keeps producing in other places, and it is silent every
 * time.
 */
function bandLabel(doc = {}) {
    if (doc.audience === 'aspirant') return 'Student / Aspirant';

    const min = Number(doc.minYears || 0);
    const max = doc.maxYears === null || doc.maxYears === undefined ? null : Number(doc.maxYears);

    if (max === null) return `${min}+ years`;
    if (min === 0) return `Under ${max} years`;
    return `${min} – ${max} years`;
}

/** How many years a company has traded, or `null` when it did not say. */
const yearsTrading = (commencementYear) => {
    const start = parseInt(str(commencementYear), 10);
    if (!Number.isFinite(start) || start <= 0) return null;

    const years = new Date().getFullYear() - start;
    // A year in the future is a typo, not a company that has traded -3 years.
    return years < 0 ? 0 : years;
};

const inBand = (plan, years) => {
    if (years === null) return false;
    if (years < plan.minYears) return false;
    // Half-open: `max` is exclusive, so bands cannot overlap. See the model.
    return plan.maxYears === null || years < plan.maxYears;
};

class MembershipPlanService {
    async getSettings() {
        const doc = await MembershipSettings.findById(SETTINGS_ID).lean().catch(() => null);
        return { showAllPlans: doc ? doc.showAllPlans === true : false };
    }

    async updateSettings(payload = {}) {
        const update = {};
        if (payload.showAllPlans !== undefined) {
            update.showAllPlans = payload.showAllPlans === true || payload.showAllPlans === 'true';
        }

        const doc = await MembershipSettings.findByIdAndUpdate(
            SETTINGS_ID,
            { $set: update },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();

        return { showAllPlans: doc.showAllPlans === true };
    }

    /** Every plan, active and retired, for the Super Admin's editor. */
    async listAll() {
        await ensureSeeded();
        const rows = await MembershipPlan.find({})
            .sort({ displayOrder: 1, amountPaise: 1 })
            .lean()
            .catch(() => []);

        return (rows || []).map(toPlan);
    }

    /** Active plans only — the public `/membership/plans` listing. */
    async listActive() {
        const all = await this.listAll();
        return all.filter((plan) => plan.active);
    }

    /**
     * The plans THIS applicant should be shown, and why.
     *
     * `isAspirant` wins outright: someone who declared no business has no
     * commencement year, so no band can apply and the aspirant plan is the whole
     * answer.
     *
     * For a business, the band decides. An applicant whose commencement year is
     * missing or unreadable falls back to every business plan rather than to a
     * guess — charging someone the top tier because a form field was blank is
     * the one outcome worth avoiding, and showing them the choice is honest
     * about the fact that the platform does not know.
     */
    async resolveForMember({ commencementYear, isAspirant = false } = {}) {
        const [plans, settings] = await Promise.all([this.listActive(), this.getSettings()]);

        const years = yearsTrading(commencementYear);
        const audience = isAspirant ? 'aspirant' : 'business';
        const forAudience = plans.filter((plan) => plan.audience === audience);

        if (settings.showAllPlans) {
            return {
                plans: forAudience,
                matched: null,
                years,
                reason: 'all',
                showAllPlans: true
            };
        }

        if (audience === 'aspirant') {
            return {
                plans: forAudience,
                matched: forAudience[0] || null,
                years: null,
                reason: 'aspirant',
                showAllPlans: false
            };
        }

        const matched = forAudience.find((plan) => inBand(plan, years)) || null;

        if (!matched) {
            return {
                plans: forAudience,
                matched: null,
                years,
                // Named so the screen can say WHY it is showing a choice rather
                // than one price: the year is missing, or no band covers it.
                reason: years === null ? 'no-year' : 'no-band',
                showAllPlans: false
            };
        }

        return { plans: [matched], matched, years, reason: 'band', showAllPlans: false };
    }

    /**
     * One plan by key, in the shape the payment path expects.
     *
     * THIS IS THE PRICE AUTHORITY. `paymentOrder.createOrder` calls it and
     * charges `amount`, so a Super Admin edit changes what is taken from the
     * card — not just what the screen advertises. A version of this that
     * returned the display price while payment kept its own copy would be worse
     * than no editor at all.
     *
     * Falls back to the frozen table when the collection has no such key, so an
     * unseeded database or a key retired by mistake cannot take the checkout
     * down.
     */
    async getPlanForPayment(planId) {
        const key = str(planId).toLowerCase();
        if (!key) return null;

        const doc = await MembershipPlan.findOne({ key }).lean().catch(() => null);

        if (!doc) {
            const frozen = FROZEN[key];
            if (frozen) {
                logger.warn(`Membership plan '${key}' is not in the database; using the built-in price`);
                return { ...frozen };
            }
            return null;
        }

        if (doc.isActive === false) return null;

        return {
            id: str(doc.key),
            name: doc.name || '',
            amount: rupees(doc.amountPaise),
            membershipType: doc.memberType || 'annual',
            forBusiness: doc.audience !== 'aspirant'
        };
    }

    /** Create or update one plan from the Super Admin's form. */
    async savePlan(key, payload = {}, { create = false } = {}) {
        const id = str(key || payload.key).toLowerCase();
        if (!id) throw ApiError.badRequest('A plan needs a key');
        if (!/^[a-z0-9-]+$/.test(id)) {
            throw ApiError.badRequest('A plan key may hold only lowercase letters, numbers and hyphens');
        }

        const update = {};

        if (payload.name !== undefined) {
            const name = str(payload.name);
            if (!name) throw ApiError.badRequest('A plan needs a name');
            update.name = name;
        }

        if (payload.description !== undefined) update.tagline = str(payload.description);

        if (payload.price !== undefined) {
            const price = Number(payload.price);
            if (!Number.isFinite(price) || price < 0) {
                throw ApiError.badRequest('A price must be zero or more');
            }
            update.amountPaise = paise(price);
        }

        if (payload.audience !== undefined) {
            update.audience = str(payload.audience) === 'aspirant' ? 'aspirant' : 'business';
        }

        if (payload.minYears !== undefined) {
            const min = Number(payload.minYears);
            update.minYears = Number.isFinite(min) && min > 0 ? Math.round(min) : 0;
        }

        if (payload.maxYears !== undefined) {
            // Empty means open-ended, and has to survive the trip as `null`
            // rather than becoming 0 — which would be a band matching nothing.
            const raw = payload.maxYears;
            const blank = raw === null || raw === '' || raw === undefined;
            const max = Number(raw);
            update.maxYears = blank || !Number.isFinite(max) ? null : Math.round(max);
        }

        if (payload.features !== undefined) {
            const list = Array.isArray(payload.features)
                ? payload.features
                : String(payload.features || '').split('\n');
            update.entitlements = list.map((line) => str(line)).filter(Boolean).slice(0, 12);
        }

        if (payload.popular !== undefined) {
            update.popular = payload.popular === true || payload.popular === 'true';
        }

        if (payload.active !== undefined) {
            update.isActive = payload.active === true || payload.active === 'true';
        }

        if (payload.order !== undefined) {
            const order = Number(payload.order);
            update.displayOrder = Number.isFinite(order) ? Math.round(order) : 0;
        }

        // A band whose top is at or below its bottom matches nothing, and an
        // applicant in it would silently see no plan at all.
        const min = update.minYears !== undefined ? update.minYears : null;
        const max = update.maxYears !== undefined ? update.maxYears : null;
        if (min !== null && max !== null && max <= min) {
            throw ApiError.badRequest('The band must end after it starts, or be left open-ended');
        }

        if (create) {
            const clash = await MembershipPlan.findOne({ key: id }).lean().catch(() => null);
            if (clash) throw ApiError.badRequest(`A plan with the key '${id}' already exists`);
            if (!update.name) throw ApiError.badRequest('A plan needs a name');
            if (update.amountPaise === undefined) update.amountPaise = 0;
        }

        /*
         * TWO BANDS MAY NOT COVER THE SAME YEAR.
         *
         * `resolveForMember` takes the FIRST band that matches, so an overlap is
         * not an error anywhere — it silently prices a company at whichever plan
         * happens to sort earlier, and the other plan quietly stops applying to
         * anybody. That is money, decided by sort order, with nothing reporting
         * it. A live database reached exactly this state: "Starter" at 1–4 and a
         * second plan at 2–5, both claiming years 2 to 4.
         *
         * Checked against the plans as they will be AFTER this write, and only
         * among active business plans: a retired plan prices nobody, and the
         * aspirant plan has no band to collide with.
         */
        const proposed = await MembershipPlan.findOne({ key: id }).lean().catch(() => null);
        const merged = { ...(proposed || {}), ...update, key: id };

        if ((merged.audience || 'business') !== 'aspirant' && merged.isActive !== false) {
            const others = await MembershipPlan.find({
                key: { $ne: id },
                audience: { $ne: 'aspirant' },
                isActive: { $ne: false }
            }).lean().catch(() => []);

            const min = Number(merged.minYears || 0);
            const max = merged.maxYears === null || merged.maxYears === undefined
                ? Infinity
                : Number(merged.maxYears);

            const clashing = (others || []).find((other) => {
                const otherMin = Number(other.minYears || 0);
                const otherMax = other.maxYears === null || other.maxYears === undefined
                    ? Infinity
                    : Number(other.maxYears);

                // Half-open intervals overlap when each starts before the other
                // ends. Touching ends — 0–5 and 5–10 — are not an overlap, which
                // is the whole reason the bands are half-open.
                return min < otherMax && otherMin < max;
            });

            if (clashing) {
                const band = (a, b) => (b === Infinity || b === null || b === undefined
                    ? `${a}+ years`
                    : `${a}–${b} years`);

                throw ApiError.badRequest(
                    `That band overlaps "${clashing.name}" (${band(clashing.minYears || 0, clashing.maxYears)}). `
                    + `Two plans cannot cover the same year — an applicant would be priced by whichever `
                    + `one sorted first. Adjust this band to ${band(min, max)} without crossing it, or move `
                    + `the other plan.`
                );
            }
        }

        const doc = await MembershipPlan.findOneAndUpdate(
            { key: id },
            { $set: { ...update, key: id } },
            { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
        ).lean();

        return toPlan(doc);
    }

    /**
     * Snap the business bands into one continuous run: no gaps, no overlaps.
     *
     * WHAT IT IS FOR. Bands are edited one plan at a time, and the rule they
     * have to satisfy is about all of them together. A live database reached a
     * state with two plans claiming years 2–4 and nothing at all claiming year
     * 0 — an applicant who started their company this year matched no plan and
     * was shown every plan instead, which reads as the whole feature not
     * working. Repairing that by hand means editing three plans in the right
     * order without ever passing through an overlap the validator rejects.
     *
     * THE RULE IT APPLIES. Order the active business plans by where they start,
     * then:
     *
     *   - the first starts at 0, so a brand-new company always matches;
     *   - each one ends exactly where the next begins, so there is no gap and,
     *     the intervals being half-open, no overlap either;
     *   - the last is open-ended, so an old company always matches.
     *
     * WHAT IT PRESERVES. Every plan keeps its name, its price and its position
     * in the order. Only the boundaries move, and only to the nearest value
     * that makes the set valid — the editor's intent about which plan is
     * cheapest and which is for the oldest companies is exactly what the
     * ordering encodes, so following it is following them.
     *
     * Two plans starting at the same year cannot both be kept: the second would
     * be squeezed to nothing. It is reported rather than silently retired,
     * because deciding which of two plans an association no longer wants is not
     * a decision to make on its behalf.
     */
    async alignBands() {
        const rows = await MembershipPlan.find({
            audience: { $ne: 'aspirant' },
            isActive: { $ne: false }
        }).lean().catch(() => []);

        const plans = (rows || []).slice().sort((a, b) => {
            const byStart = Number(a.minYears || 0) - Number(b.minYears || 0);
            if (byStart) return byStart;
            // Same start: the cheaper plan is the earlier band, which is the
            // convention every seeded set already follows.
            return Number(a.amountPaise || 0) - Number(b.amountPaise || 0);
        });

        if (!plans.length) throw ApiError.badRequest('There are no active company plans to align');

        const collisions = plans.filter((plan, i) => (
            i > 0 && Number(plan.minYears || 0) === Number(plans[i - 1].minYears || 0)
        ));

        if (collisions.length) {
            throw ApiError.badRequest(
                `${collisions.map((p) => `"${p.name}"`).join(' and ')} start at the same year as the plan `
                + 'before, so aligning them would leave one covering nothing. Give them different starting '
                + 'years, or retire one.'
            );
        }

        const writes = [];

        plans.forEach((plan, i) => {
            const next = plans[i + 1];
            const minYears = i === 0 ? 0 : Number(plan.minYears || 0);
            const maxYears = next ? Number(next.minYears || 0) : null;

            const unchanged = Number(plan.minYears || 0) === minYears
                && (plan.maxYears === null || plan.maxYears === undefined
                    ? maxYears === null
                    : Number(plan.maxYears) === maxYears);

            if (unchanged) return;

            writes.push({
                updateOne: {
                    filter: { _id: plan._id },
                    update: { $set: { minYears, maxYears } }
                }
            });
        });

        if (writes.length) await MembershipPlan.bulkWrite(writes);

        return { changed: writes.length, plans: await this.listAll() };
    }

    /**
     * DELETE A PLAN — really delete it, when nothing points at it.
     *
     * The first version of this only ever retired, on the reasoning that a paid
     * membership references its plan and deleting the row leaves the receipt
     * pointing at nothing. That reasoning is sound and it is also not an excuse
     * for having no delete: a plan created by mistake, or one nobody ever bought,
     * is clutter, and an editor who cannot remove it stops trusting the screen.
     *
     * So the question is asked rather than assumed. If no order references the
     * key, the row goes. If any does, the row stays and the caller is told how
     * many and offered `retire` instead — which is the honest answer, because
     * the alternative is a member's receipt describing a plan that no longer
     * exists at any price.
     *
     * The count comes from `paymentorders`, which is where a purchase records
     * the plan it bought. A cancelled or abandoned order counts: it is still a
     * record naming this plan, and a report run over last year's orders would
     * break on it just the same.
     */
    async deletePlan(key, { force = false } = {}) {
        const id = str(key).toLowerCase();
        const doc = await MembershipPlan.findOne({ key: id }).lean().catch(() => null);
        if (!doc) throw ApiError.notFound('Plan not found');

        const PaymentOrder = require('../payment/paymentorder.model');
        const orders = await PaymentOrder.countDocuments({ planId: id }).catch(() => 0);

        if (orders > 0 && !force) {
            throw ApiError.badRequest(
                `"${doc.name}" cannot be deleted: ${orders} ${orders === 1 ? 'payment references' : 'payments reference'} `
                + 'it, and deleting it would leave those receipts describing a plan that does not exist. '
                + 'Retire it instead — it stops being offered to new applicants and the records stay intact.'
            );
        }

        await MembershipPlan.deleteOne({ _id: doc._id });
        return { deleted: true, key: id, name: doc.name, orders };
    }

    /**
     * Retire a plan rather than delete it.
     *
     * A member who bought it keeps a reference, and a paid membership whose plan
     * has vanished is a receipt for nothing. `active: false` takes it off every
     * listing while leaving the record intact.
     */
    async retirePlan(key) {
        const id = str(key).toLowerCase();
        const doc = await MembershipPlan.findOneAndUpdate(
            { key: id },
            { $set: { isActive: false } },
            { new: true }
        ).lean();

        if (!doc) throw ApiError.notFound('Plan not found');
        return toPlan(doc);
    }
}

module.exports = new MembershipPlanService();
module.exports.bandLabel = bandLabel;
module.exports.yearsTrading = yearsTrading;
module.exports.inBand = inBand;
