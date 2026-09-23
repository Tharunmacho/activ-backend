/**
 * The association's four legal documents, as first supplied.
 *
 * =========================================================================
 * THIS IS A SEED. IT IS NOT THE SOURCE OF TRUTH, AND NOTHING RENDERS FROM IT
 * =========================================================================
 *
 * `web_legal_documents` is the authority. This table exists for one moment: the
 * first read on a database that has never held these documents. `ensureLegalSeeded`
 * inserts only slugs that are ABSENT, so once a row exists this table is dead to
 * it — a Super Admin's edit can never be overwritten by a deploy, and no amount
 * of restarting puts the original wording back.
 *
 * It is the same arrangement `payment/membershipPlans.js` has with the
 * `membershipPlans` collection, and for the same reason: without a seed, the
 * first deploy shows a visitor a Privacy Policy page with nothing on it, because
 * the authority moved to a collection nobody had written yet.
 *
 * THE WEBSITE HAS NO COPY OF THIS TEXT. It was previously compiled into the
 * React bundle; it is not any more. Everything the public site renders comes
 * from the API, so an edit is live on the next page load.
 *
 * WORDING IS VERBATIM AND IS NOT TIDIED. These are the terms somebody agrees
 * to. An editor's improvement to a sentence is a change to an agreement, and a
 * developer's is worse — nobody asked for it.
 */

const ORG = 'Adidravidar Confederation of Trade and Industry Vision';
const SITE = 'https://activ.org.in';
const SUPPORT = 'info@activ.org.in';

/* ------------------------------------------------------------------ privacy */

