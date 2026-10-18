// Pure readiness and registration fixtures. No OAuth, FCM, database or workers.
const assert = require('node:assert/strict');
const { createReadiness } = require('../src/modules/notifications/pushReadiness');
const environment = () => ({ PUSH_ENABLED: 'true', FIREBASE_SERVICE_ACCOUNT_JSON: 'fixture', NOTIFICATION_WORKER_ENABLED: 'true' });
async function main() {
    let clock = 1000000, calls = 0, fail = false;
    const env = environment();
    const ready = createReadiness({ env, now: () => clock, credentialFactory: () => ({
        async getAccessToken() { calls++; if (fail) throw { code: 'app/invalid-credential', message: 'PRIVATE_KEY_AND_EMAIL_MUST_NOT_ESCAPE' };
            await Promise.resolve(); return { access_token: 'PRIVATE_OAUTH_TOKEN', expires_in: 3600 }; },
    }) });
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => ready.check()));
    assert.equal(calls, 1, 'concurrent registrations coalesce one OAuth credential check');
    assert(concurrent.every(result => result.configured && result.ready && result.credentialReady && result.providerReady === null));
    assert(!JSON.stringify(concurrent).includes('PRIVATE_'), 'tokens never enter response metadata');
    await ready.check(); assert.equal(calls, 1, 'successful authentication is cached');
    env.NOTIFICATION_WORKER_ENABLED = 'false';
    assert.equal((await ready.check()).ready, false, 'credentials alone cannot claim a running worker');
    env.NOTIFICATION_WORKER_ENABLED = 'true';

    ready.recordProviderFailure({ code: 'app/invalid-credential', message: 'PRIVATE_PROVIDER_DETAIL' });
    let result = await ready.check();
    assert.equal(result.configured, false);
    assert.equal(result.credentialReady, true, 'OAuth and actual FCM rejection are distinguished');
    assert.equal(result.providerReady, false);
    assert.equal(result.errorCode, 'app/invalid-credential');
    clock += 301000;
    result = await ready.check();
    assert.equal(result.configured, false, 'fresh OAuth success cannot erase a real FCM authentication rejection');
    ready.recordProviderSuccess();
    assert.equal((await ready.check()).configured, true, 'a later accepted FCM message clears the provider block');
    ready.recordProviderFailure({ code: 'messaging/registration-token-not-registered' });
    assert.equal((await ready.check()).configured, true, 'one invalid device does not disable every account');

    clock += 301000; fail = true;
    result = await ready.check();
    assert.equal(result.configured, false); assert.equal(result.credentialReady, false);
    assert(!JSON.stringify(result).includes('PRIVATE_'));
    const before = calls; fail = false;
    await ready.check(); assert.equal(calls, before, 'credential failures are cached briefly without a retry storm');
    clock += 61000;
    assert.equal((await ready.check()).configured, true, 'failed authentication can recover after its short cache');

    const missing = createReadiness({ env: {}, credentialFactory() { throw Error('must not run'); } });
    assert.equal((await missing.check()).configurationPresent, false);
    const malformed = createReadiness({ env: environment(), credentialFactory() { throw Error('PRIVATE_JSON_SECRET'); } });
    result = await malformed.check();
    assert.equal(result.errorCode, 'push/invalid-configuration'); assert(!JSON.stringify(result).includes('PRIVATE_JSON_SECRET'));
    const slow = createReadiness({ env: environment(), timeoutMs: 10,
        credentialFactory: () => ({ getAccessToken: () => new Promise(() => {}) }) });
    assert.equal((await slow.check()).errorCode, 'push/credential-check-timeout');

    // Registration remains durable even while the sender is not configured.
    process.env.NODE_ENV = 'test'; process.env.PUSH_ENABLED = 'false';
    const MemberDevice = require('../src/modules/notifications/pushDevice.model');
    const { VisitorDevice } = require('../src/modules/notifications/visitorPush.models');
    let memberSaved = 0, visitorSaved = 0;
    MemberDevice.findOneAndUpdate = async () => { memberSaved++; };
    MemberDevice.find = () => ({ sort() { return this; }, skip() { return this; }, select() { return this; }, async lean() { return []; } });
    MemberDevice.exists = async () => null;
    VisitorDevice.updateMany = async () => {};
    VisitorDevice.findOne = async () => ({ _id: 'visitor-fixture', lastSeenAt: new Date() });
    VisitorDevice.updateOne = async () => { visitorSaved++; };
    const memberRegistration = await require('../src/modules/notifications/push.service').register('member-fixture',
        { token: 'fixture-member-token-1234567890', platform: 'android' });
    const visitorRegistration = await require('../src/modules/notifications/visitorPush.service').register('a'.repeat(64),
        { token: 'fixture-visitor-token-1234567890', platform: 'web' });
    assert.equal(memberSaved, 1); assert.equal(visitorSaved, 1);
    for (const registration of [memberRegistration, visitorRegistration]) {
        assert.equal(registration.registered, true); assert.equal(registration.configured, false);
        assert.equal(registration.ready, false); assert(registration.reason.includes('registration is saved'));
    }
    console.log('PASS push readiness: OAuth coalescing/cache/timeout, sanitized failures, persistent provider refusal until success, worker distinction, and saved member/visitor registrations while delivery is unavailable. No external requests.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
