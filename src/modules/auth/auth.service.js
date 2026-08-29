const jwt = require('jsonwebtoken');
const config = require('../../config');
const MemberDetails = require('../members/memberdetails.model');
const MemberAuth = require('./auth.model');
const ApiError = require('../../core/utils/ApiError');
const cacheClient = require('../../core/cache/cacheClient');
const { CACHE_KEYS, CACHE_TTL } = require('../../core/cache/cacheKeys');

const mongoose = require('mongoose');
const crypto = require('crypto');
const bcrypt = require('../common/passwordHash');
const logger = require('../../config/logger');
const adminRepository = require('../admin/admin.repository');
const regionService = require('../regions/region.service');
const mailer = require('../../core/utils/mailer');

/**
 * How long a password-reset link stays usable.
 *
 * An hour is long enough to survive a slow mail server and a user who checks
 * email on another device, and short enough that a link sitting in an inbox is
 * not a standing key to the account.
 */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Only the hash of a reset token is ever stored.
 *
 * SHA-256 rather than bcrypt on purpose: the token is 32 bytes of CSPRNG
 * output, so it has nothing to brute-force and does not need a slow hash — and
 * a slow hash here would be paid on every click of every reset link.
 */
const hashResetToken = (token) => {
    const raw = String(token || '').trim();
    if (!raw) return '';
    return crypto.createHash('sha256').update(raw).digest('hex');
};

/**
 * Where the reset link points.
 *
 * `PASSWORD_RESET_URL` lets a deployment aim the link at the website's own
 * route; otherwise it is derived from FRONTEND_URL. The token travels in the
 * query string because the page needs to read it before any request is made.
 */
