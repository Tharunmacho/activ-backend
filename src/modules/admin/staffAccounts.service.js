const mongoose = require('mongoose');
const ApiError = require('../../core/utils/ApiError');

/**
 * Site-staff accounts — the CMS admin and the events admin — maintained by the
 * Super Admin.
 *
 * These two accounts run one portal each and hold no region, so the tier
 * machinery in `superadmin.service` (roles, geofences, orphan impact) has
 * nothing to say about them — and `updateAdmin` there refuses them outright,
 * because their role is not one of the three manageable tiers. Without this
 * path a CMS editor who forgets their password depends on someone with
 * database access. With it, the Super Admin resets it from Manage Admins.
 *
 * What it may change: name, email, phone, active, and the password.
 * What it may never touch: a `super_admin` record (the Super Admin changes
 * their own password in Settings), the role, or any tier admin.
 *
 * Every read and write goes through `admin.repository` — the field-name
 * translation (`passwordHash`/`password`, `phoneNumber`/`phone`,
 * `active`/`isActive`) lives there and nowhere else.
 *
 * Built as a factory so the rules can be tested with in-memory fakes and no DB.
 */

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same floor `createAdmin` / `updateAdmin` apply to every admin password. */
const MIN_PASSWORD_LENGTH = 8;

/** bcrypt reads only the first 72 bytes; anything past that is silently ignored. */
const MAX_PASSWORD_BYTES = 72;

const STAFF_LABELS = {
    cms_admin: 'CMS Administrator',
    events_admin: 'Events Administrator',
    attendance_admin: 'Event Attendance Administrator'
};

/**
 * The public shape of one staff account. Built field by field from the row so
 * a hash can never ride along, whatever the repository hands over.
 */
const toStaffRow = (row = {}) => ({
    id: String(row.id || ''),
    fullName: String(row.fullName || ''),
    email: String(row.email || '').toLowerCase(),
    phoneNumber: String(row.phoneNumber || ''),
    role: String(row.role || ''),
    roleLabel: STAFF_LABELS[row.role] || row.roleLabel || 'Staff',
    active: row.active !== false,
    lastLoginAt: row.lastLoginAt || null,
    updatedAt: row.updatedAt || null,
    createdAt: row.createdAt || null
});

/** Validate a new password. Returns an error message, or '' when it is acceptable. */
const passwordProblem = (password) => {
    const value = String(password == null ? '' : password);
    if (value.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
        return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
    }
    if (!value.trim()) return 'Password cannot be only spaces';
    return '';
};

/**
 * Work out what an edit changes, without touching anything.
 *
 * Omitted fields keep their stored value (an absent field is UNTOUCHED, never
 * cleared). Returns `{ update, changed, email, password }` — `password` is the
 * raw new password or '' and is never put in `update` or `changed` metadata
 * beyond the word "password".
 */
const planStaffUpdate = (existing = {}, payload = {}) => {
    const body = payload || {};
    const pick = (key, fallback) =>
        (body[key] !== undefined && body[key] !== null ? String(body[key]).trim() : fallback);

    const fullName = pick('fullName', String(existing.fullName || ''));
    const email = pick('email', String(existing.email || '')).toLowerCase();
    const phoneNumber = pick('phoneNumber', String(existing.phoneNumber || ''));

    if (!fullName) throw ApiError.badRequest('Full name is required');
    if (!EMAIL_RX.test(email)) throw ApiError.badRequest('A valid email is required');
    if (phoneNumber && !/^[+\d][\d\s-]{5,19}$/.test(phoneNumber)) {
        throw ApiError.badRequest('Phone number is not valid');
    }

    let active = existing.active !== false;
    if (body.active !== undefined && body.active !== null) {
        // Multipart and some clients send booleans as strings.
        active = !(body.active === false || body.active === 'false');
    }

    const password = body.password !== undefined && body.password !== null && body.password !== ''
        ? String(body.password)
        : '';
    if (password) {
        const problem = passwordProblem(password);
        if (problem) throw ApiError.badRequest(problem);
    }

    const changed = [];
    if (fullName !== String(existing.fullName || '')) changed.push('name');
    if (email !== String(existing.email || '').toLowerCase()) changed.push('email');
    if (phoneNumber !== String(existing.phoneNumber || '')) changed.push('phone');
    if (active !== (existing.active !== false)) changed.push(active ? 'reactivated' : 'deactivated');
    if (password) changed.push('password');

    return {
        update: { fullName, email, phoneNumber, active },
        changed,
        email,
        password
    };
};

/**
 * @param {object} deps
 * @param {object} deps.repository   admin.repository (or a fake)
 * @param {object} deps.hasher       { hash(password, rounds) }
 * @param {object} deps.audit        { record(entry) }
 * @param {Function} [deps.memberEmailTaken]  async (email) => boolean
 * @param {Function} [deps.forgetSession]     async (id, emails) => void — drop cached session/profile data
 */
