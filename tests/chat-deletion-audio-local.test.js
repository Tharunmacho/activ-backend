// Real messages and authentication against a disposable loopback database only.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'isolated-chat-test-key', PUSH_ENABLED: 'false' });
let mongo;
(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
  assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());
  const Member = require('../src/modules/members/memberdetails.model');
  const Order = require('../src/modules/payment/paymentorder.model');
  const { Message } = require('../src/modules/messages/message.model');
  const service = require('../src/modules/messages/message.service');
  require('../src/modules/notifications/notification.service').safeCreate = async () => {};
  const members = {};
  for (const name of ['owner', 'peer', 'outsider', 'student']) {
    members[name] = await Member.create({ fullName: name, email: `${name}@example.test`, phoneNumber: '9123456780', role: 'member',
      state: 'Tamil Nadu', district: 'Chennai', memberType: name === 'student' ? 'student' : 'business', membershipStatus: 'active',
      membershipType: 'annual', membershipExpiresAt: new Date(Date.now() + 86400000), isActive: true });
    await Order.collection.insertOne({ memberId: members[name]._id, orderType: 'membership', status: 'paid', orderId: `chat-${name}`, planAudience: name === 'student' ? 'student' : 'business', paidAt: new Date() });
  }
  const owner = String(members.owner._id), peer = String(members.peer._id);
  const thread = await service.openWith(owner, peer);
  const first = await service.send(thread.id, owner, 'Private first message');
  const second = await service.send(thread.id, peer, 'Private reply');
  const app = express(); app.use(express.json()); app.use('/messages', require('../src/modules/messages/message.routes'));
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: error.message }));
  const token = name => jwt.sign({ userId: String(members[name]._id), role: 'member' }, process.env.JWT_SECRET);
  const remove = (name, id, scope) => request(app).delete(`/messages/${thread.id}/messages/${id}`).set('Authorization', `Bearer ${token(name)}`).send({ scope });
  assert.equal((await request(app).delete(`/messages/${thread.id}/messages/${first.id}`).send({ scope: 'everyone' })).status, 401);
  assert.equal((await remove('outsider', first.id, 'everyone')).status, 404);
  assert.equal((await remove('peer', first.id, 'everyone')).status, 403);
  assert.equal((await remove('student', first.id, 'me')).status, 403);
  assert.equal((await remove('owner', first.id, 'invalid')).status, 400);
  assert.equal((await remove('owner', second.id, 'me')).status, 200);
  assert.equal((await remove('owner', second.id, 'me')).status, 200, 'idempotent self deletion');
  assert.equal((await service.listMessages(thread.id, owner)).messages.some(row => row.id === second.id), false);
  assert.equal((await service.listMessages(thread.id, peer)).messages.some(row => row.id === second.id), true);
  assert.equal((await service.listConversations(owner)).conversations[0].lastMessageText, 'Private first message');
  assert.equal(await service.unreadCount(owner), 0);
  assert.equal(await service.unreadCount(peer), 1);
  assert.equal((await remove('owner', first.id, 'everyone')).status, 200);
  assert.equal((await remove('owner', first.id, 'everyone')).status, 200, 'idempotent everyone deletion');
  const deleted = (await service.listMessages(thread.id, peer)).messages.find(row => row.id === first.id);
  assert.equal(deleted.deleted, true); assert.equal(deleted.body, ''); assert.equal(deleted.attachmentUrl, '');
  assert.equal(await service.unreadCount(peer), 0);
  assert.equal((await service.listConversations(owner)).conversations[0].lastMessageText, 'Message deleted');
  const statuses = await service.messageStatus(thread.id, owner, [first.id, second.id]);
  assert.equal(statuses[0].deleted, true); assert.equal(statuses[1].hidden, true);
  console.log('PASS deletion authorization, idempotency, sender-only withdrawal, per-member inbox/unread and history status');

  const attachments = require('../src/modules/messages/messageAttachments');
  const wav = Buffer.alloc(48); wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  const file = { originalname: 'voice.wav', mimetype: 'audio/wav', buffer: wav };
  assert.equal((await attachments.validateFile(file)).kind, 'audio');
  for (const invalid of [{ ...file, buffer: Buffer.from('<html>bad</html>') }, { ...file, mimetype: 'text/html' }, { ...file, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }]) await assert.rejects(attachments.validateFile(invalid));
  const metadata = { id: '764b0ba0-29c9-4d08-bc82-146dc046188a', kind: 'audio', name: 'voice.wav', mimeType: 'audio/wav', size: wav.length, storageName: 'chat-audio/764b0ba0-29c9-4d08-bc82-146dc046188a/voice.wav', url: '/api/v1/messages/attachments/764b0ba0-29c9-4d08-bc82-146dc046188a' };
  const receipt = jwt.sign(metadata, process.env.JWT_SECRET, { subject: owner, audience: 'activ-chat-upload', expiresIn: '1h' });
  const audio = await service.send(thread.id, owner, '', '', { token: receipt });
  assert.equal(audio.attachment.kind, 'audio');
  assert.equal((await service.listConversations(peer)).conversations[0].lastMessageText, 'Audio message');
  assert.equal((await service.attachmentForDownload(metadata.id, peer)).mimeType, 'audio/wav');
  await service.remove(thread.id, audio.id, peer, 'me');
  await assert.rejects(service.attachmentForDownload(metadata.id, peer), error => error.statusCode === 404);
  assert.equal((await service.attachmentForDownload(metadata.id, owner)).name, 'voice.wav');
  await service.remove(thread.id, audio.id, owner, 'everyone');
  await assert.rejects(service.attachmentForDownload(metadata.id, owner), error => error.statusCode === 404);
  const stored = await Message.findById(audio.id).lean(); assert.equal(stored.body, ''); assert.equal(stored.attachment, undefined);
  const publicApp = express(); publicApp.use('/uploads', attachments.blockPublicFiles); publicApp.use((req, res) => res.sendStatus(200));
  assert.equal((await request(publicApp).get('/uploads/chat-audio/id/voice.wav')).status, 404);
  assert.equal((await request(publicApp).get('/uploads/%63hat-audio/id/voice.wav')).status, 404);
  console.log('PASS canonical audio validation, signed owner upload receipt, authenticated audio access and deletion revocation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