const PRIVACY_SECTIONS = [
    {
        body: [
            `At ${ORG}, accessible from ${SITE}, one of our main priorities is the privacy of our visitors. This Privacy Policy document contains types of information that is collected and recorded by ${ORG} and how we use it.`,
            `If you have additional questions or require more information about our Privacy Policy, do not hesitate to contact us on ${SUPPORT}`,
            `This Privacy Policy applies only to our online activities and is valid for visitors to our website with regards to the information that they shared and/or collect in ${ORG}. This policy is not applicable to any information collected offline or via channels other than this website. Our Privacy Policy was created with the intention to maintain the privacy of every member, beneficiary and partner.`,
        ],
    },
    {
        heading: 'Consent',
        body: ['By using our website, you hereby consent to our Privacy Policy and agree to its terms.'],
    },
    {
        heading: 'Information we collect',
        body: [
            'The personal information that you are asked to provide, and the reasons why you are asked to provide it, will be made clear to you at the point we ask you to provide your personal information.',
            'If you contact us directly, we may receive additional information about you such as your name, email address, phone number, the contents of the message and/or attachments you may send us, and any other information you may choose to provide.',
            'When you register for an Account, we may ask for your contact information, including items such as name, company name, address, email address, and telephone number.',
        ],
    },
    {
        heading: 'How we use your information',
        body: ['We use the information we collect in various ways, including to:'],
        bullets: [
            'Provide, operate, and maintain our website',
            'Improve, personalize, and expand our website',
            'Understand and analyze how you use our website',
            'Develop new products, services, features, and functionality',
            'Communicate with you, either directly or through one of our partners, including for customer service, to provide you with updates and other information relating to the website, and for marketing and promotional purposes',
            'Send you emails',
            'Find and prevent fraud',
        ],
    },
    {
        heading: 'Log Files',
        body: [
            `${ORG} follows a standard procedure of using log files. These files log visitors when they visit websites. All hosting companies do this and a part of hosting services' analytics. The information collected by log files include internet protocol (IP) addresses, browser type, Internet Service Provider (ISP), date and time stamp, referring/exit pages, and possibly the number of clicks. These are not linked to any information that is personally identifiable. The purpose of the information is for analyzing trends, administering the site, tracking users' movement on the website, and gathering demographic information.`,
        ],
    },
    {
        heading: 'Cookies and Web Beacons',
        body: [
            `Like any other website, ${ORG} uses 'cookies'. These cookies are used to store information including visitors' preferences, and the pages on the website that the visitor accessed or visited. The information is used to optimize the users' experience by customizing our web page content based on visitors' browser type and/or other information.`,
        ],
    },
    {
        heading: 'Google DoubleClick DART Cookie',
        body: [
            'Google is one of a third-party vendor on our site. It also uses cookies, known as DART cookies, to serve ads to our site visitors based upon their visit to www.website.com and other sites on the internet. However, visitors may choose to decline the use of DART cookies by visiting the Google ad and content network Privacy Policy at the following URL.',
        ],
        links: [{ label: 'Google advertising policies', href: 'https://policies.google.com/technologies/ads' }],
    },
    {
        heading: 'Our Advertising Partners',
        body: [
            'Some of advertisers on our site may use cookies and web beacons. Our advertising partners are listed below. Each of our advertising partners has their own Privacy Policy for their policies on user data.',
        ],
        links: [{ label: 'Google', href: 'https://policies.google.com/technologies/ads' }],
    },
    {
        heading: 'Advertising Partners Privacy Policies',
        body: [
            `You may consult this list to find the Privacy Policy for each of the advertising partners of ${ORG}.`,
            `Third-party ad servers or ad networks uses technologies like cookies, JavaScript, or Web Beacons that are used in their respective advertisements and links that appear on ${ORG}, which are sent directly to users' browser. They automatically receive your IP address when this occurs. These technologies are used to measure the effectiveness of their advertising campaigns and/or to personalize the advertising content that you see on websites that you visit.`,
            `Note that ${ORG} has no access to or control over these cookies that are used by third-party advertisers.`,
        ],
    },
    {
        heading: 'Third Party Privacy Policies',
        body: [
            `${ORG}'s Privacy Policy does not apply to other advertisers or websites. Thus, we are advising you to consult the respective Privacy Policies of these third-party ad servers for more detailed information. It may include their practices and instructions about how to opt-out of certain options.`,
            `You can choose to disable cookies through your individual browser options. To know more detailed information about cookie management with specific web browsers, it can be found at the browsers' respective websites.`,
        ],
    },
    {
        heading: 'CCPA Privacy Rights (Do Not Sell My Personal Information)',
        body: ['Under the CCPA, among other rights, California consumers have the right to:'],
        bullets: [
            `Request that a business that collects a consumer's personal data disclose the categories and specific pieces of personal data that a business has collected about consumers.`,
            'Request that a business delete any personal data about the consumer that a business has collected.',
            `Request that a business that sells a consumer's personal data, not sell the consumer's personal data.`,
        ],
    },
    {
        heading: 'GDPR Data Protection Rights',
        body: [
            'If you make a request, we have one month to respond to you. If you would like to exercise any of these rights, please contact us.',
            'We would like to make sure you are fully aware of all of your data protection rights. Every user is entitled to the following:',
        ],
        bullets: [
            'The right to access — You have the right to request copies of your personal data. We may charge you a small fee for this service.',
            'The right to rectification — You have the right to request that we correct any information you believe is inaccurate. You also have the right to request that we complete the information you believe is incomplete.',
            'The right to erasure — You have the right to request that we erase your personal data, under certain conditions.',
            'The right to restrict processing — You have the right to request that we restrict the processing of your personal data, under certain conditions.',
            'The right to object to processing — You have the right to object to our processing of your personal data, under certain conditions.',
            'The right to data portability — You have the right to request that we transfer the data that we have collected to another organization, or directly to you, under certain conditions.',
        ],
    },
    {
        heading: "Children's Information",
        body: [
            'Another part of our priority is adding protection for children while using the internet. We encourage parents and guardians to observe, participate in, and/or monitor and guide their online activity.',
            `${ORG} does not knowingly collect any Personal Identifiable Information from children under the age of 13. If you think that your child provided this kind of information on our website, we strongly encourage you to contact us immediately and we will do our best efforts to promptly remove such information from our records.`,
        ],
    },
    {
        heading: 'About this site',
        body: [
            'This is a site to share information about the activities of the ACTIV organization.',
            `Any information you provide while visiting the ${SITE} website will be used only by Adidravidar Confederation of Trade and Industrial Vision (ACTIV). ACTIV will not share any of your information with any other organization, including its business partners, unless you explicitly agree.`,
            'This website may contain links to third-party websites. ACTIV is not responsible for the privacy practices of any linked site or any link contained in a linked site.',
        ],
    },
];

