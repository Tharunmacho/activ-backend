const Member = require('./memberdetails.model');
const Auth = require('../auth/auth.model');
const Personal = require('./personalinfo1.model');
const Application = require('../applications/application.model');
const ApiError = require('../../core/utils/ApiError');
const { validateMobile } = require('../common/phoneNumber');
const { invalidateMemberContext } = require('../common/memberContext');

// Credential documents have independent IDs. Always resolve them through the
// stored email, never the JWT/profile ID or an email supplied by the caller.
async function update(member, body, { admin = false } = {}) {
    const oldEmail = member.email;
    const email = body.email === undefined ? oldEmail : String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest('Enter a valid email address.');
    const changes = { email };
    for (const key of ['phoneNumber', 'whatsappNumber']) {
        if (body[key] === undefined) continue;
        const number = validateMobile(body[key], { label: key === 'phoneNumber' ? 'Phone number' : 'WhatsApp number' });
        if (!number.ok) throw ApiError.badRequest(number.reason);
        changes[key] = number.stored;
    }
    const password = body.password;
    if (password !== undefined && password !== '') {
        if (typeof password !== 'string' || password.length < 6) throw ApiError.badRequest('Password must be at least 6 characters.');
        if (!admin && password !== body.confirmPassword) throw ApiError.badRequest('Passwords do not match.');
    }
    let auth = await Auth.findOne({ email: oldEmail }).select('+password +resetPasswordToken +resetPasswordExpires');
    const creatingAuth = !auth;
    if (!auth && admin && password) auth = new Auth({ email: oldEmail, password, isActive: member.isActive !== false });
    if (!auth) throw ApiError.conflict('This account has no login record. A Super Admin must save a new password to restore sign-in.');
    if (password && !admin && !await auth.comparePassword(body.currentPassword || '')) throw ApiError.badRequest('Current password is incorrect.');
    if (email !== oldEmail) {
        const [profileTaken, loginTaken] = await Promise.all([
            Member.exists({ email, _id: { $ne: member._id } }), Auth.exists({ email, _id: { $ne: auth._id } }),
        ]);
        if (profileTaken || loginTaken) throw ApiError.conflict('Email already in use.');
    }
    if (changes.phoneNumber && changes.phoneNumber !== member.phoneNumber) {
        const digits = changes.phoneNumber.replace(/\D/g, '');
        if (await Member.exists({ _id: { $ne: member._id }, phoneNumber: new RegExp(`${digits}$`) })) throw ApiError.conflict('Phone number already in use.');
    }
    const previous = Object.fromEntries(Object.keys(changes).map(key => [key, member[key]]));
    Object.assign(member, changes);
    await member.validate();
    const oldAuth = { email: auth.email, password: auth.password, resetPasswordToken: auth.resetPasswordToken, resetPasswordExpires: auth.resetPasswordExpires };
    const credentialsChanged = creatingAuth || email !== oldEmail || Boolean(password);
    if (credentialsChanged) {
        auth.email = email;
        if (password) auth.password = password; // hashed exactly once by pre-save
        auth.resetPasswordToken = undefined;
        auth.resetPasswordExpires = undefined;
        try { await auth.save(); }
        catch (error) { Object.assign(member, previous); throw error; }
    }
    try { await member.save(); }
    catch (error) {
        // Dokploy also runs standalone Mongo: compensate without rehashing the
        // previous hash, and only if this write still owns the credential state.
        if (creatingAuth) {
            await Auth.deleteOne({ _id: auth._id, email, password: auth.password });
        } else if (credentialsChanged) {
            const set = { email: oldAuth.email, password: oldAuth.password };
            const unset = {};
            for (const key of ['resetPasswordToken', 'resetPasswordExpires']) {
                if (oldAuth[key] === undefined) unset[key] = '';
                else set[key] = oldAuth[key];
            }
            await Auth.updateOne({ _id: auth._id, email, password: auth.password }, { $set: set, $unset: unset });
        }
        Object.assign(member, previous);
        throw error;
    }
    await invalidateMemberContext(member._id);
    const cache = require('../../core/cache/cacheClient');
    const { CACHE_KEYS } = require('../../core/cache/cacheKeys');
    await Promise.all([cache.del(CACHE_KEYS.USER(String(member._id))), cache.del(CACHE_KEYS.MEMBER(String(member._id)))]);
    await Promise.all([
        Personal.updateOne({ userId: member._id }, { $set: { phoneNumber: member.phoneNumber } }),
        Application.updateMany({ userId: member._id }, { $set: {
            email: member.email, 'data.personalDetails.email': member.email,
            'data.personalDetails.phoneNumber': member.phoneNumber,
            'data.personalDetails.whatsappNumber': member.whatsappNumber || '',
        } }),
    ]);
    return member;
}
module.exports = { update };
