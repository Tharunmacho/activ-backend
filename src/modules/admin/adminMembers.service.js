const MemberDetails = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const PaymentOrder = require('../payment/paymentorder.model');
const adminRepository = require('./admin.repository');
const adminService = require('./admin.service');
const { ownRegionMissing } = require('./superadmin.service');
const { membershipState, periodEnd } = require('../members/membershipState');
const { membershipNumberFor, applicationRefFor } = require('../members/memberNumber');
const { normalizeStatus } = require('../common/applicationStatus');
const renewal = require('../notifications/membershipRenewal.service');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

/**
 * THE ADMIN MEMBERS SCREEN — who has paid, whose membership has lapsed, who
 * is approved and still to pay. Every tier, each inside its own region.
 *
 * It replaces a directory built from "approved + rejected applications", where
 * Active meant "approved" and Inactive meant "rejected" — neither of which says
 * whether anyone has paid. Here Active means PAID and in date, Expired means the
 * paid period ended (`membershipState`, and the sweep that writes it), and
 * Awaiting payment is an approved application with no payment.
 *
 * GEOFENCED exactly as the queues are: anchored, case-insensitive match on the
 * member's own block/district/state, the narrowest the admin's tier has. An
 * admin whose own region cannot be resolved sees NOTHING — never everything.
 */

const DAY = 24 * 60 * 60 * 1000;
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (v) => new RegExp(`^\\s*${escapeRegex(String(v || '').trim()).replace(/\s+/g, '\\s+')}\\s*$`, 'i');

const KIND_LABEL = { business: 'Business', aspirant: 'Aspirant', student: 'Student' };

/** The actor's role and the region filter on MemberDetails; `filter: null` = sees nobody. */
const scopeOf = async (actor = {}) => {
    const role = adminRepository.normalizeRole(actor.role || actor.adminType || '');
    if (role === 'super_admin') return { role, state: '', district: '', block: '', filter: {} };
    const scope = await adminService.resolveAdminScope(actor);
    const state = scope.stateName || '';
    const district = scope.districtName || '';
    const block = scope.blockName || '';
    // No own-tier region -> nobody. The same test the Hub and queues use.
    if (ownRegionMissing({ role, state, district, block })) return { role, state, district, block, filter: null };
    // The admin's own level, narrowed further by every level above it that is known.
    const filter = {};
    if (state) filter.state = exact(state);
    if ((role === 'district_admin' || role === 'block_admin') && district) filter.district = exact(district);
    if (role === 'block_admin') filter.block = exact(block);
    return { role, state, district, block, filter };
};

const inScope = (member, scope) => {
    if (scope.role === 'super_admin') return true;
    if (!scope.filter) return false;
    return Object.entries(scope.filter).every(([k, rx]) => rx.test(String(member[k] || '')));
};

/** Latest application per member: outcome + id + reference. */
const applicationsFor = async (members) => {
    const ids = members.map((m) => m._id);
    const emails = members.map((m) => String(m.email || '').toLowerCase()).filter(Boolean);
    const apps = await Application.find({ $or: [{ userId: { $in: ids } }, { email: { $in: emails } }] })
        .select('userId email status applicationNumber createdAt updatedAt').sort({ updatedAt: -1 }).lean().catch(() => []);
    const byId = new Map();
    const byEmail = new Map();
    for (const a of apps || []) {
        const out = { id: String(a._id), outcome: normalizeStatus(a.status), reference: applicationRefFor(a) };
        const uid = String(a.userId || '');
        const em = String(a.email || '').toLowerCase();
        // Approved wins: one approved application is the outcome.
        if (uid && (!byId.has(uid) || out.outcome === 'Approved')) byId.set(uid, out);
        if (em && (!byEmail.has(em) || out.outcome === 'Approved')) byEmail.set(em, out);
    }
    return (m) => byId.get(String(m._id)) || byEmail.get(String(m.email || '').toLowerCase()) || null;
};

/** The plan each member last paid for, from their paid membership orders. */
const plansFor = async (members) => {
    const rows = await PaymentOrder.aggregate([
        { $match: { memberId: { $in: members.map((m) => m._id) }, status: 'paid', orderType: 'membership' } },
        { $sort: { paidAt: -1 } },
        { $group: { _id: '$memberId', planName: { $first: '$planName' }, amount: { $first: '$amount' } } },
    ]).catch(() => []);
    const map = new Map((rows || []).map((r) => [String(r._id), r]));
    return (m) => map.get(String(m._id)) || null;
};

