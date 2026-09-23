/**
 * WhatsApp template substitution — the binding, the slot order, the payload.
 *
 * PURE UNIT, NO DB AND NO NETWORK. `botbee.service.dispatch` is replaced with a
 * recorder, so the assertions are about the request this code decides to make
 * and nothing else. That is deliberate: the failure this file exists to catch
 * is not an error, it is a WhatsApp message reading "Welcome to ACTIV, -!"
 * delivered successfully to a real member, with a green row on the oversight
 * screen and nothing anywhere that says a word about it.
 *
 *   node tests/whatsapp-templates.test.js
 */

const botbee = require('../src/modules/notifications/botbee.service');

let passed = 0;
let failed = 0;
const failures = [];

const check = (label, ok, detail = '') => {
    if (ok) {
        passed++;
        console.log(`  ok    ${label}${detail ? '  — ' + detail : ''}`);
    } else {
        failed++;
        failures.push(`${label}${detail ? '  — ' + detail : ''}`);
        console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
    }
    return ok;
};

const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

/* ------------------------------------------------------------------ the map */

const testVariableMap = () => {
    section('parseVariableMap — what the account says each slot is bound to');

    const numeric = botbee.parseVariableMap(
        '{"header":[],"body":{"1":"#1#","2":"#2#","3":"#3#"},"button":[]}'
    );
    check('a #1# body binds to fields named 1, 2, 3',
        JSON.stringify(numeric) === '["1","2","3"]', JSON.stringify(numeric));

    const named = botbee.parseVariableMap(
        '{"header":[],"body":{"1":"#name#","2":"#topic#","3":"#date#"},"button":[]}'
    );
    check('a picked-field body binds to its real field names',
        JSON.stringify(named) === '["name","topic","date"]', JSON.stringify(named));

    /*
     * SLOT 10 COMES AFTER SLOT 2, NOT AFTER SLOT 1.
     *
     * The keys arrive as strings, and a lexicographic sort files "10" between
     * "1" and "2". `meet_confirm` on this account has thirteen slots, so the
     * off-by-one that produces is not hypothetical: it puts the amount paid
     * where the venue belongs, in a confirmation the member keeps.
     */
    const wide = botbee.parseVariableMap(
        '{"body":{"1":"#a#","2":"#b#","10":"#j#","11":"#k#","3":"#c#"}}'
    );
    check('slots sort numerically, not lexicographically',
        JSON.stringify(wide) === '["a","b","c","j","k"]', JSON.stringify(wide));

    check('an unparseable map is [], not a crash',
        JSON.stringify(botbee.parseVariableMap('not json')) === '[]');
    check('a missing map is [], not a crash',
        JSON.stringify(botbee.parseVariableMap(null)) === '[]');
    check('an empty body array is []',
        JSON.stringify(botbee.parseVariableMap('{"header":[],"body":[],"button":[]}')) === '[]');
};

/* -------------------------------------------------------------- the payload */

/** Send one template against a stubbed account, and return the request body. */
const capture = async(row, params, text = '') => {
    const realDispatch = botbee.dispatch;
    const realList = botbee.listTemplates;
    const realConfigured = botbee.isConfigured;

    let sent = null;
    botbee.isConfigured = () => true;
    botbee.listTemplates = async() => [row];
    botbee.dispatch = async(kind, phone, payload) => { sent = payload; return { success: true }; };
    botbee._templates = null;

    try {
        await botbee.sendTemplateMessage('9876543210', row.name, params, 'en', text);
    } finally {
        botbee.dispatch = realDispatch;
        botbee.listTemplates = realList;
        botbee.isConfigured = realConfigured;
        botbee._templates = null;
    }

    return sent;
};

const rowFor = (name, map, body) => ({
    id: '999',
    name,
    locale: 'en_US',
    status: 'Approved',
    variables: botbee.parseVariableMap(map).length,
    fields: botbee.parseVariableMap(map),
    body: body || ''
});

