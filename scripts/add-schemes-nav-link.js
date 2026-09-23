/**
 * Adds "Schemes" to the header menu, right after "News".
 *
 * The header's links are CMS content (`web_site_settings.header.navLinks`),
 * so a new page reaches the menu through the data, not the code. Idempotent:
 * a menu that already links to /schemes is left exactly as it is, and an
 * editor can move or remove the item afterwards under Header & Footer.
 *
 *   node scripts/add-schemes-nav-link.js            # dry run
 *   node scripts/add-schemes-nav-link.js --confirm  # apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    const confirm = process.argv.includes('--confirm');
    await mongoose.connect(process.env.MONGODB_URI);
    const { SiteSettings, SINGLETON_KEY } = require('../src/modules/cms/cms.models');

    const doc = await SiteSettings.findOne({ key: SINGLETON_KEY });
    if (!doc) { console.log('No site settings row — nothing to change.'); process.exit(0); }

    const links = (doc.header && doc.header.navLinks) || [];
    if (links.some((l) => String(l.href || '').replace(/\/+$/, '') === '/schemes')) {
        console.log('The menu already links to /schemes — unchanged.');
        process.exit(0);
    }

    const at = links.findIndex((l) => String(l.href || '') === '/news');
    const position = at >= 0 ? at + 1 : links.length;
    console.log(`Will insert "Schemes" at position ${position + 1} of ${links.length + 1}.`);

    if (!confirm) { console.log('Dry run. Re-run with --confirm to apply.'); process.exit(0); }

    links.splice(position, 0, { label: 'Schemes', href: '/schemes' });
    doc.header.navLinks = links;
    doc.markModified('header');
    await doc.save();
    console.log('Added. Menu:', doc.header.navLinks.map((l) => l.label).join(' · '));
    process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
