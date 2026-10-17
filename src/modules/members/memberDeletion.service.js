const mongoose = require('mongoose');
const Member = require('./memberdetails.model');
const Auth = require('../auth/auth.model');
const ApiError = require('../../core/utils/ApiError');
const layout = require('../../config/dataLayout');
const cache = require('../../core/cache/cacheClient');
const { CACHE_KEYS } = require('../../core/cache/cacheKeys');
const { invalidateMemberContext } = require('../common/memberContext');

const memberRoles = { $nin: ['super_admin', 'state_admin', 'district_admin', 'block_admin', 'cms_admin', 'events_admin', 'admin'] };
const collection = name => {
    const [area, table] = layout.MODELS[name];
    return mongoose.connection.getClient().db(layout.dbName(area)).collection(table);
};
const validId = value => {
    if (!mongoose.isValidObjectId(value)) throw ApiError.badRequest('Invalid member reference.');
    return new mongoose.Types.ObjectId(String(value));
};

/** Called only after authorization, or to finish an already-authorized deletion.
 * The profile holds its unique email until every dependent write succeeds.
 * A partial failure is retryable and never reported as a completed deletion.
 * The final operation physically deletes the profile; no archive copy is made.
 */
async function purgeMember(id, actor = {}) {
    const _id = validId(id);
    let member = await Member.collection.findOne({ _id, role: memberRoles });
    if (!member) {
        if (await Member.collection.findOne({ _id }, { projection: { _id: 1 } })) {
            throw ApiError.forbidden('Administrator accounts cannot be deleted from membership records.');
        }
        await invalidateMemberContext(String(_id));
        await cache.del(CACHE_KEYS.USER(String(_id)));
        await cache.delPattern(CACHE_KEYS.PATTERNS.APPLICATION);
        await cache.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD);
        return { id: String(_id), deleted: true, removed: {} };
    }
    if (member.deletionAuthId === undefined) {
        const credential = await Auth.findOne({ email: member.email }).select('_id').lean();
        await Member.collection.updateOne({ _id, email: member.email, role: memberRoles, deletionAuthId: { $exists: false } }, {
            $set: { deletionAuthId: credential?._id || null, deletedAt: member.deletedAt || new Date(),
                deletedBy: String(actor.userId || actor.id || actor._id || member.deletedBy || ''),
                isActive: false, membershipStatus: 'cancelled' }
        });
        // Never delete credentials using an email lookup after this point: a
        // concurrent retry could otherwise remove a fresh registration's login.
        member = await Member.collection.findOne({ _id, role: memberRoles });
        if (!member) return { id: String(_id), deleted: true, removed: {} };
    } else {
        await Member.collection.updateOne({ _id }, { $set: { deletedAt: member.deletedAt || new Date(), isActive: false, membershipStatus: 'cancelled' } });
    }
    await invalidateMemberContext(String(_id));
    await cache.del(CACHE_KEYS.USER(String(_id)));
    const strings = [...new Set([_id, member.deletionAuthId].filter(Boolean).map(String))];
    const owner = { $in: [...strings, ...strings.filter(value => mongoose.isValidObjectId(value)).map(value => new mongoose.Types.ObjectId(value))] };
    // Keep only the counter/ID reservation, never a member archive. Issued IDs
    // must not be reassigned to a different person later.
    const numbers = require('./memberNumber');
    for (const number of new Set([member.membershipNumber, ...(member.legacyMembershipNumbers || [])].filter(Boolean))) {
        await numbers.reserveMembershipNumber(member, number);
    }
    const companies = await collection('Company').find({ userId: owner }, { projection: { _id: 1 } }).toArray();
    const companyIds = { $in: companies.map(row => row._id) };
    const conversations = await collection('Conversation').find({ participants: owner }, { projection: { _id: 1 } }).toArray();
    const removed = {};
    const drop = async (name, filter) => { removed[name] = (await collection(name).deleteMany(filter)).deletedCount; };
    // Dependency-first writes work on standalone MongoDB too. Any failure
    // propagates, leaving the locked root available for a safe retry.
    await drop('Message', { $or: [{ conversationId: { $in: conversations.map(row => row._id) } }, { senderId: owner }] });
    await drop('Conversation', { participants: owner });
    await drop('Connection', { $or: [{ senderId: owner }, { recipientId: owner }] });
    await drop('PushDevice', { user: owner });
    await drop('TrustedCompany', { $or: [{ userId: owner }, { companyId: companyIds }] });
    await drop('StockMovement', { $or: [{ userId: owner }, { companyId: companyIds }] });
    await drop('Product', { $or: [{ userId: owner }, { companyId: companyIds }] });
    await drop('Company', { userId: owner });
    await drop('Engagement', { $or: [{ ownerId: owner }, { viewerId: owner }, { targetId: owner }] });
    await drop('BusinessInfo', { userId: owner });
    await drop('MemberFinancialInfo', { memberId: owner });
    await drop('MemberDeclaration', { $or: [{ userId: owner }, { memberId: owner }] });
    await drop('PersonalInfo1', { userId: owner });
    await drop('Application', { userId: owner });
    await drop('PlatinumRequest', { memberId: owner });
    await drop('Activity', { memberId: owner });
    await drop('Notification', { user: owner });
    await drop('NotificationLog', { $or: [{ 'data.memberId': owner }, { 'data.userId': owner }, { 'data.member._id': owner }] });
    await drop('PaymentOrder', { memberId: owner, orderType: { $in: ['membership', 'company_listing', null] } });
    // Event, booking and donation history keep their existing behavior.
    if (member.deletionAuthId) {
        const authId = new mongoose.Types.ObjectId(String(member.deletionAuthId));
        const identities = await collection('OAuthIdentity').find({ authId }, { projection: { provider: 1, subject: 1 } }).toArray();
        // Keep the captured credential ID, never a live email lookup. Expire
        // pending sign-ins before removing their links so a partial purge can
        // retry safely and old callbacks cannot recreate this deleted account.
        if (identities.length) await drop('OAuthFlow', { $or: identities.map(row => ({ provider: row.provider, subject: row.subject })) });
        await drop('OAuthIdentity', { authId });
        await drop('MemberAuth', { _id: authId });
    }
    removed.MemberDetails = (await Member.collection.deleteOne({ _id, role: memberRoles })).deletedCount;
    await invalidateMemberContext(String(_id));
    await cache.del(CACHE_KEYS.USER(String(_id)));
    await cache.delPattern(CACHE_KEYS.PATTERNS.APPLICATION);
    await cache.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD);
    return { id: String(_id), deleted: true, removed };
}
async function remove(id, actor) {
    if (actor?.role !== 'super_admin') throw ApiError.forbidden('Only the Super Admin can delete a membership account.');
    return purgeMember(id, actor);
}
async function releaseArchivedEmail(email) {
    const archived = await Member.collection.findOne({ email, deletedAt: { $ne: null }, role: memberRoles });
    if (archived) await purgeMember(archived._id);
}
module.exports = { remove, purgeMember, releaseArchivedEmail };
