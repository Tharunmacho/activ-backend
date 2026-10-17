// Isolated loopback database; no production credentials or provider sends.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false', JWT_SECRET: 'local-variable-test-only' });
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
    const visitor = require('../src/modules/notifications/visitorPush.service');
    const delivery = require('../src/modules/notifications/associationUpdateDelivery');
    const recipients = require('../src/modules/announcements/announcementRecipients');
    const personalization = require('../src/modules/common/recipientPersonalization');
    const { variableValues } = require('../src/modules/common/updateVariables');
    const messages = require('../src/modules/notifications/associationUpdateMessage');
    await Promise.all([Member, Order, Plan, Announcement, Notification, Job].map(model => model.createIndexes()));
    await Plan.create({ key: 'business-test', name: 'Current price is different', audience: 'business', amountPaise: 990000 });
    const members = [];
    for (const [index, name] of ['Alice', 'Bala', 'Celia', 'Not selected'].entries()) {
        const member = await Member.create({ fullName: name, email: `variables-${index}@example.test`, phoneNumber: '9123456780', role: 'member',
            state: index === 2 ? 'Kerala' : 'Tamil Nadu', district: 'Chennai', block: 'Central', memberType: 'business',
            membershipStatus: 'active', membershipType: 'annual', membershipNumber: `ACT-${index}`,
            membershipExpiresAt: new Date('2099-12-31T00:00:00Z'), membershipActivatedAt: new Date('2025-01-01T00:00:00Z'), isActive: true });
        await Order.collection.insertOne({ memberId: member._id, orderType: 'membership', status: 'paid', planId: 'business-test', planAudience: 'business', amount: 1234.50, currency: 'INR', paidAt: new Date(), orderId: `variable-${index}` });
        members.push(member);
    }
    const [alice, bala, celia, excluded] = members;
    const id = member => String(member._id);
    await require('../src/modules/members/businessinfo.model').collection.insertOne({ userId: alice._id, organizationName: 'Real Company' });
    const variables = [
        { key: 'name', defaultValue: 'ACTIVian', overrides: [] },
        { key: 'title', defaultValue: 'Dear member', overrides: [{ memberId: id(alice), value: 'Dr' }] },
        { key: 'company_name', defaultValue: 'your company', overrides: [{ memberId: id(bala), value: 'Bala Company' }] },
        { key: 'fee', defaultValue: 'contact us for the current fee', overrides: [{ memberId: id(alice), value: '₹2,500 agreed quote' }] },
        { key: 'meeting_place', defaultValue: 'our office', overrides: [{ memberId: id(alice), value: '<img src=x onerror=alert(1)> & {name}' }] },
    ];
    const payload = { title: '{title} {Name}', body: '<p>{company_name}: {meeting_place}; fee {fee}; paid {last_paid_fee}; expiry {renewal_date}; date {date}</p>',
        summary: 'Hello {NAME}', audience: 'plans', planKeys: ['business-test'], targets: [{ state: 'Tamil Nadu', district: '', block: '' }],
        recipientMode: 'selected', memberIds: [id(alice), id(bala), id(celia)], variables, status: 'published' };
    const created = await updates.create(payload);
    const source = await Announcement.findById(created.id).lean();
    for (const member of members) {
        const context = await recipients.loadRecipient(member);
        const eligible = member !== celia && member !== excluded;
        assert.equal(broadcast.visibleTo('announcement', source, context), eligible, `audience/region/selection ${member.fullName}`);
        const feed = await updates.listForMember(context);
        assert.equal(feed.announcements.some(row => row.id === created.id), eligible);
        if (!eligible) { await assert.rejects(updates.getForMember(created.id, context), error => error.statusCode === 404); continue; }
        const detail = await updates.getForMember(created.id, context);
        const preview = await updates.preview({ ...payload, announcementId: created.id, previewMemberId: id(member) });
        assert.equal(preview.eligible, true);
        assert.equal(preview.announcement.body, detail.body, 'server preview and final rendered body agree');
        assert.equal(preview.announcement.title, detail.title);
        assert.equal(detail.variables, undefined); assert.equal(detail.memberIds, undefined);
        assert(!JSON.stringify(detail).includes(id(member === alice ? bala : alice)), 'no other member IDs or overrides in member response');
        const rendered = messages.render(source, context);
        assert.equal(rendered.params[1], detail.title);
        assert(rendered.html.includes(member === alice ? 'Real Company' : 'Bala Company'));
        assert.equal(preview.values.last_paid_fee, '₹1,234.50', 'actual paid rupee amount; not current plan price in paise');
        if (member === alice) {
            assert(detail.body.includes('&lt;img') && !detail.body.includes('<img'), 'custom value HTML escaped');
            assert(detail.body.includes('{name}'), 'values are not recursively interpreted');
            assert.equal(preview.values.fee, '₹2,500 agreed quote');
        }
    }
    assert.equal((await updates.preview({ ...payload, previewMemberId: id(celia) })).eligible, false);
    assert.equal((await updates.preview({ ...payload, previewMemberId: id(excluded) })).eligible, false);
    assert.equal((await updates.recipientOptions({ search: 'Ali' })).members[0].id, id(alice));
    assert.equal((await updates.recipientOptions({ search: '.*' })).members.length, 0, 'search escapes regex');
    assert.equal((await updates.listForAdmin()).announcements[0].variables.length, variables.length);
    await broadcast.processBatch();
    const queued = await Notification.find({ 'data.sourceId': created.id }).lean();
    assert.deepEqual(queued.map(row => String(row.user)).sort(), [id(alice), id(bala)].sort());
    const pending = queued.find(row => String(row.user) === id(alice));
    assert(!(await delivery.current(pending, 'email')).reason, 'current send can resolve selected eligible member');
    await Member.updateOne({ _id: alice._id }, { $set: { membershipStatus: 'expired', membershipExpiresAt: new Date('2020-01-01') } });
    assert((await delivery.current(pending, 'email')).reason, 'retry rereads changed membership eligibility');
    await Member.updateOne({ _id: alice._id }, { $set: { membershipStatus: 'active', membershipExpiresAt: new Date('2099-12-31') } });
    await updates.update(created.id, { memberIds: [id(bala)] });
    assert((await delivery.current(pending, 'email')).reason, 'retry rejects a changed publication after deselection');
    await assert.rejects(updates.getForMember(created.id, await recipients.loadRecipient(alice)), error => error.statusCode === 404);
    // Even a freshly queued delivery cannot bypass the selected member gate.
    pending.data.broadcastKey = broadcast.sourceKey('announcement', await Announcement.findById(created.id).lean());
    assert((await delivery.current(pending, 'email')).reason);
    assert(queued.every(row => !/Alice|Bala|Real Company|1,234/.test(row.message)), 'push and notification inbox stay generic');
    const publicUpdate = await updates.create({ title: 'Dear {Name}', body: '{company_name}; {meeting_place}; {fee}', variables, includeVisitors: true, audience: 'all', status: 'published' });
    const publicPreview = await updates.preview({ ...publicUpdate, previewMemberId: '' });
    assert.equal(publicPreview.announcement.body, 'your company; our office; contact us for the current fee');
    assert.equal(publicPreview.announcement.title, 'Dear ACTIVian');
    const feed = await visitor.feed();
    const publicNotice = feed.find(row => row.sourceId === publicUpdate.id);
    assert(publicNotice && !JSON.stringify(publicNotice).includes('Bala Company') && !JSON.stringify(publicNotice).includes('overrides'));
    assert.equal(publicNotice.body, publicPreview.announcement.body);
    await Announcement.collection.updateOne({ _id: new mongoose.Types.ObjectId(created.id) }, { $set: { includeVisitors: true, audience: 'all', state: '', district: '', block: '', targets: [] } });
    assert.equal(visitor.publicEligible('announcement', await Announcement.findById(created.id).lean()), false, 'selected members cannot leak to visitors even with inconsistent stored flags');
    assert.equal(variableValues({}, { fullName: 'No guessed values', gender: 'Male' }).title, '');
    assert.equal(variableValues({}, await recipients.loadRecipient(bala)).fee, '');
    assert.equal(variableValues({}, { membershipType: 'lifetime', membershipExpiresAt: new Date() }).renewal_date, '');
    assert.equal(personalization.personalizeText('{{Name}} {Name}', {}), '{{Name}} ACTIVian');
    const greetingOverride = messages.render({ title: '{name}', body: 'Hello {name}', variables: [{ key: 'name', defaultValue: '', overrides: [{ memberId: id(alice), value: 'Alice Preferred' }] }] }, alice);
    assert.equal(greetingOverride.params[0], 'Alice Preferred', 'provider greeting respects the same explicit name override');
    assert.equal(greetingOverride.params[1], 'Alice Preferred');
    assert(personalization.personalizeHtml('<a href="/{meeting_place}">{meeting_place}</a>', {}, { variables }).includes('href="/{meeting_place}"'));
    for (const invalid of [
        { recipientMode: 'selected', memberIds: [] }, { recipientMode: 'selected', memberIds: [id(alice)], includeVisitors: true },
        { memberIds: ['bad'] }, { variables: [{ key: 'constructor' }] }, { variables: [{ key: 'x' }, { key: 'X' }] },
        { variables: [{ key: 'x', defaultValue: { bad: true } }] }, { variables: [{ key: 'x', overrides: [{ memberId: id(alice), value: 'a' }, { memberId: id(alice), value: 'b' }] }] },
        { body: '{unknown_variable}', variables: [] },
    ]) await assert.rejects(updates.create({ title: 'Invalid', body: 'Text', status: 'published', ...invalid }), error => error.statusCode === 400);
    console.log('PASS variable/default/override precedence, real data sources, preview/channel parity, HTML safety, private serialization, exact selected audience, retry revalidation and public fallback');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
