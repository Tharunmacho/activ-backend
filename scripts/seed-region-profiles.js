/**
 * The words and the facts on every region and state page — the half of the page
 * that is not a bench.
 *
 * =========================================================================
 * WHY THIS IS SEPARATE FROM `seed-region-leadership.js`
 * =========================================================================
 *
 * That script fills the three tiers of people. This one fills what is around
 * them: the paragraph under the headline, the four figures beside it, and the
 * office a reader writes to. Tamil Nadu and the South had all of it and every
 * other page had the scaffolding the CMS creates a page with —
 *
 *     "This is template text — replace it in the CMS."
 *     "Sample Name — replace me"
 *     facts: []
 *
 * — which is worse than an empty page, because it is an empty page that looks
 * like somebody meant it.
 *
 * ------------------------------------------------------------ what it writes
 *
 *   web_region_pages   hero.blurb, hero.facts, shortDescription,
 *                      fullDescription, contact
 *   web_state_pages    the same five
 *
 * ------------------------------------------------------------------- running
 *
 *   node scripts/seed-region-profiles.js                  # every page
 *   node scripts/seed-region-profiles.js --state Bihar
 *   node scripts/seed-region-profiles.js --region east
 *   node scripts/seed-region-profiles.js --force          # overwrite real copy too
 *
 * IT ONLY FILLS WHAT IS EMPTY OR SCAFFOLDED. A field an editor has written is
 * left exactly as it is, which is why Tamil Nadu and the South come out of a
 * full run unchanged. `--force` is for rebuilding a page somebody has half
 * edited and wants back; it is not the normal way to run this.
 *
 * ------------------------------------------------------------- about the data
 *
 * THE GEOGRAPHY IS REAL. Capitals, areas, populations and official languages
 * are the published figures, and the district counts are counted from the map
 * modules the site actually draws — not typed in beside them, because two
 * copies of a count is one wrong count waiting for somebody to add a district.
 *
 * THE PEOPLE ARE NOT. The directors' names come from the same pools the
 * leadership seed uses and the telephone numbers follow the +91 <std> 2345 xxxx
 * shape the other seeds use; both belong to nobody.
 *
 * No membership figure is invented. The South's hero says "14,200+ member
 * companies" because somebody wrote that; this script will not put a number
 * like it on the other four, because a fabricated figure on a trade
 * association's own page is the one placeholder a reader cannot tell from fact.
 * The four figures it writes are all countable.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const FORCE = process.argv.includes('--force');
const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > -1 ? String(process.argv[i + 1] || '').trim() : '';
};
const ONLY_STATE = argOf('--state');
const ONLY_REGION = argOf('--region');

/* ------------------------------------------------------------- the geography */

/**
 * `capital`, `area` in square kilometres, `people` as published, `langs` as the
 * official languages, and `about` — two sentences that say where the place is
 * and what it makes.
 *
 * The `about` sentences are deliberately about the PLACE and not about the
 * association: they sit under the headline of a page whose every other band is
 * the association, and a paragraph there that says "ACTIV convenes…" for the
 * thirty-sixth time tells a reader nothing they did not get from the heading.
 */
