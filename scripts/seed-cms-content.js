/**
 * Move the onboarding site's content out of the markup and into the CMS.
 *
 * Every string, figure, icon and image below was previously hardcoded in a
 * React component. The public pages no longer carry any of it: they render what
 * this database holds and nothing where nothing is authored. That is the point
 * — deleting a stat in the CMS has to actually delete it from the site — but it
 * means the pages come up bare until this has run once.
 *
 * Idempotent by construction: every write is an upsert on a singleton key, and
 * gallery items are matched on title. Running it twice changes nothing.
 *
 *   node scripts/seed-cms-content.js            # report what would change
 *   node scripts/seed-cms-content.js --confirm  # write it
 *   node scripts/seed-cms-content.js --confirm --force
 *       # also overwrite sections that have already been edited
 *
 * Without `--force`, a section that already holds content is left alone. An
 * admin who has rewritten the home page should not have this script quietly
 * put the shipped copy back.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');
const FORCE = process.argv.includes('--force');

const LOGO = '/logo_ACTIVian-removebg-preview.png';

/** Images the pages used to reference directly. Editable like anything else. */
const img = (url, alt = '', fit = 'cover') => ({ url, type: 'image', alt, fit, position: 'center' });

// ============================================================ the content

const SITE = {
    brand: {
        logo: img(LOGO, 'ACTIV', 'contain'),
        name: 'ACTIV',
        fullName: 'Adidravidar Confederation of Trade and Industrial Vision',
        tagline: 'Building Future',
    },
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
    },
    footer: {
        addressLines: [
            '6&7, Hayagreeva Apartments,',
            '121, Velachery Road, Guindy,',
            'Chennai, TamilNadu-600032, India',
        ],
        linkColumns: [
            {
                heading: '',
                links: [
                    { label: 'Home', href: '/' },
                    { label: 'About', href: '/about' },
                    { label: 'Events', href: '/events' },
                    { label: 'Gallery', href: '/gallery' },
                    { label: 'Contact', href: '/contact' },
                ],
            },
            {
                heading: 'News',
                links: [
                    { label: 'Latest News', href: '#' },
                    { label: 'Conferences', href: '#' },
                    { label: 'CSR Initiatives', href: '#' },
                    { label: 'Careers', href: '#' },
                ],
            },
        ],
        contactHeading: 'Contact',
        phones: ['+91 44 2345 6789', '+91 98765 43210'],
        email: 'enquiry@activ.org.in',
        socials: [
            { icon: 'instagram', href: '#' },
            { icon: 'facebook', href: '#' },
            { icon: 'linkedin', href: '#' },
            { icon: 'twitter', href: '#' },
            { icon: 'youtube', href: '#' },
        ],
        // `{year}` is replaced at render time, so this never goes stale.
        copyright: '© {year} ACTIV - Designed and Developed by ACTIV Tech Team',
        legalLinks: [
            { label: 'Terms & Conditions', href: '#' },
            { label: 'Privacy Policy', href: '#' },
        ],
        note: 'All rights reserved.',
    },
};

