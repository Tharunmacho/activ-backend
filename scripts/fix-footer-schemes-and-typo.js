/**
 * Two content fixes in `web_site_settings`:
 *   - "Schemes" added to the footer, right after "News", in every link column
 *     that has a News link (and not added twice).
 *   - The "Across India" band's eyebrow typo ("Across Indiaa") corrected.
 *
 *   node scripts/fix-footer-schemes-and-typo.js            # dry run
 *   node scripts/fix-footer-schemes-and-typo.js --confirm  # apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    const confirm = process.argv.includes('--confirm');
    await mongoose.connect(process.env.MONGODB_URI);
    const { SiteSettings, SINGLETON_KEY } = require('../src/modules/cms/cms.models');
    const doc = await SiteSettings.findOne({ key: SINGLETON_KEY });
    if (!doc) { console.log('No site settings row.'); process.exit(0); }

    const changes = [];

    const band = doc.acrossIndia || {};
    ['eyebrow', 'heading', 'subtitle'].forEach((k) => {
        const before = String(band[k] || '');
        const after = before.replace(/\bIndiaa+\b/g, 'India');
        if (before !== after) { changes.push(`acrossIndia.${k}: "${before}" -> "${after}"`); band[k] = after; }
    });

    const columns = (doc.footer && doc.footer.linkColumns) || [];
    columns.forEach((col, ci) => {
        const links = col.links || [];
        const has = links.some((l) => String(l.href || '').replace(/\/+$/, '') === '/schemes');
        const at = links.findIndex((l) => String(l.href || '') === '/news');
        console.log(`footer column ${ci + 1} "${col.heading || ''}":`, links.map((l) => l.label).join(' · '));
        if (at >= 0 && !has) {
            links.splice(at + 1, 0, { label: 'Schemes', href: '/schemes' });
            changes.push(`footer column ${ci + 1}: Schemes added after News`);
        }
    });
    console.log('acrossIndia now:', JSON.stringify({ eyebrow: band.eyebrow, heading: band.heading }));

    if (!changes.length) { console.log('Nothing to change.'); process.exit(0); }
    console.log('Changes:\n  ' + changes.join('\n  '));
    if (!confirm) { console.log('Dry run. Re-run with --confirm to apply.'); process.exit(0); }

    doc.markModified('acrossIndia');
    doc.markModified('footer');
    await doc.save();
    console.log('Saved.');
    process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
