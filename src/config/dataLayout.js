const mongoose = require('mongoose');

/**
 * ============================================================================
 * WHERE EVERY PIECE OF DATA LIVES — the one map
 * ============================================================================
 *
 * Eight databases, one per area of the platform, with plain collection names.
 * Every model registers through `model()` below and every raw collection
 * (counters, GridFS uploads, the admin repository) is reached through
 * `collection()` / `dbName()`. No other file names a database or a collection.
 *
 * WHY ONE MAP. Collection names fail SILENTLY: Mongoose writes to whatever name
 * it is given, so a model pointing at a misspelt or outdated collection keeps
 * "working" while its data goes somewhere nothing reads. Keeping every name
 * here makes that a one-file review, and `assertAllModelsMapped()` refuses to
 * boot a server with a model this map does not know.
 *
 * GROUPED BY SUBJECT: open a database and everything in it is about one
 * thing — admins (and their audit trail) in activ_admins, a member's business
 * details with the companies and products in activ_business, and so on.
 *
 * WHAT MUST STAY TOGETHER, and why:
 *   - applications + members: `Application.populate('userId')` resolves
 *     MemberDetails on the application's own connection.
 *   - products / trusted companies + companies: `populate('companyId')`.
 *   - donations + donors: `$lookup from: 'donations'` runs on donors.
 * Final approval writes member documents in two databases (members +
 * business_details / business_financials); transactions span databases on a replica set,
 * and a standalone server uses the compensating-write fallback anyway.
 *
 * `legacy` is where each collection lived in the old two-database layout
 * (`activ-db` / `adminsdb`). Only `scripts/migrate-to-dokploy.js` reads it.
 */

const DATABASES = {
    members: 'activ_members',
    business: 'activ_business',
    events: 'activ_events',
    payments: 'activ_payments',
    notifications: 'activ_notifications',
    admins: 'activ_admins',
    website: 'activ_website',
    files: 'activ_files',
};

const A = 'activ-db';
const W = 'adminsdb';

/** Mongoose models: name -> [area, collection, legacy db, legacy collection]. */
const MODELS = {
    // ---- members: the member, their sign-in, their personal details and
    //      declaration, the membership application, plans and pricing, and the
    //      member's own activity timeline
    MemberDetails: ['members', 'members', A, 'users'],
    MemberAuth: ['members', 'member_logins', A, 'auth'],
    PersonalInfo1: ['members', 'member_personal_details', A, 'additional form for personal information 1'],
    MemberDeclaration: ['members', 'member_declarations', A, 'additional form for declaration 4'],
    Application: ['members', 'applications', A, 'applications'],
    PlatinumRequest: ['members', 'platinum_requests', A, 'platinum_requests'],
    MembershipPlan: ['members', 'membership_plans', A, 'membershipPlans'],
    MembershipSettings: ['members', 'membership_settings', A, 'membershipSettings'],
    Activity: ['members', 'member_activities', A, 'activities'],

    // ---- business: the member's business details and business finances
    //      (PAN, GST, Udyam, ITR, turnover), companies, catalogue, and the
    //      network between members (connections, conversations, messages)
    BusinessInfo: ['business', 'business_details', A, 'additional form for bussiness 2'],
    MemberFinancialInfo: ['business', 'business_financials', A, 'additional form for financial 3'],
    Company: ['business', 'companies', A, 'companies'],
    Product: ['business', 'products', A, 'products'],
    TrustedCompany: ['business', 'trusted_companies', A, 'trusted companies'],
    StockMovement: ['business', 'stock_movements', A, 'stock_movements'],
    Engagement: ['business', 'engagements', A, 'engagements'],
    Conversation: ['business', 'conversations', A, 'conversations'],
    Message: ['business', 'messages', A, 'messages'],
    Connection: ['business', 'connections', A, 'connections'],

    // ---- events
    Event: ['events', 'events', A, 'events'],
    EventBooking: ['events', 'event_bookings', A, 'event_bookings'],
    EventCheckin: ['events', 'event_checkins', A, 'event_checkins'],
    EventRegistration: ['events', 'event_registrations', A, 'event_registrations'],

    // ---- payments: every rupee
    PaymentOrder: ['payments', 'payment_orders', A, 'payment orders'],
    Donation: ['payments', 'donations', A, 'donations'],
    Donor: ['payments', 'donors', A, 'donors'],

    // ---- notifications
    Notification: ['notifications', 'notifications', A, 'notifications'],
    NotificationLog: ['notifications', 'notification_logs', A, 'notificationlogs'],
    Announcement: ['notifications', 'announcements', A, 'announcements'],

    // ---- admins (super / staff / state / district / block) and the trail of
    //      everything they did
    SuperAdmin: ['admins', 'super_admins', W, 'superadmins'],
    StateAdmin: ['admins', 'state_admins', W, 'stateadmins'],
    DistrictAdmin: ['admins', 'district_admins', W, 'districtadmins'],
    BlockAdmin: ['admins', 'block_admins', W, 'blockadmins'],
    AuditLog: ['admins', 'admin_audit_logs', A, 'audit_logs'],

    // ---- website: the public site's CMS content
    CmsSiteSettings: ['website', 'site_settings', W, 'web_site_settings'],
    CmsHome: ['website', 'home', W, 'web_home'],
    CmsAbout: ['website', 'about', W, 'web_about'],
    CmsLeaderMessage: ['website', 'leader_messages', W, 'web_leader_messages'],
    CmsMembership: ['website', 'membership', W, 'web_membership'],
    CmsEventsSettings: ['website', 'events_settings', W, 'web_events_settings'],
    CmsGalleryItem: ['website', 'gallery', W, 'web_gallery'],
    CmsGallerySettings: ['website', 'gallery_settings', W, 'web_gallery_settings'],
    CmsNewsArticle: ['website', 'news', W, 'web_news'],
    CmsNewsSettings: ['website', 'news_settings', W, 'web_news_settings'],
    CmsScheme: ['website', 'schemes', W, 'web_schemes'],
    CmsSchemeSettings: ['website', 'scheme_settings', W, 'web_scheme_settings'],
    CmsLegalDocument: ['website', 'legal_documents', W, 'web_legal_documents'],
    CmsLegalRevision: ['website', 'legal_revisions', W, 'web_legal_revisions'],
    CmsStatePage: ['website', 'state_pages', W, 'web_state_pages'],
    CmsRegionPage: ['website', 'region_pages', W, 'web_region_pages'],
    CmsContactSettings: ['website', 'contact_settings', W, 'web_contact_settings'],
    CmsContactMessage: ['website', 'contact_messages', W, 'web_contact_messages'],

};

