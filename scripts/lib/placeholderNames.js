/**
 * The placeholder people: the name pools, the naming traditions and the trunk
 * dialling codes, shared by every script that writes region or state content.
 *
 * =========================================================================
 * WHY THIS IS ITS OWN MODULE
 * =========================================================================
 *
 * `seed-region-leadership.js` writes the benches and `seed-region-profiles.js`
 * writes the office a reader contacts. Both need a name that reads as belonging
 * to the place, and both need the same one: a Nagaland page whose bench is
 * composed from one list and whose director comes from another is a page with
 * two opinions about where it is.
 *
 * Nothing here touches the database.
 */

/**
 * ONE ENTRY PER NAMING TRADITION, NOT PER STATE.
 *
 * `mode` is the shape of the name, and India has two that matter here:
 *
 *   `initial`  an initial standing for the father's or the village's name,
 *              then the given name — "Mr K Ravi Shankar". The four southern
 *              languages and Meitei write names this way; a surname list would
 *              produce something nobody in Chennai is called.
 *   `surname`  given name then family name — "Mrs Anjali Bhardwaj".
 *
 * Splitting the given names by gender is not decoration: "Mrs P Anuradha" reads
 * as a person and "Mrs P Murugan" reads as a bug, and the honorific is picked
 * from the same index as the name.
 *
 * ------------------------------------------ NOBODY REAL, AND THAT IS CHECKED
 *
 * These lists are combined mechanically, so a given name and a surname that are
 * individually ordinary can compose the name of a living public figure — and
 * the first run of the seed put one on Bihar's contact band and another on
 * Gujarat's. Serving sitting chief ministers, former prime ministers and
 * well-known public names have been taken out of the pools rather than left for
 * the composition to find: a placeholder that names a real person on a trade
 * association's own page is not a placeholder any more.
 */
const INITIALS = 'ABCDEGHJKLMNPRSTVY'.split('');

