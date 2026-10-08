const crypto = require('crypto');
const MemberDetails = require('./memberdetails.model');
const PaymentOrder = require('../payment/paymentorder.model');
const Application = require('../applications/application.model');
const membershipPlanService = require('./membershipplan.service');
const notificationService = require('../notifications/notification.service');
const membershipContext = require('../notifications/membershipContext');
const { membershipNumberFor } = require('./memberNumber');
const { normalizeStatus, STATUS } = require('../common/applicationStatus');
const { invalidateMemberContext, isPaidStatus } = require('../common/memberContext');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

/**
 * PLATINUM — A LIFETIME MEMBERSHIP THE SUPER ADMIN GRANTS BY HAND.
 *
 * ₹2,00,000 (the `platinum` plan row, editable at Super Admin → Membership),
 * paid in cash, cheque or bank transfer to the office — never through the
 * online checkout; `getPlanForPayment` refuses the row. The Super Admin
 * records the receipt here and the member becomes:
 *
 *   membershipStatus 'active', membershipType 'lifetime', membershipTier
 *   'platinum', membershipExpiresAt null   -> never renews; the renewal sweep
 *                                             only reads an expiry date
 *
 * Three rules this keeps:
 *
 * - ONLY THE STATE / SUPER GRANT A MEMBERSHIP (CLAUDE.md, three verdicts, one
 *   outcome). Platinum is a TIER of membership, not a way round the review: the
 *   member's application must already be Approved — or they are already an
 *   active member upgrading. Otherwise the grant is refused with a sentence
 *   saying what to do.
 * - THE MONEY IS ON RECORD. The receipt becomes a paid `membership` PaymentOrder
 *   (provider 'offline'), so the 80G certificate's contribution table and every
 *   report that sums paid orders sees it like any other payment.
 * - A MISTAKE CAN BE UNDONE. `platinumGrant.previous` snapshots what the member
 *   held; revoking restores it and cancels the offline order.
 */

const MODES = ['cash', 'cheque', 'bank_transfer', 'upi_offline', 'other'];
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The application outcome for each member id: 'Approved' | 'Rejected' | 'Pending' | ''. */
const outcomesFor = async (ids = []) => {
    const out = new Map();
    if (!ids.length) return out;
    const rows = await Application.find({ userId: { $in: ids } })
        .select('userId status updatedAt').sort({ updatedAt: -1 }).lean();
    for (const row of rows) {
        const key = String(row.userId || '');
        const status = normalizeStatus(row.status);
        // The most advanced answer wins: one Approved row is the outcome.
        if (!out.has(key) || status === STATUS.APPROVED) out.set(key, status);
    }
    return out;
};

const shape = (m, outcome = '') => ({
    id: String(m._id),
    fullName: m.fullName || '',
    email: m.email || '',
    phoneNumber: m.phoneNumber || '',
    whatsappNumber: m.whatsappNumber || '',
    block: m.block || '',
    district: m.district || '',
    state: m.state || '',
    membershipNumber: membershipNumberFor(m),
    membershipStatus: m.membershipStatus || 'pending',
    membershipType: m.membershipType || 'none',
    membershipTier: m.membershipTier || 'standard',
    applicationOutcome: outcome,
    canAdmitManually: m.isActive !== false && m.membershipTier !== 'platinum' && outcome !== STATUS.REJECTED && (!m.role || m.role === 'member' || ['business', 'student', 'aspirant'].includes(m.role)),
    /** Why a grant would be refused, or '' when it can go ahead. */
    blockedReason: m.isActive === false ? 'Unblock this account before admission' : m.membershipTier === 'platinum'
        ? 'Already a Lifetime member'
        : (outcome === STATUS.APPROVED || isPaidStatus(m.membershipStatus))
            ? ''
            : outcome === STATUS.REJECTED
                ? 'Their application was not approved'
                : outcome
                    ? 'Approve their application first (Approvals)'
                    : 'They have not submitted an application yet',
    platinumGrant: m.platinumGrant && m.platinumGrant.grantedAt ? {
        grantedAt: m.platinumGrant.grantedAt,
        grantedByName: m.platinumGrant.grantedByName || '',
        amount: m.platinumGrant.amount || 0,
        paymentMode: m.platinumGrant.paymentMode || '',
        receiptNumber: m.platinumGrant.receiptNumber || '',
        receivedOn: m.platinumGrant.receivedOn || null,
        note: m.platinumGrant.note || ''
    } : null
});

