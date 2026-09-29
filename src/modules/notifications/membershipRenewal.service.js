const MemberDetails = require('../members/memberdetails.model');
const notificationService = require('./notification.service');
const membershipContext = require('./membershipContext');
const { PAID_STATUSES, invalidateMemberContext } = require('../common/memberContext');
const { membershipState, periodEnd, monthlyReminderDue } = require('../members/membershipState');
const logger = require('../../config/logger');

/**
 * Renewal reminders — 30 days before a membership expires, 7 days before, and
 * once on the day it lapses — on the bell, email and WhatsApp.
 *
 * Memberships carry `membershipExpiresAt` (a year from payment; renewals extend
 * it) and nothing ever told a member it was running out: the first they heard
 * was losing the directory. A sweep, not a timer per member, for the reason the
 * event reminders give: a restart loses nothing, and the sweep re-reads the
 * member, so a member who renewed yesterday is not reminded today.
 *
 * AFTER EXPIRY the same sweep (1) marks a lapsed membership `expired` — the
 * member's own screens then treat them as unpaid, and the admin Members screen
 * files them under Expired — and (2) sends "your membership has expired, renew
 * now" twice a month, on the 1st and the 15th, while the member's
 * `renewalReminderEnabled` is on (the State Admin's switch). Each is claimed by
 * a key before it is sent, so the sweep can run as often as it likes.
 *
 * `MEMBERSHIP_RENEWAL_REMINDERS=false` switches it off;
 * `MEMBERSHIP_RENEWAL_INTERVAL_HOURS` sets the sweep (6 by default).
 */

const DAY = 24 * 60 * 60 * 1000;

/** The reminder windows, widest first. `0` is "on or just after expiry". */
const WINDOWS = [30, 7, 0];

/** Which window a member is in today, or null. Expired more than 7 days ago: none. */
const windowFor = (daysLeft) => {
    if (daysLeft < -7) return null;
    if (daysLeft <= 0) return 0;
    if (daysLeft <= 7) return 7;
    if (daysLeft <= 30) return 30;
    return null;
};

const keyFor = (expiresAt, window) => `${new Date(expiresAt).toISOString().slice(0, 10)}:${window}`;

const inWords = (daysLeft) => {
    if (daysLeft <= 0) return 'today';
    if (daysLeft === 1) return 'tomorrow';
    return `in ${daysLeft} days`;
};

/** One renewal message, on every channel. Used by the sweep and by an admin's "send now". */
const dispatchRenewal = (member, now = new Date(), data = {}) => {
    const expiresAt = periodEnd(member);
    const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / DAY) : 0;
    notificationService.dispatchInBackground('MEMBERSHIP_RENEWAL_DUE',
        membershipContext.recipientFromMember(member), {
            membershipNumber: membershipContext.membershipNumberOf(member),
            membershipType: member.membershipType,
            validUntilLabel: expiresAt ? membershipContext.dateLabel(expiresAt) : '',
            daysLeft,
            expiresInLabel: inWords(daysLeft),
            data: { ...data, expiresAt: expiresAt ? expiresAt.toISOString() : '' }
        });
    return daysLeft;
};

class MembershipRenewalService {
    /** The whole sweep: pre-expiry reminders, the automatic flip, the twice-monthly reminder. */
    async sendDue(now = new Date()) {
        const before = await this.sendWindowReminders(now);
        // Order matters: the expiry-day reminder above reads PAID rows, so the
        // flip runs after it — a member lapsing today still gets that message.
        await this.flipExpired(now);
        const monthly = await this.sendMonthlyExpired(now);
        return before + monthly;
    }

    /**
     * A paid membership whose period has ended becomes `expired` — automatically.
     *
     * Lifetime and Platinum never do. A row with no stored expiry gets the date
     * its period actually ended written alongside, so the record says when.
     * `dryRun` reports without writing (used to check against live data).
     */
    async flipExpired(now = new Date(), { dryRun = false } = {}) {
        const yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
        const candidates = await MemberDetails.find({
            membershipStatus: { $in: PAID_STATUSES.concat(PAID_STATUSES.map((st) => st.toUpperCase())) },
            membershipType: { $ne: 'lifetime' },
            membershipTier: { $ne: 'platinum' },
            $or: [
                { membershipExpiresAt: { $lte: now } },
                { membershipExpiresAt: null, membershipType: 'annual', membershipActivatedAt: { $lte: yearAgo } }
            ]
        }).limit(1000).lean().catch(() => []);

        const flipped = [];
        for (const member of candidates || []) {
            const { state, expiresAt } = membershipState(member, { now });
            if (state !== 'expired') continue;
            flipped.push({ id: String(member._id), expiresAt });
            if (dryRun) continue;
            const set = { membershipStatus: 'expired' };
            if (!member.membershipExpiresAt && expiresAt) set.membershipExpiresAt = expiresAt;
            const res = await MemberDetails.updateOne(
                { _id: member._id, membershipStatus: member.membershipStatus },
                { $set: set }
            ).catch(() => null);
            if (res && res.modifiedCount) invalidateMemberContext(member._id);
        }
        if (flipped.length && !dryRun) logger.info('Memberships marked expired', { count: flipped.length });
        return flipped;
    }

