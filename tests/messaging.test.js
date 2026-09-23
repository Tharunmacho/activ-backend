/**
 * End-to-end test of MEMBER-TO-MEMBER DIRECT MESSAGES against a running server
 * and a real MongoDB.
 *
 *   BASE_URL=http://localhost:5055 node tests/messaging.test.js
 *
 * ==========================================================================
 * WHY THE SHARED-PARTICIPANT CASE IS THE FIRST THING THIS SUITE ASSERTS
 * ==========================================================================
 *
 * The feature shipped with `index({ participants: 1 }, { unique: true })` on
 * the conversation. That reads as "one conversation per pair" and is not what
 * Mongo does: an index on an array field is MULTIKEY, so unique meant each
 * member could appear in at most ONE conversation in the whole collection.
 *
 * It passed every test written for it, because every one of those tests used a
 * FRESH PAIR of members. The bug needed a member who already had a thread — so
 * it reached a real member instead, who had messaged one person and was then
 * permanently unmessageable by everybody else, with a 500 reading `_id` of
 * null.
 *
 * `openWith` keys on the scalar `pairKey` now. The test that would have caught
 * it is "bravo opens a SECOND conversation with the same hub", below, and it is
 * the reason this file seeds THREE paid members rather than two.
 *
 * SAFETY: every document is tagged with a unique run id and removed in the
 * cleanup phase, which runs even if an assertion fails. The conversation and
 * message counts are snapshotted before and compared after, because this suite
 * writes to the collections that hold real members' correspondence.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const config = require('../src/config');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5055';
const API = `${BASE_URL}/api/v1`;
const RUN = `msg${Date.now()}`;

// MemberDetails writes to `users` — see the collection table in CLAUDE.md.
const MEMBERS = 'users';

let passed = 0;
let failed = 0;
const created = { members: [] };

const test = async(name, fn) => {
    try {
        await fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${error.message}`);
    }
};

const section = (title) => console.log(`\n${title}`);

const eq = (actual, expected, what) => {
    if (String(actual) !== String(expected)) {
        throw new Error(`${what}: expected ${expected}, got ${actual}`);
    }
};

const request = async(method, path, { token, body } = {}) => {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    });

    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, body: json, data: json && json.data };
};

/**
 * A member token, minted directly.
 *
 * `verifyToken` is stateless — it checks the signature and reads the claims —
 * so signing here produces the same token the login route would hand out,
 * without needing a password hash and a `memberauths` row per fixture. The
 * service re-reads membership status from the database regardless, and that is
 * the half which actually gates this feature.
 */
const tokenFor = (id) => jwt.sign(
    { userId: String(id), id: String(id), email: `${RUN}@msg.invalid`, role: 'member' },
    config.jwt.secret,
    { expiresIn: '15m' }
);

