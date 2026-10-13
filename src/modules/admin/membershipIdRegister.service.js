const mongoose = require('mongoose');
const Member = require('../members/memberdetails.model');
const ApiError = require('../../core/utils/ApiError');
const numbers = require('../members/memberNumber');
const dates = require('../members/membershipDates');
const eligibility = require('../members/membershipEligibility');
const rules = require('../members/membershipPlanRules');
const { membershipIdCategory } = require('../members/membershipIdCategory');
const { membershipState } = require('../members/membershipState');

const fields = ['fullName', 'email', 'phoneNumber', 'whatsappNumber', 'state', 'district', 'block', 'city', 'place', 'educationalQualification'];
const projection = Object.fromEntries([...fields, 'membershipNumber', 'legacyMembershipNumbers', 'membershipActivatedAt', 'membershipExpiresAt', 'membershipStatus', 'membershipType', 'membershipTier', 'memberType', 'registrationType', 'createdAt', 'updatedAt', 'deletedAt', 'isActive'].map(key => [key, 1]));
const enrolled = { $or: [{ membershipActivatedAt: { $type: 'date' } }, { membershipNumber: { $type: 'string', $ne: '' } }, { membershipStatus: { $in: ['active', 'expired', 'completed'] } }] };
const superOnly = actor => { if (actor?.role !== 'super_admin') throw ApiError.forbidden('Only the Super Admin can manage membership IDs.'); };
const validId = id => { if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Invalid member reference.'); return new mongoose.Types.ObjectId(id); };
const dateInput = value => { const day = value && dates.indiaDayKey(value); return day ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : ''; };
const parseDay = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw ApiError.badRequest('Choose a valid date.');
    const day = new Date(`${value}T00:00:00+05:30`);
    if (!Number.isFinite(+day) || dateInput(day) !== value) throw ApiError.badRequest('Choose a valid date.');
    return day;
};
async function shape(member) {
    const data = await eligibility.load(member);
    const progress = rules.progression(member, data.business, data.paid, data.plans);
    const lifetime = member.membershipType === 'lifetime' || member.membershipTier === 'platinum';
    const plan = lifetime ? { name: 'Lifetime', membershipType: 'lifetime' } : progress.effective || data.paid || {};
    return { id: String(member._id), ...Object.fromEntries(fields.map(key => [key, String(member[key] || '')])),
        membershipNumber: member.membershipNumber || '', previousIds: member.legacyMembershipNumbers || [],
        planName: plan.name || plan.planName || '', categoryCode: membershipIdCategory(member, plan), lifetime,
        status: member.deletedAt ? 'archived' : membershipState(member).state,
        memberSince: dateInput(member.membershipActivatedAt), validUntil: lifetime ? '' : dateInput(dates.lastValidDay(member.membershipExpiresAt)),
        updatedAt: member.updatedAt ? new Date(member.updatedAt).toISOString() : null, editable: !member.deletedAt,
        history: (member.membershipEdits || []).slice(-20).reverse() };
}
async function list(query, actor) {
    superOnly(actor);
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.max(1, Math.min(50, Math.floor(Number(query.limit) || 20)));
    const search = String(query.search || '').trim().slice(0, 120);
    const filters = [enrolled, { deletedAt: null }];
    if (search) {
        const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filters.push({ $or: ['membershipNumber', 'legacyMembershipNumbers', 'fullName', 'email', 'phoneNumber'].map(key => ({ [key]: rx })) });
    }
    const filter = { $and: filters };
    // Only current accounts appear here. Historical IDs remain reserved in the
    // archived record and can never be assigned to a different person.
    const [members, total] = await Promise.all([
        Member.collection.find(filter, { projection }).sort({ membershipActivatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        Member.collection.countDocuments(filter)
    ]);
    return { rows: await Promise.all(members.map(shape)), total, page, limit };
}
async function detail(id, actor) {
    superOnly(actor);
    const member = await Member.collection.findOne({ _id: validId(id), ...enrolled, deletedAt: null }, { projection: { ...projection, membershipEdits: 1 } });
    if (!member) throw ApiError.notFound('Membership record not found.');
    return shape(member);
}
async function update(id, body, actor) {
    superOnly(actor); validId(id);
    const allowed = new Set([...fields, 'membershipNumber', 'memberSince', 'validUntil', 'note', 'updatedAt', 'generateId']);
    if (Object.keys(body).some(key => !allowed.has(key))) throw ApiError.badRequest('Unsupported member field. Use membership payments to change entitlements.');
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!note || note.length > 500) throw ApiError.badRequest('Enter a correction note (up to 500 characters).');
    const member = await Member.findById(id).select('+membershipEdits');
    if (!member || member.deletedAt || !member.membershipNumber && !member.membershipActivatedAt) throw ApiError.notFound('Membership record not found.');
    if (!body.updatedAt || +new Date(body.updatedAt) !== +member.updatedAt) throw ApiError.conflict('This member was changed by another request. Reload their details before saving.');
    member.$where = { updatedAt: member.updatedAt, membershipNumber: member.membershipNumber || null };
    const changes = {};
    const set = (key, value) => { if (String(member[key] ?? '') !== String(value ?? '')) { changes[key] = { before: member[key] ?? null, after: value }; member.set(key, value); } };
    const contacts = {};
    for (const key of fields) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'string' || body[key].length > 200) throw ApiError.badRequest('Enter a valid ' + key + '.');
        const value = key === 'email' ? body[key].trim().toLowerCase() : body[key].trim();
        if (['email', 'phoneNumber', 'whatsappNumber'].includes(key)) {
            if (value !== (member[key] || '')) { contacts[key] = value; changes[key] = { before: member[key] || '', after: value }; }
        } else set(key, value);
    }
    if (body.memberSince !== undefined && body.memberSince !== dateInput(member.membershipActivatedAt)) set('membershipActivatedAt', parseDay(body.memberSince));
    if (body.validUntil !== undefined && body.validUntil !== dateInput(dates.lastValidDay(member.membershipExpiresAt))) {
        if (member.membershipType === 'lifetime' || member.membershipTier === 'platinum') {
            if (body.validUntil) throw ApiError.badRequest('Lifetime membership has no expiry date.');
        } else set('membershipExpiresAt', new Date(+parseDay(body.validUntil) + 86400000));
    }
    if (member.membershipExpiresAt && member.membershipActivatedAt && +member.membershipExpiresAt <= +member.membershipActivatedAt) throw ApiError.badRequest('Valid until must be on or after the joining date.');
    let requested = member.membershipNumber;
    if (body.generateId === true) {
        const row = await shape(member.toObject());
        requested = await numbers.prepareMembershipNumber({ ...member.toObject(), membershipNumber: '' }, '', row.categoryCode);
    } else if (body.membershipNumber !== undefined && body.membershipNumber !== member.membershipNumber) {
        requested = numbers.validateMembershipNumber(body.membershipNumber);
        if (!requested) throw ApiError.badRequest('Membership ID cannot be empty.');
    }
    if (requested !== member.membershipNumber) {
        await numbers.reserveMembershipNumber(member, requested);
        if (member.membershipNumber) {
            await numbers.reserveMembershipNumber(member, member.membershipNumber);
            member.legacyMembershipNumbers = [...new Set([...(member.legacyMembershipNumbers || []), member.membershipNumber])];
        }
        await numbers.advanceMembershipCounter(requested);
        set('membershipNumber', requested);
    }
    if (!Object.keys(changes).length) return detail(id, actor);
    member.membershipEdits = [...(member.membershipEdits || []), { at: new Date(), by: String(actor.email || actor.userId || 'Super Admin'), note, changes }];
    try {
        if (Object.keys(contacts).length) await require('../members/accountDetails.service').update(member, contacts, { admin: true });
        else { await member.save(); await require('../common/memberContext').invalidateMemberContext(member._id); }
    } catch (error) {
        if (error.code === 11000) throw ApiError.conflict('These member details already exist. Check the ID and email.');
        if (['DocumentNotFoundError', 'VersionError'].includes(error.name)) throw ApiError.conflict('Member details changed. Reload before saving.');
        throw error;
    }
    // The profile endpoint also reads the member's personal-details document.
    // Keep editable identity fields in sync so a saved correction is visible in
    // both clients even for members whose registration predates this register.
    const personal = {};
    for (const key of ['fullName', 'phoneNumber', 'state', 'district', 'block', 'city', 'educationalQualification']) {
        if (body[key] !== undefined) personal[key === 'fullName' ? 'name' : key] = member[key];
    }
    if (Object.keys(personal).length) await require('../members/personalinfo1.model').updateOne({ userId: member._id }, { $set: personal });
    return detail(id, actor);
}
module.exports = { list, detail, update };