const STYLES = {
    tamil: {
        mode: 'initial',
        male: ['Murugan', 'Senthil Kumar', 'Ramachandran', 'Arulmozhi', 'Thiagarajan',
            'Balasubramanian', 'Karthikeyan', 'Sundaram', 'Vetrivel', 'Anbarasan',
            'Chandrasekaran', 'Palanivel'],
        female: ['Meenakshi', 'Kalaiselvi', 'Bhuvaneswari', 'Revathi', 'Tamilselvi',
            'Jayanthi', 'Nandhini', 'Poongodi', 'Vasanthi'],
    },
    telugu: {
        mode: 'initial',
        male: ['Ravi Shankar', 'Srinivasa Rao', 'Nageswara Rao', 'Chandrasekhar',
            'Prasad Rao', 'Ramakrishna', 'Venkata Reddy', 'Satyanarayana', 'Subba Rao',
            'Naveen Kumar', 'Gopala Krishna', 'Ranga Rao'],
        female: ['Anuradha', 'Padmaja', 'Sridevi', 'Swapna', 'Vijayalakshmi', 'Haritha',
            'Bhavani', 'Lavanya', 'Manjula'],
    },
    kannada: {
        mode: 'initial',
        male: ['Shivakumar', 'Basavaraj', 'Prakash Gowda', 'Nagaraj', 'Manjunath',
            'Rajesh Rao', 'Mallikarjun', 'Chandrashekar', 'Krishnamurthy', 'Ravindra',
            'Somashekar', 'Siddaraju'],
        female: ['Girija', 'Deepa', 'Vidya', 'Roopa', 'Sharada', 'Anitha', 'Sowmya',
            'Pavithra', 'Rekha'],
    },
    malayalam: {
        mode: 'initial',
        male: ['Rajeev', 'Mohanan', 'Pradeep Kumar', 'Thomas Mathew', 'Sudheer', 'Anoop',
            'Jayaprakash', 'Vinod Kumar', 'Hariharan', 'Sajeev', 'Manoj', 'Baiju'],
        female: ['Bindu', 'Anjali', 'Sreelatha', 'Divya', 'Lekha', 'Reshma', 'Sindhu',
            'Aswathy', 'Remya'],
    },

    hindi: {
        mode: 'surname',
        male: ['Rajesh', 'Anil', 'Vikram', 'Sanjay', 'Deepak', 'Manish', 'Ashok',
            'Naveen', 'Pankaj', 'Rohit', 'Arun', 'Vinod'],
        female: ['Anjali', 'Sunita', 'Neha', 'Kavita', 'Poonam', 'Shalini', 'Meera',
            'Ritu', 'Nidhi'],
        sur: ['Sharma', 'Verma', 'Agarwal', 'Gupta', 'Chauhan', 'Rathore', 'Yadav',
            'Bhardwaj', 'Khanna', 'Saxena', 'Mehta', 'Singhal'],
    },
    bihari: {
        mode: 'surname',
        male: ['Ranjan', 'Abhishek', 'Sudhir', 'Rakesh', 'Niranjan', 'Amrendra', 'Shashi',
            'Vivek', 'Birendra', 'Manoj', 'Prabhat', 'Chandan'],
        female: ['Archana', 'Sushma', 'Rekha', 'Priyanka', 'Sarita', 'Kumari Nisha',
            'Madhu', 'Anita', 'Shobha'],
        sur: ['Prasad', 'Jha', 'Mishra', 'Sinha', 'Choudhary', 'Tiwari', 'Pandey',
            'Singh', 'Mahto', 'Oraon', 'Kumar', 'Thakur'],
    },
    central: {
        mode: 'surname',
        male: ['Rakesh', 'Dinesh', 'Jitendra', 'Mukesh', 'Lokesh', 'Hemant', 'Bhupendra',
            'Yogesh', 'Alok', 'Devendra', 'Sanjeev', 'Shailendra'],
        female: ['Archana', 'Seema', 'Vandana', 'Jyoti', 'Rashmi', 'Pushpa', 'Sadhana',
            'Mamta', 'Kiran'],
        sur: ['Agrawal', 'Dubey', 'Sahu', 'Tiwari', 'Patel', 'Shukla', 'Namdeo',
            'Rajput', 'Jain', 'Chouhan', 'Netam', 'Dhruw'],
    },
    punjabi: {
        mode: 'surname',
        male: ['Harpreet Singh', 'Gurpreet Singh', 'Jaswinder Singh', 'Amarjit Singh',
            'Baldev Singh', 'Tejinder Singh', 'Ravinder Singh', 'Karan', 'Rohit',
            'Sukhdev Singh', 'Inderjit Singh', 'Navdeep Singh'],
        female: ['Harjit Kaur', 'Simran Kaur', 'Navneet Kaur', 'Rupinder Kaur',
            'Manpreet Kaur', 'Jasleen Kaur', 'Amrit Kaur', 'Gurleen Kaur', 'Sonia'],
        sur: ['Gill', 'Sidhu', 'Dhillon', 'Sandhu', 'Bedi', 'Grewal', 'Bajwa', 'Chadha',
            'Sethi', 'Arora', 'Bhatia', 'Sodhi'],
    },
    kashmiri: {
        mode: 'surname',
        male: ['Bilal Ahmad', 'Mushtaq', 'Showkat', 'Irfan', 'Javed', 'Tariq', 'Nisar',
            'Aijaz', 'Rouf', 'Sameer', 'Zahoor', 'Fayaz'],
        female: ['Shazia', 'Rubeena', 'Nighat', 'Insha', 'Yasmeen', 'Ulfat', 'Sabreena',
            'Iqra', 'Mehvish'],
        sur: ['Bhat', 'Wani', 'Dar', 'Mir', 'Lone', 'Shah', 'Khan', 'Rather', 'Malik',
            'Andrabi', 'Qureshi', 'Parray'],
    },
    ladakhi: {
        mode: 'surname',
        male: ['Stanzin', 'Tsering', 'Rigzin', 'Sonam', 'Jigmet', 'Tashi', 'Phuntsog',
            'Thinles', 'Norbu', 'Lobzang', 'Konchok', 'Dorjey'],
        female: ['Padma', 'Deachen', 'Yangchen', 'Skarma', 'Tsewang', 'Nilza', 'Rinchen',
            'Dolma', 'Chorol'],
        sur: ['Namgyal', 'Dorjey', 'Angchuk', 'Wangchuk', 'Gyaltsen', 'Nurboo', 'Spalzes',
            'Tundup', 'Morup', 'Chhosphel', 'Zangpo', 'Targais'],
    },

    bengali: {
        mode: 'surname',
        male: ['Sujoy', 'Arindam', 'Debashis', 'Pradip', 'Somnath', 'Anirban', 'Tapas',
            'Subhankar', 'Kaushik', 'Rathin', 'Bikash', 'Amitava'],
        female: ['Moumita', 'Sharmistha', 'Rituparna', 'Ananya', 'Piyali', 'Debjani',
            'Sanchita', 'Paromita', 'Sudeshna'],
        sur: ['Banerjee', 'Chatterjee', 'Mukherjee', 'Das', 'Ghosh', 'Bose', 'Sen',
            'Roy', 'Dutta', 'Chakraborty', 'Sarkar', 'Bhattacharya'],
    },
    odia: {
        mode: 'surname',
        male: ['Subrat', 'Bibhuti', 'Prasanta', 'Sanjib', 'Rabindra', 'Debasis',
            'Jagannath', 'Sarat', 'Manoranjan', 'Akshaya', 'Dillip', 'Bijay'],
        female: ['Sasmita', 'Snehalata', 'Itishree', 'Pratima', 'Lopamudra', 'Subhasmita',
            'Jyotsna', 'Manasi', 'Rojalin'],
        sur: ['Mohanty', 'Patnaik', 'Das', 'Sahoo', 'Behera', 'Pradhan', 'Nayak',
            'Swain', 'Jena', 'Rout', 'Panda', 'Mishra'],
    },

    marathi: {
        mode: 'surname',
        male: ['Sachin', 'Nilesh', 'Prashant', 'Milind', 'Sameer', 'Amol', 'Vaibhav',
            'Nitin', 'Girish', 'Swapnil', 'Mangesh', 'Abhijit'],
        female: ['Smita', 'Manasi', 'Aparna', 'Snehal', 'Shubhangi', 'Trupti', 'Rohini',
            'Madhuri', 'Ketaki'],
        sur: ['Deshpande', 'Kulkarni', 'Patil', 'Joshi', 'Jadhav', 'More', 'Shinde',
            'Gaikwad', 'Pawar', 'Sawant', 'Naik', 'Kamat'],
    },
    gujarati: {
        mode: 'surname',
        male: ['Jignesh', 'Hardik', 'Nilay', 'Chirag', 'Bhavin', 'Mitesh', 'Tushar',
            'Dhaval', 'Rushabh', 'Kalpesh', 'Nirav', 'Parth'],
        female: ['Hetal', 'Bhavna', 'Kinjal', 'Nisha', 'Krupa', 'Palak', 'Dhara',
            'Rina', 'Foram'],
        sur: ['Patel', 'Shah', 'Desai', 'Mehta', 'Trivedi', 'Parikh', 'Joshi', 'Vyas',
            'Amin', 'Thakkar', 'Bhatt', 'Dave'],
    },

    assamese: {
        mode: 'surname',
        male: ['Pranjal', 'Nabajyoti', 'Dhrubajyoti', 'Bhaskar', 'Ranjit', 'Manash',
            'Kaushik', 'Arup', 'Jitul', 'Pallab', 'Diganta', 'Utpal'],
        female: ['Mridula', 'Anamika', 'Jonali', 'Rituparna', 'Bandana', 'Nayanmoni',
            'Purabi', 'Dipanwita', 'Rekhamoni'],
        sur: ['Baruah', 'Sarma', 'Gogoi', 'Bora', 'Das', 'Hazarika', 'Saikia', 'Deka',
            'Kalita', 'Phukan', 'Bhuyan', 'Nath'],
    },
    manipuri: {
        mode: 'initial',
        male: ['Bijoy Singh', 'Ibomcha Singh', 'Tomba Singh', 'Rajen Singh',
            'Nandakumar Singh', 'Premjit Singh', 'Ranjit Singh', 'Ibungo Singh',
            'Sanjoy Singh', 'Manihar Singh', 'Kunjo Singh', 'Ratan Singh'],
        female: ['Memma Devi', 'Sanatombi Devi', 'Ranjita Devi', 'Chaoba Devi',
            'Thoibi Devi', 'Ibemhal Devi', 'Sushila Devi', 'Binota Devi', 'Ningol Devi'],
    },
    naga: {
        mode: 'surname',
        male: ['Imkong', 'Temjen', 'Kevi', 'Lima', 'Along', 'Neiba', 'Toshi', 'Vikuo',
            'Yanpvuo', 'Chumben', 'Pukhayi', 'Merenmoa'],
        female: ['Merenla', 'Asenla', 'Kevinuo', 'Bendangla', 'Vilasier', 'Imlimeren',
            'Nzanbeni', 'Rukuwenuo', 'Tialila'],
        sur: ['Kikon', 'Jamir', 'Ao', 'Konyak', 'Sema', 'Angami', 'Chishi', 'Zeliang',
            'Yanthan', 'Longkumer', 'Ovung', 'Rengma'],
    },
    mizo: {
        mode: 'surname',
        male: ['Lalrinawma', 'Lalthanmawia', 'Lalremruata', 'Vanlalruata', 'Lalrinsanga',
            'Lalhriatpuia', 'Malsawmzuala', 'Lalnunmawia', 'Ramengmawia', 'Lalbiakzuala',
            'Vanlalhruaia', 'Zohmingliana'],
        female: ['Lalhmangaihi', 'Zothanpuii', 'Lalnunsiami', 'Ramdinpuii',
            'Lalrinpuii', 'Zonunmawii', 'Lalengmawii', 'Vanlalrempuii', 'Hmingthanmawii'],
        sur: ['Sailo', 'Hmar', 'Ralte', 'Chhangte', 'Colney', 'Pachuau', 'Fanai',
            'Renthlei', 'Khiangte', 'Varte', 'Hrahsel', 'Tochhawng'],
    },
    khasi: {
        mode: 'surname',
        male: ['Banteilang', 'Wanshanlang', 'Donkupar', 'Rikynti', 'Phrangsngi',
            'Kyrmen', 'Balajied', 'Hamletson', 'Batskhem', 'Aiban', 'Ksan', 'Wandondor'],
        female: ['Iaishah', 'Daphisha', 'Banrilang', 'Ibashisha', 'Wanrisa', 'Larisha',
            'Meban', 'Silda', 'Riti'],
        sur: ['Lyngdoh', 'Marbaniang', 'Kharkongor', 'Syiem', 'Nongrum', 'Sangma',
            'Marak', 'Momin', 'Mylliemngap', 'Kharbuli', 'Shylla', 'Dkhar'],
    },
    arunachali: {
        mode: 'surname',
        male: ['Tadar', 'Nabam', 'Techi', 'Likha', 'Toko', 'Gyati', 'Kaling', 'Bamang',
            'Taba', 'Hage', 'Punyo', 'Koj'],
        female: ['Yami', 'Mamung', 'Onit', 'Nending', 'Yalam', 'Tarh Ani', 'Millo Yaja',
            'Dani Yami', 'Nyage'],
        sur: ['Tayeng', 'Riba', 'Gamlin', 'Ering', 'Pertin', 'Doke', 'Mize', 'Perme',
            'Padu', 'Tana', 'Nyodu', 'Bagra'],
    },
    sikkimese: {
        mode: 'surname',
        male: ['Ugen', 'Karma', 'Tshering', 'Dawa', 'Nima', 'Passang', 'Bhim', 'Sanjay',
            'Dilip', 'Norden', 'Tenzing', 'Lhendup'],
        female: ['Doma', 'Yangchen', 'Dechen', 'Pemala', 'Sangay', 'Kesang', 'Bimala',
            'Sarita', 'Choden'],
        sur: ['Bhutia', 'Lepcha', 'Subba', 'Rai', 'Tamang', 'Gurung', 'Sherpa',
            'Namgyal', 'Limboo', 'Chettri', 'Pradhan', 'Dahal'],
    },
    tripuri: {
        mode: 'surname',
        male: ['Bikash', 'Sanjoy', 'Ratan', 'Debabrata', 'Nikhil', 'Subrata', 'Sudip',
            'Anupam', 'Tapan', 'Nirmal', 'Ashis', 'Gopal'],
        female: ['Bithika', 'Sunita', 'Aparna', 'Mamata', 'Sanchita', 'Rina', 'Jharna',
            'Papiya', 'Kalpana'],
        sur: ['Debbarma', 'Jamatia', 'Reang', 'Deb', 'Bhattacharjee', 'Chakraborty',
            'Saha', 'Tripura', 'Roy', 'Nath', 'Sarkar', 'Das'],
    },

    /** A mixed-settlement territory: the pool is deliberately not one tradition. */
    islander: {
        mode: 'surname',
        male: ['Prakash', 'Alex', 'Ranjit', 'Joseph', 'Hari Prasad', 'Edward', 'Suresh',
            'Anand', 'Thomas', 'Bimal', 'Sunil', 'Vincent'],
        female: ['Nirmala', 'Rekha', 'Sheela', 'Lalitha', 'Shanthi', 'Ganga', 'Grace',
            'Sarita', 'Mary'],
        sur: ['Rao', 'Thomas', 'Kumar', 'Biswas', 'Mondal', 'Lakra', 'Ekka', 'Francis',
            'Halder', 'Roy', 'Nair', 'Toppo'],
    },
    lakshadweep: {
        mode: 'surname',
        male: ['Abdul Rahman', 'Hameed', 'Abdulla', 'Basheer', 'Shameem', 'Kunhi Koya',
            'Nizamudheen', 'Salih', 'Rafeeq', 'Mohammed Ali', 'Sulaiman', 'Ashraf'],
        female: ['Fathima Beevi', 'Nasreen', 'Sajida', 'Fathima', 'Ayisha', 'Raheema',
            'Suhara', 'Jameela', 'Shakeela'],
        sur: ['Koya', 'Thangal', 'Hassan', 'Kunhi', 'Ali', 'Beary', 'Musaliar', 'Kakkat',
            'Malmi', 'Cherya', 'Palli', 'Kidavu'],
    },
};

