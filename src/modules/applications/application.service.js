const mongoose = require('mongoose');
const Application = require('./application.model');
const MemberAuth = require('../auth/auth.model');
const MemberDetails = require('../members/memberdetails.model');
const BusinessInfo = require('../members/businessinfo.model');
const MemberFinancialInfo = require('../members/memberfinancialinfo.model');
const MemberDeclaration = require('../members/memberdeclaration.model');
const { internationalFromPhone } = require('../common/phoneNumber');
const ApiError = require('../../core/utils/ApiError');
const cacheClient = require('../../core/cache/cacheClient');
const { CACHE_KEYS, CACHE_TTL } = require('../../core/cache/cacheKeys');
const logger = require('../../config/logger');
const { normalizeStatus, isPending, PENDING_STORED_STATUSES } = require('../common/applicationStatus');
/* The member's own row, from the shared fifteen-second cache — see the note
   at the top of `memberContext.js` for why one exists at all. */
const { memberSnapshot } = require('../common/memberContext');
const regionService = require('../regions/region.service');
const auditService = require('../audit/audit.service');
const notificationService = require('../notifications/notification.service');

/**
 * The approval state machine, keyed by *normalized* status.
 *
 *   Pending --approve--> Approved      (terminal; creates the member profile)
 *           --reject---> Rejected      (terminal)
 *
 * ONE STEP, NOT THREE. An application is put in front of its Block, District
 * and State admin together — see `common/tierRouting.js` — and the first of
 * them to decide decides it. There is no tier to advance a file to, so there is
 * no intermediate state for it to sit in.
 *
 * What this replaced was `Pending-Block -> Pending-District -> Pending-State`,
 * where each step was one tier's approval and the file was invisible to the
 * tiers above until it arrived. The association asked for the three to review
 * in parallel instead.
 *
 * `Approved` and `Rejected` remain terminal, and for the same reason as before:
 * approval writes the member's five documents, and a second approval would try
 * to write them again.
 */
const tierReviews = require('../common/tierReviews');

const ALLOWED_TRANSITIONS = {
    'Pending': ['Approved', 'Rejected'],
    'Approved': [],
    'Rejected': []
};

/** How a tier signs the decision it records. */
const TIER_ACTOR = {
    block: 'BlockAdmin',
    district: 'DistrictAdmin',
    state: 'StateAdmin',
    super: 'SuperAdmin'
};

const TIER_LABEL = { block: 'Block', district: 'District', state: 'State', super: 'Super' };

/** Maps an admin role to the tier it acts as. */
const ROLE_TO_TIER = {
    block_admin: 'block',
    district_admin: 'district',
    state_admin: 'state',
    super_admin: 'super'
};

class ApplicationService {
    /**
     * Record one activity, without ever failing the caller.
     *
     * Required lazily rather than at the top of the file: the extras controller
     * reaches back into member models that import this service, and a static
     * require would close that cycle at boot.
     */
    async logActivity(memberId, type, entityType, entityId, description) {
        try {
            const { recordActivity } = require('../members/memberExtras.controller');
            await recordActivity(memberId, type, entityType, entityId, description);
        } catch (err) {
            logger.warn('Could not record activity', { type, error: err && err.message });
        }
    }

