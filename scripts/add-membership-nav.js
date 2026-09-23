/**
 * Put "Membership" in the public site's nav.
 *
 *   node scripts/add-membership-nav.js            # report what would change
 *   node scripts/add-membership-nav.js --confirm  # write it
 *
 * =========================================================================
 * WHY THIS IS A SCRIPT AND NOT A LINE IN THE SEED
 * =========================================================================
 *
 * It is a line in the seed too — `seed-cms-content.js` now lists the link, so a
 * database seeded from scratch gets it. But that script deliberately leaves a
 * section alone once it holds content ("An admin who has rewritten the home
 * page should not have this script quietly put the shipped copy back"), and
 * every live deployment already has its nav. On those, the seed writes nothing
 * and the new `/membership` page would be a route with no way to reach it.
 *
 * So: one narrow, idempotent write. It adds exactly one link, in one place in
 * the order, and leaves every other nav entry, the CTA, the colours and the
 * footer's other columns exactly as the editor left them. Running it twice
 * changes nothing, because the first thing it does is look for the link.
 *
 * The Super Admin can also add it by hand in CMS → Site settings; this is the
 * same edit, made once, without asking them to type a path correctly.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');

const LINK = { label: 'Membership', href: '/membership' };

/** Matched on the PATH, not the label: an editor may have renamed it. */
const has = (links = []) =>
    links.some(l => String((l || {}).href || '').trim().toLowerCase() === LINK.href);

/**
 * After "About", or at the end when there is no About.
 *
 * Beside About on purpose — the two answer neighbouring questions ("what is
 * this association" and "what do I get by joining it"), and the prospectus
 * reads as the second half of the first. Appending it after Contact Us would
 * put the one page with a Join button on it at the far end of the bar.
 */
const withLink = (links = []) => {
    const at = links.findIndex(l => String((l || {}).href || '').trim() === '/about');
    const next = links.map(l => ({ label: l.label, href: l.href }));
    if (at === -1) next.push({ ...LINK });
    else next.splice(at + 1, 0, { ...LINK });
    return next;
};

async function main() {
    console.log('\n=== Membership nav link ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: DRY RUN (pass --confirm to write)');

    await mongoose.connect(config.db.uri);
    // The CMS models bind to the secondary connection; opening it before they
    // are required is what keeps them off the default database.
    await adminsDb.ensureReady();

    const cms = require('../src/modules/cms/cms.service');
    const site = await cms.getSiteSettings();

    const header = site.header || {};
    const navLinks = header.navLinks || [];
    const columns = (site.footer || {}).linkColumns || [];

    const headerNeeds = !has(navLinks);
    // The footer's FIRST column is the site map — the one that mirrors the nav.
    // A heading-less column is that one; the others are "News", "Support" and
    // so on, and adding a membership link to those would read as a mistake.
    const columnIndex = columns.findIndex(c => !String((c || {}).heading || '').trim());
    const footerNeeds = columnIndex !== -1 && !has((columns[columnIndex] || {}).links);

    console.log(`\nHeader nav : ${navLinks.length} links — ${headerNeeds ? 'ADD' : 'already there, leaving it'}`);
    console.log(`Footer map : ${columnIndex === -1 ? 'no site-map column, skipping' : (footerNeeds ? 'ADD' : 'already there, leaving it')}`);

    if (!headerNeeds && !footerNeeds) {
        console.log('\nNothing to do.\n');
        return;
    }

    if (!CONFIRM) {
        console.log('\nDry run — nothing written. Re-run with --confirm.\n');
        return;
    }

    const payload = {};

    if (headerNeeds) {
        payload.header = { ...header, navLinks: withLink(navLinks) };
    }

    if (footerNeeds) {
        payload.footer = {
            ...(site.footer || {}),
            linkColumns: columns.map((column, i) => (
                i === columnIndex
                    ? { ...column, links: withLink(column.links || []) }
                    : column
            )),
        };
    }

    await cms.updateSiteSettings(payload, { email: 'script@activ.org.in' });

    const after = await cms.getSiteSettings();
    console.log('\nNav is now:', ((after.header || {}).navLinks || []).map(l => l.label).join(' · '));
    console.log('Done.\n');
}

main()
    .catch((err) => {
        console.error('\nFailed:', err && err.message ? err.message : err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
        process.exit(process.exitCode || 0);
    });
