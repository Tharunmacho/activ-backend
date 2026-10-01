const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../../config/logger');
const ApiError = require('../../core/utils/ApiError');
const mailer = require('../../core/utils/mailer');
const Donor = require('./donor.model');
const Donation = require('./donation.model');
const PaymentOrder = require('../payment/paymentorder.model');
const { validateMobile } = require('../common/phoneNumber');
const U = require('./donation.util');

/**
 * ============================================================================
 * DONATIONS — anyone can give, every gift gets an 80G receipt, and each donor
 * gets one consolidated certificate per financial year
 * ============================================================================
 *
 *   POST /donations                   donor fills the form -> Instamojo (or mock)
 *   GET  /donations/return/:orderId   back from Instamojo -> verify -> settle
 *   webhook (payment.service)         Instamojo tells us   -> settle
 *   GET  /donations/receipt/:token    one gift's 80G receipt
 *   GET  /donations/statement/:token  the donor's year: every gift + the total
 *
 * `settleOrder` is the ONE place a donation becomes paid. The webhook and the
 * donor's browser arrive at the same moment, so it claims the row with a
 * conditional update and whichever loses answers with the settled donation.
 */

const ORG = {
    name: 'Adidravidar Confederation of Trade and Industrial Vision',
    shortName: 'ACTIV',
    pan: 'AAITA2239D',
    registration80G: 'AAITA2239DF20210'
};
const DEFAULT_ADDRESS = '6&7, Hayagreeva Apartments, 121, Velachery Road, Guindy, Chennai, Tamil Nadu 600032';

const isMockMode = () =>
    String(process.env.PAYMENT_MODE || 'mock').toLowerCase() === 'mock' &&
    String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

