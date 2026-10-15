// Pure notification regression checks: no database connection and no provider sends.
const assert = require('node:assert/strict');
// Application imports a process-wide cache cleanup interval. These notification
// paths do not use cache; replace it before loading the service, keeping this
// unit test isolated and letting Node exit naturally after all awaited checks.
const cachePath = require.resolve('../src/core/cache/cacheClient');
const priorCache = require.cache[cachePath];
require.cache[cachePath] = { id: cachePath, filename: cachePath, loaded: true, exports: {} };
const templates = require('../src/modules/notifications/notificationTemplates');
const context = require('../src/modules/notifications/membershipContext');
const audience = require('../src/modules/common/memberAudience');
const Member = require('../src/modules/members/memberdetails.model');
const Business = require('../src/modules/members/businessinfo.model');
const notifications = require('../src/modules/notifications/notification.service');
const applications = require('../src/modules/applications/application.service');
const logger = require('../src/config/logger');

const original = { paidMembership: audience.paidMembership, findById: Member.findById,
    findOne: Member.findOne, businessFind: Business.findOne,
    dispatch: notifications.dispatchLifecycleEvent, background: notifications.dispatchInBackground, warn: logger.warn };
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`ok ${label}`); };
const textOf = value => JSON.stringify(value);
const forbiddenBenefits = /member directory|find and message|company page|product catalogue|reach analytics|every member benefit|completely active/i;
const base = { name: 'Test member', firstName: 'Test', membershipNumber: 'TEST123',
    planName: 'Student', membershipType: 'annual', daysLeft: 7, expiresInLabel: 'in 7 days' };
const member = { _id: '64f0c0ffee000000000000b2', memberType: 'business', membershipType: 'annual',
    membershipStatus: 'active', membershipExpiresAt: new Date('2099-01-01'), isActive: true };
const query = value => ({ select() { return this; }, lean: async() => value });

