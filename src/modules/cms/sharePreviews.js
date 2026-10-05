const { imagePath } = require('../share/sitePreviewImages');
const ApiError = require('../../core/utils/ApiError');

const STATIC_PAGES = [
    ['/', 'Home', 'ACTIV - Trade and Industrial Vision', 'Connecting entrepreneurs, students and aspiring business owners through ACTIV membership, events and opportunities.'],
    ['/onboarding', 'Home (onboarding)', 'ACTIV - Trade and Industrial Vision', 'Discover ACTIV membership, events and opportunities.'],
    ['/about', 'About us', 'About ACTIV', 'Learn about ACTIV, our mission and our community of entrepreneurs.'],
    ['/membership', 'Membership', 'ACTIV Membership', 'Explore ACTIV membership plans, benefits and how to join.'],
    ['/events', 'Events', 'ACTIV Events', 'Discover upcoming ACTIV events, programmes and conferences.'],
    ['/gallery', 'Gallery', 'ACTIV Gallery', 'Photographs and highlights from ACTIV events and our community.'],
    ['/news', 'News', 'ACTIV News', 'News, chapters and announcements from ACTIV.'],
    ['/schemes', 'Schemes', 'ACTIV Government Schemes', 'Explore government schemes and opportunities for entrepreneurs.'],
    ['/schemes/central', 'Central schemes', 'ACTIV Central Government Schemes', 'Explore central government schemes and opportunities for entrepreneurs.'],
    ['/schemes/state', 'State schemes', 'ACTIV State Government Schemes', 'Explore state government schemes and opportunities for entrepreneurs.'],
    ['/contact', 'Contact', 'Contact ACTIV', 'Contact ACTIV for membership, events and support.'],
    ['/donate', 'Donate', 'Support ACTIV', 'Support ACTIV and its work with entrepreneurs and the community.'],
    ['/login', 'Member login', 'Sign in to ACTIV', 'Sign in to your ACTIV membership account.'],
    ['/register', 'Member registration', 'Join ACTIV', 'Create your ACTIV account and apply for membership.'],
    ['/forgot-password', 'Forgot password', 'Recover your ACTIV account', 'Recover access to your ACTIV membership account.'],
    ['/privacy-policy', 'Privacy policy', 'ACTIV Privacy Policy', 'How ACTIV handles and protects your information.'],
    ['/terms-and-conditions', 'Terms and conditions', 'ACTIV Terms and Conditions', 'Terms and conditions for ACTIV services.'],
    ['/refund-policy', 'Refund policy', 'ACTIV Refund Policy', 'Refund information for ACTIV memberships and bookings.'],
    ['/cancellation-policy', 'Cancellation policy', 'ACTIV Cancellation Policy', 'Cancellation information for ACTIV services and bookings.'],
].map(([path, label, title, description]) => ({ path, label, title, description, group: 'Main pages' }));

const plain = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
const staticPage = path => STATIC_PAGES.find(page => page.path === path);
// Main navigation routes. Published zone/state pages come from the region map;
// event, article, gallery and chapter sections keep automatic cards.
const EDITOR_PATHS = new Set(['/', '/about', '/membership', '/events', '/gallery', '/news', '/schemes', '/schemes/central', '/schemes/state']);
const EDITOR_PAGES = STATIC_PAGES.filter(page => EDITOR_PATHS.has(page.path));
// Onboarding remains another entry point to Home. Scheme tiers are distinct pages.
const PREVIEW_ALIASES = { '/onboarding': '/' };
const FEED_TYPES = ['about', 'leaders', 'keyAchievements', 'sectorUpdates', 'newsUpdates', 'speakInMedia', 'achievements', 'events', 'projects', 'policyAdvocacy', 'consultingServices', 'publications', 'mediaReleases', 'mediaCoverages', 'gallery'];
const feedTypes = FEED_TYPES.join('|');
const dynamicPath = new RegExp(`^/(?:(?:events/[^/]+(?:/book)?)|(?:gallery/[^/]+(?:/photo/\\d+)?)|(?:news/[^/]+)|(?:schemes/(?:view|state)/[^/]+)|(?:(?:states|regions)/[^/]+(?:/(?:${feedTypes}|section-[^/]+))?)|(?:legal/[^/]+))$`);

// Only public marketing routes may have a card. Account, payment, reset tokens
// and administrator pages must never expose their state to crawlers.
const normalizePath = raw => {
    if (typeof raw !== 'string' || raw.length > 400 || !raw.startsWith('/') || raw.startsWith('//')) return null;
    let path;
    try { path = decodeURIComponent(raw.split(/[?#]/, 1)[0]); } catch { return null; }
    if (/[\\<>\x00-\x20]/.test(path) || path.includes('//') || path.split('/').some(part => ['.', '..', '__proto__', 'constructor', 'prototype'].includes(part))) return null;
    path = path.replace(/\/+$/, '') || '/';
    path = PREVIEW_ALIASES[path] || path;
    return staticPage(path) || dynamicPath.test(path) ? path : null;
};

const defaultImage = path => ({
    url: imagePath('activ-conference'),
    type: 'image', alt: 'ACTIV conference and community gathering',
    fit: 'contain', position: 'center',
});

const cleanImage = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw ApiError.badRequest('Choose a preview image');
    if (value.type && value.type !== 'image') throw ApiError.badRequest('Social previews require an image');
    const url = typeof value.url === 'string' ? value.url.trim() : '';
    if (url && (url.length > 2000 || /[<>\x00-\x20]/.test(url) || (!/^https?:\/\//i.test(url) && !/^\/(?!\/)/.test(url)))) throw ApiError.badRequest('Use an uploaded image or an HTTP(S) image URL');
    if (/\.(mp4|webm|mov|m4v|ogg|svg)(?:[?#]|$)/i.test(url)) throw ApiError.badRequest('Use a JPEG, PNG, WebP or GIF image');
    if (/^https?:/i.test(url)) {
        try { const parsed = new URL(url); if (parsed.username || parsed.password) throw new Error(); }
        catch { throw ApiError.badRequest('Invalid image URL'); }
    }
    return { url, type: 'image', alt: plain(value.alt).slice(0, 250), fit: value.fit === 'contain' ? 'contain' : 'cover', position: ['center', 'top', 'bottom', 'left', 'right'].includes(value.position) ? value.position : 'center' };
};

const cleanPreview = payload => {
    const path = normalizePath(payload?.path);
    if (!path) throw ApiError.badRequest('Choose a public website route');
    const result = { path };
    for (const [key, length] of [['title', 200], ['description', 700]]) {
        if (Object.hasOwn(payload, key)) {
            if (typeof payload[key] !== 'string') throw ApiError.badRequest(`Invalid ${key}`);
            result[key] = plain(payload[key]).slice(0, length);
        }
    }
    if (Object.hasOwn(payload, 'image')) result.image = cleanImage(payload.image);
    return result;
};

module.exports = { STATIC_PAGES, EDITOR_PAGES, FEED_TYPES, plain, staticPage, normalizePath, defaultImage, cleanPreview };
