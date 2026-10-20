const Member = require('../members/memberdetails.model');
const eligibility = () => require('../members/membershipEligibility');
const { membershipState } = require('../members/membershipState');
const { PAID_STATUSES } = require('../common/memberContext');
const membershipContext = require('./membershipContext');
const logger = require('../../config/logger');

// Establish a baseline silently on rollout. Only a later forward change sends
// congratulations, so deployment cannot replay every historic plan upgrade.
const transitionFor = (member, progress) => {
    if (progress.kind !== 'business' || !progress.effective || member.membershipType === 'lifetime'
        || member.membershipTier === 'platinum') return null;
    const plan = progress.effective;
    const next = { planId: plan.key, planName: plan.name, minYears: Number(plan.minYears || 0) };
    const old = member.planNotificationState;
    if (old && old.planId === next.planId && Number(old.minYears) === next.minYears) return null;
    if (old && Number(old.minYears) > next.minYears) return null;
    return { next, notify: !!(old && progress.promoted && next.minYears > Number(old.minYears)), previous: old };
};

class MembershipProgressionService {
    async observe(member, progress, now = new Date()) {
        if (member.isActive === false || member.deletedAt) return false;
        if (membershipState(member, { now }).state !== 'active') return false;
        const change = transitionFor(member, progress);
        if (!change) return false;
        const old = change.previous;
        const claim = {
            _id: member._id, membershipStatus: member.membershipStatus,
            isActive: { $ne: false }, deletedAt: null,
            membershipType: member.membershipType, membershipTier: member.membershipTier || null,
            membershipExpiresAt: member.membershipExpiresAt || null,
            ...(old ? { 'planNotificationState.planId': old.planId,
                'planNotificationState.minYears': old.minYears,
                'planNotificationState.initializedAt': old.initializedAt }
                : { planNotificationState: null })
        };
        if (change.notify) {
            const validUntil = require('../members/membershipDates').lastValidDay(require('../members/membershipState').periodEnd(member));
            const progressionFrom = { planId: old.planId, minYears: Number(old.minYears),
                initializedAt: old.initializedAt ? new Date(old.initializedAt).toISOString() : '' };
            const progressionKey = require('node:crypto').createHash('sha256')
                .update(JSON.stringify({ memberId: String(member._id), from: progressionFrom,
                    to: { planId: change.next.planId, minYears: change.next.minYears } })).digest('hex');
            const queued = await require('./notification.service').dispatchInBackground('MEMBERSHIP_PLAN_ADVANCED',
                membershipContext.recipientFromMember(member), {
                    membershipNumber: membershipContext.membershipNumberOf(member),
                    previousPlanName: old.planName, planName: progress.effective.name,
                    planFeatures: progress.effective.features || [], feeLabel: membershipContext.rupees(progress.effective.price),
                    validUntilLabel: membershipContext.dateLabel(validUntil),
                    data: { planId: progress.effective.key, previousPlanId: old.planId, feeAppliesAtRenewal: true,
                        progressionKey, progressionFrom }
                });
            if (!queued?.queued) return false;
        }
        // Enqueue first. A failed checkpoint is safe to retry using the same
        // transition key, including when contacts or display text have changed.
        const saved = await Member.updateOne(claim, { $set: { planNotificationState: {
            ...change.next, initializedAt: old?.initializedAt || now,
            ...(change.notify ? { notifiedAt: now } : old?.notifiedAt ? { notifiedAt: old.notifiedAt } : {})
        } } });
        if (!saved.modifiedCount || !change.notify) return false;
        return true;
    }

    async sendDue(now = new Date()) {
        if (this.running) return 0;
        this.running = true;
        let count = 0;
        try {
            let after;
            while (true) {
                const members = await Member.find({ membershipStatus: { $in: PAID_STATUSES.concat(PAID_STATUSES.map(value => value.toUpperCase())) },
                    isActive: { $ne: false }, deletedAt: null,
                    membershipType: { $ne: 'lifetime' }, membershipTier: { $ne: 'platinum' },
                    ...(after ? { _id: { $gt: after } } : {}) }).sort({ _id: 1 }).limit(100).lean();
                if (!members.length) break;
                for (const member of members) {
                    if (membershipState(member, { now }).state !== 'active') continue;
                    try {
                        const data = await eligibility().load(member);
                        const progress = require('../members/membershipPlanRules').progression(member, data.business, data.paid, data.plans, now);
                        if (await this.observe(member, progress, now)) count++;
                    } catch (error) {
                        logger.warn('Membership plan notice could not be checked', { memberId: String(member._id), error: error.message });
                    }
                }
                after = members[members.length - 1]._id;
                if (members.length < 100) break;
            }
        } finally { this.running = false; }
        return count;
    }

    start() {
        if (this.timer || process.env.MEMBERSHIP_PLAN_NOTICES === 'false') return;
        const tick = () => this.sendDue().catch(error => logger.warn('Membership plan notice sweep failed', { error: error.message }));
        this.timer = setInterval(tick, 6 * 60 * 60 * 1000);
        this.timer.unref?.();
        const initial = setTimeout(tick, 90000);
        initial.unref?.();
    }
}
module.exports = new MembershipProgressionService();
module.exports.transitionFor = transitionFor;
