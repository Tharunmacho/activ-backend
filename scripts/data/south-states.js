/**
 * What is true about each state in the South region, and what its council does.
 *
 * =========================================================================
 * FACTS ARE FACTS; THE REST IS TEMPLATE CONTENT THE CMS OWNS
 * =========================================================================
 *
 * `capital`, `area`, `population` and `languages` are real and are printed as
 * the four fact chips in the hero. Everything built out of `sectors`, `cities`
 * and `standing` is PLAUSIBLE COUNCIL CONTENT, written so a page can be judged
 * at full size — an editor replaces it from CMS -> Regions & States, and the
 * names of office-bearers are placeholders exactly as Tamil Nadu's are.
 *
 * It lives in its own file because the generator that reads it is long enough
 * already, and because this table is the thing anybody will want to correct.
 */

/* Photographs, all public, all checked. The hero of each state and the
   portraits its leaders and its contact use. */
const SCENES = [
    'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1570168007204-dfb528c6958f?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1587474260584-136574528ed5?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1477587458883-47145ed94245?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1449824913935-59a10b8d2000?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80',
];

const PORTRAITS = [
    'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=600',
];

/* Working photographs for the lists and the gallery. */
const WORK = [
    'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1523580494863-6f3031224c94?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1528605248644-14dd04022da1?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1581092160562-40aa08e78837?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80',
];

/**
 * One entry per state, in the order the region map lists them.
 *
 *   about      two or three sentences of geography and standing — the card text
 *   story      the paragraphs behind "View More"
 *   sectors    what the council's programme is built around, most important first
 *   cities     the three the council works in; [0] is where the office is
 *   glance     the three lines in the State at a Glance card
 *   features   the four tiles across the foot of the About card
 *   standing   the third figure in Statistics
 *   office     the address block on the Contact card
 */
