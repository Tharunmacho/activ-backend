// Isolated fixtures only: no .env files, database, sockets, or provider requests.
const assert = require('node:assert/strict');
require('dotenv').config = () => ({ parsed: {} });
const setting = 'ASSOCIATION_UPDATE_EMAIL_MAX_AGE_MINUTES';
const previousSetting = process.env[setting];
const originalNow = Date.now;
const baseNow = Date.parse('2026-10-20T06:30:00.000Z');
let now = baseNow;
let lookupResult = null;
let lookupError = null;
let lookupDelay = 0;
let lookups = [];
let checks = 0;
const broadcastPath = require.resolve('../src/modules/notifications/broadcast.model');
const previousBroadcastModule = require.cache[broadcastPath];
require.cache[broadcastPath] = {
    id: broadcastPath, filename: broadcastPath, loaded: true,
    exports: {
        findOne(query) {
            lookups.push(query);
            return {
                select(fields) {
                    assert.equal(fields, 'createdAt');
                    return {
                        async lean() {
                            now += lookupDelay;
                            if (lookupError) throw lookupError;
                            return lookupResult;
                        },
                    };
                },
            };
        },
    },
};
Date.now = () => now;

function timestamp(ageMinutes) {
    return new Date(baseNow - ageMinutes * 60000);
}
function row(ageMinutes = 5) {
    return {
        createdAt: timestamp(0),
        data: { broadcastKey: 'announcement:fixture', broadcastCreatedAt: timestamp(ageMinutes) },
    };
}
function reset() {
    now = baseNow;
    lookupResult = null;
    lookupError = null;
    lookupDelay = 0;
    lookups = [];
    delete process.env[setting];
}
async function test(name, body) {
    reset();
    await body();
    checks += 1;
    console.log(`PASS ${name}`);
}
function expectFresh(result, date) {
    assert.equal(result.reason, '');
    assert(result.broadcastCreatedAt instanceof Date);
    assert.equal(+result.broadcastCreatedAt, +date);
}
function expectExpired(result) {
    assert.match(result.reason, /expir/i);
}
function expectInvalid(result) {
    assert.equal(typeof result.reason, 'string');
    assert(result.reason.length > 0, 'An unusable timestamp must fail closed.');
}

