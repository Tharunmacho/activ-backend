const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const config = require('../../config');
const ApiError = require('../../core/utils/ApiError');
const cache = require('../../core/cache/cacheClient');
const mailer = require('../../core/utils/mailer');
const Flow = require('./oauthFlow.model');
const Identity = require('./oauthIdentity.model');
const Auth = require('./auth.model');
const Member = require('../members/memberdetails.model');
const admins = require('../admin/admin.repository');
const PROVIDERS = ['google', 'facebook', 'linkedin'];
const TTL = 10 * 60;
const expired = () => ApiError.unauthorized('That sign-in has expired or has already been used. Please try again.');
const emailSchema = Joi.string().email({ tlds: { allow: false } }).max(254);
const cleanEmail = value => typeof value === 'string' && !emailSchema.validate(value.trim()).error ? value.trim().toLowerCase() : '';
const active = id => ({ _id: id, usedAt: null, expiresAt: { $gt: new Date() } });
const hashOtp = (id, email, otp) => crypto.createHmac('sha256', config.jwt.secret).update(`${id}\n${email}\n${otp}`).digest('hex');

async function create(provider, who) {
    const subject = typeof who?.subject === 'string' ? who.subject.trim() : '';
    if (!PROVIDERS.includes(provider) || !subject || subject.length > 255) throw ApiError.unauthorized('The provider did not identify this account. Please try again.');
    const linked = await Identity.findOne({ provider, subject }).select('authId').lean();
    const id = crypto.randomBytes(24).toString('hex');
    await Flow.create({ _id: id, provider, subject, linkedAuthId: linked?.authId || null, email: cleanEmail(who.email), verified: who.verified === true,
        name: String(who.name || '').trim().slice(0, 150), expiresAt: new Date(Date.now() + TTL * 1000) });
    return jwt.sign({ t: 'oauth-handoff', p: provider, jti: id }, config.jwt.secret, { expiresIn: TTL });
}
async function read(code) {
    let claims;
    try { claims = jwt.verify(String(code || ''), config.jwt.secret); } catch { throw expired(); }
    if (claims?.t !== 'oauth-handoff' || !PROVIDERS.includes(claims.p) || typeof claims.jti !== 'string') throw expired();
    const flow = await Flow.findOne({ ...active(claims.jti), provider: claims.p }).lean();
    if (!flow) throw expired();
    return flow;
}
async function requestEmail(code, inputEmail) {
    const flow = await read(code);
    const remaining = Math.floor((new Date(flow.expiresAt).getTime() - Date.now()) / 1000);
    if (remaining < 60) throw expired();
    const email = cleanEmail(inputEmail);
    if (!email) throw ApiError.badRequest('Enter a valid email address for your ACTIV account.');
    // A pending OAuth flow never proves ownership of a typed or provider email.
    // Limit both the signed flow and recipient; no code or token is logged/copied.
    const recent = await Flow.countDocuments({ otpEmail: email, lastSentAt: { $gt: new Date(Date.now() - 60 * 60 * 1000) } });
    if (recent >= 5 || !await cache.claim(`oauth:mail:${crypto.createHash('sha256').update(email).digest('hex')}`, 1, 60)) {
        throw new ApiError(429, 'Please wait before requesting another verification code.');
    }
    const otp = String(crypto.randomInt(100000, 1000000));
    const now = new Date();
    const reserved = await Flow.findOneAndUpdate({ ...active(flow._id), attempts: { $lt: 5 }, sendCount: { $lt: 3 },
        $or: [{ lastSentAt: null }, { lastSentAt: { $lte: new Date(now.getTime() - 60000) } }] },
    { $set: { otpEmail: email, otpHash: hashOtp(flow._id, email, otp), lastSentAt: now }, $inc: { sendCount: 1 } }, { new: true }).lean();
    if (!reserved) throw new ApiError(429, 'Please wait before requesting another code, or start sign-in again.');
    const delivery = await mailer.send({ to: email, privateRecipientOnly: true, subject: 'Your ACTIV sign-in verification code',
        text: `Your ACTIV verification code is ${otp}.\n\nEnter it only in the ACTIV sign-in screen you opened. It expires in ${Math.max(1, Math.floor(remaining / 60))} minutes and can be used once. Never share this code.\n\nIf you did not request this sign-in, ignore this email. Your account has not been changed.`,
        log: { event: 'SOCIAL_EMAIL_VERIFICATION', data: { provider: flow.provider } } });
    if (!delivery?.sent) {
        await Flow.updateOne({ _id: flow._id, otpHash: reserved.otpHash }, { $set: { otpHash: '' } });
        throw new ApiError(503, 'We could not send the verification email. Please try again shortly.');
    }
    return { sent: true, email, expiresInSeconds: Math.max(0, Math.floor((new Date(flow.expiresAt).getTime() - Date.now()) / 1000)) };
}
async function accountFor(flow, email, expectedLinkedAuthId) {
    const linked = await Identity.findOne({ provider: flow.provider, subject: flow.subject }).lean();
    // Deletion can complete after exchange consumed the flow but before this
    // lookup. A previously linked callback must never recreate that account.
    if (expectedLinkedAuthId && String(linked?.authId || '') !== String(expectedLinkedAuthId)) {
        throw ApiError.unauthorized('This linked ACTIV account is unavailable. Please start sign-in again.');
    }
    if (linked) {
        const auth = await Auth.findById(linked.authId).select('email isActive').lean();
        if (!auth) throw ApiError.unauthorized('This linked ACTIV account is unavailable. Please contact support.');
        return auth;
    }
    let auth = await Auth.findOne({ email }).select('email isActive').lean();
    if (!auth && await admins.findRawByEmail(email)) throw ApiError.forbidden('Administrators sign in with their email and password on the admin login page.');
    let profile = await Member.findOne({ email });
    if (auth?.isActive === false || profile?.isActive === false) throw ApiError.forbidden('Your account has been blocked by the organisation. Please contact ACTIV administration.');
    if (auth && !profile) throw ApiError.unauthorized('Your ACTIV profile is unavailable. Please contact support.');
    if (profile && /admin/i.test(String(profile.role || ''))) throw ApiError.forbidden('Administrators sign in on the admin login page.');
    let createdProfile = false;
    if (!auth) {
        if (!profile) {
            try {
                profile = await Member.create({ email, fullName: flow.name || '', phoneNumber: '', state: '', district: '', block: '',
                    registrationIncomplete: true, role: 'member', isActive: true, profileCompleted: false, membershipStatus: 'pending', membershipType: 'none' });
                createdProfile = true;
            } catch (error) {
                if (error?.code !== 11000) throw error;
                profile = await Member.findOne({ email });
                if (!profile || profile.isActive === false) throw ApiError.forbidden('This account is unavailable. Please contact ACTIV administration.');
            }
        }
        try {
            auth = await Auth.create({ email, passwordLoginEnabled: false, isActive: true });
        } catch (error) {
            if (error?.code === 11000) auth = await Auth.findOne({ email }).select('email isActive').lean();
            if (!auth) {
                if (createdProfile && !await Auth.exists({ email })) await Member.deleteOne({ _id: profile._id });
                throw error;
            }
        }
    }
    if (auth.isActive === false) throw ApiError.forbidden('Your account has been blocked by the organisation. Please contact ACTIV administration.');
    try { await Identity.create({ provider: flow.provider, subject: flow.subject, authId: auth._id }); }
    catch (error) {
        if (error?.code !== 11000) throw error;
        const winner = await Identity.findOne({ provider: flow.provider, subject: flow.subject }).lean();
        if (String(winner?.authId || '') !== String(auth._id)) throw ApiError.conflict('This social account is already linked to another ACTIV account.');
    }
    if (createdProfile) await require('../notifications/notification.service').dispatchInBackground('ACCOUNT_REGISTERED', {
        id: profile._id, name: profile.fullName, email: profile.email,
    });
    return auth;
}
async function exchange(code, input = {}) {
    const flow = await read(code);
    const linked = await Identity.findOne({ provider: flow.provider, subject: flow.subject }).lean();
    if (flow.linkedAuthId && String(linked?.authId || '') !== String(flow.linkedAuthId)) {
        throw ApiError.unauthorized('This linked ACTIV account is unavailable. Please start sign-in again.');
    }
    let email = flow.verified ? flow.email : '';
    let match = active(flow._id);
    if (!linked && !email) {
        if (!input.verificationCode) return { requiresEmailVerification: true, email: flow.email, provider: flow.provider };
        const attempted = await Flow.findOneAndUpdate({ ...active(flow._id), attempts: { $lt: 5 }, otpHash: { $ne: '' } },
            { $inc: { attempts: 1 } }, { new: true }).lean();
        const otp = String(input.verificationCode || '').trim();
        if (!attempted || !/^\d{6}$/.test(otp) || !attempted.otpEmail
            || !crypto.timingSafeEqual(Buffer.from(attempted.otpHash, 'hex'), Buffer.from(hashOtp(flow._id, attempted.otpEmail, otp), 'hex'))) {
            throw ApiError.badRequest('That verification code is incorrect or expired. Please try again or restart sign-in.');
        }
        email = attempted.otpEmail;
        match = { ...match, otpHash: attempted.otpHash };
    }
    // Mongo makes the handoff single-use across workers even without Redis.
    if (!await Flow.findOneAndUpdate(match, { $set: { usedAt: new Date(), otpHash: '' } })) throw expired();
    const auth = await accountFor(flow, email, linked?.authId || flow.linkedAuthId);
    if (auth.isActive === false) throw ApiError.forbidden('Your account has been blocked by the organisation. Please contact ACTIV administration.');
    const session = await require('./auth.service').memberSession(auth.email, 'member', flow.provider);
    if (!session) throw ApiError.unauthorized('Your ACTIV profile is unavailable. Please contact support.');
    return session;
}
module.exports = { create, exchange, requestEmail, cleanEmail };
