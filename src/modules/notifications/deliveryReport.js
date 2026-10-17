const mongoose = require("mongoose");
const Log = require("./notificationLog.model");
const Notification = require("./notification.model");
const Member = require("../members/memberdetails.model");
const BroadcastJob = require("./broadcast.model");
const { VisitorDelivery, PublicNotice } = require("./visitorPush.models");
const ApiError = require("../../core/utils/ApiError");
const { EFFECTIVE_STATUS_EXPR, istDay } = require("./deliveryQuery");

// A reporting read never queues, retries or sends a message. Historical send
// attempts remain in /logs; this view counts the current outcome of each send.
const CHANNELS = ["email", "whatsapp", "push", "in_app"];
const STATES = [
  "queued",
  "accepted",
  "sent",
  "delivered",
  "read",
  "marked_read",
  "failed",
  "skipped",
  "mock",
];
const escapeRe = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nullable = (field) => ({ $ifNull: [field, null] });
const present = (field) => ({ $ne: [nullable(field), null] });
const visibleHistoryChannel = {
  $expr: { $eq: [{ $ifNull: [{ $switch: {
    branches: CHANNELS.map(channel => ({ case: { $eq: ['$reportChannels', channel] }, then: `$adminHistoryHiddenAt.${channel}` })),
    default: null,
  } }, null] }, null] },
};
const publicationKey = { $concat: ["publication:", "$data.broadcastKey"] };
const campaignKey = (event) => ({
  $cond: [
    present("$data.broadcastKey"),
    publicationKey,
    { $concat: ["automation:", event] },
  ],
});
const queueState = (field) => ({
  $switch: {
    branches: [
      { case: { $eq: [field, "sent"] }, then: "accepted" },
      { case: { $in: [field, ["failed", "skipped"]] }, then: field },
    ],
    default: "queued",
  },
});
const countIf = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
const statusIn = (values) => ({ $in: ["$status", values] });
const totals = () => ({
  records: countIf({ $ne: ["$reportRecord", false] }),
  accepted: countIf(
    statusIn(["accepted", "sent", "delivered", "read", "marked_read"])
  ),
  delivered: countIf({
    $and: [{ $eq: ["$channel", "whatsapp"] }, statusIn(["delivered", "read"])],
  }),
  opened: countIf({ $eq: ["$status", "read"] }),
  failed: countIf({ $eq: ["$status", "failed"] }),
  queued: countIf({ $eq: ["$status", "queued"] }),
  skipped: countIf(statusIn(["skipped", "mock"])),
  unconfirmed: countIf({
    $and: [{ $ne: ["$reportRecord", false] }, { $ne: ["$status", "read"] }],
  }),
});