    /** "Your membership has expired — renew now", once per half-month (1st, 15th). */
    async sendMonthlyExpired(now = new Date()) {
        const members = await MemberDetails.find({
            membershipStatus: { $in: ['expired', 'EXPIRED'] },
            renewalReminderEnabled: { $ne: false }
        }).limit(1000).lean().catch(() => []);

        let sent = 0;
        for (const member of members || []) {
            const key = monthlyReminderDue(member, { now, already: member.renewalReminders });
            if (!key) continue;
            const claimed = await MemberDetails.updateOne(
                { _id: member._id, renewalReminders: { $ne: key } },
                { $addToSet: { renewalReminders: key }, $set: { lastRenewalReminderAt: now } }
            ).catch(() => null);
            if (!claimed || !claimed.modifiedCount) continue;
            dispatchRenewal(member, now, { monthly: key });
            sent++;
        }
        if (sent) logger.info('Expired-membership reminders sent', { count: sent });
        return sent;
    }

    async sendWindowReminders(now = new Date()) {
        const from = new Date(now.getTime() - 7 * DAY);
        const to = new Date(now.getTime() + 30 * DAY);

        const members = await MemberDetails.find({
            membershipExpiresAt: { $gte: from, $lte: to },
            membershipStatus: { $in: PAID_STATUSES.concat(PAID_STATUSES.map((s) => s.toUpperCase())) }
        }).limit(500).lean().catch(() => []);

        let sent = 0;
        for (const member of members || []) {
            const expiresAt = new Date(member.membershipExpiresAt);
            const daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY);
            const window = windowFor(daysLeft);
            if (window === null) continue;

            const key = keyFor(expiresAt, window);
            const already = Array.isArray(member.renewalReminders) ? member.renewalReminders : [];
            // A wider window not yet sent is SKIPPED once a narrower one is due:
            // "expires in 30 days" arriving five days before expiry is wrong.
            if (already.includes(key)) continue;

            // Claim the key BEFORE sending, conditionally, so two instances of
            // the server cannot both send the same reminder.
            const claimed = await MemberDetails.updateOne(
                { _id: member._id, renewalReminders: { $ne: key } },
                { $addToSet: { renewalReminders: key }, $set: { lastRenewalReminderAt: now } }
            ).catch(() => null);
            if (!claimed || !claimed.modifiedCount) continue;

            notificationService.dispatchInBackground('MEMBERSHIP_RENEWAL_DUE',
                membershipContext.recipientFromMember(member), {
                    membershipNumber: membershipContext.membershipNumberOf(member),
                    membershipType: member.membershipType,
                    validUntilLabel: membershipContext.dateLabel(expiresAt),
                    daysLeft,
                    expiresInLabel: inWords(daysLeft),
                    data: { window, expiresAt: expiresAt.toISOString() }
                });
            sent++;
        }

        if (sent) logger.info('Membership renewal reminders sent', { count: sent });
        return sent;
    }

    /** Start the sweep. Idempotent; `server.js` calls it once. */
    start() {
        if (this.timer) return;
        if (String(process.env.MEMBERSHIP_RENEWAL_REMINDERS || 'true').toLowerCase() === 'false') return;

        const hours = Math.max(1, parseInt(process.env.MEMBERSHIP_RENEWAL_INTERVAL_HOURS, 10) || 6);
        const tick = () => this.sendDue().catch((error) =>
            logger.warn('Membership renewal sweep failed', { error: error && error.message }));

        this.timer = setInterval(tick, hours * 60 * 60 * 1000);
        if (this.timer.unref) this.timer.unref();
        const first = setTimeout(tick, 60 * 1000);
        if (first.unref) first.unref();
    }
}

module.exports = new MembershipRenewalService();
module.exports.dispatchRenewal = dispatchRenewal;
module.exports.windowFor = windowFor;
module.exports.WINDOWS = WINDOWS;