const buildResetUrl = (rawToken) => {
    const base = String(process.env.PASSWORD_RESET_URL || `${config.frontendUrl}/reset-password`)
        .trim()
        .replace(/\/+$/, '');
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}token=${encodeURIComponent(rawToken)}`;
};

/**
 * Shared demo passwords, read once at boot.
 *
 * A startup warning is the point: an authentication bypass that is silently on
 * is far worse than one that announces itself in the logs every restart.
 */
const DEMO_PASSWORDS = (config.admin && config.admin.demoPasswords) || [];
if (DEMO_PASSWORDS.length > 0) {
    logger.warn(
        `SECURITY: ADMIN_DEMO_PASSWORDS is enabled with ${DEMO_PASSWORDS.length} shared password(s). ` +
        'Any admin account can be signed into with them. Unset this before production.'
    );
}

const normalizeRole = (r) => {
    if (!r) return 'member';
    const lower = r.toLowerCase();
    if (lower === 'blockadmin' || lower === 'block_admin') return 'block_admin';
    if (lower === 'districtadmin' || lower === 'district_admin') return 'district_admin';
    if (lower === 'stateadmin' || lower === 'state_admin') return 'state_admin';
    if (lower === 'superadmin' || lower === 'super_admin') return 'super_admin';
    if (lower === 'admin') return 'admin';
    /*
     * Everything else is a member.
     *
     * `createApplication` used to write the declared member type ('business' /
     * 'aspirant') into this field, so accounts that submitted an application
     * under that build still carry one of those words where an authorization
     * role belongs. Returning it verbatim minted tokens with `role: 'business'`,
     * and every `role === 'member'` check on both clients then failed — which is
     * what emptied the website's profile-completion bar to 0% after a logout.
     *
     * The write is gone; this folds the rows it already produced back to the
     * only role a record in the member collection can have, so those accounts
     * recover on their next sign-in without a migration.
     */
    return 'member';
};

class AuthService {
    async register(userData) {
        const email = String(userData.email || '').toLowerCase().trim();

        /*
         * Both collections, not just the profile one.
         *
         * A registration writes a profile to "web users" and a credential to
         * `auth`, and only `auth` carries the unique index on email. Checking
         * "web users" alone meant an address present in `auth` but missing from
         * "web users" sailed past this guard, and the request died on an E11000
         * from `memberAuth.save()` — *after* the profile row had already been
         * written. The production log shows exactly that pair: an E11000 at
         * 09:17:21, then the same address returning a clean 409 two minutes
         * later, because the failed attempt had left its orphan behind.
         */
        const [existingMember, existingAuth] = await Promise.all([
            MemberDetails.findOne({ email }).select('_id').lean(),
            MemberAuth.findOne({ email }).select('_id').lean()
        ]);

        if (existingMember || existingAuth) {
            throw ApiError.conflict('Email already registered');
        }

        // An applicant may only register into a region that has an active admin
        // waiting to review them. The registration screen only offers such
        // regions, so this catches a stale client or a direct API call — the two
        // ways an orphaned application could otherwise still be created.
        //
        // The canonical spellings come back from the admin database and are what
        // gets stored. An applicant whose block name differs only in casing would
        // otherwise sit outside their own admin's geofence regex and never appear
        // in anyone's queue.
        const coverage = await regionService.validateRegion({
            state: userData.state,
            district: userData.district,
            block: userData.block
        });

        if (!coverage.ok) {
            throw ApiError.badRequest(coverage.reason);
        }

        const region = coverage.region || {
            state: userData.state,
            district: userData.district,
            block: userData.block
        };

        // Create member in "web users" collection (NO password here)
        const memberDetails = new MemberDetails({
            fullName: userData.fullName,
            email,
            phoneNumber: userData.phoneNumber,
            state: region.state,
            district: region.district,
            block: region.block,
            city: userData.city || '',
            role: 'member',
            isActive: true,
            profileCompleted: false,
            membershipStatus: 'pending',
            membershipType: 'none'
        });

        await memberDetails.save();

        /*
         * The credential write is the one that can still fail — the unique index
         * on `auth.email` is the only real arbiter, and two requests for the same
         * address can both clear the check above. If it does fail, the profile
         * written a line earlier has to go, or the address is left half-registered:
         * a profile with no way to sign in, and a pre-check that will now reject
         * every honest retry with "Email already registered".
         *
         * Same compensating-delete shape as `commitFinalApproval()`, and for the
         * same reason — two collections, no transaction across them.
         */
        const memberAuth = new MemberAuth({
            email,
            password: userData.password,
            isActive: true
        });

        try {
            await memberAuth.save();
        } catch (err) {
            await MemberDetails.deleteOne({ _id: memberDetails._id }).catch((cleanupErr) => {
                logger.error('Registration rollback failed; orphaned member profile left behind', {
                    memberId: String(memberDetails._id),
                    email,
                    error: cleanupErr && cleanupErr.message
                });
            });

            // A duplicate key here is a race on the same address, not a fault.
            if (err && err.code === 11000) {
                throw ApiError.conflict('Email already registered');
            }
            throw err;
        }

        // Generate tokens
        const tokens = this.generateTokens({ _id: memberDetails._id, email: memberDetails.email, role: 'member' });

        // Cache user data
        await cacheClient.set(
            CACHE_KEYS.USER(memberDetails._id),
            memberDetails.toJSON(),
            CACHE_TTL.HOUR
        );

        return {
            user: {
                id: memberDetails._id,
                memberId: memberDetails._id,
                email: memberDetails.email,
                role: memberDetails.role
            },
            memberDetails: memberDetails.toJSON(),
            token: tokens.accessToken
        };
    }

    /**
     * Turn whatever the sign-in form was given into the account's email.
     *
     * Both clients label the field "Email or Member ID", so it arrives as an
     * address or as a Member ID (which is `MemberDetails._id`). Credentials
     * live in the `auth` collection keyed by email alone, so a Member ID has to
     * be resolved through the profile first.
     *
     * A phone number is deliberately NOT accepted, even though the form used to
     * be able to send one. `phoneNumber` carries no unique index and the live
     * data shows why that matters: four of the five member rows share a single
     * number. Resolving it would sign the caller into whichever of those rows
     * Mongo happened to return — a login that hands out someone else's account.
     * Email and `_id` are the only two fields on this collection that identify
     * exactly one member.
     *
     * Returns '' when nothing matches — the caller reports invalid credentials
     * rather than distinguishing "no such account", so a stranger cannot use
     * this endpoint to discover which Member IDs exist.
     */
    async resolveLoginEmail(identifier) {
        const raw = String(identifier || '').trim();
        if (!raw) return '';
        if (raw.includes('@')) return raw.toLowerCase();

        // A Member ID is an ObjectId. `findById` on a malformed one throws a
        // CastError, so the shape is checked before the query rather than
        // catching a 500 after it. The round-trip comparison rejects the values
        // `isValid` accepts loosely (any 12-character string), which would
        // otherwise be cast into an unrelated id.
        if (!mongoose.Types.ObjectId.isValid(raw)) return '';
        if (String(new mongoose.Types.ObjectId(raw)) !== raw.toLowerCase()) return '';

        const profile = await MemberDetails.findById(raw).select('email');
        return String(profile?.email || '').toLowerCase();
    }

    async login(identifier, password) {
        // `identifier` is an email, a Member ID or a mobile number; see
        // resolveLoginEmail. Admins sign in by email only.
        const normalizedEmail = await this.resolveLoginEmail(identifier);

        if (!normalizedEmail) {
            throw ApiError.unauthorized('Invalid credentials');
        }

        // 1. Check "web auth" collection for regular members
        const memberAuth = await MemberAuth.findOne({ email: normalizedEmail })
            .select('+password');

        if (memberAuth) {
            if (!memberAuth.isActive) {
                throw ApiError.forbidden('Account is deactivated');
            }

            // Verify password
            const isPasswordValid = await memberAuth.comparePassword(password);
            if (!isPasswordValid) {
                throw ApiError.unauthorized('Invalid credentials');
            }

            // Get full user details from "web users" collection
            const memberDetails = await MemberDetails.findOne({ email: normalizedEmail });

            if (memberDetails) {
                const userRole = normalizeRole(memberDetails.role);
                // Location claims must ride in the token: the geofenced admin
                // dashboards read them off req.user to scope every query.
                const tokens = this.generateTokens({
                    _id: memberDetails._id,
                    email: memberDetails.email,
                    role: userRole,
                    block: memberDetails.block,
                    district: memberDetails.district,
                    state: memberDetails.state
                });

                await cacheClient.set(
                    CACHE_KEYS.USER(memberDetails._id),
                    memberDetails.toJSON(),
                    CACHE_TTL.HOUR
                );

                return {
                    user: {
                        id: memberDetails._id,
                        memberId: memberDetails._id,
                        email: memberDetails.email,
                        fullName: memberDetails.fullName,
                        role: userRole
                    },
                    memberDetails: memberDetails.toJSON(),
                    token: tokens.accessToken,
                    role: userRole
                };
            }
        }

        // 2. Admin sign-in. One lookup through the repository, which scans every
        // admin collection in both databases — so an account deleted from the
        // primary collection cannot keep signing in through a legacy mirror, and
        // an account that only exists in a mirror can still sign in.
        const adminHit = await adminRepository.findRawByEmail(normalizedEmail);
        const adminUser = adminHit ? adminHit.doc : null;

        if (adminUser) {
            const adminRow = adminRepository.toAdminRow(adminUser, adminHit.source);

            if (!adminRow.active) {
                throw ApiError.forbidden('Account is deactivated');
            }

            const storedHash = adminUser.password || adminUser.passwordHash || '';
            let isPasswordValid = false;
            let storedInPlaintext = false;

            if (storedHash && storedHash.startsWith('$2')) {
                try {
                    isPasswordValid = await bcrypt.compare(password, storedHash);
                } catch (bcryptErr) {
                    isPasswordValid = false;
                }
            } else if (storedHash) {
                // Some accounts were seeded with a plaintext password. Comparing
                // them is the only way those admins can sign in at all, so it is
                // kept — but the record is upgraded to a hash on the way through,
                // so each such account is plaintext for exactly one more login.
                isPasswordValid = storedHash === password;
                storedInPlaintext = isPasswordValid;
            }

            /**
             * Temporary shared-password fallback for the pre-seeded demo admins.
             *
             * Off unless ADMIN_DEMO_PASSWORDS is set. It is a real bypass — any
             * admin account can be signed into with one of these — so every use
             * is logged with the account it unlocked, and it is checked last so
             * a correct real password never takes this path.
             */
            if (!isPasswordValid && DEMO_PASSWORDS.length > 0 && DEMO_PASSWORDS.includes(password)) {
                isPasswordValid = true;
                logger.warn('Admin signed in with a shared demo password — ADMIN_DEMO_PASSWORDS is enabled', {
                    email: adminRow.email,
                    role: adminRow.role
                });
            }

            if (!isPasswordValid) {
                throw ApiError.unauthorized('Invalid credentials');
            }

            if (storedInPlaintext) {
                try {
                    const upgraded = await bcrypt.hash(password, 10);
                    await adminHit.handle.updateOne(
                        { _id: adminUser._id },
                        { $set: { password: upgraded }, $unset: { passwordHash: '' } }
                    );
                    logger.warn('Upgraded a plaintext admin password to bcrypt on login', { email: adminRow.email });
                } catch (upgradeErr) {
                    // Non-fatal: the credential was correct and the session is
                    // valid. It stays plaintext until the next successful login.
                    logger.warn('Could not upgrade a plaintext admin password', {
                        email: adminRow.email,
                        error: upgradeErr && upgradeErr.message
                    });
                }
            }

            const adminRole = adminRow.role || normalizeRole(adminUser.role || adminUser.adminType);
            const tokens = this.generateTokens({
                _id: adminUser._id,
                email: adminRow.email,
                role: adminRole,
                block: adminRow.block,
                district: adminRow.district,
                state: adminRow.state
            });

            // Real values only. A hardcoded default region here is worse than an
            // empty one: it silently geofences the admin to somebody else's
            // district and shows them applications that are not theirs.
            const adminObj = {
                id: adminUser._id.toString(),
                _id: adminUser._id.toString(),
                memberId: adminUser._id.toString(),
                email: adminRow.email,
                fullName: adminRow.fullName || 'Admin User',
                // Carried so the settings screen can show it without a second
                // round trip. Its absence here is why the field rendered blank
                // for admins whose record has had a number all along.
                phoneNumber: adminRow.phoneNumber || '',
                role: adminRole,
                state: adminRow.state,
                district: adminRow.district,
                block: adminRow.block
            };

            await cacheClient.set(
                CACHE_KEYS.USER(adminUser._id.toString()),
                adminObj,
                CACHE_TTL.HOUR
            );

            return {
                user: adminObj,
                memberDetails: adminObj,
                token: tokens.accessToken,
                role: adminRole
            };
        }

        throw ApiError.unauthorized('Invalid credentials');
    }

    async refreshToken(refreshToken) {
        try {
            const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret);

            const memberDetails = await MemberDetails.findById(decoded.userId);

            if (!memberDetails) {
                throw ApiError.unauthorized('Invalid refresh token');
            }

            // Generate new tokens
            const tokens = this.generateTokens(memberDetails);

            return tokens;
        } catch (error) {
            throw ApiError.unauthorized('Invalid or expired refresh token');
        }
    }

    async logout(userId) {
        // Clear cache
        await cacheClient.del(CACHE_KEYS.USER(userId));

        return true;
    }

    /**
     * The signed-in account, resolved from the database rather than from cache.
     *
     * This used to read `MemberAuth.findById(userId)`. The id in the token is
     * `MemberDetails._id` — a different collection with different ids — so that
     * lookup never matched, and the endpoint only appeared to work because the
     * login handler had just written the profile into cache under the same key.
     * With Redis disabled that cache is per-process and one hour long, so
     * /auth/me answered correctly right after signing in and 404'd after a
     * restart. Callers that had been given a profile then silently got nothing.
     *
     * The database is consulted first now and the cache is only a shortcut, so
     * the endpoint is correct on a cold process. The shape is the flat profile
     * the clients already read (`fullName`, `phoneNumber`, …); `details` is kept
     * as an alias because existing screens probe for it first.
     *
     * Admins have no row in `users`, so they resolve through the admin
     * repository — otherwise every admin got a 404 from their own profile call.
     */
    async getCurrentUser(userId, user = {}) {
        const cached = await cacheClient.get(CACHE_KEYS.USER(userId));
        if (cached && (cached.email || cached.fullName)) {
            return cached;
        }

        const memberDetails = await MemberDetails.findById(userId).catch(() => null);

        if (memberDetails) {
            const profile = memberDetails.toJSON();
            const result = {
                ...profile,
                id: memberDetails._id,
                memberId: memberDetails._id,
                // Kept for the screens that probe `payload.details.fullName`
                // before falling back to the flat shape.
                details: profile
            };

            await cacheClient.set(CACHE_KEYS.USER(userId), result, CACHE_TTL.HOUR);
            return result;
        }

        // No member profile: this is an admin account. Their record lives in one
        // of the admin collections, which only the repository knows how to scan.
        const email = String(user.email || '').toLowerCase();
        if (email) {
            const hit = await adminRepository.findRawByEmail(email).catch(() => null);
            if (hit) {
                const row = adminRepository.toAdminRow(hit.doc, hit.source);
                const result = {
                    id: String(hit.objectId),
                    memberId: String(hit.objectId),
                    fullName: row.fullName,
                    email: row.email,
                    phoneNumber: row.phoneNumber,
                    role: row.role || user.role || '',
                    state: row.state,
                    district: row.district,
                    block: row.block
                };
                result.details = result;

                await cacheClient.set(CACHE_KEYS.USER(userId), result, CACHE_TTL.HOUR);
                return result;
            }
        }

        throw ApiError.notFound('User not found');
    }

    /**
     * Start a password reset.
     *
     * Always resolves the same way whether or not the address exists. An
     * endpoint that answers "no such account" is an account-enumeration oracle,
     * and this one is public and unauthenticated — anyone could walk a list of
     * addresses through it and learn which are registered.
     *
     * Both member and admin accounts are supported. They store credentials in
     * different places, so the token is written wherever the account actually
     * lives; `resetPassword` looks in both.
     */
    async requestPasswordReset(email) {
        const normalizedEmail = String(email || '').toLowerCase().trim();
        const generic = {
            message: 'If that email is registered, a reset link is on its way.'
        };

        if (!normalizedEmail) return generic;

        // The raw token goes in the email and is never stored; only its hash is
        // kept, so a database dump yields no usable links.
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashResetToken(rawToken);
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        let recipientName = '';
        let stored = false;

        const memberAuth = await MemberAuth.findOne({ email: normalizedEmail }).catch(() => null);
        if (memberAuth && memberAuth.isActive !== false) {
            await MemberAuth.updateOne(
                { _id: memberAuth._id },
                { $set: { resetPasswordToken: tokenHash, resetPasswordExpires: expiresAt } }
            );
            stored = true;

            const memberDetails = await MemberDetails.findOne({ email: normalizedEmail }).catch(() => null);
            recipientName = (memberDetails && memberDetails.fullName) || '';
        } else {
            const hit = await adminRepository.findRawByEmail(normalizedEmail).catch(() => null);
            if (hit) {
                const row = adminRepository.toAdminRow(hit.doc, hit.source);
                if (row.active) {
                    await adminRepository.updateById(hit, {
                        resetPasswordToken: tokenHash,
                        resetPasswordExpires: expiresAt
                    });
                    stored = true;
                    recipientName = row.fullName || '';
                }
            }
        }

        if (!stored) {
            // Nothing to reset. Logged so a genuine support request can be
            // traced, but the caller is told the same thing either way.
            logger.info('Password reset requested for an unknown or inactive account', {
                email: normalizedEmail
            });
            return generic;
        }

        const resetUrl = buildResetUrl(rawToken);
        const delivery = await mailer.sendPasswordReset({
            email: normalizedEmail,
            fullName: recipientName,
            resetUrl,
            expiresInMinutes: RESET_TOKEN_TTL_MS / 60000
        });

        if (!delivery.sent) {
            // The token is valid and stored; only delivery failed. Say so in the
            // logs rather than to the caller, who must not learn from the
            // response whether the address exists.
            logger.warn('Password reset email was not delivered', {
                email: normalizedEmail,
                skipped: delivery.skipped,
                error: delivery.error
            });
        }

        return generic;
    }

    /**
     * Check a token before showing the "choose a new password" form.
     *
     * Lets the client fail early with a clear message instead of collecting a
     * new password and then rejecting it. Returns a boolean rather than
     * throwing — an expired link is an ordinary outcome, not an error.
     */
    async verifyResetToken(token) {
        const tokenHash = hashResetToken(token);
        if (!tokenHash) return { valid: false };

        const memberAuth = await MemberAuth.findOne({
            resetPasswordToken: tokenHash,
            resetPasswordExpires: { $gt: new Date() }
        }).catch(() => null);

        if (memberAuth) return { valid: true, email: memberAuth.email };

        const hit = await adminRepository.findRawByResetToken(tokenHash).catch(() => null);
        if (hit) return { valid: true, email: String(hit.doc.email || '').toLowerCase() };

        return { valid: false };
    }

    /**
     * Consume a reset token and set the new password.
     *
     * The token is cleared in the same write that sets the password, so a link
     * works exactly once even if it is opened twice.
     */
    async resetPassword(token, newPassword) {
        const password = String(newPassword || '');
        if (password.length < 6) {
            throw ApiError.badRequest('Password must be at least 6 characters long');
        }

        const tokenHash = hashResetToken(token);
        if (!tokenHash) {
            throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.');
        }

        const memberAuth = await MemberAuth.findOne({
            resetPasswordToken: tokenHash,
            resetPasswordExpires: { $gt: new Date() }
        }).select('+password').catch(() => null);

        if (memberAuth) {
            // Assigned, not updated in place, so the model's pre-save hook does
            // the hashing — writing the raw string through updateOne would store
            // the password in plaintext.
            memberAuth.password = password;
            memberAuth.resetPasswordToken = undefined;
            memberAuth.resetPasswordExpires = undefined;
            await memberAuth.save();

            await cacheClient.del(CACHE_KEYS.USER(memberAuth._id.toString()));
            logger.info('Password reset completed', { email: memberAuth.email, kind: 'member' });

            return { email: memberAuth.email };
        }

        const hit = await adminRepository.findRawByResetToken(tokenHash).catch(() => null);
        if (hit) {
            // The repository translates `passwordHash` to whichever spelling the
            // holding collection uses; writing it directly would land in the
            // wrong field and leave the account with its old credential.
            const passwordHash = await bcrypt.hash(password, 10);
            await adminRepository.updateById(hit, {
                passwordHash,
                resetPasswordToken: '',
                resetPasswordExpires: null,
                mustResetPassword: false
            });

            const email = String(hit.doc.email || '').toLowerCase();
            await cacheClient.del(CACHE_KEYS.USER(String(hit.objectId)));
            logger.info('Password reset completed', { email, kind: 'admin' });

            return { email };
        }

        throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.');
    }

    async changePassword(userId, oldPassword, newPassword) {
        const memberAuth = await MemberAuth.findById(userId).select('+password');

        if (!memberAuth) {
            throw ApiError.notFound('User not found');
        }

        // Verify old password
        const isPasswordValid = await memberAuth.comparePassword(oldPassword);
        if (!isPasswordValid) {
            throw ApiError.badRequest('Current password is incorrect');
        }

        // Update password
        memberAuth.password = newPassword;
        await memberAuth.save();

        // Clear cache
        await cacheClient.del(CACHE_KEYS.USER(userId));

        return true;
    }

    generateTokens(memberAuth) {
        const payload = {
            userId: memberAuth._id,
            email: memberAuth.email,
            role: memberAuth.role || 'member',
            block: memberAuth.block,
            district: memberAuth.district,
            state: memberAuth.state
        };

        const accessToken = jwt.sign(payload, config.jwt.secret, {
            expiresIn: config.jwt.expiresIn
        });

        const refreshToken = jwt.sign({ userId: memberAuth._id },
            config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiresIn }
        );

        return {
            accessToken,
            refreshToken
        };
    }
}

module.exports = new AuthService();