function sourcePipeline(from, to, { historySelection = false } = {}) {
  const start = istDay(from),
    end = istDay(to, true);
  const date =
    start || end
      ? {
          createdAt: {
            ...(start ? { $gte: start } : {}),
            ...(end ? { $lt: end } : {}),
          },
        }
      : {};
  const logProject = {
    ...(historySelection ? { historyRemovable: { $and: [
      { $ne: ['$status', 'queued'] }, { $eq: [nullable('$retryClaim.token'), null] },
    ] } } : {}),
    _id: { $concat: ["log:", { $toString: "$_id" }] },
    logId: { $toString: "$_id" },
    user: 1,
    channel: 1,
    createdAt: 1,
    updatedAt: 1,
    recipient: 1,
    recipientName: 1,
    title: { $ifNull: ["$subject", "$event"] },
    campaignKey: campaignKey("$event"),
    event: "$event",
    sourceId: "$data.sourceId",
    kind: {
      $cond: [present("$data.broadcastKey"), "announcement", "automation"],
    },
    status: EFFECTIVE_STATUS_EXPR,
    error: { $ifNull: ["$failureReason", "$lastError"] },
    deliveredAt: 1,
    openedAt: "$readAt",
    failedAt: 1,
    history: "$statusHistory",
    provider: 1,
    templateId: 1,
    attempts: 1,
    bookingRef: 1,
  };
  return [
    {
      $match: {
        ...date,
        adminHistoryHiddenAt: null,
        channel: { $in: ["email", "whatsapp"] },
        resentAs: { $exists: false },
        // Association deliveries are joined from their queue row below so
        // consent skips and pending sends are visible without duplicates.
        $nor: [
          {
            event: "ASSOCIATION_UPDATE",
            "data.notificationId": { $exists: true },
          },
        ],
      },
    },
    { $project: logProject },
    {
      $unionWith: {
        coll: Notification.collection.name,
        pipeline: [
          { $match: date },
          {
            $set: {
              reportChannels: {
                $concatArrays: [
                  ["in_app"],
                  { $cond: [present("$push.status"), ["push"], []] },
                  { $cond: [present("$updateDelivery.email"), ["email"], []] },
                  {
                    $cond: [
                      present("$updateDelivery.whatsapp"),
                      ["whatsapp"],
                      [],
                    ],
                  },
                ],
              },
            },
          },
          { $unwind: "$reportChannels" },
          { $match: visibleHistoryChannel },
          {
            $set: {
              queue: {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ["$reportChannels", "email"] },
                      then: "$updateDelivery.email",
                    },
                    {
                      case: { $eq: ["$reportChannels", "whatsapp"] },
                      then: "$updateDelivery.whatsapp",
                    },
                  ],
                  default: "$push",
                },
              },
            },
          },
          {
            $lookup: {
              from: Log.collection.name,
              localField: "queue.logId",
              foreignField: "_id",
              as: "deliveryLog",
            },
          },
          { $set: { deliveryLog: { $arrayElemAt: ["$deliveryLog", 0] } } },
          { $match: { 'deliveryLog.adminHistoryHiddenAt': null } },
          {
            $project: {
              ...(historySelection ? { historyRemovable: { $or: [
                { $eq: ['$reportChannels', 'in_app'] },
                { $and: [
                  { $not: [{ $in: ['$queue.status', ['pending', 'sending']] }] },
                  { $ne: ['$deliveryLog.status', 'queued'] },
                  { $eq: [nullable('$deliveryLog.retryClaim.token'), null] },
                ] },
              ] } } : {}),
              _id: { $concat: [{ $toString: "$_id" }, ":", "$reportChannels"] },
              notificationId: { $toString: "$_id" },
              logId: { $toString: "$queue.logId" },
              user: 1,
              channel: "$reportChannels",
              createdAt: 1,
              updatedAt: 1,
              recipient: "$deliveryLog.recipient",
              recipientName: "$deliveryLog.recipientName",
              title: { $ifNull: ["$deliveryLog.subject", "$title"] },
              campaignKey: campaignKey({
                $ifNull: ["$data.event", { $ifNull: ["$data.kind", "CUSTOM"] }],
              }),
              event: {
                $ifNull: ["$data.event", { $ifNull: ["$data.kind", "CUSTOM"] }],
              },
              sourceId: "$data.sourceId",
              kind: {
                $cond: [
                  present("$data.broadcastKey"),
                  "$data.kind",
                  "automation",
                ],
              },
              status: {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ["$reportChannels", "in_app"] },
                      then: {
                        $cond: [
                          present("$openedAt"),
                          "read",
                          { $cond: ["$isRead", "marked_read", "accepted"] },
                        ],
                      },
                    },
                    {
                      case: {
                        $and: [
                          { $eq: ["$reportChannels", "push"] },
                          present("$push.openedAt"),
                        ],
                      },
                      then: "read",
                    },
                    {
                      case: { $eq: ["$queue.status", "skipped"] },
                      then: "skipped",
                    },
                    {
                      case: { $eq: ["$deliveryLog.mock", true] },
                      then: "mock",
                    },
                    {
                      case: {
                        $and: [
                          { $in: ["$queue.status", ["pending", "sending"]] },
                          { $eq: ["$deliveryLog.deliveryStatus", "failed"] },
                        ],
                      },
                      then: "queued",
                    },
                    {
                      case: present("$deliveryLog.deliveryStatus"),
                      then: "$deliveryLog.deliveryStatus",
                    },
                  ],
                  default: queueState("$queue.status"),
                },
              },
              error: {
                $ifNull: [
                  "$queue.lastError",
                  {
                    $ifNull: [
                      "$deliveryLog.failureReason",
                      "$deliveryLog.lastError",
                    ],
                  },
                ],
              },
              deliveredAt: "$deliveryLog.deliveredAt",
              openedAt: {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ["$reportChannels", "in_app"] },
                      then: "$openedAt",
                    },
                    {
                      case: { $eq: ["$reportChannels", "push"] },
                      then: "$push.openedAt",
                    },
                  ],
                  default: "$deliveryLog.readAt",
                },
              },
              readAt: 1,
              failedAt: "$deliveryLog.failedAt",
              history: "$deliveryLog.statusHistory",
              provider: {
                $ifNull: [
                  "$deliveryLog.provider",
                  {
                    $cond: [
                      { $eq: ["$reportChannels", "push"] },
                      "fcm",
                      "activ",
                    ],
                  },
                ],
              },
              templateId: "$deliveryLog.templateId",
              attempts: "$queue.attempts",
              nextAttemptAt: "$queue.nextAttemptAt",
              bookingRef: "$data.bookingRef",
            },
          },
        ],
      },
    },
    {
      $unionWith: {
        coll: VisitorDelivery.collection.name,
        pipeline: [
          { $match: date },
          {
            $lookup: {
              from: PublicNotice.collection.name,
              localField: "notice",
              foreignField: "_id",
              as: "publicNotice",
            },
          },
          { $unwind: "$publicNotice" },
          { $set: { reportChannels: ["push", "in_app"] } },
          { $unwind: "$reportChannels" },
          { $match: visibleHistoryChannel },
          {
            $project: {
              ...(historySelection ? { historyRemovable: { $or: [
                { $eq: ['$reportChannels', 'in_app'] },
                { $not: [{ $in: ['$status', ['pending', 'sending']] }] },
              ] } } : {}),
              _id: {
                $concat: [
                  "visitor:",
                  { $toString: "$_id" },
                  ":",
                  "$reportChannels",
                ],
              },
              recipientKey: { $concat: ["visitor:", { $toString: "$device" }] },
              recipientName: {
                $concat: [
                  "Visitor · ",
                  { $substrBytes: [{ $toString: "$device" }, 18, 6] },
                ],
              },
              title: "Public update",
              channel: "$reportChannels",
              audienceType: { $literal: "visitor" },
              campaignKey: { $concat: ["publication:", "$publicNotice.key"] },
              kind: "$publicNotice.kind",
              sourceId: { $toString: "$publicNotice.sourceId" },
              status: {
                $cond: [
                  { $eq: ["$reportChannels", "in_app"] },
                  { $cond: [present("$inAppOpenedAt"), "read", "accepted"] },
                  {
                    $cond: [
                      present("$openedAt"),
                      "read",
                      queueState("$status"),
                    ],
                  },
                ],
              },
              openedAt: {
                $cond: [
                  { $eq: ["$reportChannels", "in_app"] },
                  "$inAppOpenedAt",
                  "$openedAt",
                ],
              },
              createdAt: 1,
              updatedAt: 1,
              sentAt: 1,
              attempts: 1,
              nextAttemptAt: 1,
              error: {
                $cond: [
                  { $eq: ["$reportChannels", "push"] },
                  "$lastError",
                  null,
                ],
              },
              provider: {
                $cond: [{ $eq: ["$reportChannels", "push"] }, "fcm", "activ"],
              },
            },
          },
        ],
      },
    },
    // Keep an unprocessed or empty publication visible, without counting
    // the job itself as a recipient or delivery.
    ...[BroadcastJob, PublicNotice].map((model) => ({
      $unionWith: {
        coll: model.collection.name,
        pipeline: [
          { $match: date },
          {
            $project: {
              _id: { $concat: ["publication-job:", { $toString: "$_id" }] },
              campaignKey: { $concat: ["publication:", "$key"] },
              kind: 1,
              sourceId: { $toString: "$sourceId" },
              title: { $literal: "Publication" },
              createdAt: 1,
              publicationStatus: "$status",
              publicationError: "$lastError",
              reportRecord: { $literal: false },
            },
          },
        ],
      },
    })),
    {
      $set: {
        recipientName: { $ifNull: ["$recipientName", ""] },
        recipientKey: {
          $ifNull: [
            "$recipientKey",
            {
              $ifNull: [
                { $toString: "$user" },
                { $concat: ["$channel", ":", "$recipient"] },
              ],
            },
          ],
        },
      },
    },
  ];
}

