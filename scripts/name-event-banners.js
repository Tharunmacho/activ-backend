/**
 * Existing uploaded event banners: copy to an event-slug filename, preserving
 * every original. Dry run by default; --confirm persists copies and URLs.
 * Run inside the deployed backend so its database and storage are available.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const config = require('../src/config');
const Event = require('../src/modules/events/event.model');
const store = require('../src/core/storage/uploadStore');
const { readOriginal } = require('../src/core/storage/imageVariants');
const { uploadNameOf } = require('../src/core/storage/uploadUrls');
const { bannerName, nameEventBanner } = require('../src/modules/events/eventBanner');

async function main() {
    const confirmed = process.argv.includes('--confirm');
    await mongoose.connect(config.db.uri, { dbName: config.db.name });
    try {
        let updated = 0;
        let unavailable = 0;
        for await (const event of Event.find({ bannerUrl: { $nin: ['', null] } })
            .select('_id title slug startAt bannerUrl').lean().cursor()) {
            const source = uploadNameOf(event.bannerUrl);
            if (!source || store.safeRel(source) !== source) continue;
            const bytes = await readOriginal(store.UPLOADS_DIR, source, store);
            if (!bytes) { unavailable++; continue; }
            const name = bannerName(event, source, bytes);
            if (!name || name === source) continue;
            console.log(`${event.slug || event._id}: /uploads/${name}`);
            if (confirmed) {
                const bannerUrl = await nameEventBanner(event);
                if (bannerUrl === event.bannerUrl) { unavailable++; continue; }
                const result = await Event.updateOne({ _id: event._id, bannerUrl: event.bannerUrl }, { $set: { bannerUrl } });
                updated += result.modifiedCount;
            }
        }
        console.log(JSON.stringify({ mode: confirmed ? 'applied' : 'dry-run', updated, unavailable }));
    } finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error('Banner migration failed; check database/storage connectivity.'); process.exitCode = 1; });