const PlatinumRequest = require('./platinumrequest.model');
const config = require('../../config');

const OPEN = ['new', 'contacted'];
const CONTACT_LABEL = { call: 'Phone call', whatsapp: 'WhatsApp', email: 'Email' };

const shapeRequest = (r) => r && ({
    id: String(r._id),
    memberId: r.memberId,
    name: r.name || '',
    email: r.email || '',
    phone: r.phone || '',
    block: r.block || '',
    district: r.district || '',
    state: r.state || '',
    companyName: r.companyName || '',
    preferredContact: r.preferredContact || 'call',
    preferredTime: r.preferredTime || '',
    message: r.message || '',
    status: r.status || 'new',
    notes: r.notes || '',
    handledBy: r.handledBy || '',
    handledAt: r.handledAt || null,
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null
});

/**
 * Who hears about a new request: the ACTIV office inbox and every active
 * Super Admin with an address. Deduped; best effort — a request is never
 * refused because a mail host is down.
 */
const requestWatchers = async () => {
    const out = new Map();
    const office = String((config.email && (config.email.supportAddress || config.email.officeAddress)) || 'enquiry@activ.org.in').trim();
    if (office) out.set(office.toLowerCase(), { name: 'ACTIV Office', email: office });
    try {
        const adminRepository = require('../admin/admin.repository');
        const roster = await adminRepository.findActive();
        for (const a of roster || []) {
            if (a && a.role === 'super_admin' && a.email) {
                out.set(String(a.email).toLowerCase(), { name: a.fullName || 'Super Admin', email: a.email });
            }
        }
    } catch (error) {
        logger.warn('Lifetime request: super admin roster unavailable', { error: error && error.message });
    }
    return [...out.values()];
};

class PlatinumService {
    async updateAccount(id, body, actor = {}) {
        if (actor.role !== 'super_admin') throw ApiError.forbidden('Only the Super Admin can edit member accounts.');
        if (!require('mongoose').isValidObjectId(id)) throw ApiError.badRequest('Invalid member ID.');
        const member = await MemberDetails.findById(id);
        if (!member || member.deletedAt || (member.role && !['member', 'business', 'student', 'aspirant'].includes(member.role))) throw ApiError.notFound('Member not found.');
        await require('./accountDetails.service').update(member, body, { admin: true });
        const outcome = (await outcomesFor([member._id])).get(String(member._id)) || '';
        return shape(member, outcome);
    }
    async createAccount(body, actor = {}) {
        if (actor.role !== 'super_admin') throw ApiError.forbidden('Only the Super Admin can create a Lifetime member account.');
        const email = String(body.email || '').trim().toLowerCase();
        const phone = String(body.phoneNumber || '').replace(/\D/g, '').slice(-10);
        if (!email && phone.length !== 10) throw ApiError.badRequest('Enter the member email or mobile number.');
        // Prefer the exact login email when older accounts share a contact
        // number. MongoDB's first $or match must not pick another member.
        let existing = email ? await MemberDetails.findOne({ email }).lean() : null;
        if (!existing && phone.length === 10) existing = await MemberDetails.findOne({ phoneNumber: new RegExp(`${phone}$`) }).lean();
        if (existing) {
            if (email && existing.email?.toLowerCase() !== email) throw ApiError.conflict('This mobile belongs to a different account. Select that member before recording payment.');
            // A new-account form must never silently discard the entered password.
            if (body.password) throw ApiError.conflict('This account already exists. Select Use existing account, then Edit login and contact details to change its password.');
            const outcome = (await outcomesFor([existing._id])).get(String(existing._id)) || '';
            return { ...shape(existing, outcome), existingAccount: true };
        }
        const result = await require('../auth/auth.service').register(body);
        // Never return the member's password or sign-in token to the admin UI.
        return shape(result.memberDetails, '');
    }
    /* ================================================== member's request */

