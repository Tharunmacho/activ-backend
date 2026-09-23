/**
 * DUMMY ALBUM PHOTOGRAPHS, so the gallery's album viewer can be looked at.
 *
 * Reuses image URLs ALREADY IN this gallery — nothing new is uploaded and no
 * external asset is introduced. Each caption is marked "(sample)" so an editor
 * can tell at a glance which rows to clear.
 *
 * Goes through `cmsService.updateGalleryItem`, which is the same path the CMS
 * save uses, so this exercises `cleanPhotos` rather than writing round it.
 *
 *   node scripts/sample-gallery-photos.js            add them
 *   node scripts/sample-gallery-photos.js --undo     clear them again
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ensureReady } = require('../src/modules/admin/adminsDb');

const TARGETS = [
    '6a9387dcf1f8fb2d80441c7c',   // Annual Business Conference 2024
    '6aa68ae679ae717ddc9de86a',   // State council meeting, Chennai
    '6ab118e9181c4d70b43b514a',   // SC/ST Entrepreneurs Integration Conference
    '6aa6c7e6b23d9baf3534f958',   // Annual awards night, Port Blair
];

const IMG = [
    'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1528605248644-14dd04022da1?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80',
];

const CAPS = [
    'Delegates at the registration desk on the opening morning. (sample)',
    'The chief guest addressing the hall after the inaugural session. (sample)',
    'The panel on export readiness for first-generation entrepreneurs. (sample)',
    'Members of the state council during the afternoon working session. (sample)',
    'The vote of thanks, and the close of the day. (sample)',
];

const NL = String.fromCharCode(10);

const TITLES = [
    'Registration opens',
    'The chief guest opens the hall',
    'Panel: export readiness',
    'The state council in session',
    'The vote of thanks',
];

const BODIES = [
    ['The doors opened at half past eight and the hall was full within the hour.',
     'Members travelled from every district in the state, and a third of those signing in were attending for the first time. (sample)'].join(NL + NL),
    ['The Minister opened the hall a little after ten, to a full auditorium.',
     'His address covered the state\u2019s procurement reforms and what they mean for first-generation entrepreneurs bidding for public work. (sample)'].join(NL + NL),
    ['Four panellists, an hour, and a room that did not empty at the break.',
     'The discussion ran from documentation and freight to the practical business of finding a first overseas buyer. (sample)'].join(NL + NL),
    'The council met through the afternoon to settle the year\u2019s programme and the district allocations. (sample)',
    'The day closed a little after six, with thanks to the host chapter and to the volunteers who ran the registration desk. (sample)',
];

const FIELDS = [
    [{ icon: 'camera', label: 'Photographer', value: 'S Anand (sample)' },
     { icon: 'clock', label: 'Time', value: '08:45' },
     { placement: 'content', label: 'How the desk was run',
       value: 'Four volunteers worked the desk in two shifts, checking membership numbers against the printed roll and issuing badges on the spot. (sample)' }],
    [{ icon: 'user', label: 'Chief Guest', value: 'Shri R Kumar, Minister for Industries (sample)' },
     { icon: 'camera', label: 'Photographer', value: 'S Anand (sample)' }],
    [{ icon: 'users', label: 'Panellists', value: ['V Subramanian', 'R Meenakshi', 'A Rajeev (sample)'].join(NL) },
     { icon: 'calendar-days', label: 'Session', value: 'Afternoon, Hall 2' }],
    [{ icon: 'users-2', label: 'Present', value: '24 council members (sample)' }],
    [{ icon: 'quote', label: 'Proposed by', value: 'Dr D Arulmozhi (sample)' }],
];

(async () => {
    await ensureReady();
    const cms = require('../src/modules/cms/cms.service');
    const { GalleryItem } = require('../src/modules/cms/cms.models');
    const undo = process.argv.includes('--undo');

    for (const id of TARGETS) {
        const before = await GalleryItem.findById(id).lean();
        if (!before) { console.log('missing:', id); continue; }

        const photos = undo ? [] : IMG.map((url, i) => ({
            url, type: 'image', alt: '', fit: 'cover', position: 'center',
            title: TITLES[i],
            caption: CAPS[i],
            description: BODIES[i],
            customFields: FIELDS[i],
        }));

        await cms.updateGalleryItem(id, { photos }, { name: 'sample data' });
        const after = await GalleryItem.findById(id).select('title photos').lean();
        console.log(`${undo ? 'cleared' : 'added  '}  ${after.title}  ->  ${(after.photos || []).length} photos`);
    }
    await mongoose.disconnect();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