    async createApplication(userId, applicationData) {
        // Check for existing pending application
        const existingApplication = await Application.findOne({
            userId: userId,
            // Every spelling that means "not decided" — matched against what is
            // ON DISK, so a legacy row still blocks a duplicate submission.
            status: { $in: PENDING_STORED_STATUSES }
        });

        if (existingApplication) {
            return existingApplication;
        }

        // Fetch user profile details to ensure required schema fields exist
        let userDetails = await MemberDetails.findOne({ $or: [{ userId }, { _id: userId }, { memberId: userId }] });
        if (!userDetails) {
            userDetails = await MemberAuth.findById(userId);
        }

        const appData = applicationData.data || applicationData;
        const bizInfo = appData.businessInfo || {};
        const isAspirant =
            bizInfo.doingBusiness === false ||
            appData.registrationType === 'aspirant' ||
            appData.memberType === 'aspirant' ||
            applicationData.registrationType === 'aspirant' ||
            applicationData.memberType === 'aspirant';

        const derivedRole = isAspirant ? 'aspirant' : (bizInfo.doingBusiness ? 'business' : 'member');

        const payload = {
            fullName: applicationData.fullName || (userDetails && (userDetails.fullName || userDetails.name)) || 'Applicant',
            email: applicationData.email || (userDetails && userDetails.email) || 'applicant@activ.org',
            phone: applicationData.phone || applicationData.phoneNumber || (userDetails && (userDetails.phoneNumber || userDetails.phone)) || '0000000000',
            // No default region. These used to fall back to Tamil Nadu /
            // Chennai / Chennai North, which defeated the coverage gate below:
            // an application submitted with no region at all was handed a real,
            // staffed one, passed validation, and landed in the Chennai North
            // block admin's queue belonging to nobody. Empty fails the gate,
            // which is the correct outcome.
            state: applicationData.state || (userDetails && userDetails.state) || '',
            district: applicationData.district || (userDetails && userDetails.district) || '',
            block: applicationData.block || (userDetails && userDetails.block) || '',
            data: appData,
            role: derivedRole,
            memberType: isAspirant ? 'aspirant' : 'business',
            registrationType: isAspirant ? 'aspirant' : 'business',
            ...applicationData
        };

        // The last gate before an application exists. The registration screen only
        // offers staffed regions, but a direct API call or a stale client could
        // still submit one nobody covers — and an application whose block has no
        // admin is precisely the orphan this architecture exists to prevent.
        //
        // The canonical spellings come back from the admin database and are what
        // gets stored: an applicant whose block name differs only in casing would
        // otherwise fall outside their own admin's geofence regex.
        /*
         * A MEMBER OUTSIDE INDIA: no region, and the application says so.
         *
         * Decided from the member's stored number (or the member record's own
         * flag), never from the request. With no state on it, no block,
         * district or state admin's geofence matches the application, so it is
         * the Super Admin's alone — and the Super Admin signs the State's seat,
         * which is the approval that enrols. Nothing in the review workflow
         * needs a special case for it.
         */
        const abroad = (userDetails && userDetails.isInternational === true)
            ? { international: true, country: userDetails.country || '' }
            : internationalFromPhone(payload.phone);

        if (abroad.international) {
            payload.state = '';
            payload.district = '';
            payload.block = '';
            payload.isInternational = true;
            payload.country = abroad.country || (userDetails && userDetails.country) || '';
            payload.place = String(
                applicationData.place || (userDetails && (userDetails.place || userDetails.city)) || '',
            ).trim().slice(0, 200);

            /* `buildGeoFilter` also matches the region inside the submitted form
               (`data.personalDetails.*`, `data.personal.*`). Cleared there too,
               or a stray state in the form data would put this file in a tier
               admin's queue after all. */
            const data = payload.data && typeof payload.data === 'object' ? { ...payload.data } : null;
            if (data) {
                ['personalDetails', 'personal'].forEach((k) => {
                    if (data[k] && typeof data[k] === 'object') {
                        data[k] = { ...data[k], state: '', district: '', block: '' };
                    }
                });
                payload.data = data;
            }
        } else {
            const coverage = await regionService.validateRegion({
                state: payload.state,
                district: payload.district,
                block: payload.block
            });

            if (!coverage.ok) {
                throw ApiError.badRequest(coverage.reason);
            }
            if (coverage.region) {
                payload.state = coverage.region.state;
                payload.district = coverage.region.district;
                payload.block = coverage.region.block;
            }
            payload.isInternational = false;
        }

        const application = new Application({
            userId: userId,
            ...payload,
            // One pending state. Every admin in the applicant's own region —
            // block, district and state — sees it from this moment.
            status: 'Pending'
        });

        await application.save();

        await this.logActivity(userId, 'application_submitted', 'Application', application._id,
            'Membership application submitted');

        notificationService.dispatchInBackground('APPLICATION_SUBMITTED', {
            id: userId,
            name: application.fullName,
            email: application.email,
            phone: application.phone,
            whatsapp: application.phone,
            state: application.state,
            district: application.district,
            block: application.block
        }, {
            application,
            reference: String(application._id || '').slice(-6).toUpperCase()
        });

        /*
         * Record what the applicant is, on the profile that describes them.
         *
         * The `MemberAuth` half of this used to write `role`, `memberType` and
         * `registrationType` to the `auth` collection. That collection holds an
         * email, a password and a flag and nothing else — by design, so a
         * credential store cannot leak profile data — so strict mode dropped all
         * three every time and reported nothing. It is gone rather than fixed:
         * the fields belong on the profile, not beside the password.
         *
         * The `MemberDetails` half threw instead of dropping, because `role`'s
         * enum did not include `aspirant`. Both failures landed in the same
         * catch and produced one "Non-fatal" warning, which is why nobody
         * noticed that the declared member type was never stored anywhere.
         */
        try {
            if (userDetails && userDetails.save) {
                /*
                 * `role` is deliberately NOT written here.
                 *
                 * It is the authorization role — 'member' or an admin tier — and
                 * this used to overwrite it with the *member type* ('business' /
                 * 'aspirant'). Nothing failed at the time, so it looked harmless.
                 * The damage landed at the member's NEXT sign-in: `login()` mints
                 * the token from `memberDetails.role`, so the session came back
                 * as role 'business', and every client check of the shape
                 * `role === 'member'` stopped matching. On the website that is
                 * `isMemberSession()`, which gates `ProfileContext` — so the
                 * member's profile completion, form list and event count were
                 * never loaded and the bar read 0% however much they had filled
                 * in. It only appeared after a logout, because the session
                 * written at registration still said 'member'.
                 *
                 * The declared type has two fields of its own, below, and both
                 * clients already read them.
                 */
                userDetails.memberType = isAspirant ? 'aspirant' : 'business';
                userDetails.registrationType = isAspirant ? 'aspirant' : 'business';
                await userDetails.save();
            }
        } catch (updateErr) {
            // Still non-fatal: the application itself is already saved, and the
            // member type can be re-derived from it. But say what actually
            // failed rather than logging the whole error object.
            logger.warn('Could not stamp member type on the profile', {
                userId: String(userId || ''),
                role: derivedRole,
                error: updateErr && updateErr.message
            });
        }

        await cacheClient.del(CACHE_KEYS.APPLICATION_USER(userId));
        // Every tier dashboard is a cached, region-scoped view of exactly this
        // data, and a review is precisely the event that makes it wrong. Clear
        // the whole pattern rather than reason about which regions moved: a
        // rejection can change what three tiers see, and a queue an admin is
        // about to act on is the one thing that must never be stale.
        await cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null);

        // Acknowledge the submission. Without this the notification list is
        // empty until the first admin acts, which reads as "nothing happened"
        // to an applicant who has just filled in four forms.
        /*
         * Bell, email and WhatsApp from one call.
         *
         * `application` is handed in so the dispatcher resolves the applicant's
         * OWN Block Admin and puts that admin's real address in the Reply-To —
         * the applicant can answer this email and reach the person now holding
         * their file, rather than a no-reply mailbox.
         *
         * Not awaited: `dispatchInBackground` cannot throw, and three network
         * calls have no business sitting between an applicant pressing Submit
         * and seeing their confirmation. The submission is already saved.
         */
        notificationService.dispatchInBackground('APPLICATION_SUBMITTED', {
            id: userId,
            name: application.fullName,
            email: application.email,
            phone: application.phone,
            state: application.state,
            district: application.district,
            block: application.block
        }, {
            application,
            reference: String(application._id).slice(-6).toUpperCase(),
            data: { applicationId: String(application._id) }
        });

        logger.info('Application submitted', {
            applicationId: application._id,
            userId,
            status: 'Pending'
        });