const STATES = {
    /* ------------------------------------------------------------- South */
    'Andhra Pradesh': {
        capital: 'Amaravati',
        area: '1,62,975 km²',
        people: '49.6 Million',
        langs: 'Telugu (Official), Urdu',
        about: 'Andhra Pradesh runs along the Coromandel Coast between Odisha and Tamil Nadu, with the Eastern Ghats behind a coastline of almost a thousand kilometres — the second longest of any Indian state. Its industry is built on that coast: the ports at Visakhapatnam, Krishnapatnam and Kakinada, pharmaceuticals and aquaculture around the Krishna and Godavari deltas, and automotive and textile clusters inland.',
    },
    Karnataka: {
        capital: 'Bengaluru',
        area: '1,91,791 km²',
        people: '61.1 Million',
        langs: 'Kannada (Official), English',
        about: 'Karnataka spans the Deccan plateau, the Western Ghats and a short Arabian Sea coast, and holds the largest concentration of technology and aerospace employers in the country. Beyond Bengaluru it is an industrial state of long standing — steel at Ballari, machine tools and engineering at Mysuru and Belagavi, and the cotton and sugar belt of the north.',
    },
    Kerala: {
        capital: 'Thiruvananthapuram',
        area: '38,863 km²',
        people: '33.4 Million',
        langs: 'Malayalam (Official), English',
        about: 'Kerala is a narrow strip between the Western Ghats and the Arabian Sea, the most densely settled and the most literate of the southern states. Its economy turns on the plantation crops of the hills, the marine and spice trade of the coast, a shipbuilding and refining cluster at Kochi, and remittances from a large workforce abroad.',
    },
    /*
     * Tamil Nadu is here only so a full run does not warn about it. Every one
     * of its fields was written by the association and none of them is blank,
     * so nothing below is ever used — but a script that skips the reference
     * page with a warning invites somebody to "fix" the warning.
     */
    'Tamil Nadu': {
        capital: 'Chennai',
        area: '1,30,058 km²',
        people: '7.21 Crore',
        langs: 'Tamil (Official), English',
        about: 'Tamil Nadu lies at the southern end of the peninsula, between the Eastern Ghats, the Nilgiris and the Bay of Bengal. It is the second largest state economy in the country, built on automobiles and components around Chennai, textiles and knitwear at Tiruppur and Coimbatore, leather at Vellore and Ambur, and the ports at Chennai, Ennore and Thoothukudi.',
    },
    Telangana: {
        capital: 'Hyderabad',
        area: '1,12,077 km²',
        people: '35.0 Million',
        langs: 'Telugu (Official), Urdu',
        about: 'Telangana sits on the Deccan plateau between the Godavari and the Krishna, and became a state in its own right in 2014. Hyderabad anchors it — pharmaceuticals and vaccines, information technology and defence electronics — while the districts carry cotton, rice, granite and a growing textile park at Warangal.',
    },
    Puducherry: {
        capital: 'Puducherry',
        area: '490 km²',
        people: '12.5 Lakh',
        langs: 'Tamil, French, Telugu, Malayalam, English',
        about: 'Puducherry is four separate enclaves on two coasts — Puducherry and Karaikal on the Bay of Bengal, Yanam in the Godavari delta and Mahe on the Arabian Sea — and was French India until 1954. Its small industrial base is concentrated in pharmaceuticals, automotive components, textiles and tourism.',
    },
    Lakshadweep: {
        capital: 'Kavaratti',
        area: '32 km²',
        people: '64,473',
        langs: 'Malayalam, Jeseri, English',
        about: 'Lakshadweep is thirty-six coral islands in the Arabian Sea, ten of them inhabited, and the smallest union territory in the country by land area. Its economy is fishing — tuna above all — coconut and coir, and a carefully limited tourism.',
    },
    'Andaman and Nicobar Islands': {
        capital: 'Port Blair',
        area: '8,249 km²',
        people: '3.81 Lakh',
        langs: 'Hindi, English, Bengali, Tamil, Nicobarese',
        about: 'The Andaman and Nicobar Islands are a chain of over five hundred islands in the Bay of Bengal, closer to Myanmar and Indonesia than to the mainland. Fisheries, timber, coconut and tourism carry the local economy, and the transhipment terminal at Port Blair puts the territory on the east–west shipping lane.',
    },

    /* ------------------------------------------------------------- North */
    Delhi: {
        capital: 'New Delhi',
        area: '1,483 km²',
        people: '1.68 Crore',
        langs: 'Hindi, English, Punjabi, Urdu',
        about: 'Delhi is the national capital territory and the commercial centre of northern India, a city state on the Yamuna surrounded by the industrial districts of Haryana and Uttar Pradesh. Its own industry is light and service-led — printing, garments, electronics assembly, logistics and the head offices of much of the country.',
    },
    Haryana: {
        capital: 'Chandigarh',
        area: '44,212 km²',
        people: '2.54 Crore',
        langs: 'Hindi (Official), Punjabi',
        about: 'Haryana wraps around Delhi on three sides and carries the densest manufacturing corridor in the north — passenger cars at Gurugram and Manesar, tractors and bicycles at Faridabad, and scientific instruments at Ambala. It is also one of the country’s largest surplus producers of wheat and rice.',
    },
    Punjab: {
        capital: 'Chandigarh',
        area: '50,362 km²',
        people: '2.77 Crore',
        langs: 'Punjabi (Official), Hindi',
        about: 'Punjab is the doab country between the Sutlej, the Beas and the Ravi, and the state that carried the Green Revolution. Its industry grew out of that agriculture and around it — hosiery and bicycles at Ludhiana, sports goods and hand tools at Jalandhar, light engineering across the Mohali belt.',
    },
    Rajasthan: {
        capital: 'Jaipur',
        area: '3,42,239 km²',
        people: '6.85 Crore',
        langs: 'Hindi (Official), Rajasthani',
        about: 'Rajasthan is the largest Indian state by area, the Thar desert on one side of the Aravallis and a fertile south-east on the other. It supplies most of the country’s marble, sandstone, zinc and lead, and adds textiles at Bhilwara, gemstones and handicraft at Jaipur, and a growing solar belt in the west.',
    },
    'Uttar Pradesh': {
        capital: 'Lucknow',
        area: '2,40,928 km²',
        people: '19.98 Crore',
        langs: 'Hindi (Official), Urdu',
        about: 'Uttar Pradesh is the most populous state in the country, spread across the Ganga plain from the Himalayan foothills to the Vindhyas. It is sugar and grain at scale, leather at Kanpur and Agra, glass at Firozabad, brassware at Moradabad, and the electronics and services cluster that has grown up at Noida.',
    },
    Uttarakhand: {
        capital: 'Dehradun',
        area: '53,483 km²',
        people: '1.01 Crore',
        langs: 'Hindi (Official), Sanskrit',
        about: 'Uttarakhand is a Himalayan state of two halves — the hill districts of Garhwal and Kumaon, and the industrial plain along the Ganga at Haridwar and Udham Singh Nagar. Automobiles, pharmaceuticals and food processing sit in the plain; hydropower, horticulture and pilgrimage carry the hills.',
    },
    'Himachal Pradesh': {
        capital: 'Shimla',
        area: '55,673 km²',
        people: '68.6 Lakh',
        langs: 'Hindi (Official), Pahari',
        about: 'Himachal Pradesh is entirely mountain, from the Shivaliks to the high Himalaya at Lahaul and Spiti. Hydroelectric power, apple and stone-fruit orchards and tourism are the mainstays, with a substantial pharmaceutical and electronics cluster in the Baddi–Barotiwala–Nalagarh belt.',
    },
    'Jammu and Kashmir': {
        capital: 'Srinagar (summer) · Jammu (winter)',
        area: '42,241 km²',
        people: '1.23 Crore',
        langs: 'Kashmiri, Dogri, Urdu, Hindi, English',
        about: 'Jammu and Kashmir runs from the plains at Jammu through the Pir Panjal to the Kashmir Valley. Horticulture is the dominant industry — apple, walnut and saffron — alongside handicraft of long standing in pashmina, carpet and papier mâché, and a tourism economy built on the valley and the pilgrim routes.',
    },
    Ladakh: {
        capital: 'Leh',
        area: '59,146 km²',
        people: '2.74 Lakh',
        langs: 'Ladakhi, Urdu, Hindi, English',
        about: 'Ladakh is high-altitude cold desert between the Karakoram and the Great Himalaya, and became a union territory in its own right in 2019. Its economy is tourism, pashmina wool, seabuckthorn and apricot, and the solar potential of one of the sunniest inhabited places on earth.',
    },
    Chandigarh: {
        capital: 'Chandigarh',
        area: '114 km²',
        people: '10.5 Lakh',
        langs: 'English, Hindi, Punjabi',
        about: 'Chandigarh is a planned city and a union territory, serving as the capital of both Punjab and Haryana. Its own economy is services, education and administration, with a light industrial area and an information technology park at the eastern edge.',
    },

    /* -------------------------------------------------------------- East */
    Bihar: {
        capital: 'Patna',
        area: '94,163 km²',
        people: '10.41 Crore',
        langs: 'Hindi (Official), Urdu, Maithili',
        about: 'Bihar lies on the Gangetic plain between Uttar Pradesh and West Bengal, some of the most fertile and most densely settled land in the country. Food processing leads its industry — sugar, rice, maize and makhana — with leather at Muzaffarpur and a growing cement and construction-materials belt.',
    },
    Jharkhand: {
        capital: 'Ranchi',
        area: '79,716 km²',
        people: '3.30 Crore',
        langs: 'Hindi (Official), Santali, Nagpuri',
        about: 'Jharkhand sits on the Chota Nagpur plateau and holds the largest mineral reserves of any Indian state — coal, iron ore, copper, bauxite and mica. Steel at Jamshedpur and Bokaro, aluminium, heavy engineering at Ranchi and the coalfields of Dhanbad make it the industrial heart of the east.',
    },
    Odisha: {
        capital: 'Bhubaneswar',
        area: '1,55,707 km²',
        people: '4.20 Crore',
        langs: 'Odia (Official), English',
        about: 'Odisha runs along the Bay of Bengal from the Mahanadi delta to the Eastern Ghats, with a coastline of nearly five hundred kilometres. Bauxite, chromite and iron ore underpin an aluminium and steel industry at Angul, Jharsuguda and Kalinganagar, and the ports at Paradip and Dhamra carry it out.',
    },
    'West Bengal': {
        capital: 'Kolkata',
        area: '88,752 km²',
        people: '9.13 Crore',
        langs: 'Bengali (Official), Hindi, English',
        about: 'West Bengal reaches from the Darjeeling Himalaya to the Sundarbans delta, and Kolkata remains the commercial and financial centre of eastern India. Tea, jute, leather at Bantala, engineering along the Hooghly and the ports at Kolkata and Haldia are the long-standing industries.',
    },

    /* -------------------------------------------------------------- West */
    Goa: {
        capital: 'Panaji',
        area: '3,702 km²',
        people: '14.6 Lakh',
        langs: 'Konkani (Official), Marathi, English',
        about: 'Goa is the smallest Indian state by area, on the Konkan coast between Maharashtra and Karnataka, and was Portuguese India until 1961. Tourism is the largest employer, alongside pharmaceuticals, shipbuilding at Vasco, and the iron ore trade through the Mormugao port.',
    },
    Gujarat: {
        capital: 'Gandhinagar',
        area: '1,96,024 km²',
        people: '6.04 Crore',
        langs: 'Gujarati (Official), Hindi',
        about: 'Gujarat has the longest coastline of any Indian state, sixteen hundred kilometres of it, and forty-odd working ports along it. Petrochemicals at Jamnagar and Dahej, chemicals and pharmaceuticals around Vadodara and Ahmedabad, diamonds and textiles at Surat and the shipbreaking yard at Alang make it the country’s most industrialised state by output.',
    },
    Maharashtra: {
        capital: 'Mumbai',
        area: '3,07,713 km²',
        people: '11.24 Crore',
        langs: 'Marathi (Official), Hindi, English',
        about: 'Maharashtra runs from the Konkan coast over the Western Ghats onto the Deccan plateau, and produces the largest state economy in the country. Mumbai carries finance, film and trade; Pune, Nashik and Aurangabad carry automobiles and engineering; Nagpur and Vidarbha carry cotton, oranges and logistics.',
    },
    'Madhya Pradesh': {
        capital: 'Bhopal',
        area: '3,08,252 km²',
        people: '7.26 Crore',
        langs: 'Hindi (Official)',
        about: 'Madhya Pradesh is the second largest state by area and sits at the centre of the country, drained by the Narmada, the Chambal and the Son. Soybean, wheat and pulses lead its agriculture; cement, diamonds at Panna, textiles and automotive components at Pithampur lead its industry.',
    },
    Chhattisgarh: {
        capital: 'Raipur',
        area: '1,35,192 km²',
        people: '2.55 Crore',
        langs: 'Hindi (Official), Chhattisgarhi',
        about: 'Chhattisgarh was carved out of Madhya Pradesh in 2000 and holds a fifth of the country’s iron ore and a large share of its coal. Steel at Bhilai and Raigarh, aluminium at Korba, power generation and a wide forest economy in tendu leaf and sal seed carry the state.',
    },
    'Dadra and Nagar Haveli and Daman and Diu': {
        capital: 'Daman',
        area: '603 km²',
        people: '5.86 Lakh',
        langs: 'Gujarati, Hindi, Marathi, Konkani',
        about: 'The territory is three separate enclaves on the Gujarat–Maharashtra coast, merged into one union territory in 2020 and Portuguese-administered until 1961. It is heavily industrial for its size — textiles, plastics, engineering and pharmaceuticals in the Silvassa and Daman estates — and fishing at Diu.',
    },

    /* -------------------------------------------------------- North East */
    Assam: {
        capital: 'Dispur',
        area: '78,438 km²',
        people: '3.12 Crore',
        langs: 'Assamese (Official), Bodo, Bengali',
        about: 'Assam is the Brahmaputra and Barak valleys, and the gateway between the rest of India and the seven states beyond it. It grows more than half the country’s tea, holds its oldest oil fields at Digboi and Duliajan, and adds plywood, silk and a refining and petrochemical cluster at Numaligarh and Bongaigaon.',
    },
    'Arunachal Pradesh': {
        capital: 'Itanagar',
        area: '83,743 km²',
        people: '13.8 Lakh',
        langs: 'English (Official), Nyishi, Adi, Apatani',
        about: 'Arunachal Pradesh is the largest state in the North East and the most thinly settled in the country, rising from the Assam plain to the eastern Himalaya. Hydroelectric potential is its great resource, alongside forestry, horticulture, orange and large-cardamom cultivation and a growing tourism.',
    },
    Manipur: {
        capital: 'Imphal',
        area: '22,327 km²',
        people: '28.6 Lakh',
        langs: 'Meiteilon (Official), English',
        about: 'Manipur is a broad oval valley ringed by hills, with Loktak — the largest freshwater lake in the North East — at its centre. Handloom and handicraft employ more people than any other industry, alongside bamboo, horticulture, and the border trade at Moreh with Myanmar.',
    },
    Meghalaya: {
        capital: 'Shillong',
        area: '22,429 km²',
        people: '29.7 Lakh',
        langs: 'Khasi, Garo, English (Official)',
        about: 'Meghalaya is the Khasi, Jaintia and Garo hills, and includes the wettest inhabited places on earth at Sohra and Mawsynram. Limestone and cement, coal, horticulture — turmeric, ginger and the Khasi mandarin — and tourism carry the state.',
    },
    Mizoram: {
        capital: 'Aizawl',
        area: '21,081 km²',
        people: '10.9 Lakh',
        langs: 'Mizo (Official), English, Hindi',
        about: 'Mizoram is a state of north–south hill ranges between Myanmar and Bangladesh, and the most literate state in the country after Kerala. Bamboo covers much of its area and carries much of its industry, alongside horticulture, handloom and the border trade at Zokhawthar.',
    },
    Nagaland: {
        capital: 'Kohima',
        area: '16,579 km²',
        people: '19.8 Lakh',
        langs: 'English (Official), Nagamese',
        about: 'Nagaland is hill country along the Myanmar border, home to sixteen recognised tribes and as many languages. Its economy is agriculture and forestry with a strong handloom and handicraft tradition, and a growing trade in bamboo, honey, the Naga chilli and tourism around the Hornbill festival.',
    },
    Sikkim: {
        capital: 'Gangtok',
        area: '7,096 km²',
        people: '6.1 Lakh',
        langs: 'Nepali, Sikkimese, Lepcha, English',
        about: 'Sikkim is the least populous Indian state, wedged between Nepal, Tibet and Bhutan and rising to Kangchenjunga. It was the first state in the world to become fully organic, and lives on cardamom, floriculture, hydroelectric power, pharmaceuticals at Rangpo and tourism.',
    },
    Tripura: {
        capital: 'Agartala',
        area: '10,486 km²',
        people: '36.7 Lakh',
        langs: 'Bengali, Kokborok, English',
        about: 'Tripura is almost surrounded by Bangladesh, with a short corridor to Assam and Mizoram, and the second most populous state in the North East. Natural gas, rubber, tea, bamboo and handicraft carry the economy, and the Agartala–Akhaura link makes it the region’s shortest route to a seaport.',
    },
};