/* -------------------------------------------------------------------- terms */

const TERMS_SECTIONS = [
    {
        body: [
            `Welcome to ${ORG} (ACTIV)!`,
            `These terms and conditions outline the rules and regulations for the use of ${ORG}'s Website, located at ${SITE}.`,
            `By accessing this website we assume you accept these terms and conditions. Do not continue to use ${ORG} if you do not agree to take all of the terms and conditions stated on this page.`,
            `The following terminology applies to these Terms and Conditions, Privacy Statement and Disclaimer Notice and all Agreements: "Client", "You" and "Your" refers to you, the person log on this website and compliant to the Company's terms and conditions. "The Company", "Ourselves", "We", "Our" and "Us", refers to our Company. "Party", "Parties", or "Us", refers to both the Client and ourselves. All terms refer to the offer, acceptance and consideration of payment necessary to undertake the process of our assistance to the Client in the most appropriate manner for the express purpose of meeting the Client's needs in respect of provision of the Company's stated services, in accordance with and subject to, prevailing law of Netherlands. Any use of the above terminology or other words in the singular, plural, capitalization and/or he/she or they, are taken as interchangeable and therefore as referring to same.`,
        ],
    },
    {
        heading: 'Cookies',
        body: [
            `We employ the use of cookies. By accessing ${ORG}, you agreed to use cookies in agreement with the ${ORG}'s Privacy Policy.`,
            `Most interactive websites use cookies to let us retrieve the user's details for each visit. Cookies are used by our website to enable the functionality of certain areas to make it easier for people visiting our website. Some of our affiliate/advertising partners may also use cookies.`,
        ],
    },
    {
        heading: 'License',
        body: [
            `Unless otherwise stated, ${ORG} and/or its licensors own the intellectual property rights for all material on ${ORG}. All intellectual property rights are reserved. You may access this from ${ORG} for your own personal use subjected to restrictions set in these terms and conditions.`,
            'You must not:',
        ],
        bullets: [
            `Republish material from ${ORG}`,
            `Sell, rent or sub-license material from ${ORG}`,
            `Reproduce, duplicate or copy material from ${ORG}`,
            `Redistribute content from ${ORG}`,
        ],
    },
    {
        heading: 'Comments',
        body: [
            'This Agreement shall begin on the date hereof. Our Terms and Conditions were created with the intention of helping each other.',
            `Parts of this website offer an opportunity for users to post and exchange opinions and information in certain areas of the website. ${ORG} does not filter, edit, publish or review Comments prior to their presence on the website. Comments do not reflect the views and opinions of ${ORG}, its agents and/or affiliates. Comments reflect the views and opinions of the person who post their views and opinions. To the extent permitted by applicable laws, ${ORG} shall not be liable for the Comments or for any liability, damages or expenses caused and/or suffered as a result of any use of and/or posting of and/or appearance of the Comments on this website.`,
            `${ORG} reserves the right to monitor all Comments and to remove any Comments which can be considered inappropriate, offensive or causes breach of these Terms and Conditions.`,
            'You warrant and represent that:',
        ],
        bullets: [
            'You are entitled to post the Comments on our website and have all necessary licenses and consents to do so;',
            'The Comments do not invade any intellectual property right, including without limitation copyright, patent or trademark of any third party;',
            'The Comments do not contain any defamatory, libelous, offensive, indecent or otherwise unlawful material which is an invasion of privacy;',
            'The Comments will not be used to solicit or promote business or custom or present commercial activities or unlawful activity.',
        ],
    },
    {
        heading: 'Hyperlinking to our Content',
        body: [
            `You hereby grant ${ORG} a non-exclusive license to use, reproduce, edit and authorize others to use, reproduce and edit any of your Comments in any and all forms, formats or media.`,
            'The following organizations may link to our Website without prior written approval:',
        ],
        bullets: [
            'Government agencies;',
            'Search engines;',
            'News organizations;',
            'Online directory distributors may link to our Website in the same manner as they hyperlink to the Websites of other listed businesses; and',
            'System wide Accredited Businesses except soliciting non-profit organizations, charity shopping malls, and charity fundraising groups which may not hyperlink to our Web site.',
        ],
    },
    {
        body: [
            `These organizations may link to our home page, to publications or to other Website information so long as the link: (a) is not in any way deceptive; (b) does not falsely imply sponsorship, endorsement or approval of the linking party and its products and/or services; and (c) fits within the context of the linking party's site.`,
            'We may consider and approve other link requests from the following types of organizations:',
        ],
        bullets: [
            'commonly-known consumer and/or business information sources;',
            'dot.com community sites;',
            'associations or other groups representing charities;',
            'online directory distributors;',
            'internet portals;',
            'accounting, law and consulting firms; and',
            'educational institutions and trade associations.',
        ],
    },
    {
        body: [
            `We will approve link requests from these organizations if we decide that: (a) the link would not make us look unfavorably to ourselves or to our accredited businesses; (b) the organization does not have any negative records with us; (c) the benefit to us from the visibility of the hyperlink compensates the absence of ${ORG}; and (d) the link is in the context of general resource information.`,
            `These organizations may link to our home page so long as the link: (a) is not in any way deceptive; (b) does not falsely imply sponsorship, endorsement or approval of the linking party and its products or services; and (c) fits within the context of the linking party's site.`,
            `If you are one of the organizations listed in paragraph 2 above and are interested in linking to our website, you must inform us by sending an e-mail to ${ORG}. Please include your name, your organization name, contact information as well as the URL of your site, a list of any URLs from which you intend to link to our Website, and a list of the URLs on our site to which you would like to link. Wait 2-3 weeks for a response.`,
            'Approved organizations may hyperlink to our Website as follows:',
        ],
        bullets: [
            'By use of our corporate name; or',
            'By use of the uniform resource locator being linked to; or',
            `By use of any other description of our Website being linked to that makes sense within the context and format of content on the linking party's site.`,
        ],
    },
    {
        body: [`No use of ${ORG}'s logo or other artwork will be allowed for linking absent a trademark license agreement.`],
    },
    {
        heading: 'iFrames',
        body: [
            'Without prior approval and written permission, you may not create frames around our Webpages that alter in any way the visual presentation or appearance of our Website.',
        ],
    },
    {
        heading: 'Content Liability',
        body: [
            'We shall not be hold responsible for any content that appears on your Website. You agree to protect and defend us against all claims that is rising on your Website. No link(s) should appear on any Website that may be interpreted as libelous, obscene or criminal, or which infringes, otherwise violates, or advocates the infringement or other violation of, any third party rights.',
        ],
    },
    {
        heading: 'Your Privacy',
        body: ['Please read our Privacy Policy.'],
        links: [{ label: 'Privacy Policy', href: '/privacy-policy' }],
    },
    {
        heading: 'Reservation of Rights',
        body: [
            `We reserve the right to request that you remove all links or any particular link to our Website. You approve to immediately remove all links to our Website upon request. We also reserve the right to amen these terms and conditions and it's linking policy at any time. By continuously linking to our Website, you agree to be bound to and follow these linking terms and conditions.`,
        ],
    },
    {
        heading: 'Removal of links from our website',
        body: [
            'If you find any link on our Website that is offensive for any reason, you are free to contact and inform us any moment. We will consider requests to remove links but we are not obligated to or so or to respond to you directly.',
            'We do not ensure that the information on this website is correct, we do not warrant its completeness or accuracy; nor do we promise to ensure that the website remains available or that the material on the website is kept up to date.',
        ],
    },
    {
        heading: 'Disclaimer',
        body: [
            'To the maximum extent permitted by applicable law, we exclude all representations, warranties and conditions relating to our website and the use of this website. Nothing in this disclaimer will:',
        ],
        bullets: [
            'limit or exclude our or your liability for death or personal injury;',
            'limit or exclude our or your liability for fraud or fraudulent misrepresentation;',
            'limit any of our or your liabilities in any way that is not permitted under applicable law; or',
            'exclude any of our or your liabilities that may not be excluded under applicable law.',
        ],
    },
    {
        body: [
            'The limitations and prohibitions of liability set in this Section and elsewhere in this disclaimer: (a) are subject to the preceding paragraph; and (b) govern all liabilities arising under the disclaimer, including liabilities arising in contract, in tort and for breach of statutory duty.',
            'As long as the website and the information and services on the website are provided free of charge, we will not be liable for any loss or damage of any nature.',
        ],
    },
];

