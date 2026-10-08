const crypto = require('crypto');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A 302 to a custom scheme can be blocked after Facebook's consent redirects.
// Keep a real browser page with a user-activated Android intent as a fallback.
function sendOAuthReturn(req, res, target) {
    if (!String(target).startsWith('activ://auth/social?')) return res.redirect(target);
    const nonce = crypto.randomBytes(16).toString('base64');
    const android = /Android/i.test(String(req.headers['user-agent'] || ''));
    const open = android ? `intent://${target.slice('activ://'.length)}#Intent;scheme=activ;package=in.activ.membership;end` : target;
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
    return res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Return to ACTIV</title>
      <style nonce="${nonce}">body{margin:0;background:#f6f3fb;color:#21113f;font:18px/1.6 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{max-width:420px;margin:24px;padding:32px;background:white;border:1px solid #e6ddf3;border-radius:24px;box-shadow:0 12px 45px #28134f12}h1{font-size:28px;line-height:1.2}.brand{font-weight:800;letter-spacing:3px;color:#572994}.button{display:block;text-align:center;background:#572994;color:white;text-decoration:none;padding:14px;border-radius:12px;font-weight:700}.note{font-size:14px;color:#716880}</style></head><body><main class="card"><div class="brand">ACTIV</div><h1>Return to the ACTIV app</h1><p>Open ACTIV to finish signing in. If the app did not open automatically, tap below.</p><a class="button" href="${escape(open)}">Open ACTIV</a><p class="note">If this sign-in has expired, start again from the app’s login screen. Keep the browser window open until ACTIV opens.</p></main>
      <script nonce="${nonce}">setTimeout(function(){location.href=${JSON.stringify(target).replace(/</g, '\\u003c')};},250);</script></body></html>`);
}
module.exports = sendOAuthReturn;