/** What each region is, in its own words. */
const REGIONS = {
    north: {
        langs: 'Hindi, Punjabi, Urdu, Rajasthani, Kashmiri, Dogri, Ladakhi',
        about: 'The North region runs from the Ladakh plateau and the Kashmir Valley down through the Himalaya and the Punjab plain to the desert of Rajasthan and the Gangetic heartland of Uttar Pradesh. It holds the national capital and the manufacturing corridor around it, the country’s largest grain surplus, and industry as varied as passenger cars at Manesar, hosiery at Ludhiana, leather at Kanpur, marble in the Aravallis and pharmaceuticals at Baddi.',
    },
    east: {
        langs: 'Bengali, Hindi, Odia, Maithili, Santali, Nagpuri',
        about: 'The East region covers the lower Gangetic plain, the mineral belt of the Chota Nagpur plateau and the Bay of Bengal coast from the Sundarbans to the Mahanadi delta. It holds the greatest concentration of coal, iron ore and bauxite in the country and the steel, aluminium and heavy engineering built on them, alongside tea, jute, leather and the ports at Haldia, Paradip and Dhamra.',
    },
    west: {
        langs: 'Marathi, Gujarati, Hindi, Konkani, Chhattisgarhi',
        about: 'The West region reaches from the Kutch salt flats and the Konkan coast across the Deccan to the forests and mineral belt of central India. It produces the largest share of the country’s industrial output — petrochemicals and diamonds in Gujarat, automobiles and finance in Maharashtra, steel and aluminium in Chhattisgarh — and works the longest stretch of the western seaboard.',
    },
    'north-east': {
        langs: 'Assamese, Bengali, Meiteilon, Khasi, Garo, Mizo, Nagamese, Nepali, Kokborok',
        about: 'The North East region is eight states joined to the rest of the country by the Siliguri corridor and bordered by Bhutan, China, Myanmar and Bangladesh. It grows more than half of India’s tea, holds its oldest oil fields, and carries the largest bamboo resource in the country, alongside a handloom and handicraft economy that employs more people here than any factory industry.',
    },
};