/** Which tradition each state's placeholders are written in. */
const STYLE_OF = {
    /* South */
    'Tamil Nadu': 'tamil',
    Puducherry: 'tamil',
    'Andhra Pradesh': 'telugu',
    Telangana: 'telugu',
    Karnataka: 'kannada',
    Kerala: 'malayalam',
    Lakshadweep: 'lakshadweep',
    'Andaman and Nicobar Islands': 'islander',

    /* North */
    Delhi: 'hindi',
    Haryana: 'hindi',
    Punjab: 'punjabi',
    Rajasthan: 'hindi',
    'Uttar Pradesh': 'hindi',
    Uttarakhand: 'hindi',
    'Himachal Pradesh': 'hindi',
    'Jammu and Kashmir': 'kashmiri',
    Ladakh: 'ladakhi',
    Chandigarh: 'punjabi',

    /* East */
    Bihar: 'bihari',
    Jharkhand: 'bihari',
    Odisha: 'odia',
    'West Bengal': 'bengali',

    /* West */
    Goa: 'marathi',
    Gujarat: 'gujarati',
    Maharashtra: 'marathi',
    'Madhya Pradesh': 'central',
    Chhattisgarh: 'central',
    'Dadra and Nagar Haveli and Daman and Diu': 'gujarati',

    /* North East */
    Assam: 'assamese',
    'Arunachal Pradesh': 'arunachali',
    Manipur: 'manipuri',
    Meghalaya: 'khasi',
    Mizoram: 'mizo',
    Nagaland: 'naga',
    Sikkim: 'sikkimese',
    Tripura: 'tripuri',
};

