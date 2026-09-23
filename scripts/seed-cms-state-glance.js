/**
 * Fills in the dashboard fields on every state page that is still missing them.
 *
 * A TOP-UP, not a re-seed — it writes only the keys that are empty, through the
 * same service the CMS posts to, which treats an absent key as untouched. An
 * editor's afternoon of work is never overwritten. Safe to run repeatedly.
 *
 *   node scripts/seed-cms-state-glance.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

/**
 * Capital, area, population and languages for every state and union territory.
 *
 * These are REAL, because a state page carrying an invented capital is worse
 * than one carrying none — a reader who spots one wrong fact stops believing
 * the rest of the page. Figures are the 2011 census population and the standard
 * area, which is what the association's own reference material uses; an editor
 * replaces them from their own source.
 */
const FACTS = {
    'Andhra Pradesh': ['Amaravati', '1,62,970 km²', '49.4 Million', 'Telugu'],
    Karnataka: ['Bengaluru', '1,91,791 km²', '61.1 Million', 'Kannada'],
    Kerala: ['Thiruvananthapuram', '38,863 km²', '33.4 Million', 'Malayalam'],
    'Tamil Nadu': ['Chennai', '1,30,058 km²', '72.1 Million', 'Tamil (official), English'],
    Telangana: ['Hyderabad', '1,12,077 km²', '35.0 Million', 'Telugu, Urdu'],
    Puducherry: ['Puducherry', '479 km²', '1.2 Million', 'Tamil, French, English'],
    Lakshadweep: ['Kavaratti', '32 km²', '64 Thousand', 'Malayalam, English'],
    'Andaman and Nicobar Islands': ['Port Blair', '8,249 km²', '0.4 Million', 'Hindi, English'],

    Delhi: ['New Delhi', '1,483 km²', '16.8 Million', 'Hindi, English, Punjabi, Urdu'],
    Haryana: ['Chandigarh', '44,212 km²', '25.4 Million', 'Hindi'],
    Punjab: ['Chandigarh', '50,362 km²', '27.7 Million', 'Punjabi'],
    Rajasthan: ['Jaipur', '3,42,239 km²', '68.5 Million', 'Hindi'],
    'Uttar Pradesh': ['Lucknow', '2,40,928 km²', '199.8 Million', 'Hindi, Urdu'],
    Uttarakhand: ['Dehradun', '53,483 km²', '10.1 Million', 'Hindi, Sanskrit'],
    'Himachal Pradesh': ['Shimla', '55,673 km²', '6.9 Million', 'Hindi'],
    'Jammu and Kashmir': ['Srinagar / Jammu', '42,241 km²', '12.5 Million', 'Urdu, Kashmiri, Dogri'],
    Ladakh: ['Leh', '59,146 km²', '0.3 Million', 'Ladakhi, Hindi, English'],
    Chandigarh: ['Chandigarh', '114 km²', '1.1 Million', 'English, Hindi, Punjabi'],

    Bihar: ['Patna', '94,163 km²', '104.1 Million', 'Hindi, Urdu'],
    Jharkhand: ['Ranchi', '79,716 km²', '33.0 Million', 'Hindi'],
    Odisha: ['Bhubaneswar', '1,55,707 km²', '42.0 Million', 'Odia'],
    'West Bengal': ['Kolkata', '88,752 km²', '91.3 Million', 'Bengali, English'],

    Goa: ['Panaji', '3,702 km²', '1.5 Million', 'Konkani'],
    Gujarat: ['Gandhinagar', '1,96,024 km²', '60.4 Million', 'Gujarati'],
    Maharashtra: ['Mumbai', '3,07,713 km²', '112.4 Million', 'Marathi'],
    'Madhya Pradesh': ['Bhopal', '3,08,245 km²', '72.6 Million', 'Hindi'],
    Chhattisgarh: ['Raipur', '1,35,192 km²', '25.5 Million', 'Hindi, Chhattisgarhi'],
    'Dadra and Nagar Haveli and Daman and Diu': ['Daman', '603 km²', '0.6 Million', 'Gujarati, Hindi'],

    Assam: ['Dispur', '78,438 km²', '31.2 Million', 'Assamese, Bodo, Bengali'],
    'Arunachal Pradesh': ['Itanagar', '83,743 km²', '1.4 Million', 'English'],
    Manipur: ['Imphal', '22,327 km²', '2.9 Million', 'Meitei, English'],
    Meghalaya: ['Shillong', '22,429 km²', '3.0 Million', 'English, Khasi, Garo'],
    Mizoram: ['Aizawl', '21,081 km²', '1.1 Million', 'Mizo, English'],
    Nagaland: ['Kohima', '16,579 km²', '2.0 Million', 'English'],
    Sikkim: ['Gangtok', '7,096 km²', '0.6 Million', 'Nepali, Sikkimese, English'],
    Tripura: ['Agartala', '10,486 km²', '3.7 Million', 'Bengali, Kokborok, English'],
};

const EXPLORE_IMAGES = [
    'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1587474260584-136574528ed5?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1477587458883-47145ed94245?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&q=80',
];

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const service = require('../src/modules/cms/cms.regionPages.service');
    const { StatePage } = require('../src/modules/cms/cms.models');

    const pages = await StatePage.find({}).lean();
    let touched = 0;
    let skipped = 0;

    for (let i = 0; i < pages.length; i += 1) {
        const doc = pages[i];
        const hero = doc.hero || {};

        /* Already has its facts? Leave the whole page alone. */
        if (Array.isArray(hero.facts) && hero.facts.length) { skipped += 1; continue; }

        const facts = FACTS[doc.stateName];
        const updates = {
            hero: {
                ...hero,
                eyebrow: hero.eyebrow || 'Indian States',
                headline: hero.headline || doc.stateName,
                tagline: hero.tagline
                    || 'Progress through unity, heritage through culture, and growth through opportunity.',
                facts: facts ? [
                    { icon: 'building', label: 'Capital', value: facts[0] },
                    { icon: 'map-pin', label: 'Area', value: facts[1] },
                    { icon: 'users', label: 'Population', value: facts[2] },
                    { icon: 'globe', label: 'Languages', value: facts[3] },
                ] : [],
                glance: [
                    { icon: 'trending-up', title: 'A growing economy', subtitle: 'sample — replace me' },
                    { icon: 'factory', title: 'A strong industrial base', subtitle: 'sample — replace me' },
                    { icon: 'graduation-cap', title: 'Rich in culture and education', subtitle: 'sample — replace me' },
                ],
                features: (hero.features && hero.features.length) ? hero.features : [
                    { icon: 'award', label: 'Rich Heritage & Culture' },
                    { icon: 'factory', label: 'Thriving Industries' },
                    { icon: 'graduation-cap', label: 'Educational Hub' },
                    { icon: 'ship', label: 'Maritime Trade' },
                ],
            },
            explore: {
                imageUrl: EXPLORE_IMAGES[i % EXPLORE_IMAGES.length],
                title: doc.stateName,
                subtitle: 'Sample line — replace it with what the state is known for.',
                href: `/gallery?state=${encodeURIComponent(doc.stateName)}`,
            },
            socialLinks: [
                { icon: 'facebook', href: 'https://facebook.com' },
                { icon: 'twitter', href: 'https://twitter.com' },
                { icon: 'linkedin', href: 'https://linkedin.com' },
                { icon: 'youtube', href: 'https://youtube.com' },
            ],
        };

        await service.saveStatePage(doc.slug, updates, { email: 'seed:cms-regions' });
        touched += 1;
    }

    console.log(`dashboard fields added to ${touched} state pages, ${skipped} already had them`);
    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