/* ------------------------------------------------------------ the scaffolding */

/**
 * WHAT COUNTS AS "NOT WRITTEN YET".
 *
 * Empty is the easy half. The other half is the copy the CMS creates a page
 * with, which is not empty and is not content either — and which an editor
 * seeing it on the live site reads as somebody's unfinished draft rather than
 * as an invitation.
 */
const SCAFFOLD = [
    /this is template text/i,
    /this is the longer description/i,
    /^longer description, shown when/i,
    /replace (it|this) in the cms/i,
    /replace me/i,
    /^sample /i,
    /template text for /i,
    /*
     * A CONTACT NAME THAT IS AN HONORIFIC AND ONE LETTER.
     *
     * "Mr T", "Dr M", "Mr H" — half the southern states were carrying one,
     * written by an earlier seed that split a name on a space and kept the
     * wrong half. It is not scaffolding anybody typed, but it is unambiguously
     * not a person, and leaving it be means leaving a broken name on the
     * contact band of five live pages.
     */
    /^(Mr|Mrs|Ms|Dr)\s+\S{1,2}$/,
];

const isBlank = (value) => {
    const text = String(value || '').trim();
    if (!text) return true;
    return SCAFFOLD.some((re) => re.test(text));
};

/** Fill `field` only if nothing real is there. Returns whether it wrote. */
const fill = (doc, field, value) => {
    if (!value) return false;
    const current = field.split('.').reduce((o, k) => (o || {})[k], doc);
    if (!FORCE && !isBlank(current)) return false;
    const keys = field.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => {
        if (!o[k]) o[k] = {};
        return o[k];
    }, doc);
    target[last] = value;
    return true;
};