/** A region's own council is written in the tradition of its largest state. */
const REGION_STYLE = {
    south: 'tamil', north: 'hindi', east: 'bengali', west: 'marathi',
    'north-east': 'assamese',
};

/**
 * A deterministic pool of `count` distinct names in one tradition.
 *
 * ================================================================== the grid
 *
 * It ENUMERATES A GRID rather than walking two lists with strides. The stride
 * version looked fine and quietly ran out: a tradition with twelve given names
 * and twelve surnames has a hundred and forty-four men in it, and stepping both
 * lists together found twelve of them and then repeated. Sixty names was the
 * ceiling for the southern traditions, a state's three tiers need forty-nine of
 * them, and the eleven left over were not enough for the contact seed to find a
 * Director who was not already on the bench — every northern state ended up
 * with the same one.
 *
 *   surname mode   given × surname. "Mrs Anjali Bhardwaj".
 *   initial mode   given × initial, and then given × initial × second initial,
 *                  which is how the name is actually written in the south:
 *                  "Mr K Ravi Shankar" first, "Mr A K Ravi Shankar" once the
 *                  single initials are used up.
 *
 * ---------------------------------------------------------------- the people
 *
 * One woman in three, which is roughly what the benches already seeded look
 * like. The honorific follows from the SAME index as the name and not from the
 * position in the output, so one person is never both "Mr Anil Verma" and
 * "Dr Anil Verma" — two rows of a bench that a reader reads as one man listed
 * twice.
 */
