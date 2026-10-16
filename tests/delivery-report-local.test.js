// Reports run against disposable loopback Mongo. No provider is contacted.
const assert = require("node:assert/strict");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server-core");
const request = require("supertest");
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "report-test-local-only",
  JWT_REFRESH_SECRET: "report-refresh-local-only",
  PUSH_ENABLED: "false",
});
let mongo;
(async () => {
  mongo = await MongoMemoryServer.create({
    binary: {
      downloadDir: path.resolve(
        __dirname,
        "../node_modules/.cache/mongodb-memory-server"
      ),
    },
    instance: { ip: "127.0.0.1" },
  });
  assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  const Notification = require("../src/modules/notifications/notification.model");
  const Log = require("../src/modules/notifications/notificationLog.model");
  const Member = require("../src/modules/members/memberdetails.model");
  const reports = require("../src/modules/notifications/deliveryReport");
  const service = require("../src/modules/notifications/notification.service");
  const region = { state: "Tamil Nadu", district: "Chennai", block: "Chennai" };
  const member = await Member.create({
    ...region,
    fullName: "Asha Test",
    email: "asha@example.test",
    phoneNumber: "9123456780",
    role: "member",
    isActive: true,
  });
  const other = await Member.create({
    ...region,
    fullName: "Other Member",
    email: "other@example.test",
    phoneNumber: "9123456781",
    role: "member",
    isActive: true,
  });
  const admin = {
    _id: new mongoose.Types.ObjectId(),
    email: "admin@example.test",
    role: "super_admin",
  };
  const broadcastKey = `announcement:${new mongoose.Types.ObjectId()}:revision-one`;
  const notice = await Notification.create({
    user: member._id,
    title: "Regional update",
    message: "Hello Asha",
    data: { kind: "announcement", broadcastKey },
    push: { status: "sent" },
    updateDelivery: { email: { status: "sent" }, whatsapp: { status: "sent" } },
  });
  const email = await Log.create({
    user: member._id,
    channel: "email",
    recipient: member.email,
    recipientName: member.fullName,
    event: "ASSOCIATION_UPDATE",
    status: "sent",
    deliveryStatus: "accepted",
    data: { notificationId: String(notice._id), broadcastKey },
  });
  const whatsapp = await Log.create({
    user: member._id,
    channel: "whatsapp",
    recipient: member.phoneNumber,
    recipientName: member.fullName,
    event: "ASSOCIATION_UPDATE",
    status: "sent",
    deliveryStatus: "read",
    deliveredAt: new Date(),
    readAt: new Date(),
    data: { notificationId: String(notice._id), broadcastKey },
  });
  await Notification.updateOne(
    { _id: notice._id },
    {
      $set: {
        "updateDelivery.email.logId": email._id,
        "updateDelivery.whatsapp.logId": whatsapp._id,
      },
    }
  );
  await Notification.create({
    user: other._id,
    title: "Regional update",
    message: "Hello other",
    data: { kind: "announcement", broadcastKey },
    push: { status: "skipped", lastError: "No registered devices" },
    updateDelivery: {
      email: { status: "skipped", lastError: "Email updates disabled" },
      whatsapp: {
        status: "pending",
        lastError: "Waiting for template approval",
      },
    },
  });
  const oldLog = await Log.create({
    user: member._id,
    channel: "email",
    recipient: member.email,
    event: "ACCOUNT_REGISTERED",
    status: "failed",
    lastError: "Temporary issue",
  });
  const resent = await Log.create({
    user: member._id,
    channel: "email",
    recipient: member.email,
    event: "ACCOUNT_REGISTERED",
    status: "sent",
    resendOf: oldLog._id,
  });
  await Log.updateOne({ _id: oldLog._id }, { $set: { resentAs: resent._id } });
  await Log.create({
    channel: "email",
    recipient: "guest@example.test",
    event: "EVENT_BOOKING_CONFIRMED",
    status: "sent",
    mock: true,
  });
  let result = await reports.report({
    campaignKey: `publication:${broadcastKey}`,
  });
  assert.equal(
    result.summary.records,
    8,
    "two members across four channels, no duplicate provider logs"
  );
  assert.equal(result.summary.recipients, 2);
  assert.equal(result.summary.accepted, 5);
  assert.equal(
    result.summary.delivered,
    1,
    "only WhatsApp provides delivery evidence"
  );
  assert.equal(result.summary.opened, 1);
  assert.equal(result.summary.skipped, 2);
  assert.equal(result.summary.queued, 1);
  assert(
    !JSON.stringify(result).includes("sentTokens"),
    "device secrets never returned"
  );
  assert.equal(
    result.rows.find(
      (r) => r.channel === "whatsapp" && String(r.user) === String(other._id)
    ).status,
    "queued"
  );
  result = await reports.report({ group: "automation" });
  assert.equal(
    result.summary.records,
    2,
    "superseded retry attempt is not counted as another recipient delivery"
  );
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.skipped, 1, "mock must never count as accepted");
  assert.equal(
    (await reports.report({ search: "Asha", channel: "push" })).summary.records,
    1
  );
  assert.equal(
    (await reports.report({ search: ".*" })).summary.records,
    0,
    "search is a literal, not arbitrary regexp"
  );
  assert.equal(
    (await reports.report({ from: "2099-01-01" })).summary.records,
    0
  );
  result = await reports.report({ status: "unconfirmed" });
  assert.equal(result.pagination.total, 9);
  assert.equal(
    result.summary.records,
    10,
    "outcome filters do not distort summary denominator"
  );
  await service.markAllAsRead(member._id);
  result = await reports.report({ channel: "in_app", search: "Asha" });
  assert.equal(result.rows[0].status, "marked_read");
  assert.equal(result.summary.opened, 0, "mark all read never claims a view");
  await reports.recordOpen(member._id, String(notice._id), "in_app");
  await reports.recordOpen(member._id, String(notice._id), "push");
  const first = await Notification.findById(notice._id).lean();
  await reports.recordOpen(member._id, String(notice._id), "push");
  assert.equal(
    (await Notification.findById(notice._id).lean()).push.openedAt.getTime(),
    first.push.openedAt.getTime(),
    "first tap timestamp remains stable"
  );
  await assert.rejects(
    reports.recordOpen(other._id, String(notice._id), "push"),
    (e) => e.statusCode === 404
  );
  await assert.rejects(
    reports.recordOpen(member._id, String(notice._id), "email"),
    (e) => e.statusCode === 400
  );
  result = await reports.report({ campaignKey: `publication:${broadcastKey}` });
  assert.equal(
    result.summary.opened,
    3,
    "WhatsApp read plus explicitly opened inbox and push"
  );
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use(
    "/notifications",
    require("../src/modules/notifications/notification.routes")
  );
  app.use((err, req, res, next) =>
    res.status(err.statusCode || 500).json({ message: err.message })
  );
  const auth = require("../src/modules/auth/auth.service");
  const token = auth.generateTokens(member).accessToken,
    adminToken = auth.generateTokens(admin).accessToken;
  assert.equal((await request(app).get("/notifications/reports")).status, 401);
  assert.equal(
    (
      await request(app)
        .get("/notifications/reports")
        .set("Authorization", `Bearer ${token}`)
    ).status,
    403
  );
  const response = await request(app)
    .get("/notifications/reports?limit=2")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.rows.length, 2);
  assert.equal(
    (
      await request(app)
        .patch(`/notifications/${notice._id}/open`)
        .set(
          "Authorization",
          `Bearer ${auth.generateTokens(other).accessToken}`
        )
        .send({ channel: "push" })
    ).status,
    404
  );
  const {
    PublicNotice,
    VisitorDevice,
    VisitorDelivery,
  } = require("../src/modules/notifications/visitorPush.models");
  const publicNotice = await PublicNotice.create({
    key: broadcastKey,
    kind: "announcement",
    sourceId: new mongoose.Types.ObjectId(),
    status: "done",
  });
  const visitor = await VisitorDevice.create({
    secretHash: "local-fixture-secret-must-not-appear",
    token: "private-fcm-test-token",
    platform: "android",
    enabled: true,
  });
  await VisitorDelivery.create({
    notice: publicNotice._id,
    device: visitor._id,
    status: "sent",
    openedAt: new Date(),
  });
  result = await reports.report({ campaignKey: `publication:${broadcastKey}` });
  assert.equal(
    result.summary.records,
    10,
    "anonymous push and public feed deliveries are included"
  );
  assert.equal(
    result.summary.recipients,
    3,
    "one anonymous installation across its two channels"
  );
  assert.equal(result.summary.opened, 4);
  assert.equal(
    result.summary.delivered,
    1,
    "guest push tap is never called provider-confirmed delivery"
  );
  assert.equal(
    result.campaigns.length,
    1,
    "guest and signed-in recipients share their publication revision report"
  );
  assert(result.rows.some((row) => /^Visitor · /.test(row.recipientName)));
  assert(!JSON.stringify(result).includes("private-fcm-test-token"));
  assert(
    !JSON.stringify(result).includes("local-fixture-secret-must-not-appear")
  );
  await require("../src/modules/notifications/broadcast.model").create({
    key: "event:empty-publication:version",
    kind: "event",
    sourceId: new mongoose.Types.ObjectId(),
  });
  result = await reports.report({
    campaignKey: "publication:event:empty-publication:version",
  });
  assert.equal(
    result.campaigns.length,
    1,
    "pending publication visible before fanout"
  );
  assert.equal(
    result.summary.records,
    0,
    "publication jobs are not deliveries"
  );
  assert.equal(result.summary.recipients, 0);
  assert.deepEqual(result.campaigns[0].publicationStatuses, ["pending"]);
  const retryNotice = await Notification.create({
    user: member._id,
    title: "Retry scheduled",
    message: "Retry fixture",
    data: { kind: "announcement", broadcastKey: "retry-fixture" },
    updateDelivery: {
      email: { status: "pending", lastError: "Temporary mail failure" },
    },
  });
  const retryLog = await Log.create({
    user: member._id,
    channel: "email",
    recipient: member.email,
    event: "ASSOCIATION_UPDATE",
    status: "failed",
    deliveryStatus: "failed",
    data: {
      notificationId: String(retryNotice._id),
      broadcastKey: "retry-fixture",
    },
  });
  await Notification.updateOne(
    { _id: retryNotice._id },
    { $set: { "updateDelivery.email.logId": retryLog._id } }
  );
  result = await reports.report({
    campaignKey: "publication:retry-fixture",
    channel: "email",
  });
  assert.equal(
    result.summary.queued,
    1,
    "a scheduled retry is queued while the failed attempt remains in its timeline"
  );
  assert.equal(result.rows[0].error, "Temporary mail failure");
  result = await reports.report({
    campaignKey: `publication:${broadcastKey}`,
    status: "delivered",
  });
  assert.equal(
    result.pagination.total,
    1,
    "confirmed-delivered filter includes WhatsApp reads and excludes device taps"
  );
  console.log(
    "PASS: unified delivery counts, retries, missing open evidence, queues, filters, pagination and owner/admin access"
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
    process.exit(process.exitCode || 0);
  });
