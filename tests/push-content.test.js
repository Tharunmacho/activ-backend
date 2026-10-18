const assert = require('node:assert/strict');
const { plain, clip, apply } = require('../src/modules/notifications/pushContent');
assert.equal(plain('<p>Payment <strong>received</strong> &amp; confirmed.</p><script>bad()</script>'), 'Payment received & confirmed.');
assert.equal(plain('Tamil &#x0BA4;&#2990;&#3007;&#2996;&#3021; &#128512;'), 'Tamil தமிழ் 😀');
assert.equal(plain('Meet at 10 AM.\nBring your ID.'), 'Meet at 10 AM.\nBring your ID.');
assert.equal(clip('தமிழ்😀'.repeat(800), 200).includes('\ufffd'), false);
for (const native of [true, false]) {
    const payload = apply({ token: 'test-token', data: { userId: 'owner', kind: 'announcement', notificationId: 'notice',
        sourceId: '1'.repeat(180), slug: 'a'.repeat(180) }, ...(native ? { notification: {} } : { webpush: { headers: { TTL: '86400' } } }) },
    { title: '<b>Meeting</b> &amp; training', body: 'தமிழ் 😀 '.repeat(2000) });
    assert.equal(payload.data.title, 'Meeting & training');
    assert(payload.data.body.endsWith('…'));
    assert(!payload.data.body.includes('\ufffd'));
    assert(Buffer.byteLength(JSON.stringify({ ...payload, token: undefined })) <= 3800);
    assert.equal(payload.data.userId, 'owner');
    if (native) assert.deepEqual(payload.notification, { title: payload.data.title, body: payload.data.body });
    else assert.equal(payload.notification, undefined, 'web ownership checks remain in the worker');
}
assert.equal(apply({ data: {} }, { title: 'Booking confirmed', message: 'Your booking ACTIV-123 is confirmed.' }).data.body, 'Your booking ACTIV-123 is confirmed.');
console.log('PASS: actual title/body, readable HTML/entities, Tamil/emoji-safe payload limits, and native/web preview parity. No provider requests.');
