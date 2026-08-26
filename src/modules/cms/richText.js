/**
 * Reduce authored HTML to a small, safe subset.
 *
 * The About body and each bullet are stored as HTML and rendered on the public
 * site with `dangerouslySetInnerHTML`. Only a signed-in super admin can write
 * them, so this is not a route in from the open internet — but "only an admin
 * can do it" is an argument about who, not about what, and an account taken
 * over should not be able to leave a script tag on the landing page for every
 * future visitor.
 *
 * A whitelist, not a blacklist. Blacklists lose: there is always another
 * attribute, another encoding, another tag. Everything here is dropped unless
 * it is explicitly named, so an unknown tag fails closed.
 *
 * Written without a dependency because the accepted subset is tiny and fixed —
 * the formatting a toolbar with four buttons can produce. If the editor ever
 * grows tables or embeds, replace this with a real parser rather than adding
 * cases to the expressions below.
 */

/** Tags an editor may produce. Anything else has its markup removed. */
const ALLOWED_TAGS = new Set(['strong', 'b', 'em', 'i', 'u', 'br', 'p', 'a', 'ul', 'ol', 'li', 'span']);

/** Tags whose CONTENT goes too, not just their markup. */
const STRIP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template'];

/** The only attribute kept, and only on a link. */
const ALLOWED_HREF = /^(https?:\/\/|mailto:|tel:|\/|#)/i;

/**
 * Whether a link target is safe to keep.
 *
 * `javascript:` is the obvious one. The rest of the check is about what it can
 * be disguised as: whitespace and control characters inside the scheme are
 * ignored by browsers, so `java\tscript:` and `java&#09;script:` both run.
 */
const safeHref = (value) => {
    const cleaned = String(value || '')
        // Strip characters a browser ignores when reading the scheme.
        .replace(/[\s\u0000-\u001F\u007F\u00A0\u2000-\u200D\u3000\uFEFF]/g, '')
        .replace(/&#[xX]?[0-9a-fA-F]+;?/g, '');

    if (/^(javascript|data|vbscript|file):/i.test(cleaned)) return false;
    return ALLOWED_HREF.test(cleaned);
};

/**
 * Strip everything not on the whitelist.
 *
 * Returns plain text unchanged, so a field that never held markup is not
 * altered by passing through here.
 */
const sanitizeHtml = (input) => {
    let html = String(input ?? '');
    if (!html) return '';

    // 1. Tags whose content is as dangerous as their markup.
    for (const tag of STRIP_WITH_CONTENT) {
        html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), '');
        // An unclosed one would otherwise survive as a bare opening tag.
        html = html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
    }

    // 2. HTML comments — `<!--[if IE]><script>` is a real technique.
    html = html.replace(/<!--[\s\S]*?-->/g, '');

    // 3. Every remaining tag, rebuilt from nothing but what is allowed.
    html = html.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, closing, rawName, attrs) => {
        const name = rawName.toLowerCase();
        if (!ALLOWED_TAGS.has(name)) return '';
        if (closing) return `</${name}>`;

        // Only a link keeps anything, and only its destination.
        if (name === 'a') {
            const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs || '');
            const value = href ? (href[2] ?? href[3] ?? href[4] ?? '') : '';

            if (!safeHref(value)) return '<a>';

            // `noopener` because a new tab can otherwise reach back through
            // `window.opener`; `nofollow` because this is editor-supplied.
            const external = /^https?:\/\//i.test(value);
            return external
                ? `<a href="${value.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer nofollow">`
                : `<a href="${value.replace(/"/g, '&quot;')}">`;
        }

        // `<br>` is void; the rest keep their markup and lose every attribute.
        return name === 'br' ? '<br>' : `<${name}>`;
    });

    // 4. Anything left that looks like a tag but did not parse as one.
    html = html.replace(/<(?![a-zA-Z/])/g, '&lt;');

    return html.trim();
};

/** Sanitize, and give back plain text — used where markup is never wanted. */
const stripHtml = (input) =>
    sanitizeHtml(input).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

module.exports = { sanitizeHtml, stripHtml, ALLOWED_TAGS };