const testPayload = async() => {
    section('sendTemplateMessage — values go out under the bound field names');

    const numeric = await capture(
        rowFor('activ_registration_welcome', '{"body":{"1":"#1#"}}',
            'Welcome to ACTIV, #1#! Your account is ready.'),
        ['Tharun']
    );

    check('the value is sent under the numeric field name', numeric && numeric['1'] === 'Tharun');
    check('and under the #1# spelling', numeric && numeric['#1#'] === 'Tharun');
    check('and inside custom_fields', numeric && numeric.custom_fields
        && numeric.custom_fields['1'] === 'Tharun' && numeric.custom_fields['#1#'] === 'Tharun');

    const named = await capture(
        rowFor('zoommeet', '{"body":{"1":"#name#","2":"#topic#"}}'),
        ['Tharun', 'Webinar']
    );

    /*
     * The same code path, no configuration changed, a different account
     * binding. This is the whole point of reading `variable_map`: rebinding a
     * template on the dashboard must not need a deploy, and the two spellings
     * must never need to be kept in step by a person.
     */
    check('a #name#-bound template sends under name/topic, not 1/2',
        named && named.name === 'Tharun' && named.topic === 'Webinar');
    check('and does not invent numeric keys for it',
        named && named['1'] === undefined && named['2'] === undefined);

    /*
     * TOO FEW PARAMETERS IS THE `-` FAILURE, AND IT MUST BE PADDED NOT DROPPED.
     * A slot with no value renders as the placeholder in a real member's chat.
     */
    const short = await capture(
        rowFor('activ_member_update', '{"body":{"1":"#1#","2":"#2#","3":"#3#"}}'),
        ['Tharun']
    );
    check('a short parameter list is padded to the template width',
        short && short['1'] === 'Tharun' && short['2'] === '' && short['3'] === '');

    const long = await capture(
        rowFor('activ_payment_due', '{"body":{"1":"#1#","2":"#2#"}}'),
        ['Tharun', 'Rs 10,000', 'extra']
    );
    check('an over-long parameter list is trimmed to the template width',
        long && long['1'] === 'Tharun' && long['2'] === 'Rs 10,000' && long['3'] === undefined);

    check('the row id is what addresses the template, not the name',
        numeric && numeric.template_id === '999');

    /*
     * THE PRODUCTION SHAPE. Every ACTIV template is variable-free, because the
     * provider answers 200 and renders a literal `-` in any slot it is given.
     * The event builders still produce parameters — they are the right thing to
     * send the day substitution works, or through Meta's API directly — so what
     * has to hold is that a zero-variable template drops them rather than
     * padding four blanks into a body with nowhere to put them.
     */
    const none = await capture(
        { id: '438417', name: 'activ_reg_welcome', locale: 'en_US', status: 'Approved',
            variables: 0, fields: [], body: 'Welcome to ACTIV! Your account is ready.' },
        ['Tharun', 'Approved', 'pay now'],
        'Welcome to ACTIV, Tharun! Your account is ready.'
    );
    check('a variable-free template sends no variable keys at all',
        none && none['1'] === undefined && none['#1#'] === undefined
        && none.custom_fields === undefined && none.template_data === undefined,
        Object.keys(none || {}).join(','));
    check('and still carries the session-text fallback',
        none && typeof none.message === 'string' && none.message.length > 0);
};

/* ------------------------------------------------- Meta Cloud API + routing */

const axios = require('axios');
const config = require('../src/config');
const meta = require('../src/modules/notifications/metaCloud.service');
const whatsappTemplate = require('../src/modules/notifications/whatsappTemplate');

/** Run `fn` with Meta configured and axios captured. Returns the request made. */
const withMeta = async(fn, response = { status: 200, data: { messages: [{ id: 'wamid.TEST' }] } }) => {
    const realPost = axios.post;
    const realCfg = { ...config.metaCloud };
    let sent = null;

    Object.assign(config.metaCloud, {
        accessToken: 'TESTTOKEN', phoneNumberId: '642450735629232',
        apiVersion: 'v21.0', baseUrl: 'https://graph.facebook.com', isConfigured: true
    });
    axios.post = async(url, body, opts) => { sent = { url, body, opts }; return response; };

    try {
        const result = await fn();
        return { sent, result };
    } finally {
        axios.post = realPost;
        Object.assign(config.metaCloud, realCfg);
    }
};

