/** Membership IDs: ACTIV-TYPE-YYYYMMDD-001, using the activation date in IST.
 * Mongo allocates a separate atomic counter per date and reserves each number.
 * Assigned IDs, including legacy and office-entered numbers, survive renewals.
 * Application references keep their existing format.
 */

/** The four-digit year a record belongs to, from whatever it carries. */
const yearOf = (record = {}) => {
    const candidates = [
        record.membershipActivatedAt,
        record.approvedAt,
        record.createdAt,
        record.submittedAt,
    ];

    for (const value of candidates) {
        if (!value) continue;
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.getFullYear();
    }

    /*
     * THE ID ITSELF, which is never absent.
     *
     * A Mongo ObjectId's first four bytes are the creation time in seconds.
     * Reading the year out of it means a record whose date fields were dropped
     * by strict mode — which is how several fields on this model were lost —
     * still produces the right year rather than the current one. Using "now"
     * as the fallback would hand a member registered in 2024 a 2026 number the
     * first time anybody opened their profile.
     */
    const id = String(record._id || record.id || '');
    if (/^[0-9a-f]{24}$/i.test(id)) {
        const seconds = parseInt(id.slice(0, 8), 16);
        if (seconds > 0) return new Date(seconds * 1000).getFullYear();
    }

    return new Date().getFullYear();
};

/** Six characters off the id. Upper case, as every screen has always shown it. */
const tailOf = (record = {}) =>
    String(record._id || record.id || '').slice(-6).toUpperCase() || '000000';

/** New numbers count activations per Indian calendar day; existing IDs stay stable. */
const { indiaDayKey } = require('./membershipDates');
const ApiError = require('../../core/utils/ApiError');
const STANDARD_NUMBER = /^ACTIV-(?:[A-Z][A-Z0-9]{2,7}-)?(?:\d{4}|\d{8})-\d{3,9}$/;
const DAILY_NUMBER = /^ACTIV-([A-Z][A-Z0-9]{2,7})-(\d{8})-(\d{3,9})$/;

const formatNumber = (day, seq, category = 'MEM') => `ACTIV-${category}-${day}-${String(seq).padStart(3, '0')}`;