const STATES = [
    {
        name: 'Andhra Pradesh',
        capital: 'Amaravati',
        area: '1,62,975 km²',
        population: '53.9 Million (2023)',
        languages: 'Telugu (Official), English',
        std: '0866',
        pincode: '522020',
        tagline: 'A long coast, a working port and an industry base that ships.',
        about: 'Andhra Pradesh runs along nine hundred and seventy kilometres of the '
            + 'Bay of Bengal, the second longest coastline in the country, and is bordered '
            + 'by Telangana, Odisha, Chhattisgarh, Karnataka and Tamil Nadu. Its economy '
            + 'rests on agriculture and aquaculture, on the pharmaceutical corridor around '
            + 'Visakhapatnam, and on the ports that carry both.',
        sectors: ['Pharmaceuticals', 'Aquaculture & Marine Exports', 'Automobiles', 'Textiles'],
        cities: ['Visakhapatnam', 'Vijayawada', 'Tirupati'],
        glance: [
            ['trending-up', 'Second longest coastline', 'in India'],
            ['ship', 'Six working ports', 'and a growing container trade'],
            ['leaf', 'Leader in aquaculture', 'and horticulture exports'],
        ],
        features: [
            ['ship', 'Port-led Growth'],
            ['factory', 'Pharma & Bulk Drugs'],
            ['leaf', 'Aquaculture Exports'],
            ['award', 'Temple & Heritage Tourism'],
        ],
        standing: ['2nd', 'Longest coastline in India'],
        office: ['ACTIV Andhra Pradesh State Council', 'Gate 2, Secretariat Road'],
        leaders: [
            ['Mr K Ravi Shankar', 'Chairman', 'Managing Director, Coastal Agro Exports Pvt Ltd'],
            ['Mrs P Anuradha', 'Vice Chairman', 'Director, Vizag Pharma Works Ltd'],
        ],
    },
    {
        name: 'Karnataka',
        capital: 'Bengaluru',
        area: '1,91,791 km²',
        population: '67.6 Million (2023)',
        languages: 'Kannada (Official), English',
        std: '080',
        pincode: '560001',
        tagline: 'Machine tools, aerospace and the country’s deepest technology base.',
        about: 'Karnataka sits on the Deccan plateau with a short western coast, bordered '
            + 'by Maharashtra, Goa, Telangana, Andhra Pradesh, Tamil Nadu and Kerala. It '
            + 'holds the country’s largest concentration of electronics, aerospace and '
            + 'machine-tool capacity, and a garment industry that employs several hundred '
            + 'thousand people around Bengaluru and Mysuru.',
        sectors: ['Electronics & IT Hardware', 'Machine Tools', 'Aerospace & Defence', 'Garments'],
        cities: ['Bengaluru', 'Mysuru', 'Hubballi'],
        glance: [
            ['trending-up', 'Largest technology exporter', 'in India'],
            ['factory', 'Aerospace and machine tools', 'at national scale'],
            ['graduation-cap', 'Deep engineering talent', 'across the state'],
        ],
        features: [
            ['rocket', 'Technology & Innovation'],
            ['factory', 'Aerospace & Machine Tools'],
            ['graduation-cap', 'Engineering Talent'],
            ['leaf', 'Coffee & Agro Exports'],
        ],
        standing: ['1st', 'Technology exports in India'],
        office: ['ACTIV Karnataka State Council', '4th Floor, Kasturba Road'],
        leaders: [
            ['Mr H Raghavendra', 'Chairman', 'Managing Director, Deccan Precision Works Pvt Ltd'],
            ['Mr S Manjunath', 'Vice Chairman', 'Director, Mysuru Garment Mills Ltd'],
        ],
    },
    {
        name: 'Kerala',
        capital: 'Thiruvananthapuram',
        area: '38,863 km²',
        population: '35.7 Million (2023)',
        languages: 'Malayalam (Official), English',
        std: '0471',
        pincode: '695001',
        tagline: 'Spices, marine exports and the most skilled workforce in the South.',
        about: 'Kerala lies between the Western Ghats and the Arabian Sea, bordered by '
            + 'Karnataka and Tamil Nadu, with a coastline of five hundred and ninety '
            + 'kilometres. It is the country’s leading exporter of spices and one of its '
            + 'largest in marine products, and it has the highest literacy rate in India — '
            + 'which is what its light-engineering and services base is built on. Kochi '
            + 'handles container and cruise traffic on the west coast, and the plantation '
            + 'districts of Idukki and Wayanad supply the spice and rubber trades that most '
            + 'of the council’s exporting members work in.',
        sectors: ['Spices & Marine Exports', 'Rubber & Plantations', 'Light Engineering', 'Tourism'],
        cities: ['Kochi', 'Kozhikode', 'Thrissur'],
        glance: [
            ['graduation-cap', 'Highest literacy', 'in India'],
            ['ship', 'Leading spice exporter', 'and a major marine trade'],
            ['handshake', 'Strong MSME base', 'across fourteen districts'],
        ],
        features: [
            ['ship', 'Spices & Marine Exports'],
            ['leaf', 'Rubber & Plantations'],
            ['graduation-cap', 'Skilled Workforce'],
            ['award', 'Responsible Tourism'],
        ],
        standing: ['1st', 'Spice exports in India'],
        office: ['ACTIV Kerala State Council', 'Vellayambalam, Sasthamangalam'],
        leaders: [
            ['Mr T Vijayakumar', 'Chairman', 'Managing Director, Malabar Spice Traders Pvt Ltd'],
            ['Mrs A Lekha Menon', 'Vice Chairman', 'Director, Kochi Marine Exports Ltd'],
        ],
    },
    {
        name: 'Telangana',
        capital: 'Hyderabad',
        area: '1,12,077 km²',
        population: '38.5 Million (2023)',
        languages: 'Telugu (Official), Urdu, English',
        std: '040',
        pincode: '500004',
        tagline: 'Life sciences, technology services and a state that plans its corridors.',
        about: 'Telangana sits on the Deccan plateau, bordered by Maharashtra, '
            + 'Chhattisgarh, Odisha, Andhra Pradesh and Karnataka. Hyderabad carries one of '
            + 'the largest life-sciences clusters in the world, and the state’s industrial '
            + 'corridors have drawn pharmaceutical, electronics and food-processing '
            + 'investment at scale. The corridor along the outer ring road and the parks at '
            + 'Warangal and Nizamabad have taken most of the new capacity, and the council’s '
            + 'members are concentrated in bulk drugs, engineering and textiles.',
        sectors: ['Pharma & Life Sciences', 'Technology Services', 'Textiles', 'Food Processing'],
        cities: ['Hyderabad', 'Warangal', 'Nizamabad'],
        glance: [
            ['trending-up', 'Life sciences capital', 'of India'],
            ['rocket', 'Among the fastest growing', 'state economies'],
            ['factory', 'Planned industrial corridors', 'with plug-and-play parks'],
        ],
        features: [
            ['factory', 'Life Sciences'],
            ['rocket', 'Technology Services'],
            ['award', 'Textile Parks'],
            ['leaf', 'Food Processing'],
        ],
        standing: ['1st', 'Bulk drug output in India'],
        office: ['ACTIV Telangana State Council', 'Road No. 12, Banjara Hills'],
        leaders: [
            ['Dr M Srinivas Reddy', 'Chairman', 'Managing Director, Deccan Life Sciences Pvt Ltd'],
            ['Mr G Praveen Kumar', 'Vice Chairman', 'Director, Warangal Textile Park Ltd'],
        ],
    },
    {
        name: 'Puducherry',
        capital: 'Puducherry',
        area: '492 km²',
        population: '1.7 Million (2023)',
        languages: 'Tamil (Official), French, English',
        std: '0413',
        pincode: '605001',
        tagline: 'Four districts, one industrial base, and a coast that trades.',
        about: 'Puducherry is a union territory of four districts — Puducherry and Karaikal '
            + 'on the Coromandel coast, Yanam on the Godavari delta and Mahé on the Malabar '
            + 'coast. Its industry is light manufacturing, pharmaceuticals and textiles, and '
            + 'its proximity to Chennai puts its units inside an established supply chain. '
            + 'The territory’s industrial estates hold a mix of automotive components, '
            + 'formulations and garment units, most of them small and medium enterprises, and '
            + 'tourism carries a significant part of the local economy through the year.',
        sectors: ['Light Manufacturing', 'Pharmaceuticals', 'Textiles', 'Tourism'],
        cities: ['Puducherry', 'Karaikal', 'Yanam'],
        glance: [
            ['map-pin', 'Four districts', 'across two coasts'],
            ['factory', 'Light manufacturing base', 'inside the Chennai supply chain'],
            ['award', 'Heritage and coastal tourism', 'through the year'],
        ],
        features: [
            ['factory', 'Light Manufacturing'],
            ['award', 'Heritage Tourism'],
            ['ship', 'Coastal Trade'],
            ['graduation-cap', 'Education & Research'],
        ],
        standing: ['4', 'Districts across two coasts'],
        office: ['ACTIV Puducherry Territorial Council', '100 Feet Road, Natesan Nagar'],
        leaders: [
            ['Mr R Balasubramanian', 'Chairman', 'Managing Director, Coromandel Engineering Works'],
            ['Mrs S Kalaiselvi', 'Vice Chairman', 'Director, Karaikal Textiles Pvt Ltd'],
        ],
    },
    {
        name: 'Lakshadweep',
        capital: 'Kavaratti',
        area: '32 km²',
        population: '0.07 Million (2023)',
        languages: 'Malayalam (Official), English',
        std: '04896',
        pincode: '682555',
        tagline: 'Thirty-six islands, a fishing fleet and a coconut economy.',
        about: 'Lakshadweep is an archipelago of thirty-six islands in the Arabian Sea, ten '
            + 'of them inhabited, lying two hundred to four hundred kilometres off the coast '
            + 'of Kerala. Its economy is tuna fishing, coconut and coir, and a small, '
            + 'carefully limited tourism trade. Nearly every enterprise on the islands is a '
            + 'household or a cooperative, and freight to the mainland runs through Kochi and '
            + 'Beypore. The council’s work here is about market access, cold-chain capacity '
            + 'and the cost of moving goods off the islands.',
        sectors: ['Fisheries', 'Coconut & Coir', 'Tourism', 'Island Logistics'],
        cities: ['Kavaratti', 'Agatti', 'Minicoy'],
        glance: [
            ['ship', 'Thirty-six islands', 'ten of them inhabited'],
            ['leaf', 'Tuna and coconut', 'the two working trades'],
            ['map-pin', 'Smallest union territory', 'by area in India'],
        ],
        features: [
            ['ship', 'Fisheries & Tuna'],
            ['leaf', 'Coconut & Coir'],
            ['award', 'Island Tourism'],
            ['handshake', 'Cooperative Enterprise'],
        ],
        standing: ['36', 'Islands in the archipelago'],
        office: ['ACTIV Lakshadweep Council', 'Near Administration Complex, Kavaratti'],
        leaders: [
            ['Mr A Koya Thangal', 'Chairman', 'Managing Partner, Kavaratti Marine Traders'],
            ['Mr M Abdul Rahman', 'Vice Chairman', 'Director, Agatti Coir Producers Society'],
        ],
    },
    {
        name: 'Andaman and Nicobar Islands',
        capital: 'Port Blair',
        area: '8,249 km²',
        population: '0.43 Million (2023)',
        languages: 'Hindi & English (Official), Bengali, Tamil',
        std: '03192',
        pincode: '744101',
        tagline: 'A transhipment coast, a fishing fleet and a forest economy.',
        about: 'The Andaman and Nicobar Islands are five hundred and seventy-two islands in '
            + 'the Bay of Bengal, thirty-eight of them inhabited, running north to south for '
            + 'some eight hundred kilometres. The territory’s trade is fisheries, timber and '
            + 'coir, and a transhipment port that puts it on the East-West shipping lane.',
        sectors: ['Fisheries', 'Timber & Coir', 'Tourism', 'Shipping & Transhipment'],
        cities: ['Port Blair', 'Mayabunder', 'Car Nicobar'],
        glance: [
            ['ship', 'On the East-West lane', 'and building transhipment'],
            ['leaf', 'Fisheries and forestry', 'the working trades'],
            ['map-pin', 'Five hundred islands', 'thirty-eight inhabited'],
        ],
        features: [
            ['ship', 'Shipping & Transhipment'],
            ['leaf', 'Fisheries & Forestry'],
            ['award', 'Island Tourism'],
            ['handshake', 'Small Enterprise'],
        ],
        standing: ['572', 'Islands in the territory'],
        office: ['ACTIV Andaman & Nicobar Council', 'Phoenix Bay, Port Blair'],
        leaders: [
            ['Mr D Prakash Rao', 'Chairman', 'Managing Director, Bay Islands Seafoods Pvt Ltd'],
            ['Mrs J Nirmala', 'Vice Chairman', 'Director, Port Blair Logistics Services'],
        ],
    },
];