const poolFor = (styleKey, count) => {
    const style = STYLES[styleKey] || STYLES.hindi;
    const out = [];
    const seen = new Set();
    /* A counter per list, not one shared: sharing it means the two men in every
       group of three are drawn from the same slot, and a bench reads
       "Mr Rajesh Sharma, Mr Rajesh Bhardwaj". */
    let mi = 0;
    let fi = 0;

    for (let i = 0; out.length < count && i < count * 20; i += 1) {
        const female = i % 3 === 2;
        const n = female ? fi++ : mi++;
        const list = female ? style.female : style.male;

        const given = list[n % list.length];
        const round = Math.floor(n / list.length);
        const title = n % 7 === 3 ? 'Dr' : (female ? (n % 2 ? 'Mrs' : 'Ms') : 'Mr');

        /*
         * The second axis moves on EVERY step, not once per lap of the first.
         * Advancing it only per lap made the first twelve men of every northern
         * state Sharmas — a council that reads as one family rather than as a
         * bench. Adding the lap number walks the grid diagonally instead, so
         * consecutive names differ in both halves and the pairs are still
         * distinct.
         */
        const step = (n + round) % (style.mode === 'initial'
            ? INITIALS.length
            : style.sur.length);

        let name;
        if (style.mode === 'initial') {
            const lap = Math.floor(n / (list.length * INITIALS.length));
            name = lap === 0
                ? `${title} ${INITIALS[step]} ${given}`
                : `${title} ${INITIALS[(lap - 1) % INITIALS.length]} ${INITIALS[step]} ${given}`;
        } else {
            name = `${title} ${given} ${style.sur[step]}`;
        }

        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
};


/* -------------------------------------------------------------- portraits */

/**
 * PUBLIC PORTRAITS, SPLIT BY WHO IS IN THEM.
 *
 * One list produced "Mr Abhishek Jha" over a photograph of a woman, twice in
 * the first bench that was looked at. A placeholder name and a placeholder face
 * are both obviously placeholders; a placeholder name over a face that
 * contradicts it reads as a page that has mixed up its rows.
 *
 * Ten each, keyed by a hash of the name so one placeholder person keeps one
 * face wherever they appear, and so consecutive benches do not line up — which
 * they did when the index within the tier chose the photograph, putting the
 * state council and the first region's bench under each other as the same five
 * faces in the same order.
 */
const MEN = [
    'photo-1560250097-0b93528c311a', 'photo-1472099645785-5658abf4ff4e',
    'photo-1507003211169-0a1dd7228f2d', 'photo-1519085360753-af0119f7cbe7',
    'photo-1500648767791-00dcc994a43e', 'photo-1506794778202-cad84cf45f1d',
    'photo-1492562080023-ab3db95bfbce', 'photo-1552058544-f2b08422138a',
    'photo-1590086782792-42dd2350140d', 'photo-1566492031773-4f4e44671857',
];

const WOMEN = [
    'photo-1573497019940-1c28c88b4f3e', 'photo-1580489944761-15a19d654956',
    'photo-1494790108377-be9c29b29330', 'photo-1531123897727-8f129e1688ce',
    'photo-1544005313-94ddf0286df2', 'photo-1517841905240-472988babdf9',
    'photo-1534528741775-53994a69daeb', 'photo-1487412720507-e7ab37603c6f',
    'photo-1573496359142-b8d87734a5a2', 'photo-1508214751196-bcfd4ca60f91',
];

const shot = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&q=80&w=600`;

/**
 * Whether a composed name is one of the women's.
 *
 * `Mrs`/`Ms` would answer it for most rows and not for the doctorates, and
 * "Dr Anjali Bhardwaj" needs the same answer as "Mrs Anjali Bhardwaj". So it
 * checks the GIVEN NAME against the tradition's own list — matched as a whole
 * word, because a substring test makes "Ritu" out of "Rituparna" and would
 * eventually make a man out of somebody.
 */
const isFemaleName = (styleKey, name) => {
    const style = STYLES[styleKey] || STYLES.hindi;
    const text = ` ${String(name || '').trim()} `;
    return style.female.some((given) => text.includes(` ${given} `));
};

/** Which portrait a name gets, and always the same one. */
const portraitOf = (styleKey, name, taken) => {
    const list = isFemaleName(styleKey, name) ? WOMEN : MEN;
    let h = 0;
    for (const ch of String(name)) h = (h * 33 + ch.charCodeAt(0)) % 1000003;
    const from = h % list.length;

    /*
     * WALK ON IF THIS FACE IS ALREADY IN THE ROW.
     *
     * A hash over ten portraits and a bench of five collides about as often as
     * two people in a room of five sharing a birth month — which is to say
     * regularly, and Tamil Nadu's council had the chairman and the secretary as
     * the same man. Nobody reads that as a coincidence; they read it as the page
     * having rendered the wrong row.
     *
     * `taken` is the set of photographs already used by THIS bench. Across
     * different benches a repeat is fine and unavoidable — ten faces cannot
     * staff forty-nine posts — but never twice in one row of five.
     */
    for (let i = 0; i < list.length; i += 1) {
        const url = shot(list[(from + i) % list.length]);
        if (!taken || !taken.has(url)) {
            if (taken) taken.add(url);
            return url;
        }
    }
    return shot(list[from]);
};

/** Trunk dialling codes, so a number looks like it belongs where it says. */
const CODES = {
    'Tamil Nadu': '44', 'Andhra Pradesh': '866', Telangana: '40', Karnataka: '80',
    Kerala: '471', Puducherry: '413', Lakshadweep: '4896',
    'Andaman and Nicobar Islands': '3192',

    Delhi: '11', Haryana: '124', Punjab: '161', Rajasthan: '141',
    'Uttar Pradesh': '522', Uttarakhand: '135', 'Himachal Pradesh': '177',
    'Jammu and Kashmir': '194', Ladakh: '1982', Chandigarh: '172',

    Bihar: '612', Jharkhand: '651', Odisha: '674', 'West Bengal': '33',

    Goa: '832', Gujarat: '79', Maharashtra: '22', 'Madhya Pradesh': '755',
    Chhattisgarh: '771', 'Dadra and Nagar Haveli and Daman and Diu': '260',

    Assam: '361', 'Arunachal Pradesh': '360', Manipur: '385', Meghalaya: '364',
    Mizoram: '389', Nagaland: '370', Sikkim: '3592', Tripura: '381',

    /* The regions' own councils, keyed by label. */
    South: '44', North: '11', East: '33', West: '22', 'North East': '361',
};


module.exports = {
    INITIALS, STYLES, STYLE_OF, REGION_STYLE, poolFor, CODES,
    MEN, WOMEN, isFemaleName, portraitOf,
};