const HOME = {
    carousel: {
        slides: [
            { media: img('https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80', 'ACTIV conference'), caption: '' },
            { media: img('https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80', 'Members networking'), caption: '' },
            { media: img('https://images.unsplash.com/photo-1556761175-4b46a572b786?auto=format&fit=crop&q=80', 'Partnership handshake'), caption: '' },
        ],
        headline: 'Empowering SC/ST Entrepreneurs for a',
        headlineHighlight: 'Better Future',
        subheadline: 'Help us provide a strong platform, education, networking, and resources to upcoming businesses. Together, we can build a brighter economic foundation.',
        ctaLabel: 'Donate Now',
        ctaHref: '#',
        ctaIcon: 'heart',
        secondaryCtaLabel: 'Learn More',
        secondaryCtaHref: '/about',
        secondaryCtaIcon: 'play',
        highlightCard: {
            enabled: true,
            icon: 'users',
            eyebrow: 'Growing Network',
            value: '5,000+',
            caption: 'Members Registered',
            stats: [
                { icon: 'map-pin', value: '39+', label: 'Districts' },
                { icon: 'users', value: '405+', label: 'Blocks' },
                { icon: 'calendar-days', value: '15+', label: 'Events' },
            ],
        },
    },

    about: {
        badgeIcon: 'users',
        badgeText: 'About Us',
        heading: 'About the Activities',
        headingHighlight: 'of ACTIV',
        eyebrow: '',
        body: '<strong>ACTIV</strong> (Adidravidar Confederation of Trade and Industrial Vision) is an Indian Chamber of Commerce for SC/ST entrepreneurs spread across the world.',
        bullets: [
            { icon: 'users', text: 'A <strong>Non-Government, Non-Profit, Non-Political</strong> business association in India for SC/ST community known as Scheduled Castes and Scheduled Tribes, Adidravidar or Dalits.' },
            { icon: 'globe', text: 'Unites <strong>Hindu, Christian, Sikh and Buddhist</strong> entrepreneurs, businesspersons, and traders from SC/ST communities, irrespective of their religions.' },
            { icon: 'trending-up', text: "Contributes to the Nation's Growth and International Business by Networking with SC/ST Entrepreneurs and Creating Entrepreneurs in SC/ST Community by giving Handholding support to relevant field Experts." },
            { icon: 'briefcase', text: 'Conducts continuous business events like Seminars, webinars, Conferences, Exhibitions, Networking Events, Start-up meetings, Pitch festivals, Investor meetings, and Vendor Development programs.' },
            { icon: 'shield-check', text: 'Works for SC/ST business friendly Policy Framing with Government in India for Entrepreneurship Development and Wealth Creation of SC/ST communities.' },
        ],
        media: img('https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80', 'ACTIV presentation'),
        logoOverlay: img(LOGO, 'ACTIV', 'contain'),
        linkLabel: '',
        linkHref: '',
        statsBar: [
            { icon: 'users', value: '10K+', label: 'Active Members' },
            { icon: 'handshake', value: '500+', label: 'Business Partners' },
            { icon: 'calendar', value: '200+', label: 'Events Conducted' },
            { icon: 'globe', value: '25+', label: 'Countries Connected' },
        ],
    },
};

/** The About page. Same layout as the home block, its own content. */
const ABOUT = {
    badgeIcon: 'users',
    badgeText: 'About Us',
    heading: 'About the Activities',
    headingHighlight: 'of ACTIV',
    body: HOME.about.body,
    bullets: HOME.about.bullets,
    media: HOME.about.media,
    logoOverlay: HOME.about.logoOverlay,
    statsBar: HOME.about.statsBar,
};

const EVENTS_SETTINGS = {
    badgeText: 'Upcoming Events',
    heading: 'Our Events & Conclaves',
    subtitle: 'join the network',
    viewAllLabel: 'See All Events',
    viewAllHref: '/events',
    emptyText: 'No events are scheduled at the moment. Please check back soon.',
    homeLimit: 3,
};

const GALLERY_SETTINGS = {
    badgeIcon: 'image',
    badgeText: 'Our Gallery',
    heading: 'Moments That Tell Our',
    headingHighlight: 'Story',
    description: 'Explore highlights from our events, community initiatives, projects and activities that showcase the vision and impact of ACTIV across the region.',
    noteLines: ['Our Work', 'Our People', 'Our Impact'],
    categories: [
        { label: 'Conferences', icon: 'users' },
        { label: 'Seminars', icon: 'monitor-play' },
        { label: 'Networking', icon: 'grid' },
        { label: 'Exhibitions', icon: 'tent' },
        { label: 'Workshops', icon: 'book-open' },
        { label: 'Community', icon: 'heart-handshake' },
        { label: 'Projects', icon: 'hard-hat' },
    ],
    viewMoreLabel: 'View More Photos',
    pageSize: 8,
    emptyText: 'No photographs have been published yet.',
    emptyFilterText: 'Nothing in {category} yet.',
};

/**
 * The gallery cards.
 *
 * `category` matches a chip label above; the first three are `featured`, which
 * is what fills the collage at the top of the page.
 */