async function main() {
    const { emailMaxAgeMinutes, emailFreshness } = require('../src/modules/notifications/associationUpdateFreshness');

    await test('email freshness defaults to 60 minutes and accepts only bounded whole minutes', async () => {
        assert.equal(emailMaxAgeMinutes(), 60);
        for (const invalid of ['', ' ', 'invalid', '0', '-1', '1441', '1.5', 'NaN', 'Infinity']) {
            process.env[setting] = invalid;
            assert.equal(emailMaxAgeMinutes(), 60, `Invalid value ${JSON.stringify(invalid)} must use the default.`);
        }
        for (const valid of [1, 60, 120, 1440]) {
            process.env[setting] = String(valid);
            assert.equal(emailMaxAgeMinutes(), valid);
        }
    });

    await test('persisted original broadcast timestamp is authoritative and avoids a lookup', async () => {
        const input = row(10);
        input.createdAt = timestamp(120);
        lookupResult = { createdAt: timestamp(180) };
        expectFresh(await emailFreshness(input), timestamp(10));
        assert.deepEqual(lookups, []);
        input.data.broadcastCreatedAt = timestamp(90).toISOString();
        input.createdAt = timestamp(0);
        expectExpired(await emailFreshness(input));
        assert.deepEqual(lookups, []);
    });

    await test('an overnight update cannot acquire a fresh deadline from a newly generated notification', async () => {
        const input = row(12 * 60);
        input.createdAt = timestamp(0);
        expectExpired(await emailFreshness(input));
    });

    await test('present but unusable snapshot timestamps never fall back to newer records', async () => {
        lookupResult = { createdAt: timestamp(0) };
        for (const invalid of [undefined, null, '', 'not-a-date', new Date(NaN)]) {
            const input = row();
            input.data.broadcastCreatedAt = invalid;
            expectInvalid(await emailFreshness(input));
        }
        assert.deepEqual(lookups, []);
    });

    await test('legacy rows use original broadcast age even when the notification was just created', async () => {
        const input = row();
        delete input.data.broadcastCreatedAt;
        lookupResult = { createdAt: timestamp(12 * 60) };
        expectExpired(await emailFreshness(input));
        assert.deepEqual(lookups, [{ key: input.data.broadcastKey }]);
        lookupResult = { createdAt: timestamp(15) };
        expectFresh(await emailFreshness(input), timestamp(15));
    });

    await test('legacy rows use notification age only when the broadcast job is absent', async () => {
        const input = row();
        delete input.data.broadcastCreatedAt;
        input.createdAt = timestamp(5);
        expectFresh(await emailFreshness(input), timestamp(5));
        assert.deepEqual(lookups, [{ key: input.data.broadcastKey }]);
        input.createdAt = timestamp(61);
        expectExpired(await emailFreshness(input));
    });

    await test('legacy rows without a broadcast key fall back to their notification timestamp', async () => {
        const input = { createdAt: timestamp(5), data: {} };
        expectFresh(await emailFreshness(input), timestamp(5));
        assert.deepEqual(lookups, []);
    });

    await test('a present broadcast job with an invalid timestamp fails closed', async () => {
        const input = row();
        delete input.data.broadcastCreatedAt;
        for (const invalid of [undefined, null, '', 'not-a-date', new Date(NaN)]) {
            lookupResult = { createdAt: invalid };
            expectInvalid(await emailFreshness(input));
        }
    });

    await test('broadcast lookup errors propagate and cannot become a fresh fallback', async () => {
        const input = row();
        delete input.data.broadcastCreatedAt;
        lookupError = new Error('Offline broadcast lookup fixture failed');
        await assert.rejects(emailFreshness(input), error => error === lookupError);
    });

    await test('missing, invalid, or future fallback timestamps cannot authorize delivery', async () => {
        for (const createdAt of [undefined, null, '', 'not-a-date', new Date(NaN), timestamp(-1)]) {
            expectInvalid(await emailFreshness({ createdAt, data: {} }));
        }
        expectInvalid(await emailFreshness(row(-1)));
        const input = row();
        delete input.data.broadcastCreatedAt;
        lookupResult = { createdAt: timestamp(-1) };
        expectInvalid(await emailFreshness(input));
    });

    await test('the configured deadline expires at the exact boundary', async () => {
        const input = row(60);
        now = baseNow - 1;
        expectFresh(await emailFreshness(input), timestamp(60));
        now = baseNow;
        expectExpired(await emailFreshness(input));
        now = baseNow + 1;
        expectExpired(await emailFreshness(input));
        process.env[setting] = '120';
        expectFresh(await emailFreshness(input), timestamp(60));
        now = baseNow + 60 * 60000;
        expectExpired(await emailFreshness(input));
    });

    await test('retries cannot reset the original deadline by changing notification timestamps', async () => {
        const input = row(59);
        expectFresh(await emailFreshness(input), timestamp(59));
        now += 60000;
        input.createdAt = new Date(now);
        expectExpired(await emailFreshness(input));
        now += 86400000;
        input.createdAt = new Date(now);
        expectExpired(await emailFreshness(input));
    });

    await test('a legacy lookup that crosses the deadline is evaluated after the lookup completes', async () => {
        const input = row();
        delete input.data.broadcastCreatedAt;
        lookupResult = { createdAt: timestamp(59) };
        lookupDelay = 60000;
        expectExpired(await emailFreshness(input));
    });

    console.log(`Association update email freshness: ${checks} groups passed.`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Date.now = originalNow;
    if (previousSetting === undefined) delete process.env[setting];
    else process.env[setting] = previousSetting;
    if (previousBroadcastModule) require.cache[broadcastPath] = previousBroadcastModule;
    else delete require.cache[broadcastPath];
});