/**
 * The region itself.
 *
 * Written as a region writes: what it does ACROSS its states, not a summary of
 * any one of them.
 */
const REGION = {
    key: 'south',
    name: 'South',
    headline: 'ACTIV South Region',
    tagline: 'Five states, three union territories, and one council that carries their case.',
    about: 'The South region covers Andhra Pradesh, Karnataka, Kerala, Tamil Nadu and '
        + 'Telangana together with Puducherry, Lakshadweep and the Andaman and Nicobar '
        + 'Islands. Between them they hold the country’s deepest manufacturing base, its '
        + 'largest technology and life-sciences clusters, and four of its busiest ports.',
    story: 'The regional council convenes the eight state and territorial councils four '
        + 'times a year, carries their common representations to the central government, '
        + 'and runs the programmes that are worth running once for all of them — the '
        + 'export desk, the skills partnership and the credit clinics.\n\n'
        + 'Its working groups cover manufacturing, exports, energy and skills. Each is '
        + 'chaired by a member company and reports to the regional council with a written '
        + 'note every quarter.\n\n'
        + 'Where a state council is better placed to act, the region does not: the rule is '
        + 'that the region takes what crosses a border and leaves what does not.',
    facts: [
        ['map-pin', 'States & UTs', '8'],
        ['users', 'Member companies', '14,200+'],
        ['building', 'District chapters', '96'],
        ['globe', 'Languages', 'Tamil, Telugu, Kannada, Malayalam'],
    ],
    glance: [
        ['trending-up', 'Largest industrial output', 'of any Indian region'],
        ['ship', 'Four major ports', 'and the busiest container trade'],
        ['graduation-cap', 'Deepest engineering talent', 'in the country'],
    ],
    features: [
        ['factory', 'Manufacturing Depth'],
        ['ship', 'Ports & Exports'],
        ['rocket', 'Technology & Life Sciences'],
        ['graduation-cap', 'Skills & Training'],
    ],
    achievements: [
        ['14,200+', 'Member companies', 'users'],
        ['96', 'District chapters', 'building'],
        ['8', 'State and territorial councils', 'map-pin'],
        ['340+', 'Events held in the last year', 'calendar'],
    ],
    leaders: [
        ['Mr V Subramanian', 'Regional Chairman',
            'Chairman, ACTIV South Region',
            'Managing Director, Southern Castings Pvt Ltd',
            'Chairs the regional council and its manufacturing working group. Thirty years '
            + 'in castings and precision machining, and a member of the association since '
            + 'its second year.'],
        ['Mrs R Meenakshi', 'Vice Chairman',
            'Vice Chairman, ACTIV South Region',
            'Director, Coromandel Exports Ltd',
            'Leads the export working group and the region’s trade delegations. Built an '
            + 'export business across eleven markets from a single unit in Coimbatore.'],
        ['Mr N Ashok Kumar', 'Secretary',
            'Secretary, ACTIV South Region',
            'Partner, Deccan Industrial Services',
            'Runs the secretariat, the quarterly council meetings and the region’s '
            + 'correspondence with the state councils.'],
    ],
    office: {
        personName: 'Mr S Ganesan',
        designation: 'Regional Director',
        addressLines: ['ACTIV South Regional Office', '2nd Floor, Prof. CK Prahalad Centre',
            '98/1, Velachery Main Road, Guindy'],
        city: 'Chennai',
        state: 'Tamil Nadu',
        pincode: '600032',
        email: 'south@activ.org.in',
        phone: '+91 44 2345 1100',
    },
    hero: 'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?auto=format&fit=crop&q=80',
};

module.exports = { STATES, REGION, SCENES, PORTRAITS, WORK };