const kindOf = (m) => {
    const k = String(m.memberType || m.registrationType || '').toLowerCase();
    return KIND_LABEL[k] ? k : '';
};

const toRow = (m, app, plan, now) => {
    const s = membershipState(m, { outcome: app ? app.outcome : '', now });
    const kind = kindOf(m);
    const platinum = String(m.membershipTier || '').toLowerCase() === 'platinum';
    return {
        id: String(m._id),
        applicationId: app ? app.id : '',
        applicationRef: app ? app.reference : '',
        name: m.fullName || '',
        email: m.email || '',
        phone: m.whatsappNumber || m.phoneNumber || '',
        photo: m.profilePhoto || '',
        block: m.block || '', district: m.district || '', state: m.state || '',
        memberNumber: s.state === 'none' || s.state === 'awaiting_payment' ? '' : membershipNumberFor(m),
        kind,
        kindLabel: KIND_LABEL[kind] || 'Member',
        platinum,
        lifetime: s.lifetime,
        planName: platinum ? 'Lifetime Membership' : (plan && plan.planName) || '',
        activatedAt: m.membershipActivatedAt || null,
        expiresAt: s.expiresAt,
        daysLeft: s.daysLeft,
        /** The MEMBERSHIP status — `state` above is the region. */
        status: s.state,
        expiringSoon: s.expiringSoon,
        blocked: m.isActive === false,
        reminders: m.renewalReminderEnabled !== false,
        remindersChangedBy: m.renewalReminderChangedBy || '',
        remindersChangedAt: m.renewalReminderChangedAt || null,
        lastReminderAt: m.lastRenewalReminderAt || null,
    };
};

const TABS = ['active', 'expiring', 'expired', 'awaiting', 'all'];
const inTab = (row, tab) => {
    if (tab === 'active') return row.status === 'active';
    if (tab === 'expiring') return row.status === 'active' && row.expiringSoon;
    if (tab === 'expired') return row.status === 'expired';
    if (tab === 'awaiting') return row.status === 'awaiting_payment';
    return row.status !== 'none';
};

class AdminMembersService {
    async list(actor = {}, query = {}) {
        const scope = await scopeOf(actor);
        const canManageReminders = scope.role === 'super_admin' || scope.role === 'state_admin';
        const empty = { rows: [], counts: { active: 0, expiring: 0, expired: 0, awaiting: 0, all: 0 },
            summary: { active: 0, expiringSoon: 0, expired: 0, awaitingPayment: 0, platinum: 0, renewedThisMonth: 0 },
            canManageReminders, scopeUnresolved: true, region: scope,
            message: `Your account has no ${String(scope.role || '').replace('_admin', '') || 'region'} set — ask the Super Admin to add it in Manage Admins.` };
        if (!scope.filter) return empty;

        const now = new Date();
        const members = await MemberDetails.find(scope.filter)
            .select('fullName email phoneNumber whatsappNumber profilePhoto block district state membershipStatus membershipType '
                + 'membershipTier membershipActivatedAt membershipExpiresAt membershipNumber memberType registrationType isActive '
                + 'renewalReminderEnabled renewalReminderChangedBy renewalReminderChangedAt lastRenewalReminderAt lastPaymentDate createdAt')
            .limit(5000).lean().catch(() => []);
        const [appOf, planOf] = await Promise.all([applicationsFor(members), plansFor(members)]);
        const all = members.map((m) => toRow(m, appOf(m), planOf(m), now)).filter((r) => r.status !== 'none');

        const counts = Object.fromEntries(TABS.map((t) => [t, all.filter((r) => inTab(r, t)).length]));
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const summary = {
            active: counts.active,
            expiringSoon: counts.expiring,
            expired: counts.expired,
            awaitingPayment: counts.awaiting,
            platinum: all.filter((r) => r.platinum).length,
            // Paid this month by someone who had been a member before — a renewal.
            renewedThisMonth: members.filter((m) => m.lastPaymentDate && new Date(m.lastPaymentDate) >= monthStart
                && m.membershipActivatedAt && new Date(m.membershipActivatedAt) < monthStart).length,
        };

        const tab = TABS.includes(query.tab) ? query.tab : 'all';
        const q = String(query.q || '').trim().toLowerCase();
        const type = String(query.type || '').toLowerCase();
        const rows = all
            .filter((r) => inTab(r, tab))
            .filter((r) => !q || [r.name, r.email, r.phone, r.memberNumber, r.block, r.district].some((v) => String(v || '').toLowerCase().includes(q)))
            .filter((r) => !type || (type === 'platinum' ? r.platinum : type === 'lifetime' ? r.lifetime : r.kind === type))
            .sort((a, b) => {
                // Most urgent first: soonest to lapse, then most recently lapsed, then by name.
                const ax = a.daysLeft === null ? Infinity : a.daysLeft;
                const bx = b.daysLeft === null ? Infinity : b.daysLeft;
                if (tab === 'expired') return bx - ax;
                if (ax !== bx) return ax - bx;
                return a.name.localeCompare(b.name);
            });
        return { rows, counts, summary, canManageReminders, scopeUnresolved: false, region: { state: scope.state, district: scope.district, block: scope.block } };
    }