const GALLERY_ITEMS = [
    { title: 'Annual Business Conference 2024', category: 'Conferences', eventDate: '20 Jan 2024', location: 'Chennai, India', featured: true, url: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80' },
    { title: 'Entrepreneurship Growth Seminar', category: 'Seminars', eventDate: '15 Feb 2024', location: 'Bangalore, India', featured: true, url: 'https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80' },
    { title: 'National Entrepreneurs Meet', category: 'Networking', eventDate: '10 Mar 2024', location: 'Hyderabad, India', featured: true, url: 'https://images.unsplash.com/photo-1556761175-4b46a572b786?auto=format&fit=crop&q=80' },
    { title: 'SC/ST Business Expo 2024', category: 'Exhibitions', eventDate: '05 Apr 2024', location: 'Mumbai, India', featured: false, url: 'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80' },
    { title: 'Digital Transformation Workshop', category: 'Workshops', eventDate: '22 Apr 2024', location: 'Pune, India', featured: false, url: 'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&q=80' },
    { title: 'Leadership Excellence Awards 2024', category: 'Conferences', eventDate: '30 May 2024', location: 'New Delhi, India', featured: false, url: 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&q=80' },
    { title: 'Community Outreach Program', category: 'Community', eventDate: '15 Jun 2024', location: 'Coimbatore, India', featured: false, url: 'https://images.unsplash.com/photo-1582213782179-e0d53f98f2ca?auto=format&fit=crop&q=80' },
    { title: 'Infrastructure Development Visit', category: 'Projects', eventDate: '28 Jun 2024', location: 'Trichy, India', featured: false, url: 'https://images.unsplash.com/photo-1541888087405-bd804cb74d81?auto=format&fit=crop&q=80' },
];

const CONTACT = {
    badgeIcon: 'users',
    badgeText: 'Get In Touch',
    heading: "We'd Love to Hear From",
    headingHighlight: 'You!',
    description: "Have questions, suggestions, or partnership inquiries? Fill out the form or use our contact details — we're here to help and connect with you.",
    heroMedia: [
        img('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&q=80', 'ACTIV head office'),
        img('https://images.unsplash.com/photo-1556761175-4b46a572b786?auto=format&fit=crop&q=80', 'Partnership handshake'),
    ],
    formCard: {
        icon: 'send',
        title: 'Send us a Message',
        subtitle: 'Fill in the details below and we will get back to you as soon as possible.',
        submitLabel: 'Send Message',
        successMessage: 'Thank you! Your message has been sent successfully.',
        namePlaceholder: 'Your Name',
        emailPlaceholder: 'Email Address',
        phonePlaceholder: 'Mobile Number',
        subjectPlaceholder: 'Subject',
        messagePlaceholder: 'Your Message',
        validationMessage: 'Please fill in your name, email and message.',
        failureMessage: 'Your message could not be sent. Please try again.',
    },
    infoCard: {
        icon: 'users',
        title: 'Contact Information',
        subtitle: 'Reach out to us through any of the following channels.',
        addressLabel: 'Head Office Address',
        phoneLabel: 'Phone Number',
        emailLabel: 'Email Address',
        hoursLabel: 'Working Hours',
    },
    addressLines: [
        'Adidravidar Confederation of Trade and Industrial Vision,',
        '6, Ilayaperumal Apartments,',
        '121, Velachery Road, Guindy,',
        'Chennai, Tamil Nadu 600032',
    ],
    phone: '+91 8220012188',
    alternatePhone: '',
    email: 'info@activ.org.in',
    workingHours: ['Mon - Sat : 9.00 AM - 6.00 PM', 'Sunday : Closed'],
    mapEmbedUrl: '',
    social: { facebook: '', instagram: '', linkedin: '', youtube: '' },
    banner: {
        enabled: true,
        icon: 'users',
        title: "Let's Build a Stronger Community Together",
        subtitle: 'Join hands with ACTIV to empower entrepreneurs and create a lasting impact.',
        ctaLabel: 'Become a Member',
        ctaHref: '/register',
    },
};

// ============================================================ the run

/**
 * Whether a section already holds content an admin would not want overwritten.
 *
 * Deliberately per-section rather than one global check: seeding the gallery
 * should not be skipped because somebody edited the footer.
 */
const hasContent = (doc, probe) => !!(doc && probe(doc));

async function main() {
    console.log('\n=== CMS content seed ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: DRY RUN (pass --confirm to write)');
    if (FORCE) console.log('Force: ON — sections that already have content WILL be overwritten');

    // The Event model lives on the default connection; the CMS models on
    // `adminsdb`. Both are needed, so both are opened.
    await mongoose.connect(config.db.uri);
    // The CMS models live on the secondary connection; opening it before they
    // are required is what makes them bind to `adminsdb` rather than falling
    // back to the default database.
    await adminsDb.ensureReady();

    const {
        SINGLETON_KEY, SiteSettings, Home, About,
        EventsSettings, GallerySettings, GalleryItem, ContactSettings,
    } = require('../src/modules/cms/cms.models');

    const cms = require('../src/modules/cms/cms.service');
    const actor = { email: 'seed@activ.org.in' };

    const sections = [
        {
            name: 'Site header & footer',
            Model: SiteSettings,
            probe: d => (d.header || {}).navLinks && d.header.navLinks.length,
            write: () => cms.updateSiteSettings(SITE, actor),
            summary: `${SITE.header.navLinks.length} nav links, ${SITE.footer.linkColumns.length} footer columns, ${SITE.footer.socials.length} socials`,
        },
        {
            name: 'Home page',
            Model: Home,
            probe: d => (d.carousel || {}).headline || ((d.carousel || {}).slides || []).length,
            write: () => cms.updateHome(HOME, actor),
            summary: `${HOME.carousel.slides.length} slides, ${HOME.carousel.highlightCard.stats.length} banner stats, ${HOME.about.bullets.length} bullets, ${HOME.about.statsBar.length} figures`,
        },
        {
            name: 'About page',
            Model: About,
            probe: d => d.body || (d.bullets || []).length,
            write: () => cms.updateAbout(ABOUT, actor),
            summary: `${ABOUT.bullets.length} bullets, ${ABOUT.statsBar.length} figures`,
        },
        {
            name: 'Events page copy',
            Model: EventsSettings,
            probe: d => d.heading,
            write: () => cms.updateEventsSettings(EVENTS_SETTINGS, actor),
            summary: EVENTS_SETTINGS.heading,
        },
        {
            name: 'Gallery page copy',
            Model: GallerySettings,
            probe: d => d.heading || (d.categories || []).length,
            write: () => cms.updateGallerySettings(GALLERY_SETTINGS, actor),
            summary: `${GALLERY_SETTINGS.categories.length} filter chips`,
        },
        {
            name: 'Contact page',
            Model: ContactSettings,
            probe: d => d.email || d.phone,
            write: () => cms.updateContactInfo(CONTACT, actor),
            summary: `${CONTACT.addressLines.length} address lines, ${CONTACT.workingHours.length} hours lines`,
        },
    ];

    for (const section of sections) {
        const existing = await section.Model.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);
        const occupied = hasContent(existing, section.probe);

        if (occupied && !FORCE) {
            console.log(`  SKIP  ${section.name} — already has content (use --force to replace)`);
            continue;
        }

        console.log(`  ${CONFIRM ? 'WRITE' : 'would'} ${section.name} — ${section.summary}`);
        if (CONFIRM) await section.write();
    }

    // ---- gallery items, matched on title so a re-run updates rather than duplicates
    let added = 0;
    let skipped = 0;
    for (let i = 0; i < GALLERY_ITEMS.length; i++) {
        const item = GALLERY_ITEMS[i];
        const existing = await GalleryItem.findOne({ title: item.title }).lean().catch(() => null);

        if (existing && !FORCE) { skipped++; continue; }

        if (CONFIRM) {
            const payload = {
                media: img(item.url, item.title),
                title: item.title,
                category: item.category,
                eventDate: item.eventDate,
                location: item.location,
                featured: item.featured,
                sortOrder: i,
                visible: true,
            };
            if (existing) await cms.updateGalleryItem(existing._id, payload, actor);
            else await cms.addGalleryItem(payload, actor);
        }
        added++;
    }
    console.log(`  ${CONFIRM ? 'WROTE' : 'would write'} ${added} gallery item(s); ${skipped} left alone`);

    if (!CONFIRM) console.log('\nNothing was written. Re-run with --confirm.');
    else console.log('\nDone. The public site now renders from the database.');

    await mongoose.disconnect();
    // `adminsDb` exposes no close: the process exits below, which drops it.
    process.exit(0);
}

main().catch((err) => {
    console.error('\nSeed failed:', err && err.message);
    console.error(err);
    process.exit(1);
});