    /** The member's latest request, or null. */
    async myRequest(memberId) {
        const row = await PlatinumRequest.findOne({ memberId: String(memberId) }).sort({ createdAt: -1 }).lean();
        const member = await MemberDetails.findById(memberId).select('membershipTier').lean().catch(() => null);
        return { request: shapeRequest(row) || null, isPlatinum: !!(member && member.membershipTier === 'platinum') };
    }

    /** Ask for Platinum. One open request per member; asking again returns it. */
    async createRequest(memberId, body = {}) {
        const member = await MemberDetails.findById(memberId);
        if (!member) throw ApiError.notFound('Member not found');
        if (member.membershipTier === 'platinum') throw ApiError.badRequest('You are already a Lifetime member.');

        const open = await PlatinumRequest.findOne({ memberId: String(member._id), status: { $in: OPEN } }).sort({ createdAt: -1 });
        if (open) return { request: shapeRequest(open.toObject()), existing: true };

        let companyName = '';
        try {
            const BusinessInfo = require('./businessinfo.model');
            const biz = await BusinessInfo.findOne({ userId: member._id }).select('organizationName').lean();
            companyName = (biz && biz.organizationName) || '';
        } catch { /* optional */ }

        const preferredContact = PlatinumRequest.CONTACT.includes(body.preferredContact) ? body.preferredContact : 'call';
        const doc = await PlatinumRequest.create({
            memberId: String(member._id),
            name: member.fullName || '',
            email: member.email || '',
            phone: member.whatsappNumber || member.phoneNumber || '',
            block: member.block || '',
            district: member.district || '',
            state: member.state || '',
            companyName,
            preferredContact,
            preferredTime: String(body.preferredTime || '').trim().slice(0, 120),
            message: String(body.message || '').trim().slice(0, 1000)
        });
        const request = shapeRequest(doc.toObject());
        const plan = await this.plan().catch(() => ({ price: 200000, name: 'Lifetime Membership' }));
        const priceLabel = `₹${Number(plan.price || 200000).toLocaleString('en-IN')}`;

        // The member: a confirmation on every channel they have.
        notificationService.dispatchInBackground('PLATINUM_REQUESTED', {
            id: member._id, name: member.fullName, email: member.email, phone: member.phoneNumber,
            whatsapp: member.whatsappNumber, state: member.state, district: member.district, block: member.block
        }, {
            priceLabel,
            planName: plan.name,
            preferredContactLabel: CONTACT_LABEL[preferredContact],
            preferredTime: request.preferredTime,
            data: { requestId: request.id }
        });

        // The office and every Super Admin: who asked, and how to reach them.
        const watchers = await requestWatchers();
        const regionLabel = [request.block, request.district, request.state].filter(Boolean).join(', ');
        for (const w of watchers) {
            notificationService.dispatchInBackground('ADMIN_PLATINUM_REQUEST', { name: w.name, email: w.email }, {
                noRegionalContact: true,
                applicantName: request.name,
                applicantEmail: request.email,
                applicantPhone: request.phone,
                applicantRegion: regionLabel,
                region: { block: request.block, district: request.district, state: request.state },
                businessName: request.companyName,
                preferredContactLabel: CONTACT_LABEL[preferredContact],
                preferredTime: request.preferredTime,
                message: request.message,
                priceLabel,
                reviewPath: '/super-admin/membership'
            });
        }

        logger.info('Lifetime requested', { memberId: request.memberId, id: request.id });
        return { request, existing: false };
    }

