/**
 * Verifies what the CMS site-settings screen can and cannot store.
 *
 * The screen was reorganised into two cards — Header and Footer — each holding
 * everything the bar it controls renders. Three things had to change behind it,
 * and each is checked here:
 *
 *   1. **header colours.** The bar was `bg-white` with `#1c2e68` text, written
 *      into eight class names in `HeaderSection`, so recolouring the header
 *      meant a code change and a deploy. They are editable now — and validated,
 *      because they are interpolated into an inline `style` and an unchecked
 *      string there is a place to inject arbitrary CSS.
 *   2. **the field that did nothing.** `brand.name` was asked for by the CMS and
 *      rendered by nothing: not the header, not the footer, not a page. It is
 *      gone, and this asserts the server no longer stores it.
 *   3. **the repeatable lists still round-trip.** Nav links, footer columns and
 *      the links inside them, phone numbers, address lines, social buttons and
 *      legal links are all added and read back.
 *
 * The live settings are saved before the run and restored afterwards, including
 * on failure, so this is safe against the real site.
 *
 *   PORT=5077 node src/server.js
 *   BASE_URL=http://localhost:5077 node scripts/verify-cms-site-settings.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = (process.env.BASE_URL || 'http://localhost:5077').replace(/\/$/, '') + '/api/v1';

let passed = 0;
let failed = 0;

const check = (name, condition, detail) => {
    if (condition) {
        passed += 1;
        console.log('  PASS  ' + name);
    } else {
        failed += 1;
        console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
    }
};

const call = async (path, options = {}) => {
    const res = await fetch(BASE + path, {
        method: options.method || 'GET',
        headers: Object.assign(
            { 'Content-Type': 'application/json' },
            options.token ? { Authorization: 'Bearer ' + options.token } : {},
        ),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    const data = body && Object.prototype.hasOwnProperty.call(body, 'data') && body.data != null
        ? body.data
        : body;
    return { status: res.status, body, data };
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const token = jwt.sign(
        {
            userId: new mongoose.Types.ObjectId().toString(),
            role: 'super_admin',
            email: 'cms-verify@parity.local',
        },
        process.env.JWT_SECRET,
        { expiresIn: '10m' },
    );

    // The live settings, restored in `finally` whatever happens below.
    const original = (await call('/cms/site', { token })).data;

    try {
        console.log('\nThe header carries its own colours');

        const saved = await call('/cms/site', {
            method: 'PUT',
            token,
            body: {
                header: {
                    navLinks: [
                        { label: 'Home', href: '/' },
                        { label: 'About', href: '/about' },
                        { label: 'Events', href: '/events' },
                        { label: 'Gallery', href: '/gallery' },
                        { label: 'Contact Us', href: '/contact' },
                    ],
                    ctaLabel: 'Login',
                    ctaHref: '/login',
                    background: '#0B1F3A',
                    textColor: '#FFD166',
                },
            },
        });

        check('the header saves', saved.status === 200, 'answered ' + saved.status);

        let header = (saved.data || {}).header || {};
        check('the background is stored', header.background === '#0b1f3a', header.background);
        check('the text colour is stored', header.textColor === '#ffd166', header.textColor);
        check('all five nav links survive', (header.navLinks || []).length === 5,
            String((header.navLinks || []).length));
        check('the nav order is preserved',
            (header.navLinks || []).map(l => l.label).join(',') === 'Home,About,Events,Gallery,Contact Us',
            (header.navLinks || []).map(l => l.label).join(','));
        check('the button is stored', header.ctaLabel === 'Login' && header.ctaHref === '/login');

        const readBack = await call('/cms/site');
        check('the public read returns the colours',
            (readBack.data.header || {}).background === '#0b1f3a',
            (readBack.data.header || {}).background);

        console.log('\nA colour that is not a colour never reaches the page');

        for (const [label, value] of [
            ['a CSS injection attempt', 'red; background-image: url(//evil.test/x)'],
            ['a javascript: URL', 'javascript:alert(1)'],
            ['a named colour', 'rebeccapurple'],
            ['an unprefixed hex', '1c2e68'],
            ['an empty string', ''],
        ]) {
            const res = await call('/cms/site', {
                method: 'PUT',
                token,
                body: { header: { ...header, background: value } },
            });
            const stored = ((res.data || {}).header || {}).background;
            check(label + ' falls back to the default', stored === '#ffffff',
                'stored ' + JSON.stringify(stored));
        }

        // Put a real colour back for the remaining assertions.
        header = ((await call('/cms/site', {
            method: 'PUT', token, body: { header: { ...header, background: '#0b1f3a' } },
        })).data || {}).header || {};

        console.log('\nThe field that was rendered by nothing is gone');

        const withDeadField = await call('/cms/site', {
            method: 'PUT',
            token,
            body: {
                brand: {
                    logo: (original.brand || {}).logo || {},
                    name: 'SHOULD NOT PERSIST',
                    fullName: 'Adidravidar Confederation of Trade and Industrial Vision',
                    tagline: 'Building Future',
                },
            },
        });
        const brand = (withDeadField.data || {}).brand || {};
        check('a short name sent by a client is not stored', brand.name === undefined,
            JSON.stringify(brand.name));
        check('the full name still is', brand.fullName === 'Adidravidar Confederation of Trade and Industrial Vision');
        check('the tagline still is', brand.tagline === 'Building Future');

        console.log('\nEverything repeatable round-trips');

        const footerSaved = await call('/cms/site', {
            method: 'PUT',
            token,
            body: {
                footer: {
                    addressLines: ['Line one', 'Line two', 'Line three'],
                    linkColumns: [
                        { heading: 'Quick links', links: [{ label: 'Home', href: '/' }, { label: 'About', href: '/about' }] },
                        { heading: 'News', links: [{ label: 'Latest', href: '/events' }] },
                    ],
                    contactHeading: 'Contact',
                    email: 'enquiry@activ.org.in',
                    phones: ['+91 44 2345 6789', '+91 98765 43210'],
                    socials: [
                        { icon: 'instagram', href: 'https://instagram.com/activ' },
                        { icon: 'facebook', href: 'https://facebook.com/activ' },
                        // Empty — the server drops this one.
                        { icon: 'twitter', href: '' },
                        // '#' is kept on purpose: it is what an editor leaves
                        // while a social account is still being set up, and
                        // silently deleting the button they just added would be
                        // worse than rendering one that does not navigate.
                        { icon: 'youtube', href: '#' },
                    ],
                    copyright: '© {year} ACTIV',
                    legalLinks: [{ label: 'Terms', href: '/terms' }],
                    note: 'All rights reserved.',
                },
            },
        });

        const footer = (footerSaved.data || {}).footer || {};
        check('address lines survive', (footer.addressLines || []).length === 3,
            String((footer.addressLines || []).length));
        check('both columns survive', (footer.linkColumns || []).length === 2,
            String((footer.linkColumns || []).length));
        check('the links inside a column survive',
            ((footer.linkColumns || [])[0] || {}).links?.length === 2,
            String(((footer.linkColumns || [])[0] || {}).links?.length));
        check('both phone numbers survive', (footer.phones || []).length === 2,
            String((footer.phones || []).length));
        check('social links with a destination survive',
            (footer.socials || []).some(sme => sme.icon === 'instagram'));
        check('a social link with no destination at all is dropped',
            !(footer.socials || []).some(sme => !sme.href),
            JSON.stringify((footer.socials || []).map(sme => sme.icon)));
        check('a placeholder # is kept for an editor to fill in later',
            (footer.socials || []).some(sme => sme.href === '#'),
            JSON.stringify((footer.socials || []).map(sme => sme.href)));
        check('the legal link survives', (footer.legalLinks || []).length === 1);
        check('{year} is stored literally, not expanded',
            String(footer.copyright).includes('{year}'), footer.copyright);

        console.log('\nSaving one bar does not disturb the other');

        const navBefore = ((await call('/cms/site')).data.header || {}).navLinks || [];
        await call('/cms/site', {
            method: 'PUT', token, body: { footer: { ...footer, note: 'Touched' } },
        });
        const navAfter = ((await call('/cms/site')).data.header || {}).navLinks || [];
        check('the nav is untouched by a footer save',
            navBefore.length === navAfter.length && navAfter.length === 5,
            navBefore.length + ' -> ' + navAfter.length);
    } catch (error) {
        failed += 1;
        console.log('\n  FAIL  the run threw: ' + (error && error.message));
    } finally {
        if (original) {
            await call('/cms/site', {
                method: 'PUT',
                token,
                body: {
                    brand: original.brand,
                    header: original.header,
                    footer: original.footer,
                },
            }).catch(() => null);

            const restored = (await call('/cms/site')).data || {};
            const same = ((restored.header || {}).navLinks || []).length
                === ((original.header || {}).navLinks || []).length;
            console.log('\n  teardown: live settings restored' + (same ? ' (nav intact)' : '  *** CHECK MANUALLY ***'));
            if (!same) failed += 1;
        }
        await mongoose.disconnect();
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed === 0) {
        console.log('\n  THE HEADER AND FOOTER ARE EDITABLE, VALIDATED AND STORED\n');
    }
    process.exit(failed > 0 ? 1 : 0);
})();