/** Raw (non-Mongoose) collections: key -> [area, collection, legacy db, legacy collection]. */
const RAW = {
    membershipCounters: ['members', 'membership_counters', A, 'membership_counters'],
    donationCounters: ['payments', 'donation_counters', A, 'donation_counters'],
    // GridFS: one bucket, two collections. `uploads` is the bucket name.
    uploadsFiles: ['files', 'uploads.files', A, 'uploads.files'],
    uploadsChunks: ['files', 'uploads.chunks', A, 'uploads.chunks'],
};

/** The GridFS bucket and the area that holds it. */
const UPLOADS = { area: 'files', bucket: 'uploads' };

const dbName = (area) => {
    const name = DATABASES[area];
    if (!name) throw new Error(`dataLayout: unknown area '${area}'`);
    return name;
};

/** A Mongoose connection for one area, sharing the main connection's pool. */
const connectionFor = (area) => mongoose.connection.useDb(dbName(area), { useCache: true });

/**
 * Register (or return) a model in its own database and collection.
 * The collection named here wins over any `collection:` schema option.
 */
const model = (name, schema) => {
    const entry = MODELS[name];
    if (!entry) throw new Error(`dataLayout: model '${name}' has no place in the layout — add it to MODELS`);
    const [area, collectionName] = entry;
    const conn = connectionFor(area);
    return conn.models[name] || conn.model(name, schema, collectionName);
};

/** A native driver collection for a RAW key (counters, GridFS). Call at query time. */
const collection = (key) => {
    const entry = RAW[key];
    if (!entry) throw new Error(`dataLayout: raw collection '${key}' has no place in the layout — add it to RAW`);
    const [area, collectionName] = entry;
    return mongoose.connection.getClient().db(dbName(area)).collection(collectionName);
};

/** A native `Db` for an area (GridFS needs the Db, not a collection). */
const nativeDb = (area) => mongoose.connection.getClient().db(dbName(area));

/** The admin tier collections, by model name — read by `admin.repository`. */
const ADMIN_COLLECTIONS = {
    super_admin: MODELS.SuperAdmin[1],
    state_admin: MODELS.StateAdmin[1],
    district_admin: MODELS.DistrictAdmin[1],
    block_admin: MODELS.BlockAdmin[1],
};

/**
 * Refuse to run with a model that escaped the layout.
 *
 * A model registered straight on `mongoose` (the default connection) would
 * write into the main connection's own database — data in a place this map
 * does not list. Called once the routes (and so every model) are loaded.
 */
const assertAllModelsMapped = () => {
    const strays = Object.keys(mongoose.connection.models || {});
    if (strays.length) {
        throw new Error(`dataLayout: model(s) registered outside the layout: ${strays.join(', ')}. `
            + 'Register them with dataLayout.model() so their data lands in a known database.');
    }
};

/** Every (legacy -> new) pair, for the migration script. */
const migrationPlan = () => [
    ...Object.entries(MODELS).map(([name, [area, coll, fromDb, fromColl]]) => ({ name, toDb: dbName(area), toColl: coll, fromDb, fromColl })),
    ...Object.entries(RAW).map(([name, [area, coll, fromDb, fromColl]]) => ({ name, toDb: dbName(area), toColl: coll, fromDb, fromColl })),
];

module.exports = {
    DATABASES,
    MODELS,
    RAW,
    UPLOADS,
    ADMIN_COLLECTIONS,
    dbName,
    connectionFor,
    model,
    collection,
    nativeDb,
    assertAllModelsMapped,
    migrationPlan,
};