async function report(input = {}, { maxRows = 100, historySelection = false } = {}) {
  const page = Math.max(1, Math.min(100000, parseInt(input.page, 10) || 1));
  const limit = Math.max(1, Math.min(maxRows, parseInt(input.limit, 10) || 25));
  const campaignPage = Math.max(
    1,
    Math.min(100000, parseInt(input.campaignPage, 10) || 1)
  );
  const filter = {};
  if (CHANNELS.includes(input.channel)) filter.channel = input.channel;
  if (input.campaignKey)
    filter.campaignKey = String(input.campaignKey).slice(0, 250);
  if (["publication", "automation"].includes(input.group))
    filter.campaignKey = filter.campaignKey || new RegExp(`^${input.group}:`);
  const term = String(input.search || "")
    .trim()
    .slice(0, 120);
  if (term) {
    const re = new RegExp(escapeRe(term), "i");
    // Members live in a separate database, so a Mongo $lookup here would
    // silently join the wrong (empty) collection. Resolve matching IDs,
    // then batch-enrich only the paginated recipient rows below.
    const members = await Member.find({
      $or: [{ fullName: re }, { email: re }, { phoneNumber: re }],
    })
      .select("_id")
      .lean()
      .maxTimeMS(10000);
    filter.$or = [
      ...["recipient", "recipientName", "bookingRef", "title"].map((key) => ({
        [key]: re,
      })),
      { user: { $in: members.map((m) => m._id) } },
    ];
  }
  const outcomeFilter =
    input.status === "accepted_any"
      ? { status: { $in: ["accepted", "sent", "delivered", "read", "marked_read"] } }
      : input.status === "unconfirmed"
      ? { status: { $ne: "read" } }
      : input.status === "delivered"
      ? { channel: "whatsapp", status: { $in: ["delivered", "read"] } }
      : STATES.includes(input.status)
      ? { status: input.status }
      : {};
  const results = await Log.aggregate([
    ...sourcePipeline(input.from, input.to, { historySelection }),
    { $match: filter },
    {
      $facet: {
        summary: [
          { $match: { reportRecord: { $ne: false } } },
          { $group: { _id: null, ...totals() } },
          { $unset: "_id" },
        ],
        recipients: [
          { $match: { reportRecord: { $ne: false } } },
          { $group: { _id: "$recipientKey" } },
          { $count: "total" },
        ],
        channels: [
          { $match: { reportRecord: { $ne: false } } },
          { $group: { _id: "$channel", ...totals() } },
        ],
        campaigns: [
          {
            $group: {
              _id: "$campaignKey",
              title: { $first: "$title" },
              kind: { $first: "$kind" },
              sourceId: { $first: "$sourceId" },
              event: { $first: "$event" },
              createdAt: { $min: "$createdAt" },
              lastAt: { $max: "$createdAt" },
              publicationStatuses: { $addToSet: "$publicationStatus" },
              publicationErrors: { $addToSet: "$publicationError" },
              ...totals(),
            },
          },
          { $sort: { lastAt: -1, _id: 1 } },
          { $skip: (campaignPage - 1) * 12 },
          { $limit: 12 },
        ],
        campaignCount: [
          { $group: { _id: "$campaignKey" } },
          { $count: "total" },
        ],
        rows: [
          { $match: { ...outcomeFilter, reportRecord: { $ne: false } } },
          { $sort: { ...(historySelection ? { historyRemovable: -1 } : {}), createdAt: -1, _id: 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ],
        rowCount: [
          { $match: { ...outcomeFilter, reportRecord: { $ne: false } } },
          { $count: "total" },
        ],
      },
    },
  ])
    .allowDiskUse(true)
    .option({ maxTimeMS: 20000 });
  const result = results[0] || {};
  const users = (result.rows || []).map((row) => row.user).filter(Boolean);
  const members = users.length
    ? await Member.find({ _id: { $in: users } })
        .select("fullName email phoneNumber state district block")
        .lean()
    : [];
  const memberMap = new Map(
    members.map((member) => [String(member._id), member])
  );
  for (const row of result.rows || []) {
    const member = memberMap.get(String(row.user));
    row.recipientName ||=
      member?.fullName || (row.user ? "Account" : "Unregistered contact");
    row.recipient ||=
      row.channel === "whatsapp" ? member?.phoneNumber : member?.email;
    if (member)
      row.region = {
        state: member.state,
        district: member.district,
        block: member.block,
      };
  }
  const campaigns = result.campaigns || [];
  // Titles and target rules are fetched in batches, never one read per recipient.
  await Promise.all(
    ["announcement", "event", "news", "gallery", "scheme"].map(async (kind) => {
      const items = campaigns.filter(
        (c) => c.kind === kind && mongoose.isValidObjectId(c.sourceId)
      );
      if (!items.length) return;
      const docs = await require("./contentBroadcast")
        .sourceModel(kind)
        .find({ _id: { $in: items.map((c) => c.sourceId) } })
        .select(
          "title caption audience planKeys targets state district block status"
        )
        .lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      for (const item of items) {
        const doc = byId.get(String(item.sourceId));
        if (doc) {
          item.title = doc.title || doc.caption || item.title;
          item.currentAudience = doc.audience;
          item.currentTargets = doc.targets || [];
          item.contentStatus = doc.status;
        }
      }
    })
  );
  const count = Number(result.rowCount?.[0]?.total || 0),
    campaignCount = Number(result.campaignCount?.[0]?.total || 0);
  return {
    summary: {
      records: 0,
      accepted: 0,
      delivered: 0,
      opened: 0,
      failed: 0,
      queued: 0,
      skipped: 0,
      unconfirmed: 0,
      ...result.summary?.[0],
      recipients: Number(result.recipients?.[0]?.total || 0),
    },
    channels: result.channels || [],
    campaigns,
    rows: result.rows || [],
    pagination: {
      page,
      limit,
      total: count,
      pages: Math.max(1, Math.ceil(count / limit)),
    },
    campaignPagination: {
      page: campaignPage,
      total: campaignCount,
      pages: Math.max(1, Math.ceil(campaignCount / 12)),
    },
    generatedAt: new Date().toISOString(),
  };
}

async function recordOpen(userId, id, channel) {
  if (
    !mongoose.isValidObjectId(id) ||
    !CHANNELS.includes(channel) ||
    !["push", "in_app"].includes(channel)
  )
    throw ApiError.badRequest("Choose an existing notification and channel.");
  // Individual authenticated taps only. Mark-all-read does not imply viewing.
  const field = channel === "push" ? "push.openedAt" : "openedAt";
  const owner = { _id: id, user: userId };
  const found = await Notification.exists(owner);
  if (!found) throw ApiError.notFound("Notification not found");
  await Notification.updateOne(
    { ...owner, [field]: null },
    { $set: { [field]: new Date() } }
  );
  return { recorded: true };
}

module.exports = { report, recordOpen, sourcePipeline };