/* --------------------------------------------------------------- the people */

/**
 * WHO THE DIRECTOR IS: the first name in the pool that is not already on the
 * page, starting from a point the place's own name decides.
 *
 * Two things have to be true at once and each was got wrong on its own first.
 *
 *   NOT SOMEBODY ON THE BENCH. Taking the first name in the pool made the
 *   North's Regional Director and its Regional Chairman the same person, in two
 *   bands of one page. Taking a fixed high index instead — past everything the
 *   leadership seed draws — fixed that and broke on the four southern styles,
 *   whose pools are sixty names deep rather than a hundred and twenty: the
 *   index fell off the end and Kerala's contact band read `undefined`.
 *
 *   NOT THE SAME PERSON AS THE NEXT STATE. Six states share the `hindi`
 *   tradition and one fixed index gave all six the same Director — no collision
 *   on any one page, and obvious to anybody who opens two.
 *
 * Walking forward from a hashed start until the name is free satisfies both and
 * cannot run out: the pool is far larger than any one page's bench.
 */
/* Comfortably past everything the leadership seed draws on one page (49), so
   the walk below always has somewhere to go. */
const POOL_DEPTH = 160;

const startAt = (key, size) => {
    let h = 0;
    for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
    return h % Math.max(1, size);
};

/** Every name already printed somewhere on this page. */
const namesOn = (page) => {
    const out = new Set();
    const add = (list) => (list || []).forEach((l) => {
        const name = String(l?.name || '').trim().toLowerCase();
        if (name) out.add(name);
    });
    add(page.leaders);
    (page.stateRegions || []).forEach((r) => add(r.leaders));
    (page.districts || []).forEach((d) => add(d.leaders));
    return out;
};