/** Next value of this Indian calendar day's counter. Atomic on one document. */
const nextSequence = async (day, category = 'MEM') => {
    const res = await require('../../config/dataLayout').collection('membershipCounters').findOneAndUpdate(
        { _id: `membership:${category}:${day}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    // Driver 6 returns the document; older drivers wrap it in `{ value }`.
    const doc = res && res.value !== undefined && res.seq === undefined ? res.value : res;
    return Number((doc && doc.seq) || 0);
};

/** Accept a real calendar date and a canonical, positive daily sequence. */
const validateMembershipNumber = value => {
    if (typeof value !== 'string' || value.length > 40) throw ApiError.badRequest('Enter a membership ID in ACTIV-TYPE-YYYYMMDD-001 format.');
    const number = value.trim().toUpperCase();
    if (!number) return '';
    const match = DAILY_NUMBER.exec(number);
    const day = match?.[2] || '';
    const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T12:00:00+05:30`;
    if (!match || Number(match[3]) < 1 || String(Number(match[3])).padStart(3, '0') !== match[3] || indiaDayKey(date) !== day) throw ApiError.badRequest('Enter a valid membership ID, for example ACTIV-BEG-20261012-001.');
    return number;
};

// The counter collection also reserves IDs using Mongo's unique _id index.
// This protects manual entries and automatic numbering across concurrent requests.
const reserveNumber = async (member, number) => {
    const Member = require('./memberdetails.model');
    const existing = await Member.collection.findOne({ $or: [{ membershipNumber: number }, { legacyMembershipNumbers: number }], _id: { $ne: member._id } }, { projection: { _id: 1 } });
    if (existing) throw ApiError.conflict('Membership ID already exists. Choose a different ID.');
    const counters = require('../../config/dataLayout').collection('membershipCounters');
    try { await counters.insertOne({ _id: `number:${number}`, memberId: String(member._id), reservedAt: new Date() }); }
    catch (error) {
        if (error.code !== 11000) throw error;
        const reserved = await counters.findOne({ _id: `number:${number}` });
        if (reserved?.memberId !== String(member._id)) throw ApiError.conflict('Membership ID already exists. Choose a different ID.');
    }
    return number;
};

const advanceMembershipCounter = async number => {
    const [, category, day, sequence] = DAILY_NUMBER.exec(validateMembershipNumber(number));
    await require('../../config/dataLayout').collection('membershipCounters').updateOne(
        { _id: `membership:${category}:${day}` }, { $max: { seq: Number(sequence) } }, { upsert: true });
};

const prepareMembershipNumber = async (member, requested = '', category) => {
    const current = String(member.membershipNumber || '').trim();
    const supplied = String(requested || '').trim().toUpperCase();
    if (current) {
        if (supplied && supplied !== current.toUpperCase()) throw ApiError.conflict('This member already has a membership ID. Keep their existing ID when renewing.');
        return current;
    }
    if (supplied) {
        const number = validateMembershipNumber(requested);
        await reserveNumber(member, number);
        await advanceMembershipCounter(number);
        return number;
    }
    category = category || await require('./membershipIdCategory').resolveMembershipIdCategory(member);
    const day = indiaDayKey(member.membershipActivatedAt || new Date());
    for (let attempt = 0; attempt < 100; attempt++) {
        const number = formatNumber(day, await nextSequence(day, category), category);
        try { return await reserveNumber(member, number); }
        catch (error) { if (error.statusCode !== 409 && error.status !== 409) throw error; }
    }
    throw ApiError.conflict('Unable to allocate a membership ID. Please retry.');
};

const assignMembershipNumber = async (memberOrId) => {
    try {
        const MemberDetails = require('./memberdetails.model');
        const id = memberOrId && (memberOrId._id || memberOrId.id) ? (memberOrId._id || memberOrId.id) : memberOrId;
        const member = await MemberDetails.findById(id)
            .select('membershipNumber membershipActivatedAt createdAt membershipType membershipTier memberType registrationType').lean();
        if (!member) return '';
        const current = String(member.membershipNumber || '').trim();
        if (current) return current;
        const number = await prepareMembershipNumber(member);

        // Conditional: if another request numbered this member first, keep theirs.
        const res = await MemberDetails.updateOne(
            { _id: member._id, $or: [{ membershipNumber: { $exists: false } }, { membershipNumber: '' }, { membershipNumber: null }] },
            { $set: { membershipNumber: number } }
        );
        if (res && res.modifiedCount) {
            try { require('../common/memberContext').invalidateMemberContext(member._id); } catch { /* cache only */ }
            return number;
        }
        const again = await MemberDetails.findById(member._id).select('membershipNumber').lean();
        return String((again && again.membershipNumber) || number);
    } catch (error) {
        try {
            require('../../config/logger').warn('Could not assign a membership number', { error: error && error.message });
        } catch { /* logging only */ }
        return '';
    }
};

/**
 * The number to show for this member.
 *
 * Reads preserve assigned IDs. The explicit migration converts legacy IDs and
 * retains their old references without changing them during a profile read.
 */
const membershipNumberFor = (member = {}) => {
    const assigned = String(member.membershipNumber || '').trim();
    if (assigned) return assigned;
    return `ACTIV-${yearOf(member)}-${tailOf(member)}`;
};

/**
 * The reference to show for an application.
 *
 * Same shape, with `APP` in it, so a member quoting a number over the telephone
 * and an administrator searching for it cannot confuse the two. The year is the
 * year it was SUBMITTED, which is the year the applicant remembers.
 */
const applicationRefFor = (application = {}) => {
    const assigned = String(application.applicationNumber || '').trim();
    if (assigned) return assigned;
    return `ACTIV-APP-${yearOf(application)}-${tailOf(application)}`;
};

module.exports = {
    membershipNumberFor, applicationRefFor, yearOf,
    assignMembershipNumber, prepareMembershipNumber, validateMembershipNumber, reserveMembershipNumber: reserveNumber, advanceMembershipCounter, nextSequence, formatNumber, STANDARD_NUMBER
};
