const { indiaDayKey } = require('./membershipDates');
const { membershipNumberFor, validateMembershipNumber, reserveMembershipNumber, advanceMembershipCounter, formatNumber } = require('./memberNumber');
const { membershipIdCategory } = require('./membershipIdCategory');
const daily = value => { try { return !!validateMembershipNumber(value); } catch { return false; } };
const joinedAt = member => {
    if (member.membershipActivatedAt) return new Date(member.membershipActivatedAt);
    if (member.createdAt) return new Date(member.createdAt);
    const id = String(member._id);
    return /^[0-9a-f]{24}$/i.test(id) ? new Date(parseInt(id.slice(0, 8), 16) * 1000) : null;
};
function planMembershipNumberMigration(members, reservations = []) {
    const occupied = new Set([...members.flatMap(m => [m.membershipNumber, ...(m.legacyMembershipNumbers || [])]), ...reservations.map(r => String(r._id).replace(/^number:/, ''))].filter(Boolean));
    const rows = members.filter(m => m.membershipNumber || m.membershipActivatedAt || ['active', 'completed', 'expired'].includes(String(m.membershipStatus).toLowerCase()))
        .sort((a, b) => +joinedAt(a) - +joinedAt(b) || String(a._id).localeCompare(String(b._id)));
    const next = new Map();
    const changes = [];
    for (const member of rows) {
        if (daily(member.membershipNumber || '')) continue;
        const date = joinedAt(member);
        const day = date && indiaDayKey(date);
        if (!day) throw new Error('A member has no valid original joining date: ' + member._id);
        const category = membershipIdCategory(member, member.idPlan || {});
        const counter = category + ':' + day;
        let seq = next.get(counter) || 0;
        let number;
        do { number = formatNumber(day, ++seq, category); } while (occupied.has(number));
        next.set(counter, seq); occupied.add(number);
        changes.push({ memberId: String(member._id), previousStored: member.membershipNumber || null,
            previousDisplay: membershipNumberFor(member), membershipNumber: number, joinedAt: date.toISOString() });
    }
    return changes;
}
async function applyMembershipNumberMigration(changes) {
    const Member = require('./memberdetails.model');
    const { Types } = require('mongoose');
    for (const change of changes) {
        validateMembershipNumber(change.membershipNumber);
        const _id = new Types.ObjectId(change.memberId);
        const member = await Member.collection.findOne({ _id });
        if (!member) throw new Error('Member no longer exists: ' + change.memberId);
        if (member.membershipNumber === change.membershipNumber) continue;
        if ((member.membershipNumber || null) !== change.previousStored) throw new Error('Member ID changed since the plan was prepared: ' + change.memberId);
        await reserveMembershipNumber(member, change.membershipNumber);
        if (member.membershipNumber) await reserveMembershipNumber(member, member.membershipNumber);
        await advanceMembershipCounter(change.membershipNumber);
        const result = await Member.collection.updateOne({ _id, membershipNumber: change.previousStored }, {
            $set: { membershipNumber: change.membershipNumber }, $addToSet: { legacyMembershipNumbers: change.previousDisplay },
        });
        if (!result.modifiedCount) throw new Error('Member changed during conversion: ' + change.memberId);
        require('../common/memberContext').invalidateMemberContext(_id);
    }
    return changes.length;
}
module.exports = { planMembershipNumberMigration, applyMembershipNumberMigration };
