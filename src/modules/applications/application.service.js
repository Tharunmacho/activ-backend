const mongoose = require('mongoose');
const Application = require('./application.model');
const MemberAuth = require('../auth/auth.model');
const MemberDetails = require('../members/memberdetails.model');
const BusinessInfo = require('../members/businessinfo.model');
const MemberFinancialInfo = require('../members/memberfinancialinfo.model');
const MemberDeclaration = require('../members/memberdeclaration.model');
const ApiError = require('../../core/utils/ApiError');
const cacheClient = require('../../core/cache/cacheClient');
const { CACHE_KEYS, CACHE_TTL } = require('../../core/cache/cacheKeys');
const logger = require('../../config/logger');
const { normalizeStatus } = require('../common/applicationStatus');
const tierRouting = require('../common/tierRouting');
const regionService = require('../regions/region.service');
const auditService = require('../audit/audit.service');
const notificationService = require('../notifications/notification.service');

/**
 * The sequential approval state machine, keyed by *normalized* status.
 * 'Approved' and 'Rejected' are terminal.
 *
 *   Pending-Block --approve--> Pending-District --approve--> Pending-State --approve--> Approved
 *        |                            |                            |
 *        +---------- reject ----------+---------- reject ----------+--> Rejected
 */
const ALLOWED_TRANSITIONS = {
    'Pending-Block': ['Pending-District', 'Rejected'],
    'Pending-District': ['Pending-State', 'Rejected'],
    'Pending-State': ['Approved', 'Rejected'],
    'Approved': [],
    'Rejected': []
};

/** Which tier owns the decision when an application sits at a given status. */
const TRANSITION_ACTOR = {
    'Pending-Block': 'BlockAdmin',
    'Pending-District': 'DistrictAdmin',
    'Pending-State': 'StateAdmin'
};