/* ------------------------------------------------------------------- refund */

/**
 * The membership half and the events half, in that order.
 *
 * Shared by the Return Policy and the Cancellation notice because the
 * association publishes the same text under both names. They are seeded as TWO
 * ROWS, not one aliased to two URLs — the moment an editor changes one of them
 * they are different documents, and a shared row would silently change the
 * other page too.
 */
const REFUND_SECTIONS = [
    {
        body: [
            'The Adidravidar Confederation of Trade and Industrial Vision (ACTIV) reserves the right to refuse/cancel a membership in the ACTIV.',
            'If ACTIV refuses a new or renewing membership, registrants will be offered a refund.',
        ],
    },
    {
        heading: 'Membership Cancellation by Participant',
        bullets: [
            'Each payment for membership contains a non-refundable 10% of Membership Fee as administration fee.',
            'New Membership cancellations (Initial memberships) received within 30 days of registration are eligible to receive a full refund less the 10% of Membership Fee as administration fee.',
            'Membership renewals do not qualify for refund.',
            'Cancellations received after the stated deadline will not be eligible for a refund.',
            'Cancellations will be accepted via postal or e-mail.',
            'All benefits and incentives received by participant must be cancelled/returned to the ACTIV.',
            'All refund requests must be made by the attendee or credit card holder.',
            'Refund requests must include the name of the attendee and/or transaction number.',
            'Refunds will be credited back to the original credit card used for payment.',
        ],
        body: [
            'These above policies apply to all ACTIV memberships unless otherwise noted in the corresponding program materials. Please read all individual program information thoroughly.',
        ],
    },
    {
        heading: 'ACTIV Event Refund / Cancellation Policy',
        body: ['Event Cancellation by Sponsor'],
        bullets: [
            'The Adidravidar Confederation of Trade and Industrial Vision (ACTIV) reserves the right to cancel an event due to low enrolment or other circumstances which would make the event non-viable.',
            'If ACTIV cancels an event, registrants will be offered a full refund.',
            'Should circumstances arise that result in the postponement of an event, registrants will have the option to either receive a full refund or transfer registration to the same event at the new, future date.',
        ],
    },
    {
        heading: 'Registration Cancellation by Participant',
        bullets: [
            'Refunds will not be available for registrants who choose not to attend an event.',
            'The fee is non-refundable. However, change in nomination acceptable.',
            'All Nomination requests must be made by the Member, Guest Applicant, attendee or credit card holder.',
            'Nomination requests must include the name of the attendee and/or transaction number.',
        ],
        body: [
            'These above policies apply to all ACTIV Events unless otherwise noted in the corresponding event materials. Please read all individual event information thoroughly.',
        ],
    },
];