    /** Load a member the actor may MANAGE reminders for: State (own state) or Super only. */
    async managed(actor, memberId) {
        const scope = await scopeOf(actor);
        if (scope.role !== 'super_admin' && scope.role !== 'state_admin') {
            throw ApiError.forbidden('Only the State Admin can change renewal reminders.');
        }
        const member = await MemberDetails.findById(memberId);
        if (!member) throw ApiError.notFound('Member not found');
        if (!inScope(member, scope)) throw ApiError.forbidden('This member is outside your region.');
        return { member, scope };
    }

    async setReminders(actor, memberId, enabled) {
        const { member } = await this.managed(actor, memberId);
        member.renewalReminderEnabled = !!enabled;
        member.renewalReminderChangedBy = String(actor.email || actor.role || 'admin');
        member.renewalReminderChangedAt = new Date();
        await member.save();
        logger.info('Renewal reminders switched', { memberId: String(member._id), enabled: !!enabled, by: member.renewalReminderChangedBy });
        return toRow(member.toObject(), null, null, new Date());
    }

    /** "Send reminder now" — expired or expiring members; not twice within 24 hours. */
    async remindNow(actor, memberId) {
        const { member } = await this.managed(actor, memberId);
        return this.remindOne(member, actor);
    }

    async remindOne(member, actor = {}) {
        const now = new Date();
        const s = membershipState(member.toObject ? member.toObject() : member, { now });
        if (!(s.state === 'expired' || (s.state === 'active' && s.expiringSoon))) {
            throw ApiError.badRequest('Reminders are for memberships that have expired or expire within 30 days.');
        }
        const last = member.lastRenewalReminderAt ? new Date(member.lastRenewalReminderAt).getTime() : 0;
        if (last && now.getTime() - last < DAY) {
            throw ApiError.badRequest('A reminder already went to this member in the last 24 hours.');
        }
        const res = await MemberDetails.updateOne(
            { _id: member._id, $or: [{ lastRenewalReminderAt: null }, { lastRenewalReminderAt: { $lt: new Date(now.getTime() - DAY) } }] },
            { $set: { lastRenewalReminderAt: now } }
        );
        if (!res.modifiedCount) throw ApiError.badRequest('A reminder already went to this member in the last 24 hours.');
        renewal.dispatchRenewal(member.toObject ? member.toObject() : member, now, { manual: true, by: String(actor.email || '') });
        return { sent: true, at: now, expiresAt: periodEnd(member) };
    }

    /** One click: remind every expired member in the region with reminders on (24h guard each). */
    async remindAllExpired(actor) {
        const scope = await scopeOf(actor);
        if (scope.role !== 'super_admin' && scope.role !== 'state_admin') {
            throw ApiError.forbidden('Only the State Admin can send renewal reminders.');
        }
        if (!scope.filter) return { sent: 0, skipped: 0 };
        const members = await MemberDetails.find({ ...scope.filter, membershipStatus: { $in: ['expired', 'active', 'completed'] }, renewalReminderEnabled: { $ne: false } })
            .limit(2000);
        let sent = 0; let skipped = 0;
        for (const m of members) {
            if (membershipState(m.toObject()).state !== 'expired') continue;
            try { await this.remindOne(m, actor); sent++; } catch { skipped++; }
        }
        return { sent, skipped };
    }
}

module.exports = new AdminMembersService();
module.exports.scopeOf = scopeOf;