(async() => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    console.log(`\nConnected to ${mongoose.connection.name}`);
    console.log(`Server:   ${BASE_URL}`);
    console.log(`Run id:   ${RUN}`);

    const before = {
        conversations: await db.collection('conversations').countDocuments(),
        messages: await db.collection('messages').countDocuments()
    };

    try {
        // ---------------------------------------------------------------
        section('Setup: four member profiles, one of them unpaid');
        // ---------------------------------------------------------------
        const seed = async(name, membershipStatus) => {
            const _id = new mongoose.Types.ObjectId();
            await db.collection(MEMBERS).insertOne({
                _id,
                userId: _id,
                fullName: `MSG ${name}`,
                email: `${RUN}.${name}@msg.invalid`,
                phoneNumber: '9000000002',
                state: 'MSG Test State',
                district: 'MSG Test District',
                block: 'MSG Test Block',
                organizationName: `${name} Industries`,
                role: 'member',
                isActive: true,
                membershipStatus,
                createdAt: new Date(),
                updatedAt: new Date(),
                __msg: RUN
            });
            created.members.push(_id);
            return _id;
        };

        // `hub` is the member everybody else talks to — the shape the multikey
        // index made impossible.
        const hub = await seed('hub', 'active');
        const alpha = await seed('alpha', 'active');
        const bravo = await seed('bravo', 'active');
        const unpaid = await seed('unpaid', 'pending');
        console.log(`  seeded ${created.members.length} members`);

        const T = {
            hub: tokenFor(hub),
            alpha: tokenFor(alpha),
            bravo: tokenFor(bravo),
            unpaid: tokenFor(unpaid)
        };

        // ---------------------------------------------------------------
        section('One member, several conversations  (the multikey regression)');
        // ---------------------------------------------------------------
        let first = null;
        let second = null;

        await test('alpha opens a conversation with hub', async() => {
            const res = await request('POST', `/messages/with/${hub}`, { token: T.alpha });
            eq(res.status, 200, 'status');
            if (!res.data || !res.data.id) throw new Error(`no conversation id: ${JSON.stringify(res.body)}`);
            eq(res.data.withMember && res.data.withMember.id, hub, 'withMember');
            first = res.data.id;
        });

        /*
         * THE ONE THAT USED TO 500. hub is now inside a conversation, and the
         * unique multikey index refused to let them into a second one.
         */
        await test('bravo opens a SECOND conversation with the same hub', async() => {
            const res = await request('POST', `/messages/with/${hub}`, { token: T.bravo });
            eq(res.status, 200, 'status');
            if (!res.data || !res.data.id) throw new Error(`no conversation id: ${JSON.stringify(res.body)}`);
            second = res.data.id;
        });

        await test('...and it is a separate thread, not alpha’s', async() => {
            if (!first || !second) throw new Error('an earlier step did not produce a thread');
            if (first === second) throw new Error(`both calls returned ${first}`);
        });

        await test('alpha and bravo can also talk to each other', async() => {
            const res = await request('POST', `/messages/with/${bravo}`, { token: T.alpha });
            eq(res.status, 200, 'status');
        });

        await test('re-opening is idempotent, from either side', async() => {
            const mine = await request('POST', `/messages/with/${hub}`, { token: T.alpha });
            eq(mine.data && mine.data.id, first, 'alpha re-opening');
            const theirs = await request('POST', `/messages/with/${alpha}`, { token: T.hub });
            eq(theirs.data && theirs.data.id, first, 'hub opening the same pair from the other end');
        });

        await test('hub’s inbox lists both of their conversations', async() => {
            const res = await request('GET', '/messages', { token: T.hub });
            eq(res.status, 200, 'status');
            eq(((res.data && res.data.conversations) || []).length, 2, 'conversation count');
        });

        // ---------------------------------------------------------------
        section('A message reaches the other member, and they can reply');
        // ---------------------------------------------------------------
        await test('alpha sends, and the send is accepted', async() => {
            const res = await request('POST', `/messages/${first}`, {
                token: T.alpha, body: { body: 'Hello from the regression suite' }
            });
            eq(res.status, 201, 'status');
            eq(res.data && res.data.mine, true, 'mine, for the sender');
        });

        await test('hub reads it in the thread, marked as theirs and not their own', async() => {
            const res = await request('GET', `/messages/${first}`, { token: T.hub });
            eq(res.status, 200, 'status');
            const [msg] = (res.data && res.data.messages) || [];
            if (!msg) throw new Error('hub sees an empty thread');
            eq(msg.body, 'Hello from the regression suite', 'body');
            eq(msg.mine, false, 'mine, for the recipient');
        });

        await test('the unread badge counts it for hub and not for alpha', async() => {
            const theirs = await request('GET', '/messages/unread-count', { token: T.hub });
            eq(theirs.data && theirs.data.unread, 1, 'hub unread');
            const mine = await request('GET', '/messages/unread-count', { token: T.alpha });
            eq(mine.data && mine.data.unread, 0, 'alpha unread');
        });

        await test('hub replies, and alpha sees the reply', async() => {
            const sent = await request('POST', `/messages/${first}`, {
                token: T.hub, body: { body: 'Received, thank you' }
            });
            eq(sent.status, 201, 'reply status');

            const res = await request('GET', `/messages/${first}`, { token: T.alpha });
            const messages = (res.data && res.data.messages) || [];
            eq(messages.length, 2, 'messages in the thread');
            eq(messages[1].body, 'Received, thank you', 'newest last');
            eq(messages[1].mine, false, 'the reply is the other member’s');
        });

        await test('marking read clears the badge and stamps only the other side', async() => {
            await request('POST', `/messages/${first}/read`, { token: T.hub });
            const badge = await request('GET', '/messages/unread-count', { token: T.hub });
            eq(badge.data && badge.data.unread, 0, 'hub unread after reading');

            const thread = await request('GET', `/messages/${first}`, { token: T.hub });
            const [incoming, own] = thread.data.messages;
            if (!incoming.readAt) throw new Error('the message hub read is not stamped');
            if (own.readAt) throw new Error('hub’s own message was stamped read by hub');
        });

        // ---------------------------------------------------------------
        section('Who may not message whom');
        // ---------------------------------------------------------------
        await test('an unpaid member cannot open a conversation', async() => {
            const res = await request('POST', `/messages/with/${hub}`, { token: T.unpaid });
            eq(res.status, 403, 'status');
        });

        await test('a paid member cannot open one with an unpaid member', async() => {
            const res = await request('POST', `/messages/with/${unpaid}`, { token: T.alpha });
            eq(res.status, 400, 'status');
        });

        await test('nobody can start a conversation with themselves', async() => {
            const res = await request('POST', `/messages/with/${alpha}`, { token: T.alpha });
            eq(res.status, 400, 'status');
        });

        await test('a member outside a thread cannot read it, even knowing the id', async() => {
            const res = await request('GET', `/messages/${first}`, { token: T.bravo });
            eq(res.status, 404, 'status');
        });

        await test('...nor send into it', async() => {
            const res = await request('POST', `/messages/${first}`, {
                token: T.bravo, body: { body: 'not mine to send' }
            });
            eq(res.status, 404, 'status');
        });

        await test('an empty message is refused', async() => {
            const res = await request('POST', `/messages/${first}`, {
                token: T.alpha, body: { body: '   ' }
            });
            eq(res.status, 400, 'status');
        });

        await test('messaging requires a token at all', async() => {
            const res = await request('GET', '/messages');
            eq(res.status, 401, 'status');
        });
    } catch (runError) {
        failed += 1;
        console.error(`\n  ABORTED: ${runError.message}`);
        console.error((runError.stack || '').split('\n').slice(1, 4).join('\n'));
    } finally {
        // ---------------------------------------------------------------
        section('Cleanup');
        // ---------------------------------------------------------------
        const db2 = mongoose.connection.db;

        // Conversations are found through the seeded members rather than by a
        // tag: the service creates them, so there is nothing of ours on them
        // to tag.
        const convs = await db2.collection('conversations')
            .find({ participants: { $in: created.members } }).project({ _id: 1 }).toArray()
            .catch(() => []);
        const convIds = convs.map(c => c._id);

        const delMessages = await db2.collection('messages')
            .deleteMany({ conversationId: { $in: convIds } }).catch(() => ({ deletedCount: 0 }));
        const delConvs = await db2.collection('conversations')
            .deleteMany({ _id: { $in: convIds } }).catch(() => ({ deletedCount: 0 }));
        const delMembers = await db2.collection(MEMBERS)
            .deleteMany({ __msg: RUN }).catch(() => ({ deletedCount: 0 }));

        console.log(`  removed ${delMessages.deletedCount} messages, `
            + `${delConvs.deletedCount} conversations, ${delMembers.deletedCount} members`);

        const after = {
            conversations: await db2.collection('conversations').countDocuments(),
            messages: await db2.collection('messages').countDocuments()
        };
        console.log(`  conversations: ${before.conversations} before -> ${after.conversations} after`);
        console.log(`  messages:      ${before.messages} before -> ${after.messages} after`);

        if (after.conversations !== before.conversations || after.messages !== before.messages) {
            failed += 1;
            console.error('  WARNING: this run did not leave the collections as it found them');
        }

        await mongoose.disconnect();
        console.log(`\n${passed} passed, ${failed} failed\n`);
        process.exit(failed > 0 ? 1 : 0);
    }
})().catch(async(err) => {
    console.error('\nMESSAGING RUN ABORTED:', err.message);
    try { await mongoose.disconnect(); } catch { /* already closed */ }
    process.exit(1);
});