const createStaffAccountsService = ({
    repository,
    hasher,
    audit,
    memberEmailTaken = async() => false,
    forgetSession = async() => {}
} = {}) => {
    const staffRoles = repository.STAFF_ROLES || ['cms_admin', 'events_admin', 'attendance_admin'];

    const list = async() => {
        const rows = await repository.findStaff();
        return (rows || [])
            .filter(row => staffRoles.includes(row.role))
            .map(toStaffRow)
            .sort((a, b) => a.role.localeCompare(b.role) || a.email.localeCompare(b.email));
    };

    const update = async(id, payload = {}, actor = {}) => {
        if (!mongoose.Types.ObjectId.isValid(String(id || ''))) {
            throw ApiError.badRequest('Invalid account id');
        }

        const hit = await repository.findRawById(String(id));
        if (!hit) throw ApiError.notFound('Account not found');

        const existing = repository.toAdminRow(hit.doc, hit.source);

        /*
         * Staff only. A super_admin record — including one whose document
         * carries no role at all, which `toAdminRow` reads as super_admin from
         * its collection — is refused, and so is every tier admin: those have
         * their own path with its geofence and orphan checks.
         */
        if (existing.role === 'super_admin') {
            throw ApiError.forbidden('Super admin accounts cannot be edited here — change your own password in Settings');
        }
        if (!staffRoles.includes(existing.role)) {
            throw ApiError.forbidden('Only the CMS, events and attendance staff accounts are managed here');
        }
        if (payload && payload.role !== undefined && repository.normalizeRole(payload.role) !== existing.role) {
            throw ApiError.badRequest('The role of a staff account cannot be changed');
        }

        const plan = planStaffUpdate(existing, payload);

        /*
         * Every stored copy of this account, so the edit reaches all of them.
         * Found by the stored email; the located record is always included even
         * if its email is blank.
         */
        const copies = existing.email ? await repository.findAllRawByEmail(existing.email) : [];
        const ownIds = new Set([String(hit.objectId), ...copies.map(c => String(c.objectId))]);
        const targets = [hit, ...copies.filter(c => String(c.objectId) !== String(hit.objectId))];

        if (plan.email !== existing.email) {
            // Unique across every admin collection in both databases…
            const taken = await repository.findAllRawByEmail(plan.email);
            if ((taken || []).some(c => !ownIds.has(String(c.objectId)))) {
                throw ApiError.conflict('Another admin account already uses this email');
            }
            // …and across member sign-ins, which login checks FIRST: an admin
            // sharing a member's address could never reach the admin session.
            if (await memberEmailTaken(plan.email)) {
                throw ApiError.conflict('A member account already uses this email');
            }
        }

        if (plan.changed.length === 0) {
            return { account: toStaffRow(existing), changed: [], sessionsInvalidated: false };
        }

        const write = { ...plan.update, updatedAt: new Date() };
        if (plan.password) {
            // Canonical `passwordHash`; the repository writes the spelling the
            // holding collection uses and clears the other one.
            write.passwordHash = await hasher.hash(plan.password, 10);
            write.mustResetPassword = false;
        }

        for (const target of targets) {
            // eslint-disable-next-line no-await-in-loop
            await repository.updateById(target, write);
        }

        await Promise.resolve(forgetSession(String(hit.objectId), [existing.email, plan.email])).catch(() => null);

        const account = toStaffRow({ ...existing, ...plan.update, updatedAt: write.updatedAt });

        await Promise.resolve(audit.record({
            action: 'admin.staff_updated',
            category: 'admin',
            summary: `Super Admin updated ${account.roleLabel} ${account.fullName} (${plan.changed.join(', ')})`,
            actorId: actor.userId || actor._id || actor.id || '',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: String(hit.objectId),
            targetLabel: account.email,
            // What changed — never the password itself, never its hash.
            metadata: {
                role: existing.role,
                changed: plan.changed,
                previousEmail: plan.email !== existing.email ? existing.email : undefined,
                copiesUpdated: targets.length
            }
        })).catch(() => null);

        return { account, changed: plan.changed, sessionsInvalidated: false };
    };

    return { list, update };
};

let defaultInstance = null;

/** The wired service, built on first use so requiring this file stays cheap. */
const getDefault = () => {
    if (defaultInstance) return defaultInstance;
    const repository = require('./admin.repository');
    const hasher = require('../common/passwordHash');
    const audit = require('../audit/audit.service');
    const cacheClient = require('../../core/cache/cacheClient');
    const { CACHE_KEYS } = require('../../core/cache/cacheKeys');

    defaultInstance = createStaffAccountsService({
        repository,
        hasher,
        audit,
        memberEmailTaken: async(email) => {
            const MemberAuth = require('../auth/auth.model');
            const found = await MemberAuth.findOne({ email }).select('_id').lean().catch(() => null);
            return !!found;
        },
        forgetSession: async(id, emails = []) => {
            await cacheClient.del(CACHE_KEYS.USER(id)).catch(() => null);
            // GET /admin/profile is cached per email.
            await Promise.all([...new Set((emails || []).filter(Boolean))]
                .map(e => cacheClient.del(CACHE_KEYS.ADMIN(e)).catch(() => null)));
        }
    });
    return defaultInstance;
};

module.exports = {
    createStaffAccountsService,
    planStaffUpdate,
    passwordProblem,
    toStaffRow,
    MIN_PASSWORD_LENGTH,
    STAFF_LABELS,
    list: (...args) => getDefault().list(...args),
    update: (...args) => getDefault().update(...args)
};