/**
 * Whether the contact on this page needs rewriting.
 *
 * Blank or scaffolded, obviously — and ALSO when the name it holds is somebody
 * on this page's own bench. That second case is what makes the script
 * self-healing: the benches are reseeded whenever the name pools change, and a
 * director written against the previous pool can land on a name the new bench
 * now uses. Leaving it be would put one person in two bands of one page and
 * nothing would report it.
 */
const contactNeedsWriting = (page) => {
    const name = String(page.contact?.personName || '').trim();
    if (isBlank(name)) return true;
    return namesOn(page).has(name.toLowerCase());
};

const directorFor = (styleKey, page, key) => {
    const pool = poolFor(styleKey || 'hindi', POOL_DEPTH);
    const taken = namesOn(page);
    const from = startAt(key, pool.length);
    for (let i = 0; i < pool.length; i += 1) {
        const candidate = pool[(from + i) % pool.length];
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return pool[from];
};

/* One source for the names and the dialling codes — see the leadership seed. */
const {
    poolFor, STYLE_OF, REGION_STYLE, CODES, portraitOf,
} = require('./lib/placeholderNames');

const slugOf = (value) => String(value || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ------------------------------------------------------------------- counts */

/**
 * How many districts the site can actually draw for a state — read from the
 * generated map module rather than typed in beside it.
 */
const districtCount = (slug) => {
    const file = path.join(
        __dirname, '..', '..', 'website', 'src', 'data', 'maps', `${slug}.ts`,
    );
    if (!fs.existsSync(file)) return 0;
    return (fs.readFileSync(file, 'utf8').match(/"slug":/g) || []).length;
};

/* --------------------------------------------------------------------- run */

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { StatePage, RegionPage } = require('../src/modules/cms/cms.models');
    const { REGIONS: MAP, statesOf } = require('../src/modules/cms/cms.regionMap');

    const log = (who, what) => console.log(`${String(who).padEnd(42)} ${what}`);

    const regions = MAP.filter((r) => (ONLY_REGION ? r.key === ONLY_REGION : true));
    if (!regions.length) {
        throw new Error(`no region called "${ONLY_REGION}" — try ${MAP.map((r) => r.key).join(', ')}`);
    }

    for (const region of regions) {
        const copy = REGIONS[region.key];

        /* ---------------------------------------------------- the region page */
        if (!ONLY_STATE && copy) {
            const page = await RegionPage.findOne({ regionKey: region.key });
            if (!page) {
                console.warn(`skipped region ${region.label} — no page`);
            } else {
                const members = statesOf(region.key);
                const districts = members.reduce((n, s) => n + districtCount(s.slug), 0);
                /*
                 * Not anybody already on this page — see `directorFor`.
                 */
                const director = directorFor(REGION_STYLE[region.key], page, region.key);
                const changed = [];

                if (fill(page, 'shortDescription', copy.about)) changed.push('short');
                if (fill(page, 'fullDescription', copy.about)) changed.push('full');
                /* See the state below: an empty blurb over a written
                   description is the page using the description. */
                if (isBlank(page.shortDescription)
                    && fill(page, 'hero.blurb', copy.about)) changed.push('blurb');
                if (fill(page, 'hero.tagline',
                    `${members.length} states and union territories, one council`)) changed.push('tagline');

                if (FORCE || !(page.hero.facts || []).length) {
                    page.hero.facts = [
                        { icon: 'map-pin', label: 'States & UTs', value: String(members.length) },
                        { icon: 'building', label: 'Districts covered', value: String(districts) },
                        { icon: 'users', label: 'State councils', value: String(members.length) },
                        { icon: 'globe', label: 'Languages', value: copy.langs },
                    ];
                    changed.push('facts');
                }

                /* The regional office. The capital of the largest member state
                   is where every one of these actually is. */
                const seat = members[0];
                if (FORCE || contactNeedsWriting(page)) {
                    page.contact = {
                        ...(page.contact?.toObject ? page.contact.toObject() : page.contact || {}),
                        personName: director,
                        photoUrl: portraitOf(REGION_STYLE[region.key], director),
                        designation: 'Regional Director',
                        addressLines: [
                            `ACTIV ${region.label} Regional Office`,
                            'Ground Floor, Chamber Building',
                        ],
                        city: STATES[seat.name]?.capital || seat.name,
                        state: seat.name,
                        country: 'India',
                        email: `${region.key}@activ.org.in`,
                        phone: `+91 ${CODES[region.label] || '11'} 2345 1100`,
                    };
                    changed.push('contact');
                }

                await page.save();
                log(`region ${region.label}`, changed.length ? changed.join(', ') : 'already written');
            }
        }

        /* ---------------------------------------------------- the state pages */
        const wanted = statesOf(region.key)
            .filter((s) => (ONLY_STATE ? s.name === ONLY_STATE : true));

        for (const entry of wanted) {
            const facts = STATES[entry.name];
            if (!facts) { console.warn(`skipped ${entry.name} — no entry in the table`); continue; }

            const page = await StatePage.findOne({ slug: entry.slug });
            if (!page) { console.warn(`skipped ${entry.name} — no page`); continue; }

            const director = directorFor(STYLE_OF[entry.name], page, entry.name);
            const changed = [];

            if (fill(page, 'shortDescription', facts.about)) changed.push('short');
            if (fill(page, 'fullDescription', facts.about)) changed.push('full');
            /* The hero prints `hero.blurb || shortDescription`, so an empty
               blurb over a written description is not a gap — it is the page
               using the description. Filling it anyway put this script's
               paragraph over the association's own on Tamil Nadu. */
            if (isBlank(page.shortDescription)
                && fill(page, 'hero.blurb', facts.about)) changed.push('blurb');
            if (fill(page, 'hero.tagline',
                `${facts.capital} · ${region.label} Region`)) changed.push('tagline');

            if (FORCE || !(page.hero.facts || []).length) {
                page.hero.facts = [
                    { icon: 'building', label: 'Capital', value: facts.capital },
                    { icon: 'map-pin', label: 'Area', value: facts.area },
                    { icon: 'users', label: 'Population', value: facts.people },
                    { icon: 'globe', label: 'Languages', value: facts.langs },
                ];
                changed.push('facts');
            }

            if (FORCE || contactNeedsWriting(page)) {
                page.contact = {
                    ...(page.contact?.toObject ? page.contact.toObject() : page.contact || {}),
                    personName: director,
                    photoUrl: portraitOf(STYLE_OF[entry.name], director),
                    designation: 'Director',
                    addressLines: [
                        `ACTIV ${entry.name} State Office`,
                        'Ground Floor, Chamber Building',
                    ],
                    city: facts.capital.split(' (')[0],
                    state: entry.name,
                    country: 'India',
                    email: `${slugOf(entry.name)}@activ.org.in`,
                    phone: `+91 ${CODES[entry.name] || '11'} 2345 1115`,
                };
                changed.push('contact');
            }

            await page.save();
            log(entry.name, changed.length ? changed.join(', ') : 'already written');
        }
    }

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
