/**
 * Move CMS content from `activ-db` into `adminsdb`, one collection per page.
 *
 *   node scripts/migrate-cms-to-adminsdb.js            # dry run
 *   node scripts/migrate-cms-to-adminsdb.js --confirm  # apply
 *
 * The first build stored site content beside member data in `activ-db` as
 * `cms_hero`, `cms_about` and so on. It now lives in `adminsdb` keyed by page,
 * so a page's content is one document that can be read, exported or rolled back
 * on its own.
 *
 * `cms_hero` also changes shape: it becomes the `carousel` block of a `home`
 * document that additionally carries the about, stats and feature blocks.
 *
 * Nothing is deleted from the source. If the migration is wrong the old
 * collections are still there to re-read, which is worth more than a tidy
 * database on the one run where something goes sideways.
 */
require('dotenv').config();

const mongoose = require('mongoose');

const APPLY = process.argv.includes('--confirm');

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

    const adminsDb = require('../src/modules/admin/adminsDb');
    const ready = await adminsDb.ensureReady();
    if (!ready) {
        console.error('adminsdb is unreachable — nothing was migrated.');
        process.exit(1);
    }

    const source = mongoose.connection.db;
    const { Home, About, GalleryItem, ContactSettings, ContactMessage, SINGLETON_KEY } =
        require('../src/modules/cms/cms.models');

    console.log(APPLY ? 'APPLYING\n' : 'DRY RUN — nothing will be written. Re-run with --confirm to apply.\n');

    // ---- what is in the old location ----------------------------------------
    const oldHero = await source.collection('cms_hero').findOne({}).catch(() => null);
    const oldAbout = await source.collection('cms_about').findOne({}).catch(() => null);
    const oldContact = await source.collection('cms_contact_settings').findOne({}).catch(() => null);
    const oldGallery = await source.collection('cms_gallery').find({}).toArray().catch(() => []);
    const oldMessages = await source.collection('cms_contact_messages').find({}).toArray().catch(() => []);

    console.log('Found in activ-db:');
    line('cms_hero', oldHero ? '1 document' : 'none');
    line('cms_about', oldAbout ? '1 document' : 'none');
    line('cms_contact_settings', oldContact ? '1 document' : 'none');
    line('cms_gallery', `${oldGallery.length} document(s)`);
    line('cms_contact_messages', `${oldMessages.length} document(s)`);

    // ---- what is already in the new location ---------------------------------
    console.log('\nAlready in adminsdb:');
    line('home', `${await Home.countDocuments()} document(s)`);
    line('about', `${await About.countDocuments()} document(s)`);
    line('gallery', `${await GalleryItem.countDocuments()} document(s)`);
    line('contact_settings', `${await ContactSettings.countDocuments()} document(s)`);
    line('contact_messages', `${await ContactMessage.countDocuments()} document(s)`);

    if (!APPLY) {
        console.log('\nNothing written. Re-run with --confirm to migrate.');
        await mongoose.disconnect();
        process.exit(0);
    }

    console.log('\nWriting:');

    // ---- hero -> home.carousel ------------------------------------------------
    if (oldHero) {
        // Merged into whatever is already there rather than replacing it: the new
        // home document may already carry stats and features that the old hero
        // knew nothing about, and a blind overwrite would drop them.
        const existing = (await Home.findOne({ key: SINGLETON_KEY }).lean()) || {};

        await Home.findOneAndUpdate(
            { key: SINGLETON_KEY },
            {
                $set: {
                    key: SINGLETON_KEY,
                    carousel: {
                        slides: (oldHero.slides || [])
                            .filter(s => s && s.imageUrl)
                            .map(s => ({
                                media: {
                                    url: s.imageUrl,
                                    // The old shape had no type; everything stored
                                    // through it was an image.
                                    type: 'image',
                                    alt: s.alt || '',
                                    fit: 'cover',
                                    position: 'center',
                                },
                                caption: s.caption || '',
                            })),
                        headline: oldHero.headline || '',
                        subheadline: oldHero.subheadline || '',
                        ctaLabel: oldHero.ctaLabel || '',
                        ctaHref: oldHero.ctaHref || '',
                    },
                    about: existing.about || {},
                    stats: existing.stats || [],
                    features: existing.features || [],
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        line('cms_hero -> adminsdb.home.carousel', `${(oldHero.slides || []).length} slide(s)`);
    }

    // ---- about ----------------------------------------------------------------
    if (oldAbout) {
        await About.findOneAndUpdate(
            { key: SINGLETON_KEY },
            {
                $set: {
                    key: SINGLETON_KEY,
                    heading: oldAbout.heading || '',
                    body: oldAbout.body || '',
                    bulletPoints: oldAbout.bulletPoints || [],
                    media: { url: oldAbout.imageUrl || '', type: 'image', alt: '', fit: 'cover', position: 'center' },
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        line('cms_about -> adminsdb.about', 'migrated');
    }

    // ---- contact ---------------------------------------------------------------
    if (oldContact) {
        await ContactSettings.findOneAndUpdate(
            { key: SINGLETON_KEY },
            {
                $set: {
                    key: SINGLETON_KEY,
                    addressLines: oldContact.addressLines || [],
                    phone: oldContact.phone || '',
                    alternatePhone: oldContact.alternatePhone || '',
                    email: oldContact.email || '',
                    mapEmbedUrl: oldContact.mapEmbedUrl || '',
                    social: oldContact.social || {},
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        line('cms_contact_settings -> contact_settings', 'migrated');
    }

    // ---- gallery ----------------------------------------------------------------
    let galleryMoved = 0;
    for (const item of oldGallery) {
        // Keyed on the original _id so re-running does not duplicate the grid.
        const exists = await GalleryItem.findById(item._id).lean().catch(() => null);
        if (exists) continue;

        await GalleryItem.create({
            _id: item._id,
            media: { url: item.imageUrl || '', type: 'image', alt: '', fit: 'cover', position: 'center' },
            title: item.title || '',
            caption: item.caption || '',
            sortOrder: item.sortOrder || 0,
            visible: item.visible !== false,
        });
        galleryMoved += 1;
    }
    if (oldGallery.length) line('cms_gallery -> gallery', `${galleryMoved} moved, ${oldGallery.length - galleryMoved} already present`);

    // ---- messages ----------------------------------------------------------------
    let messagesMoved = 0;
    for (const msg of oldMessages) {
        const exists = await ContactMessage.findById(msg._id).lean().catch(() => null);
        if (exists) continue;
        await ContactMessage.create({ ...msg, _id: msg._id });
        messagesMoved += 1;
    }
    if (oldMessages.length) line('cms_contact_messages -> contact_messages', `${messagesMoved} moved`);

    console.log('\nDone. The old activ-db collections were left in place — delete them once you have');
    console.log('confirmed the site reads correctly from adminsdb.');

    await mongoose.disconnect();
    process.exit(0);
})().catch(async (error) => {
    console.error('Migration failed:', error && error.message);
    await mongoose.disconnect().catch(() => null);
    process.exit(1);
});
