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
const PAGE_SIZE = 500;
const PAID_VALUES = PAID_STATUSES.concat(PAID_STATUSES.map(value => value.toUpperCase()));

// Keyset pagination keeps members past the first page eligible even when older
// rows have already received their reminder. Updating rows during a sweep does
// not shift the cursor as it would with skip()/offset pagination.
async function* membersFor(filter) {
    let lastId = null;
    while (true) {
        const rows = await MemberDetails.find({ ...filter, ...(lastId ? { _id: { $gt: lastId } } : {}) })
            .sort({ _id: 1 }).limit(PAGE_SIZE).lean();
        if (!rows || !rows.length) return;
        for (const member of rows) yield member;
        if (rows.length < PAGE_SIZE) return;
        lastId = rows[rows.length - 1]._id;
    }
}

// A renewal can leave status='active' while extending the expiry. Match the
// period as well as status so a concurrently renewed member cannot be expired
// or sent a reminder based on the old scan. The fallback activation and lifetime
// fields protect older records without a stored membershipExpiresAt too.
const periodSnapshot = member => ({
    _id: member._id,
    membershipStatus: member.membershipStatus,
    membershipExpiresAt: member.membershipExpiresAt || null,
    membershipActivatedAt: member.membershipActivatedAt || null,
    membershipType: member.membershipType ?? null,
    membershipTier: member.membershipTier ?? null,
});

const claimReminder = (member, key, now) => MemberDetails.findOneAndUpdate({
    ...periodSnapshot(member), isActive: { $ne: false },
    renewalReminderEnabled: { $ne: false }, renewalReminders: { $ne: key },
}, { $addToSet: { renewalReminders: key }, $set: { lastRenewalReminderAt: now } }, { new: true }).lean();

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
const dispatchRenewal = async (member, now = new Date(), data = {}) => {
    const expiresAt = periodEnd(member);
    const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / DAY) : 0;
    await notificationService.dispatchLifecycleEvent('MEMBERSHIP_RENEWAL_DUE',
        membershipContext.recipientFromMember(member), {
            membershipNumber: membershipContext.membershipNumberOf(member),
            membershipType: member.membershipType,
            validUntilLabel: expiresAt ? membershipContext.dateLabel(require('../members/membershipDates').lastValidDay(expiresAt)) : '',
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
        const filter = {
            membershipStatus: { $in: PAID_VALUES },
            membershipType: { $ne: 'lifetime' },
            membershipTier: { $ne: 'platinum' },
            $or: [
                { membershipExpiresAt: { $lte: now } },
                { membershipExpiresAt: null, membershipType: 'annual', membershipActivatedAt: { $lte: yearAgo } }
            ]
        };

        const flipped = [];
        for await (const member of membersFor(filter)) {
            const { state, expiresAt } = membershipState(member, { now });
            if (state !== 'expired') continue;
            if (dryRun) { flipped.push({ id: String(member._id), expiresAt }); continue; }
            const set = { membershipStatus: 'expired' };
            if (!member.membershipExpiresAt && expiresAt) set.membershipExpiresAt = expiresAt;
            const res = await MemberDetails.updateOne(
                periodSnapshot(member),
                { $set: set }
            ).catch(() => null);
            if (res && res.modifiedCount) {
                invalidateMemberContext(member._id);
                flipped.push({ id: String(member._id), expiresAt });
            }
        }
        if (flipped.length && !dryRun) logger.info('Memberships marked expired', { count: flipped.length });
        return flipped;
    }

    /** "Your membership has expired — renew now", once per half-month (1st, 15th). */
    async sendMonthlyExpired(now = new Date()) {
        const filter = {
            membershipStatus: { $in: ['expired', 'EXPIRED'] },
            renewalReminderEnabled: { $ne: false }, isActive: { $ne: false },
        };

        let sent = 0;
        for await (const member of membersFor(filter)) {
            const key = monthlyReminderDue(member, { now, already: member.renewalReminders });
            if (!key) continue;
            const claimed = await claimReminder(member, key, now);
            if (!claimed) continue;
            await dispatchRenewal(claimed, now, { monthly: key });
            sent++;
        }
        if (sent) logger.info('Expired-membership reminders sent', { count: sent });
        return sent;
    }

    async sendWindowReminders(now = new Date()) {
        const from = new Date(now.getTime() - 7 * DAY);
        const to = new Date(now.getTime() + 30 * DAY);

        const filter = {
            membershipExpiresAt: { $gte: from, $lte: to },
            membershipStatus: { $in: PAID_VALUES },
            renewalReminderEnabled: { $ne: false }, isActive: { $ne: false },
        };

        let sent = 0;
        for await (const member of membersFor(filter)) {
            const expiresAt = periodEnd(member);
            if (!expiresAt || !Number.isFinite(expiresAt.getTime())) continue;
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
            const claimed = await claimReminder(member, key, now);
            if (!claimed) continue;
            await dispatchRenewal(claimed, now, { window });
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
        let running = false;
        const tick = () => {
            if (running) return;
            running = true;
            this.sendDue().catch((error) => logger.warn('Membership renewal sweep failed', { error: error && error.message }))
                .finally(() => { running = false; });
        };

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