        return application;
    }

    /**
     * Fill an empty `data` section from the member's own records.
     *
     * The application carries a snapshot of the four forms, taken at submit
     * time. Applications created before the submit path was corrected were
     * written with an EMPTY envelope — `data.personalDetails`,
     * `data.businessInfo`, `data.financialInfo` and `data.declaration` all `{}`
     * — because the client posted no `data` at all. The member's real answers
     * were never lost; they live in the four member collections, which is where
     * `updateMember` writes them.
     *
     * So an admin opening such an application saw only the handful of columns
     * stored flat on the application row (name, email, phone, region) and
     * nothing else — a "Business Member" with no Business or Financial section
     * at all, which reads as though they had filled nothing in.
     *
     * A section is only filled in when it is genuinely empty, so a real
     * snapshot always wins: the application must keep showing what was true
     * when it was submitted, not what the member edited afterwards.
     */
    async hydrateApplicationSections(application) {
        if (!application) return application;

        const plain = typeof application.toObject === 'function' ? application.toObject() : { ...application };
        const data = plain.data || {};

        const isEmpty = (section) =>
            !section || Object.keys(section).filter((k) => {
                const v = section[k];
                if (v === null || v === undefined) return false;
                if (Array.isArray(v)) return v.length > 0;
                return String(v).trim() !== '';
            }).length === 0;

        const personalEmpty = isEmpty(data.personalDetails || data.personal);
        const businessEmpty = isEmpty(data.businessInfo || data.business);
        const financialEmpty = isEmpty(data.financialInfo || data.financial);
        const declarationEmpty = isEmpty(data.declaration);

        if (!personalEmpty && !businessEmpty && !financialEmpty && !declarationEmpty) return plain;

        /**
         * Resolve the member first, and do not trust `application.userId`.
         *
         * That path is declared `ref: 'MemberAuth'` — the "web auth" collection
         * — while the four form collections are keyed on the MemberDetails
         * ("web users") id. When the caller has already `.populate()`d it, a ref
         * that resolves to nothing leaves the path as `null`, taking the raw id
         * with it, so reading `plain.userId` after a populate can yield neither
         * a document nor an id.
         *
         * The email is the reliable second route: it is stored flat on the
         * application and is unique on MemberDetails.
         */
        const rawUserId = plain.userId && plain.userId._id ? plain.userId._id : plain.userId;

        let member = null;
        if (rawUserId) member = await MemberDetails.findById(rawUserId).lean().catch(() => null);
        if (!member && plain.email) {
            member = await MemberDetails.findOne({ email: String(plain.email).toLowerCase() })
                .lean().catch(() => null);
        }
        if (!member) return plain;

        const memberId = member._id;

        const [business, financial, declaration] = await Promise.all([
            businessEmpty ? BusinessInfo.findOne({ userId: memberId }).lean().catch(() => null) : null,
            // `+panNumber` because the field is `select: false` on the schema.
            financialEmpty ? MemberFinancialInfo.findOne({ memberId })
                .select('+panNumber').lean().catch(() => null) : null,
            declarationEmpty ? MemberDeclaration.findOne({
                $or: [{ userId: memberId }, { memberId }]
            }).lean().catch(() => null) : null,
        ]);

        const strip = (doc) => {
            if (!doc) return null;
            const { _id, __v, userId, memberId, createdAt, updatedAt, ...rest } = doc;
            return rest;
        };

        plain.data = { ...data };
        if (personalEmpty && member) {
            plain.data.personalDetails = {
                ...(data.personalDetails || {}),
                fullName: member.fullName,
                email: member.email,
                phone: member.phoneNumber,
                phoneNumber: member.phoneNumber,
                state: member.state,
                district: member.district,
                block: member.block,
                city: member.city,
                religion: member.religion,
                socialCategory: member.socialCategory,
                gender: member.gender,
                dateOfBirth: member.dateOfBirth,
                aadhaarNumber: member.aadhaarNumber,
            };
        }
        if (businessEmpty && business) plain.data.businessInfo = { ...(data.businessInfo || {}), ...strip(business) };
        if (financialEmpty && financial) plain.data.financialInfo = { ...(data.financialInfo || {}), ...strip(financial) };
        if (declarationEmpty && declaration) plain.data.declaration = { ...(data.declaration || {}), ...strip(declaration) };

        return plain;
    }

    async getApplicationById(id) {
        const cached = await cacheClient.get(CACHE_KEYS.APPLICATION(id));
        if (cached) return cached;

        // The schema field is `userId`, not `user` — populating a path that does
        // not exist makes Mongoose throw StrictPopulateError, so this endpoint
        // returned 500 for every application.
        const application = await Application.findById(id).populate('userId', 'fullName email');
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        const hydrated = await this.hydrateApplicationSections(application);

        await cacheClient.set(CACHE_KEYS.APPLICATION(id), hydrated, CACHE_TTL.MEDIUM);
        return hydrated;
    }

    async getUserApplications(userId) {
        /*
           The member's own row, from the shared fifteen-second cache.

           It is read here for ONE field — the email the legacy applications are
           keyed by — and it was a full round trip of its own in front of the
           query that actually matters. Against this cluster that is 400–500ms,
           and this endpoint was logged at 1,111ms for a member with one
           application. Almost every request that reaches here has already
           warmed the same entry through `resolveMemberContext`.
        */
        const userDetails = await memberSnapshot(String(userId || ''));
        const userEmail = userDetails ? userDetails.email : null;

        const queryConditions = [
            { userId: userId },
            { user: userId }
        ];

        if (userEmail) {
            queryConditions.push({ email: userEmail });
        }

        const applications = await Application.find({ $or: queryConditions })
            .sort({ createdAt: -1 })
            .lean();

        /*
         * THE THREE TIER VERDICTS, RESOLVED HERE AND NOT IN THE BROWSER.
         *
         * The applicant's own status screen shows Block, District, State and
         * then Payment, so it needs to know what each tier has said. The raw
         * document cannot answer that on its own: a verdict may be in
         * `reviews.<tier>`, or — on anything decided before that field existed —
         * only in `approvedBy` / `rejectedBy` or a per-tier timestamp, and
         * `stateApprovedAt` specifically must NOT be read as the State's own
         * verdict because every approval stamps it.
         *
         * That rule already exists once, in `common/tierReviews.js`, and the
         * admin dashboards go through it. Re-deriving it in the member client
         * would be a second copy of it over the same fields — the reliable way
         * to end up with an applicant's screen and their admin's screen
         * disagreeing about who approved what.
         */
        return applications.map(app => ({
            ...app,
            tierReviews: tierReviews.tierVerdicts(app),
            /** The application's outcome. Only the State writes it. */
            outcome: normalizeStatus(app.status)
        }));
    }

    async getApplications(filter = {}, page = 1, limit = 20) {
        const skip = (page - 1) * limit;

        const applications = await Application.find(filter)
            .populate('userId', 'fullName email')
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

        const total = await Application.countDocuments(filter);

        return {
            applications,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        };
    }

    /**
     * The generic status write, used by `PATCH /applications/:id/status`.
     *
     * It goes through the same one-step table as the review endpoints — a
     * pending file may be approved or rejected and nothing else — so this route
     * cannot be used to put an application into a state the review path would
     * refuse. Approving through here does NOT create the member profile; that
     * is `decide()`'s job, and this route exists for corrections rather than for
     * approvals.
     */
    async updateApplicationStatus(id, status, comment, adminId) {
        const application = await Application.findById(id);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        const current = normalizeStatus(application.status);
        const allowed = ALLOWED_TRANSITIONS[current] || [];

        // No reopening a terminal decision, and no status outside the table.
        if (!allowed.includes(status)) {
            throw ApiError.badRequest(
                `Illegal status transition: ${current} -> ${status}. Allowed: ${allowed.join(', ') || 'none'}`
            );
        }

        application.status = status;

        // `notes` is the schema's audit array — the previously referenced
        // `approvalHistory` field does not exist and threw on every call.
        application.notes.push({
            adminId,
            adminType: 'SuperAdmin',
            note: comment || `Status changed from ${current} to ${status}`,
            createdAt: new Date()
        });

        if (status === 'Approved') {
            application.stateApprovedAt = new Date();
            application.approvedBy = { adminId, adminType: 'SuperAdmin', approvedAt: new Date() };
        }
        if (status === 'Rejected') {
            application.rejectionReason = comment || application.rejectionReason || 'Rejected';
            application.rejectedBy = {
                adminId,
                adminType: 'SuperAdmin',
                rejectedAt: new Date()
            };
        }

        await application.save();
        await cacheClient.del(CACHE_KEYS.APPLICATION(id));
        await cacheClient.del(CACHE_KEYS.APPLICATION_USER(application.userId));
        // Every tier dashboard is a cached, region-scoped view of exactly this
        // data, and a review is precisely the event that makes it wrong. Clear
        // the whole pattern rather than reason about which regions moved: one
        // decision changes what three tiers see, and a queue an admin is about
        // to act on is the one thing that must never be stale.
        await cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null);

        return application;
    }

    /**
     * Is there a decision left to make on this file?
     *
     * That is the whole gate now. It used to also ask *whose turn it is*, and
     * escalate the answer when the tier whose turn it was had no admin — two
     * questions that only existed because the review was sequential. Every tier
     * in the region holds a pending file simultaneously, so the only way to be
     * out of turn is to be second.
     *
     * Which region the acting admin may touch is a separate question, asked and
     * answered by `assertWithinScope` before this. Neither check substitutes for
     * the other: this one stops a double decision, that one stops a decision on
     * somebody else's applicant.
     */
    assertDecidable(application) {
        if (!isPending(application.status)) {
            const status = normalizeStatus(application.status);
            throw ApiError.badRequest(
                status === 'Approved'
                    ? 'This application has already been approved'
                    : 'This application has already been rejected'
            );
        }
    }

    /**
     * Has THIS TIER already recorded its verdict?
     *
     * The gate used to be `assertDecidable` — "has ANYBODY decided" — which was
     * right while the three tiers shared one verdict and wrong the moment they
     * stopped. Under one shared verdict the State approving closed the District
     * out of a file it had never looked at, and the District's Hub showed the
     * row as Approved: the District was told it had made a decision it had not.
     *
     * Each tier now signs its own slot, so the only thing that can be out of
     * turn is signing twice. A Block or District admin may still record their
     * view of an applicant the State has already approved — that is an
     * endorsement on the record and it changes nothing about the membership.
     *
     * The deciding seat is the exception, and `tierReviews.canTierAct` carries
     * it: once an outcome exists the seat is signed, whoever signed it, because
     * the member documents are written and no later verdict can unwrite them.
     */
    assertTierDecidable(application, tier) {
        if (tierReviews.canTierAct(application, tier)) return;

        const seat = tierReviews.decidesOutcome(tier) ? tierReviews.DECIDING_TIER : tier;
        const verdict = tierReviews.tierVerdict(application, seat);
        const label = tierReviews.TIER_LABELS[seat] || 'This tier';

        if (tierReviews.decidesOutcome(tier)) {
            throw ApiError.badRequest(
                verdict.decision === 'rejected'
                    ? 'This application has already been rejected'
                    : 'This application has already been approved'
            );
        }

        throw ApiError.badRequest(
            `The ${label} Admin has already ${verdict.decision === 'rejected' ? 'rejected' : 'approved'} this application`
        );
    }

    /**
     * Drop every cached view of an application that a review has just changed.
     *
     * The three tier dashboards are cached, keyed by tier and region. Both
     * clients POST the decision and then immediately refetch the dashboard to
     * pick up the new counts — well inside that window — so the refetch was
     * answered from the entry written *before* the approval. The card reverted
     * to "Pending" with its Approve / Reject buttons still on it, and the admin
     * was looking at a queue the database no longer agreed with.
     *
     * Failing here must not fail the review, which has already been committed,
     * so every call is caught.
     */
    async invalidateReviewCaches(application) {
        const id = application && application._id ? String(application._id) : '';
        const ownerId = application && (application.userId || application.user);

        await Promise.all([
            id ? cacheClient.del(CACHE_KEYS.APPLICATION(id)).catch(() => null) : null,
            ownerId ? cacheClient.del(CACHE_KEYS.APPLICATION_USER(ownerId)).catch(() => null) : null,
            // The whole pattern rather than one region: one decision closes the
            // file for all three tiers at once, and a queue an admin is about to
            // act on is the one thing that must never be stale.
            cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null)
        ]);
    }

    /**
     * =====================================================================
     * THE ONE REVIEW PATH
     * =====================================================================
     *
     * Approve or reject, acting as `tier`. There were three of these, one per
     * tier, and they differed in exactly two ways that mattered: which
     * timestamp they stamped, and whether they created the member profile. With
     * a single decision ending the review, those two differences collapse —
     * every approval is the final one — and three near-identical methods with
     * one real behaviour between them is three places for that behaviour to
     * drift.
     *
     * Two gates, in this order, and both are load-bearing:
     *
     *   1. `assertWithinScope` — this applicant is in YOUR block / district /
     *      state. Reading the dashboard is already geofenced, but an admin who
     *      learns an application id must not be able to decide a file from
     *      another region by calling the endpoint directly. `super_admin` is
     *      exempt; nobody else is.
     *   2. `assertTierDecidable` — YOU have not decided it yet. Not "nobody
     *      has": the three tiers hold three separate verdicts, and the District
     *      still owes theirs on a file the State has approved.
     *
     * ONLY THE STATE'S VERDICT IS THE APPLICATION'S OUTCOME — and the Super
     * Admin's, filling that seat. A Block or District verdict is an endorsement:
     * it is recorded against that tier, it is shown to everyone, and it writes
     * nothing to `status`, creates no member and closes nothing. The whole rule
     * is in `common/tierReviews.js`.
     */
    async decide(applicationId, action, tier, adminId, rejectionReason = null, user = null) {
        if (action !== 'approve' && action !== 'reject') {
            throw ApiError.badRequest('Invalid action. Use "approve" or "reject"');
        }

        const application = await Application.findById(applicationId);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        if (user) await this.assertWithinScope(application, tier, user);
        this.assertTierDecidable(application, tier);

        const actor = TIER_ACTOR[tier] || 'BlockAdmin';
        const label = TIER_LABEL[tier] || 'Block';
        const approving = action === 'approve';

        /*
         * Which slot this signs. A Super Admin signs the deciding seat, because
         * that is the seat they are filling — recording their decision under a
         * fourth name would leave the State slot looking unanswered forever on a
         * region that has no state admin, which is the case they exist for.
         */
        const seat = tierReviews.decidesOutcome(tier) ? tierReviews.DECIDING_TIER : tier;
        const writesOutcome = tierReviews.decidesOutcome(tier);

        /*
         * Pin down every verdict this row already carries BEFORE writing a new
         * one. `commitFinalApproval` overwrites `approvedBy`, which on a legacy
         * row is the only record of the tier that approved it — a State
         * approval erased a District's decision on a live applicant exactly
         * once, and this is what stops it happening twice.
         */
        tierReviews.materialiseLegacyVerdicts(application);

        if (!application.reviews) application.reviews = {};
        const decidedAt = new Date();

        application.reviews[seat] = {
            decision: approving ? 'approved' : 'rejected',
            adminId,
            adminType: actor,
            decidedAt,
            reason: approving ? '' : (rejectionReason || ''),
            auto: false
        };

        /*
         * ------------------------------------------------------------------
         * THE APPROVAL CARRIES THE TIERS BELOW IT.
         * ------------------------------------------------------------------
         * A State approval settles the District's step and the Block's; a
         * District approval settles the Block's; a Super Admin settles all
         * three. The whole rule, and what it deliberately does NOT do, is in
         * `tierReviews.TIERS_BELOW`.
         *
         * Only onto tiers that have not decided for themselves — an explicit
         * verdict, approval or rejection, is left exactly as its tier recorded
         * it. And only on an APPROVAL: a rejection ends the application through
         * `status` and has no business writing words into a slot belonging to a
         * tier that never opened the file.
         */
        if (approving) {
            for (const below of tierReviews.tiersBelow(tier)) {
                // `hasOwnVerdict`, not `hasTierDecided` — see the note on it.
                // The carried derivation would report every tier below as
                // already decided the instant this tier's slot was written, and
                // nothing would ever be persisted.
                if (tierReviews.hasOwnVerdict(application, below)) continue;
                application.reviews[below] = {
                    decision: 'approved',
                    adminId,
                    adminType: actor,
                    decidedAt,
                    reason: '',
                    // Not this tier's own decision. `adminType` names who it
                    // really was; this says the tier did not act itself.
                    auto: true
                };
            }
        }
        // `reviews` is a plain nested path rather than a sub-document array, and
        // assigning the whole object does not always mark it dirty on a document
        // loaded before the field existed — which is every legacy row.
        application.markModified('reviews');

        /*
         * ------------------------------------------------------------------
         * AN ENDORSEMENT: recorded, and that is all.
         * ------------------------------------------------------------------
         * No status write, no member profile. The dashboards still have to be
         * cleared, because this tier's own bucket for this applicant has just
         * changed.
         */
        if (!writesOutcome) {
            await application.save();

            logger.info('Tier verdict recorded', { applicationId, adminId, tier, action });

            await this.recordReviewAudit(application, tier, action, adminId, user, {
                endorsement: true,
                reason: approving ? '' : (rejectionReason || '')
            });
            await this.invalidateReviewCaches(application);

            return {
                success: true,
                // The APPLICATION's status, which this did not change. Returning
                // 'Approved' here because a block admin approved would tell the
                // client a membership had been granted.
                status: normalizeStatus(application.status),
                tier,
                decision: approving ? 'approved' : 'rejected',
                decidesOutcome: false,
                message: approving
                    ? `Recorded: the ${label} Admin approves this applicant. The State Admin grants the membership.`
                    : `Recorded: the ${label} Admin objects to this applicant. The State Admin decides the application.`
            };
        }

        /*
         * ------------------------------------------------------------------
         * THE OUTCOME.
         * ------------------------------------------------------------------
         */
        if (approving) {
            // Approval writes five documents across five collections. They must
            // land together: a partial write leaves an orphaned member row whose
            // unique email then blocks every retry, stranding the applicant
            // permanently. Run it as one transaction where the server supports it.
            // The review slot set above rides along on the same save.
            //
            // Safe to run over a profile that already exists — the one case
            // being a row a lower tier approved under the previous build, which
            // the State is now ratifying. `createMemberProfile` looks each
            // document up before writing and updates it in place, so this
            // cannot produce the duplicate the unique email index would make
            // permanent.
            const memberProfile = await this.commitFinalApproval(application, adminId, tier);

            logger.info('Application approved', {
                applicationId,
                adminId,
                tier,
                memberId: memberProfile.memberDetails._id
            });

            await this.recordReviewAudit(application, tier, 'approve', adminId, user, {
                newStatus: 'Approved',
                memberCreated: true
            });
            await this.invalidateReviewCaches(application);

            return {
                success: true,
                status: 'Approved',
                decidedBy: tier,
                tier,
                decision: 'approved',
                decidesOutcome: true,
                message: `Application approved by the ${label} Admin. Member profile created.`,
                memberId: memberProfile.memberDetails._id,
                memberProfile
            };
        }

        /*
         * A REJECTION MUST NOT ORPHAN A MEMBER PROFILE.
         *
         * Reachable on exactly one shape of row: one the PREVIOUS build let a
         * Block or District admin approve, which wrote the member's documents
         * and stamped `Approved`. The State's seat is still open on it — under
         * this rule a lower tier never made anybody a member, so the State has
         * still to say so — and their answer might be no.
         *
         * Flipping the status to Rejected would leave five member documents
         * behind, with a member code and an Active badge, belonging to an
         * application that says it was refused. Deleting them instead would
         * revoke a membership somebody may have paid for, silently, as a side
         * effect of an ordinary-looking Reject button.
         *
         * Neither is a decision this code should take, so it refuses and says
         * why. Approving is unaffected: `createMemberProfile` upserts, so the
         * State ratifying an existing profile updates it rather than duplicating
         * it — and duplication is what the unique email index would make
         * permanent.
         */
        if (!isPending(application.status)) {
            const existingMember = await MemberDetails.findOne({
                $or: [{ userId: application.userId }, { memberId: application.userId }]
            }).lean().catch(() => null);

            if (existingMember) {
                throw ApiError.badRequest(
                    'This applicant already has a member profile, created when an earlier '
                    + 'version allowed a Block or District Admin to approve. Rejecting would '
                    + 'leave that profile with no application behind it. Suspend the member '
                    + 'from the Members screen instead, or ask the Super Admin to remove the '
                    + 'profile first.'
                );
            }
        }

        application.status = 'Rejected';
        application.rejectionReason = rejectionReason || `Rejected by ${label} Admin`;
        // `rejectedAt` lives inside `rejectedBy` in the schema; a top-level
        // assignment is silently dropped and the timestamp is lost.
        application.rejectedBy = {
            adminId,
            adminType: actor,
            rejectedAt: new Date()
        };

        await application.save();

        logger.info('Application rejected', { applicationId, adminId, tier, reason: rejectionReason });

        await this.recordReviewAudit(application, tier, 'reject', adminId, user, {
            reason: rejectionReason || ''
        });
        await this.invalidateReviewCaches(application);

        return {
            success: true,
            status: 'Rejected',
            decidedBy: tier,
            tier,
            decision: 'rejected',
            decidesOutcome: true,
            message: 'Application rejected'
        };
    }

    /*
     * The three named endpoints, kept.
     *
     * `/block-review`, `/district-review` and `/state-review` are what the
     * mobile app ships against, and a released build cannot be asked to change
     * its URL. They differ only in the tier they sign the decision as — which is
     * still worth recording, because "who approved this applicant" is a real
     * question even when any of the three could have.
     */
    blockAdminReview(applicationId, action, adminId, rejectionReason = null, user = null) {
        return this.decide(applicationId, action, 'block', adminId, rejectionReason, user);
    }

    districtAdminReview(applicationId, action, adminId, rejectionReason = null, user = null) {
        return this.decide(applicationId, action, 'district', adminId, rejectionReason, user);
    }

    stateAdminReview(applicationId, action, adminId, rejectionReason = null, user = null) {
        return this.decide(applicationId, action, 'state', adminId, rejectionReason, user);
    }

    /**
     * Commit the final approval: member profile (4 collections) + the status
     * flip on the application, all or nothing.
     *
     * Uses a MongoDB transaction when the deployment supports one (Atlas and any
     * replica set). On a standalone server transactions are unavailable, so we
     * fall back to sequential writes with compensating deletes — weaker, but it
     * still avoids leaving an orphaned member row behind.
     */
    async commitFinalApproval(application, adminId, tier = 'state') {
        /*
         * WHO SIGNED IT, recorded once and honestly.
         *
         * This used to stamp `stateApprovedAt` and `reviewedBy.stateAdmin`
         * unconditionally, because only a state admin could ever reach it. Any
         * of the three tiers reaches it now, and writing every approval down as
         * the state's would put a block admin's decision under another admin's
         * name on the applicant's own record.
         *
         * `stateApprovedAt` is still set whoever acted. It is what the member
         * screens and the mobile app read as "the date this was approved", and
         * a released build cannot be asked to look somewhere else. `approvedBy`
         * is the field that carries the truth.
         */
        const TIER_FIELD = {
            block: 'blockApprovedAt',
            district: 'districtApprovedAt',
            state: 'stateApprovedAt'
        };
        const ACTOR = {
            block: 'BlockAdmin',
            district: 'DistrictAdmin',
            state: 'StateAdmin',
            super: 'SuperAdmin'
        };

        const markApproved = () => {
            const now = new Date();
            application.status = 'Approved';
            application.stateApprovedAt = now;
            if (TIER_FIELD[tier]) application[TIER_FIELD[tier]] = now;
            if (tier === 'block') application.reviewedBy.blockAdmin = adminId;
            else if (tier === 'district') application.reviewedBy.districtAdmin = adminId;
            else application.reviewedBy.stateAdmin = adminId;
            application.approvedBy = {
                adminId,
                adminType: ACTOR[tier] || 'StateAdmin',
                approvedAt: now
            };
        };

        const session = await mongoose.startSession();
        try {
            let profile = null;

            await session.withTransaction(async() => {
                profile = await this.createMemberProfile(application, adminId, session);
                markApproved();
                await application.save({ session });
            });

            return profile;
        } catch (error) {
            const unsupported = /Transaction numbers are only allowed|replica set|Transactions are not supported/i
                .test(error.message || '');

            if (!unsupported) throw error;

            logger.warn('Transactions unavailable; falling back to compensating writes');

            const created = [];
            try {
                const profile = await this.createMemberProfile(application, adminId, null, created);
                markApproved();
                await application.save();
                return profile;
            } catch (innerError) {
                // Undo whatever landed so a retry is not blocked by a half-written
                // profile (the unique email index would reject it forever).
                for (const doc of created.reverse()) {
                    await doc.deleteOne().catch(() => null);
                }
                throw innerError;
            }
        } finally {
            session.endSession();
        }
    }

    /**
     * Create member profile in 4 collections after final approval.
     *
     * @param session  Mongoose session when running inside a transaction.
     * @param track    Optional array collecting saved docs so a non-transactional
     *                 caller can roll them back.
     */
    async createMemberProfile(application, approvedByAdminId, session = null, track = null) {
        const formData = application.data || {};
        const personalDetails = formData.personalDetails || formData.personal || formData;
        const businessInfo = formData.businessInfo || formData.business || formData;
        const financialInfo = formData.financialInfo || formData.financial || formData;
        const declarationData = formData.declaration || formData;

        // `socialCategory` is enum-constrained on MemberDetails but arrives as
        // free text from legacy records and imports. An unrecognised value must
        // not block an otherwise valid approval, so fall back to unset.
        const SOCIAL_CATEGORIES = ['Christian ST', 'Christian SC', 'ST', 'SC', 'Others', ''];
        const rawCategory = personalDetails.socialCategory || '';
        const socialCategory = SOCIAL_CATEGORIES.includes(rawCategory) ? rawCategory : '';
        if (rawCategory && socialCategory !== rawCategory) {
            logger.warn('Unrecognised socialCategory on application; storing as unset', {
                applicationId: application._id,
                received: rawCategory
            });
        }

        // Single save path so every document joins the transaction (or gets
        // tracked for rollback) without repeating the plumbing four times.
        const saveDoc = async(doc) => {
            await doc.save(session ? { session } : undefined);
            if (track) track.push(doc);
            return doc;
        };

        try {
            // 1. MemberDetails (Core Profile).
            //
            // Registration already creates this row, so blindly inserting a second
            // one hits the unique email index and fails EVERY approval for anyone
            // who signed up through the app. Update the existing row when there is
            // one, insert only when there isn't.
            //
            // The key field is `userId` — writing `memberId` instead meant Mongoose
            // silently dropped it in strict mode, leaving approved members with no
            // link back to their account.
            const memberFields = {
                userId: application.userId,
                fullName: application.fullName,
                email: application.email,
                phoneNumber: application.phone,
                state: application.state,
                district: application.district,
                block: application.block,
                city: personalDetails.city,
                /* Only when true: an Indian application must not write `false`
                   over a member record, and blanks are dropped just below. */
                isInternational: application.isInternational === true ? true : undefined,
                country: application.country,
                place: application.place,
                aadhaarNumber: personalDetails.aadhaarNumber,
                educationalQualification: personalDetails.education,
                religion: personalDetails.religion,
                socialCategory,
                profileCompleted: true,
                approvedBy: approvedByAdminId,
                approvedBlock: application.block,
                approvedAt: new Date(),
                membershipStatus: 'pending', // Pending payment
                membershipType: 'none'
            };

            // Drop keys with no value so an existing profile never has real data
            // overwritten with blanks by an application that omitted a field.
            Object.keys(memberFields).forEach(k => {
                if (memberFields[k] === undefined || memberFields[k] === '') delete memberFields[k];
            });

            const existingQuery = {
                $or: [
                    { userId: application.userId },
                    ...(application.email ? [{ email: String(application.email).toLowerCase() }] : [])
                ]
            };

            let memberDetails = await MemberDetails.findOne(existingQuery).session(session || null);

            if (memberDetails) {
                memberDetails.set(memberFields);
                await saveDoc(memberDetails);
            } else {
                memberDetails = new MemberDetails(memberFields);
                await saveDoc(memberDetails);
            }

            // Each of the three remaining collections has a unique key, and the
            // member's 4-step profile form may already have written a row. Update
            // in place when one exists so approval is idempotent and never trips
            // a duplicate-key error.
            const upsert = async(Model, query, fields) => {
                const existing = await Model.findOne(query).session(session || null);
                if (existing) {
                    existing.set(fields);
                    return saveDoc(existing);
                }
                return saveDoc(new Model(fields));
            };

            // 2. BusinessInfo (for both aspirant and business members)
            let memberBusinessProfile = null;
            if (businessInfo.doingBusiness !== undefined || businessInfo.organizationName) {
                memberBusinessProfile = await upsert(
                    BusinessInfo,
                    { userId: application.userId },
                    {
                        userId: application.userId,
                        doingBusiness: businessInfo.doingBusiness === true,
                        registrationType: businessInfo.doingBusiness ? 'business' : 'aspirant',
                        organizationName: businessInfo.organizationName,
                        constitutionType: businessInfo.constitutionType,
                        businessTypes: businessInfo.businessTypes || [],
                        businessActivities: businessInfo.businessActivities,
                        businessCommencementYear: businessInfo.businessCommencementYear,
                        numberOfEmployees: businessInfo.numberOfEmployees,
                        memberOfOtherChamber: businessInfo.memberOfOtherChamber,
                        otherChamber: businessInfo.otherChamber,
                        govtOrganizations: businessInfo.govtOrganizations || [],
                        isLocked: true,
                        submittedAt: new Date()
                    }
                );
            }

            // 3. MemberFinancialInfo
            const memberFinancialProfile = await upsert(
                MemberFinancialInfo,
                { memberId: application.userId },
                {
                    memberId: application.userId,
                    panNumber: financialInfo.panNumber,
                    gstNumber: financialInfo.gstNumber,
                    udyamNumber: financialInfo.udyamNumber,
                    filedITR: financialInfo.itrFiled === true || financialInfo.filedITR === true,
                    turnoverRange: financialInfo.turnoverRange || financialInfo.lastYearTurnover,
                    govtSchemeBenefit: financialInfo.govtSchemeBenefit === true || (Array.isArray(financialInfo.govtSchemes) && financialInfo.govtSchemes.length > 0),
                    status: 'verified'
                }
            );

            // 4. MemberDeclaration — `userId` is the collection's real unique key;
            // `memberId` is kept populated for the member-facing lookups.
            const memberDeclarationProfile = await upsert(
                MemberDeclaration,
                { $or: [{ userId: application.userId }, { memberId: application.userId }] },
                {
                    userId: application.userId,
                    memberId: application.userId,
                    sisterConcerns: Number(declarationData.sisterConcerns || 0),
                    companyNames: Array.isArray(declarationData.companyNames) ? declarationData.companyNames : (declarationData.companyNames ? [declarationData.companyNames] : []),
                    agreeToDeclaration: declarationData.agreeToDeclaration === true || declarationData.agreeToTerms === true,
                    status: 'approved',
                    reviewedBy: approvedByAdminId,
                    reviewerModel: 'StateAdmin',
                    reviewedAt: new Date()
                }
            );

            logger.info('Member profile created in all 4 collections', {
                memberId: application.userId,
                memberDetailsId: memberDetails._id,
                hasBusinessProfile: !!memberBusinessProfile
            });

            return {
                memberDetails,
                memberBusinessInfo: memberBusinessProfile,
                memberFinancialInfo: memberFinancialProfile,
                memberDeclaration: memberDeclarationProfile
            };
        } catch (error) {
            // Surface the underlying reason. A bare 'Failed to create member
            // profile' gives an operator nothing to act on — Mongoose validation
            // errors name the exact offending path.
            const details = error.errors
                ? Object.entries(error.errors).map(([path, e]) => `${path}: ${e.message}`).join('; ')
                : error.message;

            logger.error(`Failed to create member profile: ${details}`, {
                error: error.message,
                details,
                applicationId: application._id
            });

            throw ApiError.internal(`Failed to create member profile — ${details}`);
        }
    }

    /**
     * Append one audit entry for a tier decision.
     *
     * Awaited but never fatal: audit.service.record swallows its own errors, so
     * a logging failure can never undo an approval that already committed.
     */
    async recordReviewAudit(application, tier, action, adminId, user = null, extra = {}) {
        const TIER_LABEL = { block: 'Block', district: 'District', state: 'State', super: 'Super' };
        const role = user?.role || `${tier}_admin`;
        // A super admin is not standing in for a tier any more — see
        // `reviewApplication`. The flag stays so the audit trail can still say a
        // decision came from outside the applicant's own region.
        const isProxy = role === 'super_admin';
        const applicant = application?.fullName || application?.email || 'an applicant';
        const verb = action === 'approve' ? 'approved' : 'rejected';

        // The applicant's own feed, alongside the admin audit trail below. The
        // two answer different questions: this one is "what happened to me",
        // the audit log is "who did what".
        await this.logActivity(
            application?.userId,
            action === 'approve' ? 'application_approved' : 'application_rejected',
            'Application',
            application?._id,
            action === 'approve'
                ? `Application approved by the ${TIER_LABEL[tier] || 'Block'} Admin`
                : `Application rejected by the ${TIER_LABEL[tier] || 'Block'} Admin`,
        );

        await auditService.record({
            action: `application.${verb}`,
            category: 'application',
            summary: isProxy
                ? `Super Admin ${verb} ${applicant}'s application`
                : `${TIER_LABEL[tier] || 'Block'} Admin ${verb} ${applicant}'s application`,
            actorId: adminId ? String(adminId) : '',
            actorEmail: user?.email || '',
            actorRole: role,
            proxy: isProxy,
            targetId: application?._id ? application._id.toString() : '',
            targetLabel: applicant,
            state: application?.state || '',
            district: application?.district || '',
            block: application?.block || '',
            metadata: { tier, ...extra }
        });

        // The applicant's own copy of the same event. Hooked here rather than at
        // each review outcome because every one of them already funnels through
        // this method — one place to keep correct instead of several that can
        // drift apart.
        await this.notifyApplicant(application, tier, action, extra);
    }

    /**
     * Tell the applicant what just happened to their file.
     *
     * Deliberately vague about *who* decided: an applicant is told their
     * application moved on, not which named admin at which tier signed it off.
     * A rejection carries the reason, because that is the one thing they can act
     * on.
     *
     * Never throws — `safeCreate` swallows and logs. An approval that succeeded
     * must not report failure because the notification could not be written; the
     * status transition has already been saved and, for a final approval, is
     * terminal and unrepeatable.
     */
    async notifyApplicant(application, tier, action, extra = {}) {
        const recipient = application?.userId;
        if (!recipient) return;

        const status = normalizeStatus(application?.status);

        /*
         * One recipient description, built once.
         *
         * The region fields are what the dispatcher resolves the applicant's own
         * Block/District/State admin from, so the email they receive can be
         * replied to and land in that admin's real inbox. Passing `application`
         * alongside them lets the resolver fall back to the copies inside
         * `data.personalDetails` on legacy rows, where the top-level fields are
         * empty — without that, an older application resolves to no region at
         * all and every reply goes to the support desk instead.
         */
        const to = {
            id: recipient,
            name: application.fullName,
            email: application.email,
            phone: application.phone,
            state: application.state,
            district: application.district,
            block: application.block
        };

        const reference = String(application._id || '').slice(-6).toUpperCase();
        const TIER_LABEL = {
            block: `${application.block || 'Block'} Block`,
            district: `${application.district || 'District'} District`,
            state: `${application.state || 'State'} State`,
            super: 'ACTIV Head Office'
        };

        if (action === 'reject') {
            const reason = String(extra.reason || application?.rejectionReason || '').trim();
            await notificationService.dispatchLifecycleEvent('CORRECTION_REQUESTED', to, {
                application,
                reference,
                reason,
                tierLabel: TIER_LABEL[tier] || `${application.block || 'Block'} Block`,
                data: { applicationId: String(application._id || ''), tier, reason }
            });
            return;
        }

        // Final approval is the one the applicant has been waiting for, and it
        // carries the next step — approval does not yet mean an active
        // membership, payment does.
        if (status === 'Approved') {
            await notificationService.dispatchLifecycleEvent('APPLICATION_APPROVED', to, {
                application,
                reference,
                state: application.state,
                data: { applicationId: String(application._id || '') }
            });
            return;
        }

        /*
         * THERE IS NO STAGE CHANGE LEFT TO ANNOUNCE.
         *
         * `STAGE_CHANGED` told an applicant their file had cleared one tier and
         * moved to the next — "cleared the Block review, now with your District
         * Admin". With one decision ending the review, an approval IS the final
         * approval and was sent above; nothing else can reach this line except a
         * file somebody left pending, which is not an event.
         *
         * Sending a stage message anyway would be worse than sending nothing: it
         * would tell an applicant whose membership has just been granted that
         * their application had been passed to somebody else.
         */
    }

    /**
     * Geofence the write path. Filtering the dashboard query is not enough on its
     * own: without this, an admin who learns an application id can approve a file
     * belonging to another block/district/state by calling the endpoint directly.
     */
    async assertWithinScope(application, tier, user = {}) {
        // Super admins operate above the geofence.
        if (user.role === 'super_admin') return;

        const { resolveAdminScope } = require('../admin/admin.service');
        const scope = await resolveAdminScope(user);

        const matches = (a, b) =>
            String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

        const personal = (application.data && (application.data.personalDetails || application.data.personal)) || {};

        if (tier === 'block') {
            const appBlock = application.block || personal.block;
            if (!matches(appBlock, scope.blockName)) {
                throw ApiError.forbidden('This application belongs to a different block');
            }
        } else if (tier === 'district') {
            const appDistrict = application.district || personal.district;
            if (!matches(appDistrict, scope.districtName)) {
                throw ApiError.forbidden('This application belongs to a different district');
            }
        } else if (tier === 'state') {
            const appState = application.state || personal.state;
            if (!matches(appState, scope.stateName)) {
                throw ApiError.forbidden('This application belongs to a different state');
            }
        }
    }

    /**
     * The generic `/approve` and `/reject` endpoints, which every dashboard uses.
     *
     * The caller's ROLE decides which tier signs the decision — a block admin
     * signs as the block, a state admin as the state. It no longer decides
     * WHETHER they may act: all three tiers hold a pending file at once, so the
     * only question left is the geofence, which `decide` asks.
     *
     * A super admin signs as themselves. They used to be mapped onto whichever
     * tier the file was sitting at and recorded as having acted "on behalf of"
     * it, which was the only way to express a super-admin decision in a
     * three-step machine. There are no steps to stand in for now, and a decision
     * attributed to a tier that never saw the file is a worse record than one
     * attributed to the person who actually made it.
     */
    async reviewApplication(applicationId, action, user = {}, rejectionReason = null) {
        const adminId = user.userId || user._id || user.id;
        const tier = ROLE_TO_TIER[user.role];

        if (!tier) {
            throw ApiError.forbidden('Your role cannot review applications');
        }

        return this.decide(applicationId, action, tier, adminId, rejectionReason, user);
    }

    async deleteApplication(id) {
        const application = await Application.findByIdAndDelete(id);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        await cacheClient.del(CACHE_KEYS.APPLICATION(id));
        await cacheClient.del(CACHE_KEYS.APPLICATION_USER(application.user));
        // Every tier dashboard is a cached, region-scoped view of exactly this
        // data, and a review is precisely the event that makes it wrong. Clear
        // the whole pattern rather than reason about which regions moved: a
        // rejection can change what three tiers see, and a queue an admin is
        // about to act on is the one thing that must never be stale.
        await cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null);

        return true;
    }
}

module.exports = new ApplicationService();