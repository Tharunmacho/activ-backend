// News and chapter share buttons and crawler cards use the same published data.
const { plain: basicPlain } = require('../cms/sharePreviews');
const plain = value => basicPlain(value).replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:\d+|x[\da-f]+);/gi, entity => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity.slice(2, -1);
    const number = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
}).trim();
const photo = value => {
    const url = typeof value === 'string' ? value : value?.type !== 'video' ? value?.url : '';
    return /\.(mp4|webm|ogg|mov)(?:[?#]|$)/i.test(url || '') ? '' : url || '';
};
const firstPhoto = values => values.map(photo).find(Boolean) || '';
const paragraph = value => String(value || '').replace(/<(?:br\s*\/?|\/p|\/div|\/li)>/gi, '\n')
    .split('\n').map(plain).filter(Boolean).join('\n').slice(0, 6000);
const date = value => {
    const d = value ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }) : '';
};
const join = values => values.filter(Boolean).join(' · ');
const lines = values => values.filter(Boolean).join('\n\n');
const fields = rows => (rows || []).filter(row => !row.isHidden).map(row => join([plain(row.label), plain(row.value)])).filter(Boolean);
const visible = rows => (rows || []).filter(row => !row.isHidden);

const newsShareContent = article => {
    const title = plain(article.title) || 'ACTIV News';
    const when = plain(article.displayDate) || date(article.publishedAt);
    const where = [...new Set([article.location, article.district, article.state].map(plain).filter(Boolean))].join(', ');
    const details = [when && `Published: ${when}`, where && `Location: ${where}`, article.category && `Category: ${plain(article.category)}`, article.sourceName && `Source: ${plain(article.sourceName)}`].filter(Boolean);
    return {
        title,
        description: join([...details, plain(article.summary || article.body)]).slice(0, 700),
        text: lines([title, details.join('\n'), plain(article.summary), paragraph(article.body), ...fields(article.extraFields), article.externalUrl && `Source link: ${plain(article.externalUrl)}`]),
        image: firstPhoto([article.image, ...(article.photos || [])]),
        alt: plain(article.image?.alt) || title,
    };
};

const newsIndexContent = settings => {
    const title = [settings.heading, settings.headingHighlight].map(plain).filter(Boolean).join(' ') || 'ACTIV News';
    const description = plain(settings.description) || 'News, chapters and announcements from ACTIV.';
    return { title, description, text: lines([title, description]), image: photo(settings.heroImage), alt: plain(settings.heroImage?.alt) || title };
};

const AREA_SECTIONS = {
    about: 'About', gallery: 'Photo Gallery', leaders: 'Leadership', achievements: 'Highlights', keyAchievements: 'Key Achievements',
    events: 'Events', projects: 'Projects', policyAdvocacy: 'Policy Advocacy', consultingServices: 'Consulting Services',
    publications: 'Publications', mediaReleases: 'Media Releases', mediaCoverages: 'Media Coverages', sectorUpdates: 'Sector Update',
    newsUpdates: 'News Update', speakInMedia: 'In the Media',
};
const leaderLine = leader => join([plain(leader.name), plain(leader.designation || leader.role), plain(leader.organisation)]);
const leaderDetails = leader => lines([leaderLine(leader), paragraph(leader.bio), [leader.email && `Email: ${plain(leader.email)}`, leader.phone && `Phone: ${plain(leader.phone)}`, plain(leader.address)].filter(Boolean).join('\n')]);
const feedLine = item => join([plain(item.title), plain(item.date) || '', plain(item.location), plain(item.summary || item.body)]);
const feedDetails = item => lines([join([plain(item.title), plain(item.date), plain(item.location), plain(item.category), plain(item.sector)]), paragraph(item.summary), paragraph(item.body), plain(item.href || item.fileUrl)]);

const areaShareContent = (doc, detail = '', customSection = null) => {
    const name = plain(doc.stateName || doc.regionName || doc.label);
    const baseTitle = plain(doc.seo?.metaTitle) || `ACTIV ${name}`;
    const heading = customSection ? plain(customSection.title) : AREA_SECTIONS[detail] || '';
    const title = heading ? `${heading} | ${baseTitle}` : baseTitle;
    const summary = plain(doc.shortDescription || doc.hero?.blurb || doc.fullDescription);
    const leaders = visible(doc.leaders);
    const groups = [...visible(doc.stateRegions), ...visible(doc.districts)];
    const groupedLeaders = groups.flatMap(group => visible(group.leaders).map(leader => ({ ...leader, groupName: group.name })));
    const allLeaders = [...leaders, ...groupedLeaders];
    const items = visible(customSection?.items || doc[detail] || doc.feeds?.[detail]);
    let description;
    let content;
    if (detail === 'leaders') {
        description = join([`Leadership of ${name}`, ...allLeaders.map(leader => join([leaderLine(leader), plain(leader.groupName)])), summary]);
        content = lines([summary, ...leaders.map(leaderDetails), ...groupedLeaders.map(leader => lines([plain(leader.groupName), leaderDetails(leader)]))]);
    } else if (detail === 'about') {
        description = plain(doc.fullDescription) || summary;
        content = lines([paragraph(doc.fullDescription) || summary, plain(doc.vision?.title), paragraph(doc.vision?.text), ...fields(doc.extraFields)]);
    } else if (detail) {
        const intro = plain(customSection?.intro || customSection?.text);
        description = join([`${heading || detail} in ${name}`, intro, ...items.map(feedLine), !items.length && !intro && summary]);
        content = lines([intro || summary, paragraph(customSection?.text), ...items.map(feedDetails)]);
    } else {
        description = plain(doc.seo?.metaDescription) || join([plain(doc.hero?.tagline), summary, allLeaders.length && `Leadership: ${allLeaders.map(leaderLine).join('; ')}`]);
        content = lines([plain(doc.hero?.tagline), summary, paragraph(doc.fullDescription), plain(doc.vision?.title), paragraph(doc.vision?.text),
            ...fields(doc.hero?.facts), allLeaders.length && 'Leadership', ...allLeaders.map(leaderDetails), ...fields(doc.extraFields)]);
    }
    const image = firstPhoto([doc.seo?.ogImageUrl, doc.hero?.backgroundUrl, doc.hero?.sideImageUrl,
        ...(doc.heroCarousel || []).map(row => row.media), ...(detail === 'leaders' ? allLeaders.map(leader => leader.photoUrl) : items.map(item => item.imageUrl)),
        doc.explore?.imageUrl, ...leaders.map(leader => leader.photoUrl)]);
    return { title, description: description.slice(0, 700), text: lines([title, content]), image, alt: title };
};

module.exports = { newsShareContent, newsIndexContent, areaShareContent, AREA_SECTIONS };
