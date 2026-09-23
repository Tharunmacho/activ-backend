/**
 * Replace the multikey unique index on `conversations.participants` with the
 * scalar `pairKey`, and backfill the key on existing rows.
 *
 * ==========================================================================
 * WHY THIS SCRIPT EXISTS
 * ==========================================================================
 *
 * `conversationSchema.index({ participants: 1 }, { unique: true })` reads as
 * "one conversation per pair". It is not what Mongo does. An index on an array
 * field is MULTIKEY — it indexes each ELEMENT — so unique meant each member
 * could appear in at most one conversation in the whole collection.
 *
 * The symptom: the second person to message anybody got
 * `E11000 ... index: participants_1`, the duplicate handler re-read by pair,
 * found nothing, and the request died with `Cannot read properties of null
 * (reading '_id')`. Every member with one thread was permanently unmessageable.
 *
 * Mongoose does NOT drop an index it no longer declares, so removing the line
 * from the schema is not enough — the index survives in the collection and
 * keeps rejecting writes. It has to be dropped explicitly, here.
 *
 *   node scripts/fix-conversation-index.js            # dry run
 *   node scripts/fix-conversation-index.js --confirm  # apply
 */
const mongoose = require('mongoose');
require('dotenv').config();

const { pairKeyOf } = require('../src/modules/messages/message.model');

const CONFIRM = process.argv.includes('--confirm');
const BAD_INDEX = 'participants_1';

(async() => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const col = mongoose.connection.db.collection('conversations');

    const indexes = await col.indexes();
    const bad = indexes.find(i => i.name === BAD_INDEX && i.unique);

    console.log('conversations indexes:');
    indexes.forEach(i => console.log('  ', i.name, JSON.stringify(i.key), i.unique ? '(unique)' : ''));

    const rows = await col.find({}).project({ participants: 1, pairKey: 1 }).toArray();
    const needKey = rows.filter(r => !r.pairKey && (r.participants || []).length === 2);

    console.log('');
    console.log('to drop      :', bad ? BAD_INDEX + ' (unique, multikey)' : 'nothing');
    console.log('to backfill  :', needKey.length, 'of', rows.length, 'conversations');

    /*
     * A pair that appears twice cannot both keep a unique key. It should be
     * impossible — the broken index was stricter than the rule it was meant to
     * enforce — but reporting it is cheap and repairing it blindly is not.
     */
    const seen = new Map();
    const clashes = [];
    for (const r of rows) {
        const key = r.pairKey || pairKeyOf(r.participants[0], r.participants[1]);
        if (seen.has(key)) clashes.push([seen.get(key), r._id, key]);
        else seen.set(key, r._id);
    }
    if (clashes.length) {
        console.log('');
        console.log('DUPLICATE PAIRS — merge these by hand before applying:');
        clashes.forEach(([a, b, k]) => console.log('  ', k, '->', String(a), String(b)));
        await mongoose.disconnect();
        return process.exit(1);
    }

    if (!CONFIRM) {
        console.log('\nDRY RUN — pass --confirm to apply.');
        await mongoose.disconnect();
        return process.exit(0);
    }

    for (const r of needKey) {
        await col.updateOne(
            { _id: r._id },
            { $set: { pairKey: pairKeyOf(r.participants[0], r.participants[1]) } },
        );
    }
    console.log('backfilled   :', needKey.length);

    if (bad) {
        await col.dropIndex(BAD_INDEX);
        console.log('dropped      :', BAD_INDEX);
    }

    // Created here rather than left to autoIndex, which is off in production.
    await col.createIndex({ pairKey: 1 }, { unique: true, name: 'pairKey_1' });
    console.log('created      : pairKey_1 (unique)');

    console.log('\nfinal indexes:');
    (await col.indexes()).forEach(i => console.log('  ', i.name, JSON.stringify(i.key), i.unique ? '(unique)' : ''));

    await mongoose.disconnect();
    process.exit(0);
})().catch((err) => {
    console.error('ERR', err.message);
    process.exit(1);
});
