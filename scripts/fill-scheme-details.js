/**
 * Fills in the detail-page fields for the real government schemes already in
 * `web_schemes`: the full description, benefits, how to apply (one step per
 * line), documents required and eligibility.
 *
 * Only the five real schemes are touched, matched by slug. The association's
 * own entries (the ACTIV skills programme, the district chapter schemes) and
 * the Karnataka placeholder are left alone — their rules are the association's
 * to write, not something to guess at.
 *
 * Government limits and rates change; every scheme also gets a "Please note"
 * row telling the reader to confirm the current figures on the official site.
 *
 * Only fields that are EMPTY are filled, so anything an editor has already
 * written in the CMS is kept. `--force` overwrites.
 *
 *   node scripts/fill-scheme-details.js            # dry run
 *   node scripts/fill-scheme-details.js --confirm  # apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

const NOTE = {
    label: 'Please note',
    value: 'Limits, rates and eligibility are set by the government and are revised from time to time. Confirm the current figures on the official website before you apply.',
};

const DETAILS = {
    'pm-employment-generation-programme': {
        category: 'Subsidy',
        applyUrl: 'https://www.kviconline.gov.in/pmegpeportal/pmegphome/index.jsp',
        eligibility: 'Any individual aged 18 or over, for a NEW micro enterprise. For projects above ₹10 lakh in manufacturing or ₹5 lakh in services, the applicant must have passed Class VIII. Existing units, and units that have already received a government subsidy, are not eligible.',
        body: 'The Prime Minister’s Employment Generation Programme (PMEGP) helps people set up a new micro enterprise by paying part of the project cost as a one-time subsidy (called margin money). The rest of the project is financed as a bank loan.\n\nIt is run by the Ministry of MSME through the Khadi and Village Industries Commission (KVIC), with the State Khadi and Village Industries Boards and the District Industries Centres as the implementing agencies.',
        benefits: 'Maximum project cost: ₹50 lakh for manufacturing units and ₹20 lakh for service units.\n\nSubsidy on the project cost: General category — 15% in urban areas and 25% in rural areas. Special category (SC, ST, OBC, minorities, women, ex-servicemen, persons with disabilities, and applicants from the North-East, hill, border and aspirational districts) — 25% in urban areas and 35% in rural areas.\n\nYour own contribution: 10% of the project cost for the general category, 5% for the special category. The balance is a bank loan.',
        howToApply: 'Register and apply online on the PMEGP e-portal (use “Click to apply”), choosing KVIC, KVIB or DIC as your implementing agency\nUpload your project report and documents and submit the application\nAttend the interview held by the district-level task force committee\nOnce recommended, the application goes to your chosen bank for loan sanction\nComplete the mandatory Entrepreneurship Development Programme (EDP) training\nThe bank releases the loan and the subsidy is credited to your loan account',
        documentsRequired: [
            'Aadhaar card',
            'PAN card',
            'Detailed project report',
            'Passport-size photograph',
            'Educational qualification certificate',
            'Caste or special-category certificate (if applicable)',
            'Rural area certificate (for the rural subsidy rate)',
            'EDP training certificate',
        ],
    },

    'credit-guarantee-fund-for-micro-and-small-enterprises': {
        category: 'Credit',
        summary: 'Collateral-free loans for micro and small enterprises: the Credit Guarantee Fund Trust (CGTMSE) guarantees the bank’s loan, so you do not have to pledge property or bring a third-party guarantor.',
        eligibility: 'New and existing micro and small enterprises in manufacturing, services and retail trade, taking a loan from a bank or financial institution that is a member lending institution of CGTMSE. Udyam registration is required.',
        body: 'Under the Credit Guarantee Scheme, CGTMSE — set up by the Ministry of MSME and SIDBI — guarantees a large part of a loan given to a micro or small enterprise. Because the loan is guaranteed, the bank lends without collateral security and without a third-party guarantee.\n\nYou do not apply to CGTMSE yourself. You apply for the loan at a bank, and the bank covers the loan under the scheme.',
        benefits: 'Loans without collateral security or third-party guarantee, for term loans and working capital.\n\nThe guarantee covers most of the loan — a higher percentage for micro-enterprise loans and for enterprises owned by women or SC/ST entrepreneurs.\n\nThe annual guarantee fee is paid by the bank and may be passed on to the borrower, as agreed with the bank.',
        howToApply: 'Get your Udyam registration if you do not have one (udyamregistration.gov.in)\nApproach a bank or financial institution that is a CGTMSE member lending institution\nApply for the loan with your project report and documents, and ask for the loan to be covered under CGTMSE\nThe bank appraises the loan and applies to CGTMSE for the guarantee\nOnce approved, the loan is sanctioned without collateral',
        documentsRequired: [
            'Udyam registration certificate',
            'Aadhaar and PAN of the proprietor, partners or directors',
            'Business address proof',
            'Project report or business plan',
            'Bank statements (last 6–12 months)',
            'Financial statements and income-tax returns (for existing units)',
        ],
    },

    'stand-up-india': {
        category: 'Credit',
        eligibility: 'SC or ST entrepreneurs and women entrepreneurs aged 18 or over, setting up a greenfield (first-time) enterprise in manufacturing, services, trading or activities allied to agriculture. In a company or firm, at least 51% of the shareholding must be held by an SC/ST or woman entrepreneur. The borrower must not be in default with any bank.',
        body: 'Stand-Up India helps SC, ST and women entrepreneurs start a new enterprise with a bank loan. Every scheduled commercial bank branch is expected to lend to at least one SC or ST borrower and at least one woman borrower under the scheme.\n\nThe loan is a composite loan — it can cover both the term loan and the working capital the new enterprise needs.',
        benefits: 'Bank loans from ₹10 lakh up to ₹1 crore for a new enterprise.\n\nThe loan can cover up to 85% of the project cost, including working capital.\n\nRepayment over up to 7 years, with a moratorium of up to 18 months.',
        howToApply: 'Register on the Stand-Up Mitra portal (use “Click to apply”), or go directly to a bank branch or the Lead District Manager\nFill in your details and your business idea — the portal can connect you with training and handholding support\nSubmit the loan application to the bank with your project report and documents\nThe bank appraises the proposal and sanctions the loan',
        documentsRequired: [
            'Identity proof (Aadhaar, voter ID or passport)',
            'Address proof',
            'Caste certificate (for SC/ST applicants)',
            'PAN card',
            'Project report',
            'Business address proof (rent agreement or property papers)',
            'Partnership deed or memorandum of association (for firms and companies)',
            'Bank statements',
        ],
    },

    'new-entrepreneur-cum-enterprise-development-scheme': {
        category: 'Subsidy',
        applyUrl: 'https://www.msmeonline.tn.gov.in/needs/',
        eligibility: 'First-generation entrepreneurs in Tamil Nadu with a degree, diploma, ITI or vocational training qualification, aged 21 to 45 (up to 55 for special categories), setting up a new manufacturing or service enterprise.',
        body: 'The New Entrepreneur-cum-Enterprise Development Scheme (NEEDS) of the Government of Tamil Nadu helps educated first-generation entrepreneurs set up a new enterprise, with entrepreneurship training, a capital subsidy and an interest subvention on the bank loan.\n\nIt is run through the District Industries Centres, with training by the Entrepreneurship Development and Innovation Institute (EDII), Tamil Nadu.',
        benefits: 'Capital subsidy of 25% of the project cost, up to ₹75 lakh.\n\nInterest subvention of 3% on the bank loan.\n\nEntrepreneurship development training before the unit is set up.',
        howToApply: 'Apply online on the Tamil Nadu MSME portal (use “Click to apply”) with your project details\nAttend the interview and selection at your District Industries Centre\nComplete the entrepreneurship development training\nThe application is sent to the bank for loan sanction\nThe subsidy is released to the bank once the unit is set up',
        documentsRequired: [
            'Aadhaar card',
            'Educational qualification certificate',
            'Community certificate (for special categories)',
            'Detailed project report',
            'Passport-size photograph',
            'Proof of residence in Tamil Nadu',
        ],
    },

    'tamil-nadu-msme-capital-subsidy': {
        category: 'Subsidy',
        applyUrl: 'https://www.msmeonline.tn.gov.in/',
        body: 'The Government of Tamil Nadu gives a capital subsidy on the plant and machinery of eligible micro and small manufacturing units, with a higher rate for units in the state’s industrially backward blocks.\n\nApplications are made online on the Tamil Nadu MSME portal and processed by the District Industries Centre.',
        howToApply: 'Register your unit with Udyam registration\nApply online on the Tamil Nadu MSME portal (use “Click to apply”) after the unit starts production\nUpload the machinery invoices and documents asked for\nThe District Industries Centre inspects the unit and processes the claim',
        documentsRequired: [
            'Udyam registration certificate',
            'Invoices for plant and machinery',
            'Proof of commencement of production',
            'Bank account details',
            'Aadhaar and PAN of the proprietor or partners',
        ],
    },
};

(async () => {
    const confirm = process.argv.includes('--confirm');
    const force = process.argv.includes('--force');
    await mongoose.connect(process.env.MONGODB_URI);
    const { Scheme } = require('../src/modules/cms/cms.models');

    const empty = (v) => v === undefined || v === null || v === ''
        || (Array.isArray(v) && v.length === 0);

    for (const [slug, fields] of Object.entries(DETAILS)) {
        const doc = await Scheme.findOne({ slug });
        if (!doc) { console.log(`- ${slug}: not in the database, skipped`); continue; }

        const set = {};
        Object.entries(fields).forEach(([k, v]) => {
            /* Eligibility, summary and apply links already hold a short
               version; they are replaced by the fuller one unless an editor
               has since changed them from the seeded text. */
            if (force || empty(doc[k]) || ['eligibility', 'summary', 'applyUrl'].includes(k)) set[k] = v;
        });
        const extras = (doc.extraFields || []).map((r) => ({ label: r.label, value: r.value }));
        if (!extras.some((r) => r.label === NOTE.label)) set.extraFields = [...extras, NOTE];

        console.log(`- ${slug}: ${Object.keys(set).join(', ') || 'nothing to change'}`);
        if (confirm && Object.keys(set).length) {
            await Scheme.updateOne({ _id: doc._id }, { $set: { ...set, editedBy: { email: 'fill-scheme-details script', at: new Date() } } });
        }
    }

    console.log(confirm ? 'Saved.' : 'Dry run. Re-run with --confirm to apply.');
    process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
