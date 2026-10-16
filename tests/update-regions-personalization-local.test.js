// Real announcement persistence and query/worker parity; isolated loopback Mongo,
// no external provider calls or production connections.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false', JWT_SECRET: 'local-region-test-only' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Order = require('../src/modules/payment/paymentorder.model');
    const Plan = require('../src/modules/members/membershipplan.model');
    const Announcement = require('../src/modules/announcements/announcement.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const Job = require('../src/modules/notifications/broadcast.model');
    const updates = require('../src/modules/announcements/announcement.service');
    const broadcast = require('../src/modules/notifications/contentBroadcast');
    const contexts = require('../src/modules/common/memberContext');
    const personalization = require('../src/modules/common/recipientPersonalization');
    const messages = require('../src/modules/notifications/associationUpdateMessage');
    await Promise.all([Member, Order, Plan, Announcement, Notification, Job].map(model => model.createIndexes()));
    await Plan.create({ key: 'aspirant-local', name: 'Aspirant', audience: 'aspirant', amountPaise: 100 });
    const cases = [
        ['Alice', 'Kerala', 'Ernakulam', 'North', 'aspirant', true],
        ['Bala', 'Tamil Nadu', 'Chennai', 'North', 'aspirant', true],
        ['Celia', 'Tamil Nadu', 'Coimbatore', 'West', 'aspirant', true],
        ['Wrong block', 'Tamil Nadu', 'Chennai', 'South', 'aspirant', false],
        ['Crossed region', 'Tamil Nadu', 'Ernakulam', 'North', 'aspirant', false],
        ['Unknown district', 'Tamil Nadu', '', '', 'aspirant', false],
        ['Wrong membership', 'Tamil Nadu', 'Chennai', 'North', 'student', false],
    ];
    const members = [];
    for (const [index, [name, state, district, block, audience, eligible]] of cases.entries()) {
        const member = await Member.create({ fullName: name, email: `regional-${index}@example.test`, phoneNumber: '9123456780', role: 'member',
            state, district: district || 'Legacy', block: block || 'Legacy', memberType: audience, membershipStatus: 'active', membershipType: 'annual',
            membershipExpiresAt: new Date(Date.now() + 30 * 86400000), isActive: true });
        if (!district) await Member.collection.updateOne({ _id: member._id }, { $set: { district: '', block: '' } });
        await Order.collection.insertOne({ memberId: member._id, orderType: 'membership', status: 'paid', planId: audience === 'aspirant' ? 'aspirant-local' : 'student-local', planAudience: audience, paidAt: new Date(), orderId: `regional-${index}` });
        members.push({ member, eligible, context: await contexts.resolveMemberContext({ user: { userId: member._id, role: 'member' } }) });
    }
    const targets = [{ state: 'Kerala', district: '', block: '' }, { state: 'Tamil Nadu', district: 'Chennai', block: 'North' }, { state: 'Tamil Nadu', district: 'Coimbatore', block: 'West' }];
    const created = await updates.create({ title: 'Dear {Name}', body: '<p>Hello {name}, this is for you.</p>', summary: 'Welcome, {NAME}', status: 'published', audience: 'plans', planKeys: ['aspirant-local'], targets: JSON.stringify(targets) });
    assert.equal(created.title, 'Dear {Name}', 'author template remains intact');
    assert.equal(created.targets.length, 3);
    assert.equal(created.state, 'Kerala', 'legacy readers keep first target');
    for (const { member, eligible, context } of members) {
        const feed = await updates.listForMember(context);
        assert.equal(feed.announcements.some(row => row.id === created.id), eligible, `list targeting ${member.fullName}`);
        assert.equal(broadcast.visibleTo('announcement', await Announcement.findById(created.id).lean(), context), eligible, `send targeting ${member.fullName}`);
        if (eligible) {
            const detail = await updates.getForMember(created.id, context);
            assert.equal(detail.title, `Dear ${member.fullName}`);
            assert.equal(detail.summary, `Welcome, ${member.fullName}`);
            assert.equal(feed.announcements.find(row => row.id === created.id).title, detail.title, 'dashboard and direct link agree');
            const rendered = messages.render(await Announcement.findById(created.id).lean(), member);
            assert.equal(rendered.params[1], detail.title, 'WhatsApp title personalized');
            assert.match(rendered.html, new RegExp(`Hello ${member.fullName}, this is for you`));
            assert(!/\{name\}/i.test(rendered.text + rendered.whatsappText + rendered.html));
        } else await assert.rejects(updates.getForMember(created.id, context), error => error.statusCode === 404);
    }
    await broadcast.processBatch();
    const queued = await Notification.find({ 'data.sourceId': created.id }).lean();
    assert.deepEqual(queued.map(row => String(row.user)).sort(), members.filter(item => item.eligible).map(item => String(item.member._id)).sort(), 'one notification per matching member, including later targets');
    assert(queued.every(row => !/Alice|Bala|Celia|Hello/.test(row.message)), 'push remains generic');
    assert.equal((await updates.listForAdmin()).announcements.find(row => row.id === created.id).title, 'Dear {Name}', 'admin edits never save a sample recipient');
    const before = await Job.countDocuments();
    await updates.update(created.id, { targets: [targets[1]] });
    assert.equal(await Job.countDocuments(), before + 1, 'target changes generate a publication revision');
    await assert.rejects(updates.getForMember(created.id, members[0].context), error => error.statusCode === 404);
    // Legacy edits replace an old list, and choosing all regions clears mirrored fields.
    await updates.update(created.id, { state: 'Kerala', district: '', block: '' });
    assert.equal((await Announcement.findById(created.id)).targets.length, 0);
    await updates.update(created.id, { targets: [] });
    assert.equal((await Announcement.findById(created.id)).state, '');
    for (const invalid of [{ targets: [{ block: 'North' }] }, { targets: [{ state: 'Kerala', block: 'North' }] }, { targets: 'invalid' }, { includeVisitors: true, audience: 'paid' }, { includeVisitors: true, audience: 'all', targets }]) {
        await assert.rejects(updates.create({ title: 'Invalid', body: 'Test', status: 'published', ...invalid }), error => error.statusCode === 400);
    }
    const visitor = await updates.create({ title: 'Dear {name}', body: 'Welcome {Name}', status: 'published', audience: 'all', includeVisitors: true, targets: [] });
    assert.equal(personalization.personalizeUpdate(visitor, {}).title, 'Dear ACTIVian');
    await assert.rejects(updates.update(visitor.id, { audience: 'student' }), error => error.statusCode === 400, 'partial edits cannot expose a restricted update to visitors');
    const malicious = { fullName: '<img src=x onerror=alert(1)> & "A"' };
    const rendered = personalization.personalizeUpdate({ title: 'Dear {Name}', body: '<p>Hello {Name}</p><a href="/member/{Name}">Open</a><script>bad()</script>' }, malicious);
    assert(!rendered.body.includes('<img') && !rendered.body.includes('<script'));
    assert(rendered.body.includes('&lt;img') && rendered.body.includes('&amp;'));
    assert(rendered.body.includes('href="/member/{Name}"'), 'names never alter links');
    const escapedEmail = messages.render({ title: 'Dear {Name}', body: '<p>Hello {Name}</p>' }, malicious);
    assert(!escapedEmail.html.includes('<img src=x'));
    assert.equal(personalization.personalizeText('{Name}', { fullName: '{Name} $&' }), '{Name} $&', 'literal name replacement without recursive expansion');
    assert.equal(personalization.personalizeText('{{Name}}', {}), '{{Name}}', 'Meta numbered/double-brace contracts untouched');
    console.log('PASS update multi-region intersection, personalized feeds/delivery, visitor restrictions and escaping');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