/**
 * `order` is the footer's order, and it is spaced by ten.
 *
 * So an editor inserting a document between two existing ones has nine numbers
 * to choose from without renumbering anything. Consecutive integers force a
 * rewrite of every row after the insertion point, which is a migration where a
 * number would do.
 */
const LEGAL_SEED = [
    {
        slug: 'privacy-policy',
        title: 'Privacy Policy',
        lede: 'How ACTIV collects, uses and protects the information you share with us.',
        footerLabel: 'Privacy Policy',
        order: 10,
        sections: PRIVACY_SECTIONS,
    },
    {
        slug: 'terms-and-conditions',
        title: 'Terms & Conditions',
        lede: 'The rules and regulations for the use of the ACTIV website.',
        footerLabel: 'Terms & Conditions',
        order: 20,
        sections: TERMS_SECTIONS,
    },
    {
        slug: 'refund-policy',
        title: 'Return Policy',
        lede: 'Money Return Policy — memberships and event registrations.',
        footerLabel: 'Return Policy',
        order: 30,
        sections: REFUND_SECTIONS,
    },
    {
        slug: 'cancellation-policy',
        title: 'Cancellation',
        lede: 'Cancelling a membership or an event registration.',
        footerLabel: 'Cancellation',
        order: 40,
        sections: REFUND_SECTIONS,
    },
];

module.exports = { LEGAL_SEED };