(async() => {
    try {
        logger.warn = () => {};
        audience.paidMembership = async() => ({ paidAudience: 'student', paidPlanKey: 'student' });
        const student = await context.benefitsForMember(member);
        check('purchased student plan wins over edited business profile', () => assert.equal(student.memberAccess.isStudent, true));

        for (const event of ['APPLICATION_APPROVED', 'MEMBERSHIP_ACTIVATED', 'MEMBERSHIP_RENEWAL_DUE']) {
            const rendered = templates.render(event, { ...base, ...student, applicantKind: 'student',
                planFeatures: ['Member directory', 'Company page and product catalogue', 'Find and message members'] });
            check(`${event}: restricted student never receives networking promises, including configured features`,
                () => assert.equal(forbiddenBenefits.test(textOf(rendered)), false));
            check(`${event}: student retains concrete included benefits`,
                () => assert.match(textOf(rendered), /events|learning opportunities/i));
        }
        check('approval uses prospective student kind before payment', () => {
            const rendered = templates.render('APPLICATION_APPROVED', { ...base, applicantKind: 'student', planFeatures: [] });
            assert.equal(forbiddenBenefits.test(textOf(rendered)), false);
            assert.match(rendered.email.afterHtml, /learning opportunities/);
        });
        check('approval keeps business networking benefits', () => {
            const rendered = templates.render('APPLICATION_APPROVED', { ...base, applicantKind: 'business', planName: 'Business' });
            assert.match(rendered.email.afterHtml, /member directory/);
        });

        const lifetime = await context.benefitsForMember({ ...member, memberType: 'student', membershipType: 'lifetime' });
        check('lifetime grant supersedes the old student plan', () => {
            assert.equal(lifetime.memberAccess.isLifetime, true);
            assert.equal(lifetime.memberAccess.isStudent, false);
            assert.match(templates.render('MEMBERSHIP_ACTIVATED', { ...base, ...lifetime, membershipType: 'lifetime' }).email.afterHtml, /member directory/);
        });
        audience.paidMembership = async() => { throw new Error('mock entitlement lookup failure'); };
        const unknown = await context.benefitsForMember(member);
        check('failed entitlement lookup uses safe copy without blocking the message', () => {
            assert.equal(unknown.memberAccess, null);
            assert.equal(forbiddenBenefits.test(textOf(templates.render('MEMBERSHIP_ACTIVATED', { ...base, ...unknown }))), false);
        });

        for (const event of ['ACCOUNT_REGISTERED', 'APPLICATION_SUBMITTED', 'MEMBERSHIP_RENEWAL_DUE']) {
            const rendered = templates.render(event, { ...base, ...student });
            check(`${event}: uses approved generic record template with all five slots`, () => {
                assert.equal(rendered.whatsapp.template, 'activ_record_update_v1');
                assert.equal(rendered.whatsapp.params.length, 5);
                assert.ok(rendered.whatsapp.params.every(value => typeof value === 'string' && value.trim()));
                assert.equal(rendered.whatsapp.fallback, undefined);
                assert.doesNotMatch(textOf(rendered), /all three|are reviewing it now|each one decides|each one records|every member benefit/);
            });
        }
        check('no lifetime follow-up deadline is promised', () => {
            assert.doesNotMatch(textOf(templates.render('PLATINUM_REQUESTED', base)), /two working days|2 working days/i);
        });
        check('international application does not invent regional reviewers', () => {
            const out = templates.render('APPLICATION_SUBMITTED', { ...base, region: {}, reviews: {
                block: { state: 'pending' }, district: { state: 'pending' }, state: { state: 'pending' }
            } });
            assert.doesNotMatch(out.email.afterHtml, /Block Admin review|District Admin review|Reviewing/);
            assert.match(out.email.afterHtml, /ACTIV final review/);
        });

        const application = { _id: '64f0c0ffee000000000000a1', userId: member._id,
            fullName: 'Applicant snapshot', email: 'applicant@example.test', phone: '+919000000001',
            status: 'Pending', memberType: 'student', state: 'State', district: 'District', block: 'Block',
            reviews: { block: { decision: 'approved', adminType: 'BlockAdmin', decidedAt: new Date('2026-10-15T10:00:00Z') } } };
        const linked = { phoneNumber: '+919000000002', whatsappNumber: '+919000000003' };
        let lookedUp;
        Member.findById = id => { lookedUp = id; return query(linked); };
        Member.findOne = () => { throw new Error('unexpected fallback lookup'); };
        Business.findOne = () => query(null);
        const sent = [];
        notifications.dispatchLifecycleEvent = async(event, to, payload) => { sent.push({ event, to, payload }); return {}; };
        notifications.dispatchInBackground = notifications.dispatchLifecycleEvent;
        await applications.notifyApplicant(application, 'block', 'approve');
        check('review uses linked member WhatsApp without replacing application identity', () => {
            assert.equal(lookedUp, application.userId);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].event, 'APPLICATION_ENDORSED');
            assert.equal(sent[0].to.id, application.userId);
            assert.equal(sent[0].to.name, application.fullName);
            assert.equal(sent[0].to.email, application.email);
            assert.equal(sent[0].to.phone, linked.phoneNumber);
            assert.equal(sent[0].to.whatsapp, linked.whatsappNumber);
            assert.equal(sent[0].payload.data.reviewDecision, 'approved');
            assert.equal(sent[0].payload.data.reviewDecidedAt, '2026-10-15T10:00:00.000Z');
        });
        const submissionContact = await context.recipientForApplication(application, linked);
        check('submission and review resolve the same contact shape', () => assert.deepEqual(submissionContact, sent[0].to));

        Member.findById = () => query({ phoneNumber: linked.phoneNumber, whatsappNumber: '' });
        const cleared = await context.recipientForApplication(application);
        check('cleared separate WhatsApp falls back to the current phone, not a stale snapshot', () => {
            assert.equal(cleared.whatsapp, '');
            assert.equal(cleared.phone, linked.phoneNumber);
        });
        Member.findById = () => query(null);
        Member.findOne = filter => { assert.deepEqual(filter, { userId: application.userId }); return query(linked); };
        const legacy = await context.recipientForApplication(application);
        check('legacy linked userId lookup preserves the applicant ID', () => {
            assert.equal(legacy.id, application.userId);
            assert.equal(legacy.whatsapp, linked.whatsappNumber);
        });
        Member.findById = () => { throw new Error('mock contact lookup failure'); };
        const fallback = await context.recipientForApplication(application);
        check('contact lookup failure retains the application destination', () => {
            assert.equal(fallback.id, application.userId);
            assert.equal(fallback.phone, application.phone);
            assert.equal(fallback.whatsapp, '');
        });
        console.log(`${passed} membership message integrity checks passed`);
    } finally {
        audience.paidMembership = original.paidMembership;
        Member.findById = original.findById;
        Member.findOne = original.findOne;
        Business.findOne = original.businessFind;
        notifications.dispatchLifecycleEvent = original.dispatch;
        notifications.dispatchInBackground = original.background;
        logger.warn = original.warn;
        if (priorCache) require.cache[cachePath] = priorCache;
        else delete require.cache[cachePath];
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
