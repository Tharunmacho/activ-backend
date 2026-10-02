const config = require('../../config');

// Use the configured website, never a request-supplied host. Its root page is
// the SPA shell; ref=share bypasses preview rewrites and prevents recursion.
let cached = null;
let pending = null;
const websiteShell = async() => {
    const origin = String(config.frontendUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin)) return null;
    if (cached && cached.origin === origin && cached.at > Date.now() - 60000) return cached.html;
    if (pending) return pending;
    pending = (async() => {
        try {
            const url = new URL('/', origin);
            url.searchParams.set('ref', 'share');
            const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
            if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) return null;
            const html = await response.text();
            if (!/id=["']root["']/.test(html) || !html.includes('</head>')) return null;
            cached = { origin, html, at: Date.now() };
            return html;
        } catch { return null; }
    })().finally(() => { pending = null; });
    return pending;
};

const mergePreview = (shell, preview) => {
    const head = preview.match(/<head>([\s\S]*?)<\/head>/i)?.[1] || '';
    const tags = head.match(/<(?:title|meta|link)\b[^>]*(?:>[\s\S]*?<\/title>|>)/gi) || [];
    const metadata = tags.filter((tag) => /<title|(?:og:|twitter:|fb:app_id)|name="description"|rel="canonical"/i.test(tag));
    return shell
        .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
        .replace(/<meta\b[^>]*(?:property|name)=["'](?:og:|twitter:|fb:)[^"']*["'][^>]*>/gi, '')
        .replace(/<meta\b[^>]*name=["']description["'][^>]*>/gi, '')
        .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, '')
        .replace('</head>', `${metadata.join('\n')}\n</head>`);
};

module.exports = { websiteShell, mergePreview };