const str = (v, max = 200) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);
const escapeRx = (v) => String(v || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const frontendBase = () => String(config.frontendUrl || process.env.FRONTEND_URL || '').replace(/\/+$/, '');

/** The head office address from CMS -> Contact, else the known one. */
const orgWithAddress = async() => {
    let address = '';
    try {
        const { ContactSettings } = require('../cms/cms.models');
        const doc = await ContactSettings.findOne({}).select('addressLines offices').lean();
        const head = ((doc && doc.offices) || []).find((o) => o && o.isHeadOffice);
        const lines = (head && head.addressLines && head.addressLines.length ? head.addressLines : (doc && doc.addressLines)) || [];
        address = lines.map((l) => String(l || '').trim()).filter(Boolean).join(', ');
    } catch { /* fall back */ }
    return { ...ORG, address: address || DEFAULT_ADDRESS };
};

/** Next receipt number for a financial year. Atomic `$inc` on one document. */
const nextReceiptNumber = async(fy) => {
    const res = await require('../../config/dataLayout').collection('donationCounters').findOneAndUpdate(
        { _id: `donation:${fy}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    const doc = res && res.value !== undefined && res.seq === undefined ? res.value : res;
    return U.receiptNumberFor(fy, Number((doc && doc.seq) || 0));
};

/* ------------------------------------------------------------- validation */

const readForm = (body = {}) => {
    const amount = U.checkAmount(body.amount);
    if (!amount.ok) throw ApiError.badRequest(amount.error);

    const fullName = str(body.fullName, 120);
    if (fullName.length < 2) throw ApiError.badRequest('Enter the donor’s full name.');

    const email = str(body.email, 160).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw ApiError.badRequest('Enter a valid email address — the receipt is sent there.');

    const phone = validateMobile(body.phone);
    if (!phone || !phone.ok) throw ApiError.badRequest('Enter a valid 10-digit mobile number.');

    const pan = str(body.pan, 10).toUpperCase();
    if (pan && !U.isValidPan(pan)) throw ApiError.badRequest('That PAN is not valid — it looks like ABCDE1234F.');

    const a = body.address || {};
    const pincode = str(a.pincode, 10);
    if (pincode && !/^\d{6}$/.test(pincode)) throw ApiError.badRequest('Enter a 6-digit PIN code.');

    return {
        amount: amount.amount,
        donor: {
            fullName,
            email,
            phone: phone.stored || str(body.phone, 20),
            pan,
            donorType: body.donorType === 'organisation' ? 'organisation' : 'individual',
            address: {
                line1: str(a.line1, 300),
                city: str(a.city, 80),
                district: str(a.district, 80),
                state: str(a.state, 80),
                pincode
            }
        },
        message: str(body.message, 1000)
    };
};

/* ------------------------------------------------------------ the shapes */

const returnShape = async(donation) => {
    const paid = donation && donation.status === 'paid';
    const donor = paid ? await Donor.findById(donation.donorId).select('statementToken').lean().catch(() => null) : null;
    return {
        status: donation ? donation.status : 'pending',
        amount: donation ? U.toRupees(donation.amountPaise) : 0,
        receiptNumber: paid ? donation.receiptNumber || '' : '',
        receiptToken: paid ? donation.receiptToken || '' : '',
        statementToken: paid && donor ? donor.statementToken || '' : '',
        donorName: donation && donation.donorSnapshot ? donation.donorSnapshot.fullName || '' : '',
        financialYear: paid ? donation.financialYear || '' : ''
    };
};

/* ---------------------------------------------------------------- emails */

const sendReceiptEmail = async(donation) => {
    const donor = await Donor.findById(donation.donorId).lean().catch(() => null);
    const snap = donation.donorSnapshot || {};
    const to = snap.email || (donor && donor.email);
    if (!to) return { sent: false, skipped: true };
    const base = frontendBase();
    const receiptUrl = `${base}/donate/receipt/${donation.receiptToken}`;
    const statementUrl = donor ? `${base}/donate/statement/${donor.statementToken}?fy=${donation.financialYear}` : '';
    const amount = `₹${U.toRupees(donation.amountPaise).toLocaleString('en-IN')}`;
    const esc = (v) => String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const name = snap.fullName || 'Donor';

    return mailer.send({
        to,
        subject: `Thank you — your 80G receipt ${donation.receiptNumber}`,
        log: {
            event: 'DONATION_RECEIPT',
            recipientName: name,
            data: { donationId: String(donation._id || ''), receiptNumber: donation.receiptNumber, financialYear: donation.financialYear }
        },
        text: [
            `Dear ${name},`, '',
            `Thank you for your donation of ${amount} to ACTIV.`, '',
            `Receipt number: ${donation.receiptNumber}`,
            `Financial year: ${donation.financialYear}`, '',
            `Your 80G receipt: ${receiptUrl}`,
            statementUrl ? `Your ${donation.financialYear} statement (all your donations this year): ${statementUrl}` : '', '',
            'Keep these links — they are how you open your certificates at any time.', '',
            `— ${ORG.name} (ACTIV)`
        ].join('\n'),
        html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111827">
  <p>Dear ${esc(name)},</p>
  <p>Thank you for your donation of <strong>${esc(amount)}</strong> to ACTIV. It is eligible for deduction under Section 80G of the Income Tax Act, 1961.</p>
  <table style="border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:4px 16px 4px 0;color:#6B7280">Receipt number</td><td style="padding:4px 0;font-weight:600">${esc(donation.receiptNumber)}</td></tr>
    <tr><td style="padding:4px 16px 4px 0;color:#6B7280">Financial year</td><td style="padding:4px 0;font-weight:600">${esc(donation.financialYear)}</td></tr>
  </table>
  <p style="margin:24px 0">
    <a href="${esc(receiptUrl)}" style="background:#1D4ED8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">View your 80G receipt</a>
  </p>
  ${statementUrl ? `<p>All your donations for ${esc(donation.financialYear)}, with the year's total, are on <a href="${esc(statementUrl)}">your annual statement</a>. After 31 March it becomes your final certificate for the year.</p>` : ''}
  <p style="color:#6B7280;font-size:13px">Keep this email — these links are how you open your certificates at any time.</p>
  <p style="color:#6B7280;font-size:13px">— ${esc(ORG.name)} (ACTIV)</p>
</div>`
    });
};

const sendStatementEmail = async(donor, fy) => {
    const url = `${frontendBase()}/donate/statement/${donor.statementToken}?fy=${fy}`;
    const esc = (v) => String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return mailer.send({
        to: donor.email,
        subject: `Your ACTIV donation certificate for ${fy}`,
        log: { event: 'DONATION_STATEMENT', recipientName: donor.fullName, data: { donorId: String(donor._id || ''), financialYear: fy } },
        text: `Dear ${donor.fullName},\n\nThe ${fy} financial year has ended. Your consolidated 80G donation certificate, listing every donation you made to ACTIV in ${fy} and the total, is ready:\n${url}\n\nThank you for your support.\n\n— ${ORG.name} (ACTIV)`,
        html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111827">
  <p>Dear ${esc(donor.fullName)},</p>
  <p>The ${esc(fy)} financial year has ended. Your consolidated 80G donation certificate — every donation you made to ACTIV in ${esc(fy)}, and the total — is ready.</p>
  <p style="margin:24px 0"><a href="${esc(url)}" style="background:#1D4ED8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">Open your ${esc(fy)} certificate</a></p>
  <p>Thank you for your support.</p>
  <p style="color:#6B7280;font-size:13px">— ${esc(ORG.name)} (ACTIV)</p>
</div>`
    });
};

/* ---------------------------------------------------------------- service */

class DonationService {
    isMockMode() { return isMockMode(); }

    /** POST /donations */
    async create(body = {}, { origin = '' } = {}) {
        const form = readForm(body);
        const paymentService = require('../payment/payment.service');
        const gateway = paymentService.isConfigured();
        if (!gateway && !isMockMode()) {
            throw ApiError.badRequest('Online donations are not available right now. Please contact the ACTIV office.');
        }

        // Same donor = same email; their details are refreshed to the latest given.
        const donor = await Donor.findOneAndUpdate(
            { email: form.donor.email },
            {
                $set: {
                    fullName: form.donor.fullName,
                    phone: form.donor.phone,
                    donorType: form.donor.donorType,
                    address: form.donor.address,
                    // A PAN, once given, is not erased by a later gift that omits it.
                    ...(form.donor.pan ? { pan: form.donor.pan } : {})
                },
                $setOnInsert: { email: form.donor.email, statementToken: crypto.randomBytes(16).toString('hex') }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const orderId = 'ord_' + crypto.randomBytes(16).toString('hex');
        const donation = await Donation.create({
            donorId: donor._id,
            amountPaise: U.toPaise(form.amount),
            status: 'pending',
            donorSnapshot: { ...form.donor, pan: form.donor.pan || donor.pan || '' },
            message: form.message,
            orderId
        });

        let paymentUrl = '';
        let requestId = '';
        if (gateway) {
            // Back to the site they gave from — same rule as payment.routes.
            const trusted = ((config.cors && config.cors.origin) || []).map((o) => String(o).trim().replace(/\/+$/, ''));
            const o = String(origin || '').trim().replace(/\/+$/, '');
            const siteBase = (o && trusted.includes(o)) ? o : frontendBase();
            try {
                const result = await paymentService.createPaymentRequest({
                    amount: form.amount,
                    purpose: 'ACTIV Donation',
                    buyerName: form.donor.fullName,
                    email: form.donor.email,
                    phone: form.donor.phone,
                    redirectUrl: `${siteBase}/donate/thank-you?orderId=${encodeURIComponent(orderId)}`,
                    webhookUrl: require('../../config/publicUrl').instamojoWebhookUrl()
                });
                paymentUrl = result.payment_url || '';
                requestId = result.payment_request_id || '';
            } catch (error) {
                await Donation.updateOne({ _id: donation._id }, { $set: { status: 'failed' } }).catch(() => null);
                throw error;
            }
        }

        await PaymentOrder.create({
            orderId,
            email: form.donor.email,
            amount: form.amount,
            orderType: 'donation',
            donationId: donation._id,
            provider: gateway ? 'instamojo' : 'mock',
            gatewayPaymentId: requestId || undefined,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000)
        });

        return {
            donationId: String(donation._id),
            orderId,
            amount: form.amount,
            paymentUrl,
            mock: !gateway
        };
    }

    /**
     * THE one place a donation becomes paid. Idempotent: the losing caller
     * (webhook vs return page) finds it already paid and returns it.
     */
    async settleOrder(order, paymentId = '', mode = 'online') {
        if (!order) throw ApiError.notFound('No such donation order');
        const donationId = order.donationId;
        const now = new Date();
        const fy = U.financialYearOf(now);

        const current = await Donation.findById(donationId);
        if (!current) throw ApiError.notFound('No such donation');
        if (current.status === 'paid') return current;

        // Claim first, number second: a number is consumed only by the winner.
        const claimed = await Donation.findOneAndUpdate(
            { _id: donationId, status: { $ne: 'paid' } },
            {
                $set: {
                    status: 'paid',
                    paidAt: now,
                    financialYear: fy,
                    paymentMode: mode === 'mock' ? 'mock' : 'online',
                    gatewayPaymentId: str(paymentId, 100)
                }
            },
            { new: true }
        );
        if (!claimed) return Donation.findById(donationId);

        claimed.receiptNumber = await nextReceiptNumber(fy);
        await claimed.save();

        await PaymentOrder.updateOne(
            { _id: order._id },
            { $set: { status: 'paid', paidAt: now, paymentMethod: mode === 'mock' ? 'mock' : 'instamojo' } }
        ).catch(() => null);

        logger.info('Donation received', {
            receiptNumber: claimed.receiptNumber, amount: U.toRupees(claimed.amountPaise), mode
        });

        sendReceiptEmail(claimed).then((r) => {
            if (r && !r.sent) logger.warn('Donation receipt email not sent', { receiptNumber: claimed.receiptNumber, error: r.error });
        }).catch(() => null);

        return claimed;
    }

    async orderFor(orderId) {
        const order = await PaymentOrder.findOne({ orderId: str(orderId, 100), orderType: 'donation' });
        if (!order) throw ApiError.notFound('No such donation order');
        return order;
    }

    /** POST /donations/mock-complete/:orderId */
    async mockComplete(orderId) {
        if (!isMockMode()) throw ApiError.forbidden('Test payments are disabled. Complete the payment through the gateway.');
        const order = await this.orderFor(orderId);
        const donation = await this.settleOrder(order, 'pay_mock_' + crypto.randomBytes(8).toString('hex'), 'mock');
        return returnShape(donation);
    }

    /** GET /donations/return/:orderId */
    async resolveReturn(orderId, { paymentId = '', gatewayStatus = '' } = {}) {
        const order = await this.orderFor(orderId);
        let donation = await Donation.findById(order.donationId);
        if (donation && donation.status === 'pending' && String(gatewayStatus).toLowerCase() !== 'failed') {
            const requestId = String(order.gatewayPaymentId || '');
            if (requestId) {
                const paymentService = require('../payment/payment.service');
                const verdict = await paymentService.verifyPaymentWithGateway(requestId, str(paymentId, 100), order.amount);
                if (verdict.paid) donation = await this.settleOrder(order, verdict.paymentId, 'online');
            }
        }
        return returnShape(donation);
    }

    /** GET /donations/receipt/:token */
    async receipt(token) {
        const donation = await Donation.findOne({ receiptToken: str(token, 64), status: 'paid' }).lean();
        if (!donation) throw ApiError.notFound('No such receipt');
        const donor = await Donor.findById(donation.donorId).select('statementToken').lean().catch(() => null);
        const amount = U.toRupees(donation.amountPaise);
        return {
            receiptNumber: donation.receiptNumber,
            financialYear: donation.financialYear,
            paidAt: donation.paidAt,
            amount,
            amountInWords: U.amountInWords(amount),
            paymentMode: donation.paymentMode,
            gatewayPaymentId: donation.gatewayPaymentId || '',
            message: donation.message || '',
            donor: donation.donorSnapshot || {},
            org: await orgWithAddress(),
            statementToken: donor ? donor.statementToken : ''
        };
    }

    /** GET /donations/statement/:token?fy= */
    async statement(token, fy = '') {
        const donor = await Donor.findOne({ statementToken: str(token, 64) }).lean();
        if (!donor) throw ApiError.notFound('No such statement');

        const years = (await Donation.distinct('financialYear', { donorId: donor._id, status: 'paid' }))
            .filter(U.isFinancialYear).sort().reverse();
        if (!years.length) throw ApiError.notFound('No donations on this statement yet');

        const year = U.isFinancialYear(fy) && years.includes(fy) ? fy : years[0];
        const bounds = U.financialYearBounds(year);
        const rows = await Donation.find({ donorId: donor._id, status: 'paid', financialYear: year })
            .sort({ paidAt: 1 }).lean();
        const donations = rows.map((d) => ({
            receiptNumber: d.receiptNumber,
            paidAt: d.paidAt,
            amount: U.toRupees(d.amountPaise),
            paymentMode: d.paymentMode
        }));
        const totalPaise = rows.reduce((sum, d) => sum + (d.amountPaise || 0), 0);
        const total = U.toRupees(totalPaise);

        return {
            financialYear: year,
            fyStart: bounds.start,
            fyEnd: new Date(bounds.end.getTime() - 1),
            isFinal: U.financialYearEnded(year),
            generatedAt: new Date(),
            statementNumber: U.statementNumberFor(year, donor._id),
            donor: {
                fullName: donor.fullName,
                email: donor.email,
                phone: donor.phone,
                pan: donor.pan,
                donorType: donor.donorType,
                address: donor.address || {}
            },
            donations,
            total,
            totalInWords: U.amountInWords(total),
            availableYears: years,
            org: await orgWithAddress()
        };
    }

    /* ------------------------------------------------------ super admin */

    async summary(fy = '') {
        const years = (await Donation.distinct('financialYear', { status: 'paid' }))
            .filter(U.isFinancialYear).sort().reverse();
        const match = { status: 'paid', ...(U.isFinancialYear(fy) ? { financialYear: fy } : {}) };
        const [agg] = await Donation.aggregate([
            { $match: match },
            { $group: { _id: null, total: { $sum: '$amountPaise' }, count: { $sum: 1 }, donors: { $addToSet: '$donorId' } } }
        ]);
        // The IST month, whatever the server's TZ.
        const monthStart = U.istMonthStart();
        const [month] = await Donation.aggregate([
            { $match: { status: 'paid', paidAt: { $gte: monthStart } } },
            { $group: { _id: null, total: { $sum: '$amountPaise' } } }
        ]);
        return {
            financialYears: years,
            fy: U.isFinancialYear(fy) ? fy : '',
            totalAmount: U.toRupees(agg ? agg.total : 0),
            donationCount: agg ? agg.count : 0,
            donorCount: agg ? agg.donors.length : 0,
            thisMonthAmount: U.toRupees(month ? month.total : 0)
        };
    }

    async listDonors({ fy = '', q = '', page = 1, limit = 25 } = {}) {
        const p = Math.max(1, parseInt(page, 10) || 1);
        const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
        const donorMatch = {};
        const term = str(q, 80);
        if (term) {
            const rx = new RegExp(escapeRx(term), 'i');
            donorMatch.$or = [{ fullName: rx }, { email: rx }, { phone: rx }, { pan: rx }];
        }
        const inYear = U.isFinancialYear(fy);

        const pipeline = [
            { $match: donorMatch },
            {
                $lookup: {
                    from: 'donations',
                    let: { id: '$_id' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$donorId', '$$id'] }, status: 'paid' } },
                        { $project: { amountPaise: 1, paidAt: 1, financialYear: 1 } }
                    ],
                    as: 'paid'
                }
            },
            {
                $addFields: {
                    inScope: inYear
                        ? { $filter: { input: '$paid', as: 'd', cond: { $eq: ['$$d.financialYear', fy] } } }
                        : '$paid'
                }
            },
            // A donor appears once they have given at least once (in the year, when filtered).
            { $match: { 'inScope.0': { $exists: true } } },
            {
                $project: {
                    fullName: 1, email: 1, phone: 1, pan: 1, address: 1, statementToken: 1,
                    donationCount: { $size: '$inScope' },
                    totalPaise: { $sum: '$inScope.amountPaise' },
                    allTimePaise: { $sum: '$paid.amountPaise' },
                    lastDonationAt: { $max: '$paid.paidAt' }
                }
            },
            { $sort: { lastDonationAt: -1 } },
            { $facet: { rows: [{ $skip: (p - 1) * l }, { $limit: l }], total: [{ $count: 'n' }] } }
        ];
        const [out] = await Donor.aggregate(pipeline);
        const rows = ((out && out.rows) || []).map((d) => ({
            id: String(d._id),
            fullName: d.fullName || '',
            email: d.email || '',
            phone: d.phone || '',
            pan: d.pan || '',
            city: (d.address && d.address.city) || '',
            district: (d.address && d.address.district) || '',
            state: (d.address && d.address.state) || '',
            donationCount: d.donationCount || 0,
            totalAmount: U.toRupees(d.totalPaise),
            allTimeAmount: U.toRupees(d.allTimePaise),
            lastDonationAt: d.lastDonationAt || null,
            statementToken: d.statementToken || ''
        }));
        return { rows, total: (out && out.total && out.total[0] && out.total[0].n) || 0 };
    }

    async getDonor(id) {
        if (!mongoose.Types.ObjectId.isValid(id)) throw ApiError.badRequest('Invalid donor id');
        const donor = await Donor.findById(id).lean();
        if (!donor) throw ApiError.notFound('Donor not found');
        const rows = await Donation.find({ donorId: donor._id }).sort({ createdAt: -1 }).lean();
        const byYearMap = {};
        rows.filter((d) => d.status === 'paid').forEach((d) => {
            const k = d.financialYear || '';
            byYearMap[k] = byYearMap[k] || { financialYear: k, totalPaise: 0, count: 0 };
            byYearMap[k].totalPaise += d.amountPaise || 0;
            byYearMap[k].count += 1;
        });
        return {
            donor: { ...donor, id: String(donor._id) },
            donations: rows.map((d) => ({
                id: String(d._id),
                receiptNumber: d.receiptNumber || '',
                amount: U.toRupees(d.amountPaise),
                status: d.status,
                paidAt: d.paidAt,
                createdAt: d.createdAt,
                financialYear: d.financialYear || '',
                message: d.message || '',
                paymentMode: d.paymentMode || '',
                receiptToken: d.status === 'paid' ? d.receiptToken : ''
            })),
            byYear: Object.values(byYearMap)
                .sort((a, b) => String(b.financialYear).localeCompare(String(a.financialYear)))
                .map((y) => ({ financialYear: y.financialYear, total: U.toRupees(y.totalPaise), count: y.count }))
        };
    }

    async listDonations({ fy = '', status = '', page = 1, limit = 25 } = {}) {
        const p = Math.max(1, parseInt(page, 10) || 1);
        const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
        const filter = {};
        if (U.isFinancialYear(fy)) filter.financialYear = fy;
        if (['pending', 'paid', 'failed'].includes(status)) filter.status = status;
        const [rows, total] = await Promise.all([
            Donation.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
            Donation.countDocuments(filter)
        ]);
        return {
            rows: rows.map((d) => ({
                id: String(d._id),
                receiptNumber: d.receiptNumber || '',
                amount: U.toRupees(d.amountPaise),
                status: d.status,
                paidAt: d.paidAt,
                createdAt: d.createdAt,
                financialYear: d.financialYear || '',
                message: d.message || '',
                paymentMode: d.paymentMode || '',
                receiptToken: d.status === 'paid' ? d.receiptToken : '',
                donorId: String(d.donorId),
                donorName: (d.donorSnapshot && d.donorSnapshot.fullName) || '',
                donorEmail: (d.donorSnapshot && d.donorSnapshot.email) || ''
            })),
            total
        };
    }

    async resend(id) {
        if (!mongoose.Types.ObjectId.isValid(id)) throw ApiError.badRequest('Invalid donation id');
        const donation = await Donation.findById(id).lean();
        if (!donation) throw ApiError.notFound('Donation not found');
        if (donation.status !== 'paid') throw ApiError.badRequest('Only a paid donation has a receipt to send.');
        const result = await sendReceiptEmail(donation);
        if (!result || !result.sent) {
            throw ApiError.badRequest(`The receipt email could not be sent${result && result.error ? `: ${result.error}` : ''}.`);
        }
        return { sent: true, to: (donation.donorSnapshot && donation.donorSnapshot.email) || '' };
    }

    /* ------------------------------------------------------- year end */

    /**
     * From 1 April, email each donor who gave in the year just ended their
     * final certificate — once. The FY is claimed on the donor BEFORE sending,
     * so two server instances cannot both send it.
     */
    async sendYearEndStatements(now = new Date()) {
        const current = U.financialYearOf(now);
        const start = Number(current.slice(0, 4)) - 1;
        const previous = `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
        const donorIds = await Donation.distinct('donorId', { status: 'paid', financialYear: previous });
        let sent = 0;
        for (const id of donorIds) {
            const claimed = await Donor.findOneAndUpdate(
                { _id: id, statementsSent: { $ne: previous } },
                { $addToSet: { statementsSent: previous } },
                { new: true }
            ).lean().catch(() => null);
            if (!claimed) continue;
            const r = await sendStatementEmail(claimed, previous).catch((e) => ({ sent: false, error: e.message }));
            if (r && r.sent) sent++;
            else logger.warn('Year-end donation statement not sent', { donor: String(id), fy: previous, error: r && r.error });
        }
        if (sent) logger.info('Year-end donation statements sent', { fy: previous, count: sent });
        return sent;
    }

    start() {
        if (this.timer) return;
        if (String(process.env.DONATION_STATEMENTS || 'true').toLowerCase() === 'false') return;
        const tick = () => this.sendYearEndStatements().catch((error) =>
            logger.warn('Donation statement sweep failed', { error: error && error.message }));
        this.timer = setInterval(tick, 24 * 60 * 60 * 1000);
        if (this.timer.unref) this.timer.unref();
        const first = setTimeout(tick, 2 * 60 * 1000);
        if (first.unref) first.unref();
    }
}

module.exports = new DonationService();
module.exports.sendReceiptEmail = sendReceiptEmail;
module.exports.sendStatementEmail = sendStatementEmail;