    /* ================================================ super admin's queue */

    async listRequests({ status } = {}) {
        const filter = status && status !== 'all' ? { status } : {};
        const [rows, counts] = await Promise.all([
            PlatinumRequest.find(filter).sort({ createdAt: -1 }).limit(300).lean(),
            PlatinumRequest.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).catch(() => [])
        ]);
        const byStatus = { new: 0, contacted: 0, converted: 0, declined: 0 };
        for (const c of counts || []) if (c && c._id in byStatus) byStatus[c._id] = c.n;
        const outcomes = await outcomesFor(rows.map((r) => r.memberId).filter((id) => /^[a-f0-9]{24}$/i.test(id)));
        const members = await MemberDetails.find({ _id: { $in: rows.map((r) => r.memberId).filter((id) => /^[a-f0-9]{24}$/i.test(id)) } })
            .select('membershipStatus membershipTier').lean().catch(() => []);
        const memberById = new Map(members.map((m) => [String(m._id), m]));
        return {
            requests: rows.map((r) => {
                const m = memberById.get(String(r.memberId)) || {};
                const shaped = shape({ ...m, _id: r.memberId, fullName: r.name, email: r.email }, outcomes.get(String(r.memberId)) || '');
                return { ...shapeRequest(r), blockedReason: shaped.blockedReason, canAdmitManually: shaped.canAdmitManually, membershipTier: m.membershipTier || 'standard' };
            }),
            counts: { ...byStatus, all: Object.values(byStatus).reduce((a, b) => a + b, 0) }
        };
    }

    /**
     * EVERYTHING THE MEMBER HAS TOLD US, for the office calling them back.
     *
     * The request row carries only what the Platinum form asked. The Super Admin
     * asked to see the rest too — registration, application, business and
     * declaration — so a call starts informed rather than with "who is this?".
     * Read-only, Super Admin only. The Aadhaar number is left out: nothing in a
     * sales call needs it, and this screen is not where it should travel.
     */
    async requestDetail(id) {
        const row = await PlatinumRequest.findById(id).lean();
        if (!row) throw ApiError.notFound('Request not found');
        const memberId = /^[a-f0-9]{24}$/i.test(String(row.memberId)) ? String(row.memberId) : '';
        const [m, biz, decl, apps, history] = await Promise.all([
            memberId ? MemberDetails.findById(memberId).lean().catch(() => null) : null,
            memberId ? require('./businessinfo.model').findOne({ userId: memberId }).lean().catch(() => null) : null,
            memberId ? require('./memberdeclaration.model').findOne({ $or: [{ userId: memberId }, { memberId }] }).lean().catch(() => null) : null,
            memberId ? Application.find({ userId: memberId }).sort({ updatedAt: -1 }).limit(3).lean().catch(() => []) : [],
            memberId ? PlatinumRequest.find({ memberId }).sort({ createdAt: -1 }).limit(10).lean().catch(() => []) : [],
        ]);
        const member = m || {};
        const app = (apps || [])[0] || null;
        const { applicationRefFor } = require('./memberNumber');
        const list = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : v ? [String(v)] : []);
        return {
            request: shapeRequest(row),
            personal: {
                fullName: member.fullName || row.name || '',
                email: member.email || row.email || '',
                phoneNumber: member.phoneNumber || '',
                whatsappNumber: member.whatsappNumber || '',
                gender: member.gender || '',
                socialCategory: member.socialCategory || '',
                religion: member.religion || '',
                educationalQualification: member.educationalQualification || '',
                block: member.block || '', district: member.district || '', state: member.state || '',
                city: member.city || '',
                isInternational: member.isInternational === true,
                place: member.place || '', country: member.country || '',
                profilePhoto: member.profilePhoto || '',
                registeredOn: member.createdAt || null,
            },
            membership: {
                memberNumber: m ? membershipNumberFor(member) : '',
                status: member.membershipStatus || 'pending',
                type: member.membershipType || 'none',
                tier: member.membershipTier || 'standard',
                memberType: member.memberType || member.registrationType || '',
                activatedAt: member.membershipActivatedAt || null,
                expiresAt: member.membershipExpiresAt || null,
                lastPaymentAmount: member.paymentAmount || 0,
                lastPaymentDate: member.lastPaymentDate || null,
            },
            application: app ? {
                reference: applicationRefFor(app),
                status: normalizeStatus(app.status),
                memberType: app.memberType || app.registrationType || '',
                submittedAt: app.submittedAt || app.createdAt || null,
                decidedAt: app.stateApprovedAt || (app.rejectedBy && app.rejectedBy.rejectedAt) || null,
            } : null,
            business: biz ? {
                doingBusiness: biz.doingBusiness === true,
                registrationType: biz.registrationType || '',
                organizationName: biz.organizationName || '',
                constitutionType: biz.constitutionType || '',
                businessTypes: list(biz.businessTypes),
                businessActivities: list(biz.businessActivities),
                commencementYear: biz.businessCommencementYear || '',
                numberOfEmployees: biz.numberOfEmployees || '',
                memberOfOtherChamber: biz.memberOfOtherChamber === true,
                otherChamber: biz.otherChamber || '',
                govtOrganizations: list(biz.govtOrganizations),
            } : null,
            declaration: decl ? {
                sisterConcerns: decl.sisterConcerns ?? '',
                companyNames: list(decl.companyNames),
                agreed: decl.agreeToDeclaration === true,
            } : null,
            history: (history || []).map(shapeRequest),
        };
    }

    async updateRequest(id, body = {}, actor = {}) {
        const row = await PlatinumRequest.findById(id);
        if (!row) throw ApiError.notFound('Request not found');
        if (body.status !== undefined) {
            if (!PlatinumRequest.STATUSES.includes(body.status)) throw ApiError.badRequest('Unknown status');
            row.status = body.status;
            row.handledBy = String(actor.email || 'Super Admin');
            row.handledAt = new Date();
        }
        if (body.notes !== undefined) row.notes = String(body.notes || '').trim().slice(0, 1000);
        await row.save();
        return shapeRequest(row.toObject());
    }

    /* ================================================================ grants */

    /** The Platinum plan's price and name, from the plan row the Super Admin edits. */
    async plan() {
        const rows = await membershipPlanService.listAll().catch(() => null);
        const list = Array.isArray(rows) ? rows : (rows && rows.plans) || [];
        const row = list.find((p) => p && (p.key === 'platinum' || p.id === 'platinum' || p.audience === 'platinum'));
        return {
            name: 'Lifetime Membership',
            price: Number((row && row.price) || 200000),
            active: row ? row.active !== false : true
        };
    }

    /** Every Platinum member, newest grant first. */
    async listMembers() {
        const rows = await MemberDetails.find({ membershipTier: 'platinum' })
            .sort({ 'platinumGrant.grantedAt': -1 }).limit(500).lean();
        const outcomes = await outcomesFor(rows.map((r) => r._id));
        return rows.map((m) => shape(m, outcomes.get(String(m._id)) || ''));
    }

    /** Find members to grant to — by name, email, phone or Member ID. */
    async search(q) {
        const text = String(q || '').trim();
        if (text.length < 2) return [];
        const rx = new RegExp(escapeRegex(text), 'i');
        const digits = text.replace(/\D/g, '');
        const or = [{ fullName: rx }, { email: rx }, { membershipNumber: rx }];
        if (digits.length >= 4) or.push({ phoneNumber: new RegExp(escapeRegex(digits)) });
        const rows = await MemberDetails.find({ $or: or }).limit(20).lean();
        const outcomes = await outcomesFor(rows.map((r) => r._id));
        return rows.map((m) => shape(m, outcomes.get(String(m._id)) || ''));
    }

    async grant(memberId, body = {}, actor = {}) {
        if (actor.role !== 'super_admin') throw ApiError.forbidden('Only the Super Admin can admit a Lifetime member.');
        let member = await MemberDetails.findById(memberId);
        if (!member) throw ApiError.notFound('Member not found');
        if (member.isActive === false || (member.role && !['member', 'business', 'student', 'aspirant'].includes(member.role))) throw ApiError.badRequest('Choose an active member account.');
        if (member.membershipTier === 'platinum') throw ApiError.badRequest('This member is already a Lifetime member.');

        const outcome = (await outcomesFor([member._id])).get(String(member._id)) || '';
        const manualAdmission = body.manualAdmission === true && outcome !== STATUS.REJECTED && String(body.note || '').trim();
        if (outcome !== STATUS.APPROVED && !isPaidStatus(member.membershipStatus) && !manualAdmission) {
            throw ApiError.badRequest(shape(member.toObject(), outcome).blockedReason
                + ' — Lifetime is granted to an approved applicant or an existing member.');
        }

        const plan = await this.plan();
        const amount = Number(body.amount);
        if (!plan.active) throw ApiError.badRequest('The Lifetime plan is not active.');
        if (!Number.isFinite(amount) || amount <= 0) throw ApiError.badRequest('Enter the actual positive amount received.');
        if (!MODES.includes(body.paymentMode)) throw ApiError.badRequest('Choose a valid payment mode.');
        const paymentMode = body.paymentMode;
        if (amount !== plan.price && !String(body.note || '').trim()) throw ApiError.badRequest('Explain why the amount received differs from the Lifetime fee.');
        const receivedOn = body.receivedOn ? new Date(body.receivedOn) : new Date();
        if (Number.isNaN(receivedOn.getTime()) || receivedOn.getTime() > Date.now()) throw ApiError.badRequest('Enter a valid payment date that is not in the future.');

        const now = new Date();
        const orderId = `OFF-${now.getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

        // The receipt, as a paid membership order — see the note at the top.
        const receipt = await PaymentOrder.create({
            orderId,
            memberId: member._id,
            email: member.email,
            planId: 'platinum',
            planName: plan.name,
            amount,
            orderType: 'membership',
            membershipType: 'lifetime',
            status: 'paid',
            provider: 'offline',
            paymentMethod: paymentMode,
            gatewayPaymentId: String(body.receiptNumber || '').trim() || orderId,
            paidAt: receivedOn,
            manualConfirmation: { by: String(actor.userId || actor.id || ''), byName: actor.email || 'Super Admin', at: now,
                note: `${manualAdmission ? 'Super Admin office admission. ' : ''}${String(body.note || '').trim()}`.slice(0, 500),
                expectedAmount: plan.price, waivedAmount: Math.max(0, plan.price - amount), receiptNumber: String(body.receiptNumber || '').trim() },
            expiresAt: now
        });

        member.platinumGrant = {
            grantedAt: now,
            grantedBy: String(actor.userId || actor.id || ''),
            grantedByName: String(actor.email || 'Super Admin'),
            amount,
            paymentMode,
            receiptNumber: String(body.receiptNumber || '').trim(),
            receivedOn,
            note: String(body.note || '').trim().slice(0, 500),
            orderId,
            previous: {
                membershipStatus: member.membershipStatus,
                membershipType: member.membershipType,
                membershipExpiresAt: member.membershipExpiresAt || null,
                membershipActivatedAt: member.membershipActivatedAt || null
            }
        };
        member.membershipTier = 'platinum';
        member.membershipStatus = 'active';
        member.membershipType = 'lifetime';
        member.membershipExpiresAt = null;
        if (!member.membershipActivatedAt) member.membershipActivatedAt = now;
        member.paymentId = orderId;
        member.paymentAmount = amount;
        member.lastPaymentDate = receivedOn;
        try {
            const saved = await MemberDetails.findOneAndUpdate({ _id: member._id, updatedAt: member.updatedAt,
                membershipTier: { $ne: 'platinum' }, isActive: { $ne: false } }, { $set: {
                platinumGrant: member.platinumGrant, membershipTier: 'platinum', membershipStatus: 'active',
                membershipType: 'lifetime', membershipExpiresAt: null, membershipActivatedAt: member.membershipActivatedAt,
                paymentId: orderId, paymentAmount: amount, lastPaymentDate: receivedOn
            } }, { new: true });
            if (!saved) throw ApiError.conflict('Member details changed or Lifetime was already granted. Refresh before trying again.');
            member = saved;
        } catch (error) {
            await PaymentOrder.updateOne({ _id: receipt._id }, { $set: { status: 'cancelled' } });
            throw error;
        }
        invalidateMemberContext(member._id);

        // ACTIV-2026-001: numbered on first activation, kept for life after.
        const assignedNumber = await require('./memberNumber').assignMembershipNumber(member).catch(() => '');
        if (assignedNumber) member.membershipNumber = assignedNumber;

        try {
            const { recordActivity } = require('./memberExtras.controller');
            await recordActivity(member._id, 'membership_activated', 'Payment', member._id,
                'Lifetime Membership granted');
        } catch { /* a feed entry is never worth failing a grant over */ }

        const ids = await require('./memberIds').idsFor(member).catch(() => ({ applicationRef: '' }));
        notificationService.dispatchInBackground('MEMBERSHIP_ACTIVATED', {
            id: member._id, name: member.fullName, email: member.email, phone: member.phoneNumber,
            whatsapp: member.whatsappNumber, state: member.state, district: member.district, block: member.block
        }, {
            membershipNumber: membershipNumberFor(member),
            applicationRef: ids.applicationRef,
            membershipType: 'lifetime',
            planName: plan.name,
            amountLabel: amount > 0 ? `₹${amount.toLocaleString('en-IN')}` : '',
            orderId,
            activatedLabel: membershipContext.dateLabel(now),
            validUntilLabel: 'Lifetime — no renewal',
            stage: 'active',
            data: { membershipType: 'lifetime', membershipTier: 'platinum', orderId }
        });

        // Their open request, if any, is now answered.
        await PlatinumRequest.updateMany(
            { memberId: String(member._id), status: { $in: OPEN } },
            { $set: { status: 'converted', handledBy: String(actor.email || 'Super Admin'), handledAt: now } }
        ).catch(() => null);

        logger.info('Lifetime Membership granted', { memberId: String(member._id), amount, paymentMode, by: actor.email });
        return shape(member.toObject(), outcome);
    }

    /** Undo a grant made in error: restore what they held, cancel the receipt. */
    async revoke(memberId, actor = {}) {
        const member = await MemberDetails.findById(memberId);
        if (!member) throw ApiError.notFound('Member not found');
        if (member.membershipTier !== 'platinum') throw ApiError.badRequest('This member is not a Lifetime member.');

        const grant = member.platinumGrant || {};
        const prev = grant.previous || {};
        if (grant.orderId) {
            await PaymentOrder.updateOne({ orderId: grant.orderId, provider: 'offline' }, { $set: { status: 'cancelled' } });
        }
        member.membershipTier = 'standard';
        member.membershipStatus = prev.membershipStatus || 'approved';
        member.membershipType = prev.membershipType || 'none';
        member.membershipExpiresAt = prev.membershipExpiresAt || null;
        member.membershipActivatedAt = prev.membershipActivatedAt || null;
        member.platinumGrant = undefined;
        member.markModified('platinumGrant');
        await member.save();
        invalidateMemberContext(member._id);

        logger.warn('Lifetime Membership revoked', { memberId: String(member._id), by: actor.email });
        const outcome = (await outcomesFor([member._id])).get(String(member._id)) || '';
        return shape(member.toObject(), outcome);
    }
}

module.exports = new PlatinumService();
module.exports.MODES = MODES;
