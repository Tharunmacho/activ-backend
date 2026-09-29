const tierReviews = require('../common/tierReviews');
const logger = require('../../config/logger');

/**
 * What a membership message needs to know, read from the LIVE records at the
 * moment it is sent — the same principle as `eventbooking.service.messageContext`.
 *
 * Every function here resolves, never rejects: a message is a side effect of a
 * registration, a review or a payment, and a lookup that fails must leave out
 * one line of the message rather than the message.
 */

/** "27 September 2026", in India time. '' for no date. */
const dateLabel = (value) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

const rupees = (value) => {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? `₹${n.toLocaleString('en-IN')}` : '';
};

const clean = (value) => String(value === null || value === undefined ? '' : value).trim();

/** The six-character reference every message and screen quotes. */
const referenceOf = (application = {}) => clean(application._id).slice(-6).toUpperCase();

/** The region fields, from the top level or the legacy copies inside `data`. */
const regionOf = (application = {}) => {
    const data = application.data || {};
    const personal = data.personalDetails || data.personal || {};
    return {
        state: clean(application.state || personal.state),
        district: clean(application.district || personal.district),
        block: clean(application.block || personal.block)
    };
};

const TIER_WORD = { block: 'Block', district: 'District', state: 'State', super: 'Head Office' };

/**
 * Each tier's verdict, as the APPLICANT should read it.
 *
 *   approved   — this tier approved, or a higher tier's approval carried it; the
 *                carried case says who ("Approved by the State Admin"), the way
 *                `buildAttribution` does on the dashboards
 *   reviewed   — this tier recorded an objection. Shown neutrally: only the
 *                State's verdict decides, and it can approve over one
 *   pending    — not decided yet
 */
const reviewsFor = (application = {}) => {
    const out = {};
    for (const tier of tierReviews.TIER_ORDER) {
        const v = tierReviews.tierVerdict(application, tier);
        if (v.decision === 'approved') {
            const actorTier = tierReviews.ACTOR_TIER ? tierReviews.ACTOR_TIER[v.adminType] : '';
            const by = v.auto && actorTier && actorTier !== tier
                ? `Approved by the ${TIER_WORD[actorTier] || 'State'} Admin`
                : 'Approved';
            out[tier] = { state: 'approved', byLine: `${by}${v.decidedAt ? ` · ${dateLabel(v.decidedAt)}` : ''}` };
        } else if (v.decision === 'rejected') {
            out[tier] = { state: 'reviewed' };
        } else {
            out[tier] = { state: 'pending' };
        }
    }
    return out;
};

/** "Guindy Block Admin" — the office name a tier's row in the journey card uses. */
const officeLabel = (region, tier) => {
    const name = region[tier];
    return `${name ? `${name} ` : ''}${TIER_WORD[tier]} Admin`;
};

/**
 * The applicant's declared type and business, from the business record (keyed
 * by `userId` — the wrong key returns null silently, see CLAUDE.md).
 */
const businessOf = async(userId) => {
    try {
        const BusinessInfo = require('../members/businessinfo.model');
        return await BusinessInfo.findOne({ userId: String(userId || '') }).lean();
    } catch (error) {
        logger.warn('Business record not read for a membership message', { error: error && error.message });
        return null;
    }
};

/** business / aspirant / student — what the applicant declared. */
const applicantKind = (application = {}, business = null) => {
    const said = (value) => application.memberType === value || application.registrationType === value
        || (!!business && business.doingBusiness === false && business.registrationType === value);
    if (said('student')) return 'student';
    if (said('aspirant') || (business && business.doingBusiness === false)) return 'aspirant';
    return 'business';
};

const memberTypeLabel = (application = {}, business = null) => ({
    student: 'Student membership',
    aspirant: 'Aspirant membership',
    business: 'Business membership'
})[applicantKind(application, business)];

/**
 * Everything about the application: reference, who, what, where, and where
 * each of the three reviews stands.
 */
const forApplication = async(application = {}) => {
    const region = regionOf(application);
    const business = await businessOf(application.userId);
    return {
        reference: referenceOf(application),
        applicantName: clean(application.fullName),
        businessName: clean(business && business.organizationName),
        memberTypeLabel: memberTypeLabel(application, business),
        regionLabel: [region.block, region.district, region.state].filter(Boolean).join(', '),
        submittedLabel: dateLabel(application.createdAt || application.submittedAt || new Date()),
        reviews: reviewsFor(application),
        blockOffice: officeLabel(region, 'block'),
        districtOffice: officeLabel(region, 'district'),
        stateOffice: officeLabel(region, 'state'),
        region,
        business
    };
};

/**
 * The plan and fee THIS applicant is offered — through `membershipplan.service`,
 * the same lookup the payment screen and the payment itself use, so the figure
 * in the message is the figure charged (CLAUDE.md: the price shown and the price
 * charged are one lookup). Only a single matched plan is quoted: when the Super
 * Admin shows every plan, or no band covers the business, the message asks the
 * applicant to choose rather than naming a price they may not pay.
 */
const planFor = async(application = {}, business = undefined) => {
    try {
        const membershipPlanService = require('../members/membershipplan.service');
        const record = business === undefined ? await businessOf(application.userId) : business;
        const resolved = await membershipPlanService.resolveForMember({
            commencementYear: record ? (record.businessCommencementYear || record.commencementYear || '') : '',
            kind: applicantKind(application, record)
        });
        const plan = resolved && resolved.matched;
        if (!plan) return {};
        return {
            planName: clean(plan.name),
            feeLabel: rupees(plan.price),
            planBand: clean(plan.experience),
            planFeatures: Array.isArray(plan.features) ? plan.features.filter(Boolean) : []
        };
    } catch (error) {
        logger.warn('Plan not resolved for a membership message', { error: error && error.message });
        return {};
    }
};

/** A member's ID, as every screen derives it (the field is not on the schema). */
const membershipNumberOf = (member = {}) => clean(member.membershipNumber)
    || clean(member._id).slice(-8).toUpperCase();

/** The recipient shape `dispatchLifecycleEvent` takes, from a member record. */
const recipientFromMember = (member = {}) => ({
    id: member._id,
    name: member.fullName,
    email: member.email,
    phone: member.phoneNumber,
    whatsapp: member.whatsappNumber,
    state: member.state,
    district: member.district,
    block: member.block
});

module.exports = {
    dateLabel,
    rupees,
    referenceOf,
    regionOf,
    reviewsFor,
    forApplication,
    planFor,
    membershipNumberOf,
    recipientFromMember
};