/** Maps an admin role to the tier review it is allowed to perform. */
const ROLE_TO_TIER = {
    block_admin: 'block',
    district_admin: 'district',
    state_admin: 'state'
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
            status: { $in: ['PENDING', 'Pending-Block', 'Pending-District', 'Pending-State'] }
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

        const application = new Application({
            userId: userId,
            ...payload,
            status: 'Pending-Block' // Start with Block Admin review
        });

        await application.save();

        await this.logActivity(userId, 'application_submitted', 'Application', application._id,
            'Membership application submitted');

        // Update role in MemberAuth (users) & MemberDetails (members) in DB
        try {
            await MemberAuth.findByIdAndUpdate(userId, {
                role: derivedRole,
                memberType: isAspirant ? 'aspirant' : 'business',
                registrationType: isAspirant ? 'aspirant' : 'business'
            });
            if (userDetails && userDetails.save) {
                userDetails.role = derivedRole;
                userDetails.memberType = isAspirant ? 'aspirant' : 'business';
                userDetails.registrationType = isAspirant ? 'aspirant' : 'business';
                await userDetails.save();
            }
        } catch (updateErr) {
            logger.warn('Non-fatal error updating user role in DB:', updateErr);
        }

        await cacheClient.del(CACHE_KEYS.APPLICATION_USER(userId));

        // Acknowledge the submission. Without this the notification list is
        // empty until the first admin acts, which reads as "nothing happened"
        // to an applicant who has just filled in four forms.
        await notificationService.safeCreate(userId, {
            title: 'Application submitted',
            message: `Your ACTIV membership application has been submitted and is now with the `
                + `${payload.block || 'Block'} Block Admin for review.`,
            type: 'info',
            data: { event: 'application.submitted', applicationId: String(application._id) }
        });

        logger.info('Application submitted', {
            applicationId: application._id,
            userId,
            status: 'Pending-Block'
        });

        return application;
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

        await cacheClient.set(CACHE_KEYS.APPLICATION(id), application, CACHE_TTL.MEDIUM);
        return application;
    }

    async getUserApplications(userId) {
        const userDetails = await MemberDetails.findById(userId);
        const userEmail = userDetails ? userDetails.email : null;

        const queryConditions = [
            { userId: userId },
            { user: userId }
        ];

        if (userEmail) {
            queryConditions.push({ email: userEmail });
        }

        const applications = await Application.find({ $or: queryConditions }).sort({ createdAt: -1 });

        return applications;
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

    async updateApplicationStatus(id, status, comment, adminId) {
        const application = await Application.findById(id);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        const current = normalizeStatus(application.status);
        const allowed = ALLOWED_TRANSITIONS[current] || [];

        // The workflow is strictly sequential: no jumping straight to 'Approved'
        // from the block stage, and no reopening a terminal decision.
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
            adminType: TRANSITION_ACTOR[current] || 'BlockAdmin',
            note: comment || `Status changed from ${current} to ${status}`,
            createdAt: new Date()
        });

        if (status === 'Pending-District') application.blockApprovedAt = new Date();
        if (status === 'Pending-State') application.districtApprovedAt = new Date();
        if (status === 'Approved') application.stateApprovedAt = new Date();
        if (status === 'Rejected') {
            application.rejectionReason = comment || application.rejectionReason || 'Rejected';
            application.rejectedBy = {
                adminId,
                adminType: TRANSITION_ACTOR[current] || 'BlockAdmin',
                rejectedAt: new Date()
            };
        }

        await application.save();
        await cacheClient.del(CACHE_KEYS.APPLICATION(id));
        await cacheClient.del(CACHE_KEYS.APPLICATION_USER(application.userId));

        return application;
    }

    /**
     * Block Admin Review - Level 1
     */
    /**
     * Decide whether `tier` may act on this application, and what it absorbs.
     *
     * Normally a tier may only act on a file whose status names it. Orphan
     * fallback widens that: when the tier that formally owns the file has no
     * active admin, ownership bubbles up, and the tier it lands on may act — but
     * has to satisfy the steps it skipped, or the sequential state machine would
     * only advance the file into the acting tier's *own* queue and they would
     * have to approve the same application twice.
     *
     * Returns `{ fallback, absorbed, coverage }` or throws the same
     * "not pending your review" error as before when no escalation applies.
     */
    async resolveTierAction(application, tier) {
        const owner = tierRouting.owningTier(application);
        const TIER_LABEL = { block: 'Block', district: 'District', state: 'State' };

        if (!owner) {
            throw ApiError.badRequest(`Application is not pending ${TIER_LABEL[tier]} Admin review`);
        }
        if (owner === tier) {
            return { fallback: false, absorbed: [], coverage: null };
        }

        // A coverage lookup that fails must not silently widen who can act, so an
        // error here falls through to the normal rejection below.
        const coverage = await regionService.coverageFor({
            state: application.state,
            district: application.district,
            block: application.block
        }).catch(() => null);

        const effective = tierRouting.effectiveTier(application, coverage);
        if (!coverage || effective !== tier) {
            throw ApiError.badRequest(`Application is not pending ${TIER_LABEL[tier]} Admin review`);
        }

        return {
            fallback: true,
            absorbed: tierRouting.absorbedTiers(application, tier),
            coverage
        };
    }

    /**
     * Record the skipped tiers on the document, in memory.
     *
     * The caller saves. Each absorbed step gets its real timestamp and the acting
     * admin's id, plus a note naming them as a fallback — so the approval trail
     * shows who actually signed off rather than implying a block admin acted when
     * there was none.
     */
    stampAbsorbedTiers(application, absorbed = [], adminId, actingTier, user = null) {
        if (!absorbed || absorbed.length === 0) return;

        const now = new Date();
        const who = (user && user.email) ? ` (${user.email})` : '';
        const ACTING_LABEL = { block: 'Block', district: 'District', state: 'State' };

        absorbed.forEach((step) => {
            if (step === 'block' && !application.blockApprovedAt) {
                application.blockApprovedAt = now;
                application.reviewedBy.blockAdmin = adminId;
            } else if (step === 'district' && !application.districtApprovedAt) {
                application.districtApprovedAt = now;
                application.reviewedBy.districtAdmin = adminId;
            }

            application.notes.push({
                adminId,
                adminType: 'FallbackRouting',
                note: `No active ${ACTING_LABEL[step]} Admin for this region — step completed by the ` +
                    `${ACTING_LABEL[actingTier]} Admin under orphan fallback routing${who}`,
                createdAt: now
            });
        });
    }

    async blockAdminReview(applicationId, action, adminId, rejectionReason = null, user = null) {
        const application = await Application.findById(applicationId);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        if (user) await this.assertWithinScope(application, 'block', user);

        // Normalized so legacy rows ('PENDING', 'pending_block_approval', ...)
        // remain actionable instead of being permanently stuck.
        //
        // Block is the bottom tier, so nothing ever escalates *into* it — this
        // resolves to the plain gate. It goes through the shared helper anyway so
        // all three tiers reject an out-of-turn action with the same message.
        await this.resolveTierAction(application, 'block');

        if (action === 'approve') {
            application.status = 'Pending-District';
            application.blockApprovedAt = new Date();
            application.reviewedBy.blockAdmin = adminId;

            await application.save();

            logger.info('Application approved by Block Admin', {
                applicationId,
                adminId,
                newStatus: 'Pending-District'
            });

            await this.recordReviewAudit(application, 'block', 'approve', adminId, user, { newStatus: 'Pending-District' });

            return {
                success: true,
                status: 'Pending-District',
                message: 'Application approved. Forwarded to District Admin.'
            };
        } else if (action === 'reject') {
            application.status = 'Rejected';
            application.rejectionReason = rejectionReason || 'Rejected by Block Admin';
            application.rejectedBy = {
                adminId: adminId,
                adminType: 'BlockAdmin',
                rejectedAt: new Date()
            };

            await application.save();

            logger.info('Application rejected by Block Admin', {
                applicationId,
                adminId,
                reason: rejectionReason
            });

            await this.recordReviewAudit(application, 'block', 'reject', adminId, user, { reason: rejectionReason || '' });

            return {
                success: true,
                status: 'Rejected',
                message: 'Application rejected'
            };
        }

        throw ApiError.badRequest('Invalid action. Use "approve" or "reject"');
    }

    /**
     * District Admin Review - Level 2
     */
    async districtAdminReview(applicationId, action, adminId, rejectionReason = null, user = null) {
        const application = await Application.findById(applicationId);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        if (user) await this.assertWithinScope(application, 'district', user);

        // Gate: the district queue is only reachable once the block has approved
        // — or once the block has no active admin at all, in which case the file
        // has escalated here and the skipped block step is absorbed below.
        const routing = await this.resolveTierAction(application, 'district');

        if (action === 'approve') {
            this.stampAbsorbedTiers(application, routing.absorbed, adminId, 'district', user);

            application.status = 'Pending-State';
            application.districtApprovedAt = new Date();
            application.reviewedBy.districtAdmin = adminId;

            await application.save();

            logger.info('Application approved by District Admin', {
                applicationId,
                adminId,
                newStatus: 'Pending-State'
            });

            await this.recordReviewAudit(application, 'district', 'approve', adminId, user, {
                newStatus: 'Pending-State',
                fallback: routing.fallback,
                absorbedTiers: routing.absorbed
            });

            return {
                success: true,
                status: 'Pending-State',
                fallback: routing.fallback,
                absorbedTiers: routing.absorbed,
                message: routing.fallback
                    ? 'Application approved on behalf of the unstaffed Block tier. Forwarded to State Admin.'
                    : 'Application approved. Forwarded to State Admin.'
            };
        } else if (action === 'reject') {
            // A rejection is terminal, so no skipped step needs completing — but
            // the note still records that this tier only saw the file because the
            // one below it was unstaffed.
            if (routing.fallback) {
                this.stampAbsorbedTiers(application, routing.absorbed, adminId, 'district', user);
            }
            application.status = 'Rejected';
            application.rejectionReason = rejectionReason || 'Rejected by District Admin';
            // `rejectedAt` lives inside `rejectedBy` in the schema; a top-level
            // assignment is silently dropped and the timestamp is lost.
            application.rejectedBy = {
                adminId: adminId,
                adminType: 'DistrictAdmin',
                rejectedAt: new Date()
            };

            await application.save();

            logger.info('Application rejected by District Admin', {
                applicationId,
                adminId,
                reason: rejectionReason
            });

            await this.recordReviewAudit(application, 'district', 'reject', adminId, user, {
                reason: rejectionReason || '',
                fallback: routing.fallback,
                absorbedTiers: routing.absorbed
            });

            return {
                success: true,
                status: 'Rejected',
                message: 'Application rejected'
            };
        }

        throw ApiError.badRequest('Invalid action. Use "approve" or "reject"');
    }

    /**
     * State Admin Review - Level 3 (Final)
     * Creates member profile upon approval
     */
    async stateAdminReview(applicationId, action, adminId, rejectionReason = null, user = null) {
        const application = await Application.findById(applicationId);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        if (user) await this.assertWithinScope(application, 'state', user);

        // Gate: the state queue is only reachable once the district has approved
        // — or once every tier beneath is unstaffed, in which case the file has
        // escalated all the way here and those steps are absorbed below.
        const routing = await this.resolveTierAction(application, 'state');

        if (action === 'approve') {
            // Stamped before the transaction so the absorbed steps are part of the
            // same atomic write as the final approval, not a separate save that
            // could survive a rolled-back commit.
            this.stampAbsorbedTiers(application, routing.absorbed, adminId, 'state', user);

            // Final approval writes five documents across five collections. They
            // must land together: a partial write leaves an orphaned member row
            // whose unique email then blocks every retry, stranding the applicant
            // permanently. Run it as one transaction where the server supports it.
            const memberProfile = await this.commitFinalApproval(application, adminId);

            logger.info('Application approved by State Admin - Member profile created', {
                applicationId,
                adminId,
                memberId: memberProfile.memberDetails._id
            });

            await this.recordReviewAudit(application, 'state', 'approve', adminId, user, {
                newStatus: 'Approved',
                memberCreated: true,
                fallback: routing.fallback,
                absorbedTiers: routing.absorbed
            });

            return {
                success: true,
                status: 'Approved',
                message: 'Application approved! Member profile created successfully.',
                memberId: memberProfile.memberDetails._id,
                memberProfile
            };
        } else if (action === 'reject') {
            if (routing.fallback) {
                this.stampAbsorbedTiers(application, routing.absorbed, adminId, 'state', user);
            }
            application.status = 'Rejected';
            application.rejectionReason = rejectionReason || 'Rejected by State Admin';
            application.rejectedBy = {
                adminId: adminId,
                adminType: 'StateAdmin',
                rejectedAt: new Date()
            };

            await application.save();

            logger.info('Application rejected by State Admin', {
                applicationId,
                adminId,
                reason: rejectionReason
            });

            await this.recordReviewAudit(application, 'state', 'reject', adminId, user, {
                reason: rejectionReason || '',
                fallback: routing.fallback,
                absorbedTiers: routing.absorbed
            });

            return {
                success: true,
                status: 'Rejected',
                message: 'Application rejected'
            };
        }

        throw ApiError.badRequest('Invalid action. Use "approve" or "reject"');
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
    async commitFinalApproval(application, adminId) {
        const markApproved = () => {
            application.status = 'Approved';
            application.stateApprovedAt = new Date();
            application.reviewedBy.stateAdmin = adminId;
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
        const TIER_LABEL = { block: 'Block', district: 'District', state: 'State' };
        const role = user?.role || `${tier}_admin`;
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
                ? `Application approved at the ${TIER_LABEL[tier]} level`
                : `Application rejected at the ${TIER_LABEL[tier]} level`,
        );

        await auditService.record({
            action: `application.${verb}`,
            category: 'application',
            summary: isProxy
                ? `Super Admin proxy-${verb} ${applicant}'s application on behalf of the ${TIER_LABEL[tier]} tier`
                : `${TIER_LABEL[tier]} Admin ${verb} ${applicant}'s application`,
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
        // each of the six review outcomes because every one of them already
        // funnels through this method — one place to keep correct instead of six
        // that can drift apart.
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

        if (action === 'reject') {
            const reason = String(extra.reason || application?.rejectionReason || '').trim();
            await notificationService.safeCreate(recipient, {
                title: 'Application not approved',
                message: reason
                    ? `Your ACTIV membership application was not approved. Reason: ${reason}`
                    : 'Your ACTIV membership application was not approved. Please contact your local admin for details.',
                type: 'error',
                data: { event: 'application.rejected', applicationId: String(application._id || ''), tier, reason }
            });
            return;
        }

        // Final approval is the one the applicant has been waiting for, and it
        // carries the next step — approval does not yet mean an active
        // membership, payment does.
        if (status === 'Approved') {
            await notificationService.safeCreate(recipient, {
                title: 'Application approved',
                message: 'Your ACTIV membership application has been fully approved. '
                    + 'Complete your membership payment to activate your account.',
                type: 'success',
                data: { event: 'application.approved', applicationId: String(application._id || '') }
            });
            return;
        }

        const NEXT_STAGE = {
            'Pending-District': 'District',
            'Pending-State': 'State'
        };
        const next = NEXT_STAGE[status];
        if (!next) return;

        await notificationService.safeCreate(recipient, {
            title: 'Application progressed',
            message: `Your application cleared the ${tier === 'block' ? 'Block' : 'District'} review `
                + `and is now with the ${next} Admin.`,
            type: 'info',
            data: { event: 'application.advanced', applicationId: String(application._id || ''), status }
        });
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
     * Role-dispatching review used by the generic /approve and /reject endpoints.
     * The caller's role decides which tier acts, so a block admin can never
     * trigger a district or state decision.
     */
    async reviewApplication(applicationId, action, user = {}, rejectionReason = null) {
        const adminId = user.userId || user._id || user.id;
        let tier = ROLE_TO_TIER[user.role];

        if (!tier) {
            if (user.role === 'super_admin') {
                // Super admin acts on whichever tier the application currently sits at.
                const application = await Application.findById(applicationId).select('status');
                if (!application) throw ApiError.notFound('Application not found');

                const actor = TRANSITION_ACTOR[normalizeStatus(application.status)];
                if (!actor) throw ApiError.badRequest('Application has no pending decision');
                tier = { BlockAdmin: 'block', DistrictAdmin: 'district', StateAdmin: 'state' }[actor];
            } else {
                throw ApiError.forbidden('Your role cannot review applications');
            }
        }

        let result;
        if (tier === 'block') result = await this.blockAdminReview(applicationId, action, adminId, rejectionReason, user);
        else if (tier === 'district') result = await this.districtAdminReview(applicationId, action, adminId, rejectionReason, user);
        else result = await this.stateAdminReview(applicationId, action, adminId, rejectionReason, user);

        // Audit trail for a super-admin override. The tier review itself records
        // the decision under the tier's own admin fields, so without this note
        // there is nothing saying the local admin never actually acted.
        // Appended after the review, which re-reads and saves the document.
        if (user.role === 'super_admin') {
            await Application.updateOne({ _id: applicationId }, {
                $push: {
                    notes: {
                        adminId,
                        adminType: 'SuperAdmin',
                        note: `Super admin proxy ${action === 'approve' ? 'approval' : 'rejection'} on behalf of the ${tier} tier` +
                            (user.email ? ` (${user.email})` : ''),
                        createdAt: new Date()
                    }
                }
            }).catch(err => logger.warn('Failed to record super-admin proxy note', { applicationId, err: err?.message }));
        }

        return result;
    }

    async deleteApplication(id) {
        const application = await Application.findByIdAndDelete(id);
        if (!application) {
            throw ApiError.notFound('Application not found');
        }

        await cacheClient.del(CACHE_KEYS.APPLICATION(id));
        await cacheClient.del(CACHE_KEYS.APPLICATION_USER(application.user));

        return true;
    }
}

module.exports = new ApplicationService();