const testMeta = async() => {
    section('Meta Cloud API — the request Meta actually receives');

    const { sent, result } = await withMeta(() =>
        meta.sendTemplateMessage('9876543210', 'activ_status_now',
            ['Tharun', 'Approved', 'complete your payment'], 'en_US'));

    check('posts to /{version}/{phone_number_id}/messages',
        sent && sent.url === 'https://graph.facebook.com/v21.0/642450735629232/messages', sent && sent.url);
    check('authorises with a bearer token',
        sent && sent.opts.headers.Authorization === 'Bearer TESTTOKEN');
    check('declares messaging_product: whatsapp',
        sent && sent.body.messaging_product === 'whatsapp');
    check('sends the number in E.164 with the country code added',
        sent && sent.body.to === '919876543210', sent && sent.body.to);

    const comp = sent && sent.body.template.components;
    check('body parameters are positional and in order',
        comp && comp.length === 1 && comp[0].type === 'body'
        && JSON.stringify(comp[0].parameters) === JSON.stringify([
            { type: 'text', text: 'Tharun' },
            { type: 'text', text: 'Approved' },
            { type: 'text', text: 'complete your payment' }
        ]));
    check('returns the wamid Meta itself issued as the message id',
        result && result.success === true && result.messageId === 'wamid.TEST');

    /*
     * An empty `parameters` array is error 132000, while the same template with
     * no `components` key at all succeeds. Meta treats "no parameters" and "an
     * empty parameter list" as different requests, so the key has to be absent.
     */
    const none = await withMeta(() => meta.sendTemplateMessage('9876543210', 'activ_reg_welcome', [], 'en_US'));
    check('a variable-free template carries NO components key',
        none.sent && none.sent.body.template.components === undefined,
        JSON.stringify(none.sent && none.sent.body.template));

    // en and en_US are different templates to Meta; the separator is normalised.
    const loc = await withMeta(() => meta.sendTemplateMessage('9876543210', 'x', ['a'], 'en-GB'));
    check('a hyphenated locale is normalised to an underscore',
        loc.sent && loc.sent.body.template.language.code === 'en_GB');

    // A refusal must be a failure, never a logged success.
    const fail = await withMeta(
        () => meta.sendTemplateMessage('9876543210', 'x', ['a'], 'en_US'),
        { status: 400, data: { error: { message: 'Template name does not exist', code: 132001, fbtrace_id: 'ABC' } } });
    check('a Meta error resolves to success:false with the message kept',
        fail.result && fail.result.success === false
        && String(fail.result.error).includes('Template name does not exist'));

    check('an unconfigured Meta service is mock, not a false success',
        (await meta.sendTemplateMessage('9876543210', 'x', ['a'])).mock === true);
};

const testRouting = async() => {
    section('Provider routing — one decision, both call sites');

    check('with no Meta token, templates go to BotBee',
        whatsappTemplate.providerName() === 'botbee');

    const { sent, result } = await withMeta(() =>
        whatsappTemplate.sendTemplateMessage('9876543210', 'activ_reg_welcome', ['Tharun'], 'en_US'));

    check('with a Meta token, the same call goes to Meta',
        sent && String(sent.url).includes('graph.facebook.com'));
    check('and the result names the provider that answered',
        result && result.provider === 'meta');

    /*
     * Falling back to BotBee here would convert a named, diagnosable Meta error
     * into a delivered message full of dashes and a green log row.
     */
    const fail = await withMeta(
        () => whatsappTemplate.sendTemplateMessage('9876543210', 'x', ['a'], 'en_US'),
        { status: 400, data: { error: { message: 'Invalid token', code: 190 } } });
    check('a Meta failure is NOT silently retried through BotBee',
        fail.result && fail.result.success === false && fail.result.provider === 'meta');
};

/* --------------------------------------------------------------------- run */

const main = async() => {
    console.log('\n' + '='.repeat(70));
    console.log('WhatsApp template substitution');
    console.log('='.repeat(70));

    testVariableMap();
    await testPayload();
    await testMeta();
    await testRouting();

    console.log('\n' + '='.repeat(70));
    console.log(`${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  - ' + f));
    }
    console.log('='.repeat(70) + '\n');

    process.exit(failed ? 1 : 0);
};

main().catch((err) => {
    console.error('\nTest run crashed:', err);
    process.exit(1);
});
