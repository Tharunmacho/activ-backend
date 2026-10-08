/**
 * THE MEMBERSHIP JOURNEY, on all three channels — account, application, each
 * tier's approval, the decision, payment, activation, renewal — and the alert
 * an admin gets when a file lands in their region.
 *
 * Built to the same standard as the event bookings in `notificationTemplates`:
 * every value comes from the live record at the moment of sending (the
 * applicant's own region office, each tier's actual verdict, the plan and price
 * `membershipplan.service` resolves for THEIR business), the email carries a
 * ticket-style highlight and a Details card, and WhatsApp goes out on a
 * dedicated, sectioned Meta template with the ACTIV logo as its image header —
 * falling back through the older approved templates while a new one is in Meta
 * review, so a member always hears something.
 *
 * WHAT THE REVIEW MODEL LETS THESE MESSAGES SAY (CLAUDE.md, "three verdicts, one
 * outcome"): the Block, District and State admins review at once; only the
 * State's approval enrols. So a Block or District approval is announced as an
 * ENDORSEMENT ("your Block Admin approved — the State Admin gives the final
 * decision"), never as the outcome, and a Block or District OBJECTION is not
 * announced to the applicant at all: it is advice to the State, who can and does
 * approve over one, and telling somebody they were "not approved" ahead of a
 * decision that may yet go their way is a false message.
 *
 * `build(helpers)` rather than top-level requires, because the helpers live in
 * `notificationTemplates`, which requires this file.
 */
module.exports = (h) => {
    const { appUrl, oneLine, clause, esc, orDash, ORG_SIGNATURE, DEFAULT_WHATSAPP_POSTER, tplOn, waLines, TPL } = h;

    /* ================================================================ shared */

    /** "Dear Tharun" — the full name when we have it, first name otherwise. */
    const greet = (ctx = {}) => oneLine(ctx.name || ctx.firstName, 60) || 'Member';

    // Every membership message uses the central office, including regional reviews.
    const contact = require('./membershipContact');
    const office = () => [contact.name, contact.phone, contact.email];

    const regionOf = (ctx = {}) => ctx.regionLabel
        || [ctx.block, ctx.district, ctx.state].filter(Boolean).join(', ');

    /**
     * The applicant's region as three separate answers. `ctx.region` is the
     * APPLICANT's (set by the sender); the top-level trio is the recipient's,
     * which on an admin alert is the admin — so the region object wins.
     */
    const regionParts = (ctx = {}) => {
        const r = ctx.region || {};
        return {
            block: oneLine(r.block || ctx.block, 60),
            district: oneLine(r.district || ctx.district, 60),
            state: oneLine(r.state || ctx.state, 60)
        };
    };
    const regionFacts = (ctx) => {
        const p = regionParts(ctx);
        return [
            { label: 'Block', value: p.block },
            { label: 'District', value: p.district },
            { label: 'State', value: p.state }
        ];
    };
    /** WhatsApp lines, one per level; an outside-India place falls back to one line. */
    const regionLines = (ctx) => {
        const p = regionParts(ctx);
        if (!p.block && !p.district && !p.state) return [['📍', regionOf(ctx) ? `Place: ${regionOf(ctx)}` : '']];
        return [['🏘', p.block ? `Block: ${p.block}` : ''], ['🏙', p.district ? `District: ${p.district}` : ''],
            ['🗺', p.state ? `State: ${p.state}` : '']];
    };
    const regionSlots = (ctx) => {
        const p = regionParts(ctx);
        return [orDash(p.block, 'Not given'), orDash(p.district, 'Not given'), orDash(p.state, regionOf(ctx) || 'Not given')];
    };
    /** v2 first, then the v1 that prints the region on one line, then `last`. */
    const chain2 = (v2, v2Params, v1, v1Params, last) => chain(v2, v2Params, chain(v1, v1Params, last));

    /** "Business membership · Sri Lakshmi Enterprises", "Student membership", "Aspirant membership". */
    const applyingAs = (ctx = {}) => [ctx.memberTypeLabel, ctx.businessName].filter(Boolean).join(' · ');

    /** The logo, as the image header every membership template carries. */
    const header = () => DEFAULT_WHATSAPP_POSTER();

    /**
     * A dedicated template, then its older approved stand-in with the same
     * meaning squeezed into fewer words. Walked by `notification.service`.
     */
    const chain = (name, params, fallback) => (tplOn(name)
        ? { template: name, params, headerImage: header(), fallback }
        : fallback);

    /* ------------------------------------------------------ review progress */

    const STATUS_STYLE = {
        done: { fg: '#047857', bg: '#d1fae5', mark: '&#10003;' },
        now: { fg: '#b45309', bg: '#fef3c7', mark: '&#9679;' },
        next: { fg: '#94a3b8', bg: '#f1f5f9', mark: '&#9675;' }
    };

    /**
     * The whole journey as one card: submitted, the three reviews, payment,
     * active. Each row reads the application as it stands NOW, so the same card
     * in two emails a week apart tells two different, true stories.
     *
     * A tier that recorded an objection shows as "Reviewed" — true, neutral, and
     * not a verdict the applicant should read as final (see the note at the top).
     */
    const journeySteps = (ctx = {}) => {
        const r = ctx.reviews || {};
        const tierRow = (tier, label, deciding) => {
            const v = r[tier] || {};
            if (v.state === 'approved') {
                return { status: 'done', title: label, note: v.byLine || 'Approved' };
            }
            if (v.state === 'reviewed') return { status: 'done', title: label, note: 'Reviewed' };
            return {
                status: 'now',
                title: label,
                note: deciding ? 'Reviewing — gives the final decision' : 'Reviewing'
            };
        };
        const paid = ctx.stage === 'active';
        const approved = ctx.stage === 'approved' || paid;
        return [
            { status: 'done', title: 'Application submitted', note: ctx.submittedLabel || '' },
            tierRow('block', ctx.blockOffice || 'Block Admin review', false),
            tierRow('district', ctx.districtOffice || 'District Admin review', false),
            tierRow('state', ctx.stateOffice || 'State Admin review', true),
            {
                status: paid ? 'done' : (approved ? 'now' : 'next'),
                title: 'Membership payment',
                note: paid ? (ctx.amountLabel ? `${ctx.amountLabel} received` : 'Received')
                    : (approved ? (ctx.feeLabel ? `${ctx.feeLabel} due` : 'Due now') : 'After approval')
            },
            { status: paid ? 'done' : 'next', title: 'Membership active', note: paid ? 'Certificates issued' : '' }
        ];
    };

    const journeyHtml = (ctx = {}, heading = 'Where your application stands') => {
        const rows = journeySteps(ctx);
        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background-color:#ffffff; border:1px solid #e6ebf3; border-radius:14px; border-collapse:separate;">
        <tr><td style="padding:18px 20px 8px 20px;">
          <div style="font-size:12px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:#64748b;
                      padding-bottom:12px;">${esc(heading)}</div>
          ${rows.map((row, i) => {
        const s = STATUS_STYLE[row.status];
        const last = i === rows.length - 1;
        return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td width="34" valign="top" style="width:34px; padding:0;">
              <div style="width:24px; height:24px; border-radius:12px; background-color:${s.bg}; color:${s.fg};
                          font-size:12px; line-height:24px; font-weight:800; text-align:center;">${s.mark}</div>
              ${last ? '' : `<div style="width:2px; height:18px; margin:2px 0 2px 11px; background-color:${
        row.status === 'done' ? '#a7f3d0' : '#e2e8f0'};"></div>`}
            </td>
            <td valign="top" style="padding:2px 0 ${last ? 10 : 0}px 0;">
              <div style="font-size:14px; line-height:1.4; font-weight:700;
                          color:${row.status === 'next' ? '#94a3b8' : '#0f172a'};">${esc(row.title)}</div>
              ${row.note ? `<div style="font-size:13px; line-height:1.4; color:${s.fg};">${esc(row.note)}</div>` : ''}
            </td>
          </tr></table>`;
    }).join('')}
        </td></tr></table>`;
    };

    /** The same journey as WhatsApp lines. */
    const journeyText = (ctx = {}) => journeySteps(ctx)
        .map((row) => `${row.status === 'done' ? '✅' : row.status === 'now' ? '⏳' : '▫️'} ${row.title}${
            row.note ? ` — ${row.note}` : ''}`)
        .join('\n');

    /** One tier's status as a word, for a WhatsApp template slot. */
    const tierWord = (ctx, tier) => {
        const v = (ctx.reviews || {})[tier] || {};
        if (v.state === 'approved') return v.byLine || 'Approved';
        if (v.state === 'reviewed') return 'Reviewed';
        return tier === 'state' ? 'Reviewing (final decision)' : 'Reviewing';
    };

    /** A checklist card — "Your next steps", "What your membership gives you". */
    const listCard = (heading, items = [], { numbered = false } = {}) => (items.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background-color:#f5f8ff; border:1px solid #dbe4fb; border-radius:14px; border-collapse:separate;">
        <tr><td style="padding:18px 20px 12px 20px;">
          <div style="font-size:12px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:#1d4ed8;
                      padding-bottom:10px;">${esc(heading)}</div>
          ${items.map((item, n) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td width="30" valign="top" style="width:30px; padding:0 0 8px 0;">
              <div style="width:20px; height:20px; border-radius:10px; background-color:#1d4ed8; color:#ffffff;
                          font-size:11px; line-height:20px; font-weight:800; text-align:center;">${numbered ? n + 1 : '&#10003;'}</div></td>
            <td valign="top" style="font-size:14px; line-height:1.55; color:#1e293b; padding:0 0 8px 0;">${esc(item)}</td>
          </tr></table>`).join('')}
        </td></tr></table>`
        : '');

    const gap = '<div style="height:16px; line-height:16px; font-size:0;">&nbsp;</div>';

    /** The "need help" block of a WhatsApp text, the same on every message. */
    const helpText = (ctx) => {
        const [n, p, e] = office(ctx);
        return `📞 *Need help? Contact ACTIV Membership support*\n👤 *Name:* ${n}\n📱 *Phone:* ${p}\n📧 *Email:* ${e}`;
    };

    const BENEFITS = [
        'The full ACTIV member directory — find and message other members',
        'Members-only events, conclaves and business programmes',
        'Your membership certificate and 80G donation receipt',
        'Your company page, product catalogue and reach analytics'
    ];

    const routes = {
        forms: appUrl('/member/forms/personal'),
        status: appUrl('/member/application-status'),
        pay: appUrl('/payment/membership-plans'),
        dashboard: appUrl('/payment/member-dashboard'),
        certificate: appUrl('/member/certificate/membership'),
        receipt: appUrl('/member/payment-success?view=receipt'),
        taxCertificate: appUrl('/member/certificate/tax-exemption'),
        documents: appUrl('/member/documents'),
        plan: appUrl('/member/plan')
    };

    /* ============================================================= templates */

    const TEMPLATES = {
        /* ---------------------------------------------------- account created */
        ACCOUNT_REGISTERED: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            return {
                inApp: {
                    title: 'Welcome to ACTIV',
                    message: 'Your account is ready. Complete your membership application — personal, business and '
                        + 'declaration details — to send it for review.',
                    type: 'success'
                },
                email: {
                    subject: 'Welcome to ACTIV — your account is ready',
                    title: 'Welcome to ACTIV',
                    badge: 'Account created',
                    tone: 'success',
                    preheader: 'Your next step: complete your membership application.',
                    bodyHtml: `<p style="margin:0 0 12px 0;">Thank you for joining the Adidravidar Confederation of Trade
                        &amp; Industrial Vision. Your account has been created.</p>
                        <p style="margin:0;">Your next step is the membership application. It takes about ten minutes,
                        and you can save and come back to it at any time.</p>`,
                    facts: [
                        { label: 'Registered email', value: ctx.email },
                        { label: 'Mobile', value: ctx.phone },
                        ...regionFacts(ctx)
                    ],
                    actionButton: { label: 'Start your application', url: routes.forms },
                    afterHtml: listCard('How membership works', [
                        'Fill in your personal details, business details and declaration',
                        'Your Block, District and State Admins review your application together',
                        'Once the State Admin approves it, pay your membership fee online',
                        'Your membership activates at once, with your certificates'
                    ], { numbered: true })
                },
                whatsapp: {
                    ...chain2(TPL.accountWelcomeV2,
                        [greet(ctx), orDash(ctx.email, 'Not given'), ...regionSlots(ctx), routes.forms, oName, oPhone, oEmail],
                        TPL.accountWelcome,
                        [greet(ctx), orDash(ctx.email, 'Not given'), orDash(regionOf(ctx), 'Not given'), routes.forms,
                            oName, oPhone, oEmail],
                        { template: TPL.welcome, params: [ctx.firstName || 'Member'] }),
                    text: '🎉 *Welcome to ACTIV*\n\n'
                        + `Dear ${greet(ctx)},\nYour account has been created.\n\n`
                        + waLines([['📧', ctx.email ? `Registered email: ${ctx.email}` : ''], ...regionLines(ctx)])
                        + `\n\n📝 *Your next step*\nComplete your membership application:\n${routes.forms}\n\n`
                        + '👥 It is then reviewed by your Block, District and State Admins.\n\n'
                        + `${helpText(ctx)}\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* ------------------------------------------------ application lodged */
        APPLICATION_SUBMITTED: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            return {
                inApp: {
                    title: 'Application submitted',
                    message: `${ctx.reference ? `Reference ${ctx.reference}. ` : ''}Your Block, District and State Admins are reviewing it now.`,
                    type: 'info'
                },
                email: {
                    subject: ctx.reference ? `Application received — reference ${ctx.reference}` : 'Your ACTIV application has been received',
                    title: 'We have received your application',
                    badge: 'Application received',
                    tone: 'info',
                    preheader: 'Your Block, District and State Admins are reviewing it now.',
                    highlight: ctx.reference && {
                        label: 'Application reference',
                        value: ctx.reference,
                        note: 'Quote this reference in any message about your application.'
                    },
                    bodyHtml: `<p style="margin:0 0 12px 0;">Thank you — your ACTIV membership application has been
                        submitted.</p>
                        <p style="margin:0;">Your Block, District and State Admins are reviewing it now, together. We will
                        write to you as each one records a decision. There is nothing you need to do in the meantime.</p>`,
                    facts: [
                        { label: 'Applicant', value: ctx.name },
                        { label: 'Applying as', value: applyingAs(ctx) },
                        ...regionFacts(ctx),
                        { label: 'Submitted on', value: ctx.submittedLabel }
                    ],
                    actionButton: { label: 'Track your application', url: routes.status },
                    afterHtml: journeyHtml(ctx)
                },
                whatsapp: {
                    ...chain2(TPL.applicationReceivedV2,
                        [greet(ctx), orDash(ctx.reference, 'See your dashboard'), orDash(applyingAs(ctx), 'Membership'),
                            ...regionSlots(ctx), orDash(ctx.submittedLabel, 'Today'), routes.status, oName, oPhone, oEmail],
                        TPL.applicationReceived,
                        [greet(ctx), orDash(ctx.reference, 'See your dashboard'), orDash(applyingAs(ctx), 'Membership'), orDash(regionOf(ctx), 'Not given'),
                            orDash(ctx.submittedLabel, 'Today'), routes.status, oName, oPhone, oEmail],
                        {
                            template: TPL.status,
                            params: [ctx.firstName || 'Member', 'submitted',
                                'with your Block, District and State Admins for review']
                        }),
                    text: '📨 *Application received*\n\n'
                        + `Dear ${greet(ctx)},\nThank you — your ACTIV membership application has been submitted.\n\n`
                        + waLines([['🔖', ctx.reference ? `Reference: ${ctx.reference}` : ''], ['🏢', applyingAs(ctx)],
                            ...regionLines(ctx), ['🗓', ctx.submittedLabel ? `Submitted on ${ctx.submittedLabel}` : '']])
                        + `\n\n*Where it stands*\n${journeyText(ctx)}\n\n`
                        + `🔎 Track it any time: ${routes.status}\n\n${helpText(ctx)}\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* --------------------------- a Block or District admin approved (NEW) */
        APPLICATION_ENDORSED: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            const who = ctx.endorsedBy || 'Your regional Admin';
            return {
                inApp: {
                    title: `${who} approved your application`,
                    message: `The State Admin now gives the final decision on your application${ctx.reference ? ` (${ctx.reference})` : ''}.`,
                    type: 'success'
                },
                email: {
                    subject: `${who} has approved your application`,
                    title: `${who} approved your application`,
                    badge: `${ctx.endorsedTierLabel || 'Review'} approval`,
                    tone: 'success',
                    preheader: 'The State Admin gives the final decision.',
                    bodyHtml: `<p style="margin:0 0 12px 0;">Good news — the <strong>${esc(who)}</strong> has
                        reviewed and approved your ACTIV membership application.</p>
                        <p style="margin:0;">Your membership is granted by the <strong>State Admin</strong>, who is
                        reviewing it now. We will write as soon as the decision is made — there is nothing you need
                        to do.</p>`,
                    facts: [
                        { label: 'Reference', value: ctx.reference },
                        { label: 'Approved by', value: who },
                        { label: 'Approved on', value: ctx.decidedLabel }
                    ],
                    actionButton: { label: 'Track your application', url: routes.status },
                    afterHtml: journeyHtml(ctx)
                },
                whatsapp: {
                    ...chain(TPL.applicationProgress,
                        [greet(ctx), who, orDash(ctx.reference, 'See your dashboard'), tierWord(ctx, 'block'), tierWord(ctx, 'district'),
                            tierWord(ctx, 'state'), routes.status, oName, oPhone, oEmail],
                        {
                            template: TPL.status,
                            params: [ctx.firstName || 'Member', `approved by your ${clause(who, 60)}`,
                                'the State Admin now gives the final decision']
                        }),
                    text: '👍 *Your application moved forward*\n\n'
                        + `Dear ${greet(ctx)},\nThe *${who}* has approved your membership application.\n`
                        + 'The State Admin now gives the final decision.\n\n'
                        + (ctx.reference ? `🔖 Reference: ${ctx.reference}\n\n` : '') + `*Where it stands*\n${journeyText(ctx)}\n\n`
                        + `🔎 ${routes.status}\n\n${helpText(ctx)}\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* ------------------------------ the State (or Super Admin) said no */
        CORRECTION_REQUESTED: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            return {
                inApp: {
                    title: 'Application not approved',
                    message: ctx.reason
                        ? `Your membership application was not approved. Reason: ${ctx.reason}`
                        : 'Your membership application was not approved. Contact ACTIV Membership support for details.',
                    type: 'error'
                },
                email: {
                    subject: `Update on your ACTIV application${ctx.reference ? ` (${ctx.reference})` : ''}`,
                    title: 'Your application was not approved',
                    badge: 'Decision made',
                    tone: 'danger',
                    preheader: ctx.reason ? oneLine(ctx.reason, 90) : 'Contact ACTIV Membership support for details.',
                    bodyHtml: `<p style="margin:0 0 12px 0;">Thank you for applying to ACTIV. After review, the
                        <strong>${esc(ctx.decidedBy || 'State Admin')}</strong> was not able to approve your membership
                        application at this time.</p>
                        ${ctx.reason ? `<p style="margin:0 0 6px 0;"><strong>Reason given</strong></p>
                        <p style="margin:0 0 12px 0; padding:12px 14px; background-color:#fef2f2; border-left:3px solid #dc2626;
                                  color:#7f1d1d; border-radius:0 8px 8px 0;">${ctx.reasonHtml || ''}</p>` : ''}
                        <p style="margin:0;">If something can be corrected, reply to this email — it reaches ACTIV Membership
                        support, who can tell you what to do next.</p>`,
                    facts: [
                        { label: 'Reference', value: ctx.reference },
                        { label: 'Decided by', value: ctx.decidedBy },
                        { label: 'Decided on', value: ctx.decidedLabel }
                    ],
                    actionButton: { label: 'View your application', url: routes.status }
                },
                whatsapp: {
                    ...chain(TPL.applicationDeclined,
                        [greet(ctx), orDash(ctx.reference, 'See your dashboard'), orDash(clause(ctx.reason, 300), 'No reason was recorded'),
                            oName, oPhone, oEmail],
                        {
                            template: TPL.status,
                            params: [ctx.firstName || 'Member', 'not approved',
                                ctx.reason ? `the reason given is: ${clause(ctx.reason, 170)}`
                                    : 'please contact ACTIV Membership support for the details']
                        }),
                    text: '*Update on your ACTIV application*\n\n'
                        + `Dear ${greet(ctx)},\nAfter review, your membership application was not approved at this time.\n\n`
                        + (ctx.reference ? `🔖 Reference: ${ctx.reference}` : '')
                        + (ctx.reason ? `\n📝 Reason: ${oneLine(ctx.reason, 400)}` : '')
                        + `\n\nIf something can be corrected, ACTIV Membership support can guide you.\n\n${helpText(ctx)}`
                        + `\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* ------------------------- the State approved: ready for payment */
        APPLICATION_APPROVED: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            const fee = ctx.feeLabel;
            const plan = ctx.planName;
            return {
                inApp: {
                    title: 'Application approved — ready for payment',
                    message: `Your membership application is approved.${fee ? ` Pay your ${plan ? `${plan} ` : ''}`
                        + `membership fee of ${fee}` : ' Complete your membership payment'} to activate it.`,
                    type: 'success'
                },
                email: {
                    subject: `Approved — complete your ACTIV membership${fee ? ` (${fee})` : ''}`,
                    title: 'Your application is approved',
                    badge: 'Approved · Ready for payment',
                    tone: 'success',
                    preheader: fee ? `One step left: your membership fee of ${fee}.` : 'One step left: your membership payment.',
                    highlight: fee ? {
                        label: plan ? `${plan} · Membership fee` : 'Membership fee',
                        value: fee,
                        note: ctx.planBand
                            ? `Your plan is based on your business: ${ctx.planBand}. Paid once, online.`
                            : 'Paid once, online. Your membership activates the moment it is received.'
                    } : null,
                    bodyHtml: `<p style="margin:0 0 12px 0;">Congratulations — the
                        <strong>${esc(ctx.decidedBy || 'State Admin')}</strong> has approved your ACTIV membership
                        application.</p>
                        <p style="margin:0;">${fee
        ? `One step remains: your membership fee of <strong>${esc(fee)}</strong>.`
        : 'One step remains: choose your plan and complete your membership payment.'}
                        Your membership activates, and your certificates are issued, the moment it is received.</p>`,
                    facts: [
                        { label: 'Reference', value: ctx.reference },
                        { label: 'Plan', value: plan ? [plan, ctx.planBand].filter(Boolean).join(' · ') : '' },
                        { label: 'Membership fee', value: fee },
                        { label: 'Approved by', value: ctx.decidedBy },
                        { label: 'Approved on', value: ctx.decidedLabel }
                    ],
                    actionButton: { label: fee ? `Pay ${fee} now` : 'Choose your plan and pay', url: routes.pay },
                    afterHtml: journeyHtml({ ...ctx, stage: 'approved' }, 'Your journey')
                        + gap + listCard('What your membership gives you',
                        (ctx.planFeatures && ctx.planFeatures.length ? ctx.planFeatures : BENEFITS).slice(0, 6))
                },
                whatsapp: {
                    ...chain(TPL.membershipApproved,
                        [greet(ctx), orDash(ctx.reference, 'See your dashboard'), orDash(plan, 'Your membership plan'),
                            orDash(fee, 'Shown on the payment page'), routes.pay, oName, oPhone, oEmail],
                        {
                            template: TPL.status,
                            params: [ctx.firstName || 'Member', 'fully approved',
                                fee ? `complete your membership payment of ${fee.replace('₹', 'Rs ')} to activate it`
                                    : 'complete your membership payment to activate it']
                        }),
                    text: '🎉 *Your application is approved*\n\n'
                        + `Dear ${greet(ctx)},\nCongratulations — your ACTIV membership application has been approved.\n\n`
                        + waLines([['🔖', ctx.reference ? `Reference: ${ctx.reference}` : ''], ['🏷', plan ? `Plan: ${plan}` : ''],
                            ['💳', fee ? `Membership fee: ${fee}` : '']])
                        + `\n\n👉 *One step left — pay online*\n${routes.pay}\n\n`
                        + 'Your membership activates the moment payment is received.\n\n'
                        + `${helpText(ctx)}\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* -------------------------------------- the payment nudge (order open) */
        PAYMENT_REQUIRED: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            return {
                email: {
                    subject: `Your ACTIV membership payment is pending${ctx.amountLabel ? ` (${ctx.amountLabel})` : ''}`,
                    title: 'Your payment is still pending',
                    badge: 'Payment pending',
                    tone: 'warning',
                    preheader: 'Complete it to activate your membership.',
                    highlight: ctx.amountLabel ? {
                        label: ctx.planName ? `${ctx.planName} · Amount due` : 'Amount due',
                        value: ctx.amountLabel,
                        note: 'If you have already paid, please ignore this message.'
                    } : null,
                    bodyHtml: `<p style="margin:0;">You started your ACTIV membership payment but it has not been
                        completed yet. It only takes a minute to finish, and your membership activates as soon as it
                        is received.</p>`,
                    facts: [
                        { label: 'Plan', value: ctx.planName },
                        { label: 'Amount', value: ctx.amountLabel },
                        { label: 'Order reference', value: ctx.reference }
                    ],
                    actionButton: { label: 'Complete your payment', url: routes.pay }
                },
                whatsapp: {
                    ...chain(TPL.paymentPending,
                        [greet(ctx), orDash(ctx.amountLabel, 'the membership fee'), orDash(ctx.planName, 'Membership'),
                            orDash(ctx.reference, '–'), routes.pay, oName, oPhone, oEmail],
                        { template: TPL.payment, params: [ctx.firstName || 'Member',
                            String(ctx.amountLabel || 'the required amount').replace('₹', 'Rs ')] }),
                    text: '⏳ *Your membership payment is pending*\n\n'
                        + `Dear ${greet(ctx)},\nYour ACTIV membership payment has not been completed yet.\n\n`
                        + waLines([['💳', ctx.amountLabel ? `Amount: ${ctx.amountLabel}` : ''],
                            ['🏷', ctx.planName ? `Plan: ${ctx.planName}` : ''],
                            ['🔖', ctx.reference ? `Order: ${ctx.reference}` : '']])
                        + `\n\n👉 Complete it here: ${routes.pay}\n\nAlready paid? Please ignore this message.\n\n`
                        + `${helpText(ctx)}\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* ---------------------------- paid: the membership confirmation */
        MEMBERSHIP_ACTIVATED: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            return {
                inApp: {
                    title: 'Membership activated',
                    message: `Payment received${ctx.amountLabel ? ` (${ctx.amountLabel})` : ''}. Your ACTIV membership is `
                        + `active${ctx.membershipNumber ? ` — Member ID ${ctx.membershipNumber}` : ''}.`,
                    type: 'success'
                },
                email: {
                    subject: `Welcome, member — your ACTIV membership is active${
                        ctx.membershipNumber ? ` (${ctx.membershipNumber})` : ''}`,
                    title: 'Your membership is active',
                    badge: 'Payment received · Membership active',
                    tone: 'success',
                    preheader: 'Your certificates and every member benefit are now open to you.',
                    highlight: ctx.membershipNumber ? {
                        label: 'Your Member ID',
                        value: ctx.membershipNumber,
                        note: 'Quote your Member ID whenever you contact ACTIV.'
                    } : null,
                    bodyHtml: `<p style="margin:0 0 12px 0;">Thank you — your payment${ctx.amountLabel
                        ? ` of <strong>${esc(ctx.amountLabel)}</strong>` : ''} has been received and your ACTIV
                        membership is now <strong>active</strong>.</p>
                        <p style="margin:0;">Welcome to the Confederation. Your membership certificate is ready to
                        download from your dashboard.</p>`,
                    facts: [
                        { label: 'Member', value: ctx.name },
                        { label: 'Plan', value: ctx.planName || ctx.membershipType },
                        { label: 'Amount paid', value: ctx.amountLabel },
                        { label: 'Payment reference', value: ctx.orderId },
                        { label: 'Payment mode', value: ctx.paymentMode ? ctx.paymentMode.replace(/_/g, ' ') : '' },
                        { label: 'Active from', value: ctx.activatedLabel },
                        { label: 'Valid until', value: ctx.validUntilLabel },
                        // The two ids a member quotes, below the details.
                        { label: 'Member ID', value: ctx.membershipNumber },
                        { label: 'Application ID', value: ctx.applicationRef }
                    ],
                    actionButton: { label: 'Open your member dashboard', url: routes.dashboard },
                    secondaryButton: { label: 'Download your certificate', url: routes.certificate },
                    afterHtml: `<p style="margin:0 0 16px;line-height:1.8;"><a href="${esc(ctx.receiptUrl || routes.receipt)}">View your payment receipt</a><br><a href="${esc(routes.taxCertificate)}">View your tax certificate</a><br><a href="${esc(routes.documents)}">Open all membership documents</a></p>` + listCard('Now open to you', BENEFITS)
                },
                whatsapp: {
                    ...chain(TPL.membershipActive,
                        [greet(ctx), orDash(ctx.membershipNumber, 'Shown on your dashboard'),
                            orDash(ctx.planName || ctx.membershipType, 'ACTIV Membership'),
                            orDash(ctx.amountLabel, 'Received'), orDash(ctx.validUntilLabel, 'See your dashboard'),
                            routes.dashboard, routes.certificate, oName, oPhone, oEmail],
                        {
                            template: TPL.status,
                            params: [ctx.firstName || 'Member', 'fully completed',
                                'your membership and benefits are now completely active']
                        }),
                    text: '🎉 *Your ACTIV membership is active*\n\n'
                        + `Dear ${greet(ctx)},\nThank you — your payment has been received. Welcome to ACTIV!\n\n`
                        + waLines([['🪪', ctx.membershipNumber ? `Member ID: ${ctx.membershipNumber}` : ''],
                            ['🏷', ctx.planName || ctx.membershipType ? `Plan: ${ctx.planName || ctx.membershipType}` : ''],
                            ['💳', ctx.amountLabel ? `Amount paid: ${ctx.amountLabel}` : ''],
                            ['📅', ctx.validUntilLabel ? `Valid until: ${ctx.validUntilLabel}` : ''],
                            ['🔖', ctx.applicationRef ? `Application ID: ${ctx.applicationRef}` : '']])
                        + `\n\n📊 Your dashboard: ${routes.dashboard}\n📜 Your certificate: ${routes.certificate}\nPayment receipt: ${ctx.receiptUrl || routes.receipt}\nTax certificate: ${routes.taxCertificate}\nAll documents: ${routes.documents}\n\n`
                        + `${helpText(ctx)}\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* ------------------------------------------ renewal due (NEW) */
        MEMBERSHIP_RENEWAL_DUE: (ctx) => {
            const [oName, oPhone, oEmail] = office(ctx);
            const expired = ctx.daysLeft !== undefined && Number(ctx.daysLeft) <= 0;
            const when = expired ? 'has expired' : `expires ${ctx.expiresInLabel || 'soon'}`;
            return {
                inApp: {
                    title: expired ? 'Your membership has expired' : 'Membership renewal due',
                    message: `Your ACTIV membership ${when}${ctx.validUntilLabel ? ` (${ctx.validUntilLabel})` : ''}. `
                        + 'Renew to keep your member benefits.',
                    type: expired ? 'warning' : 'info'
                },
                email: {
                    subject: expired ? 'Your ACTIV membership has expired — renew today'
                        : `Your ACTIV membership ${when} — time to renew`,
                    title: expired ? 'Your membership has expired' : 'Time to renew your membership',
                    badge: expired ? 'Membership expired' : 'Renewal due',
                    tone: 'warning',
                    preheader: 'Renew online in a minute to keep every member benefit.',
                    highlight: ctx.validUntilLabel ? {
                        label: expired ? 'Expired on' : 'Valid until',
                        value: ctx.validUntilLabel,
                        note: ctx.membershipNumber ? `Member ID ${ctx.membershipNumber}` : ''
                    } : null,
                    bodyHtml: `<p style="margin:0;">Your ACTIV membership ${esc(when)}. Renew online to keep your access
                        to the member directory, members-only events and your certificates — it takes a minute.</p>`,
                    facts: [
                        { label: 'Member ID', value: ctx.membershipNumber },
                        { label: 'Plan', value: ctx.planName || ctx.membershipType },
                        { label: expired ? 'Expired on' : 'Valid until', value: ctx.validUntilLabel }
                    ],
                    actionButton: { label: 'Renew your membership', url: routes.plan }
                },
                whatsapp: {
                    ...chain(TPL.membershipRenewal,
                        [greet(ctx), orDash(ctx.membershipNumber, '–'), orDash(ctx.planName || ctx.membershipType, 'Membership'),
                            orDash(ctx.validUntilLabel, 'soon'), expired ? 'has expired' : `expires ${ctx.expiresInLabel || 'soon'}`,
                            routes.plan, oName, oPhone, oEmail],
                        null),
                    text: `🔔 *${expired ? 'Your membership has expired' : 'Membership renewal due'}*\n\n`
                        + `Dear ${greet(ctx)},\nYour ACTIV membership ${when}.\n\n`
                        + waLines([['🪪', ctx.membershipNumber ? `Member ID: ${ctx.membershipNumber}` : ''],
                            ['📅', ctx.validUntilLabel ? `${expired ? 'Expired on' : 'Valid until'}: ${ctx.validUntilLabel}` : '']])
                        + `\n\n👉 Renew here: ${routes.plan}\n\n${helpText(ctx)}\n\n— ${ORG_SIGNATURE}`
                }
            };
        },

        /* ------------------------------ a member asked for Platinum (NEW) */
        PLATINUM_REQUESTED: (ctx) => {
            const how = ctx.preferredContactLabel || 'Phone call';
            const when = ctx.preferredTime ? ` (${ctx.preferredTime})` : '';
            return {
                inApp: {
                    title: 'Lifetime request received',
                    message: `The ACTIV office will contact you by ${how.toLowerCase()}${when} about Lifetime Membership.`,
                    type: 'success'
                },
                email: {
                    subject: 'Your Lifetime Membership request',
                    title: 'We have your Lifetime request',
                    badge: 'Lifetime · request received',
                    tone: 'info',
                    preheader: 'The ACTIV office will contact you within two working days.',
                    highlight: ctx.priceLabel ? {
                        label: `${ctx.planName || 'Lifetime Membership'} · one payment`,
                        value: ctx.priceLabel,
                        note: 'Member for life — never renew. Paid at the ACTIV office and activated for you.'
                    } : null,
                    bodyHtml: `<p style="margin:0 0 12px 0;">Thank you for your interest in <strong>Lifetime Membership</strong>.</p>
                        <p style="margin:0;">The ACTIV office will contact you by <strong>${esc(how)}</strong>${esc(when)}
                        within two working days to explain the next steps. Nothing is charged online — Lifetime is paid at
                        the office and your membership is upgraded for you.</p>`,
                    facts: [
                        { label: 'Contact by', value: how },
                        { label: 'Best time', value: ctx.preferredTime }
                    ],
                    actionButton: { label: 'Open your dashboard', url: routes.dashboard }
                },
                whatsapp: {
                    template: TPL.status,
                    params: [ctx.firstName || 'Member', 'received',
                        'the ACTIV office will contact you about Lifetime Membership within two working days'],
                    text: '👑 *Lifetime request received*\n\n'
                        + `Dear ${greet(ctx)},\nThank you for your interest in Lifetime Membership`
                        + `${ctx.priceLabel ? ` (${ctx.priceLabel}, one payment, never renew)` : ''}.\n\n`
                        + `📞 The ACTIV office will contact you by ${how.toLowerCase()}${when} within two working days.\n\n`
                        + `— ${ORG_SIGNATURE}`
                }
            };
        },

        /* -------------------- the office / super admin: who asked (NEW) */
        ADMIN_PLATINUM_REQUEST: (ctx) => {
            const review = appUrl(ctx.reviewPath || '/super-admin/membership');
            return {
                email: {
                    subject: `Lifetime request — ${ctx.applicantName || 'a member'}${ctx.applicantPhone ? ` (${ctx.applicantPhone})` : ''}`,
                    title: 'A member wants Lifetime',
                    badge: 'Lifetime request',
                    tone: 'info',
                    preheader: `${ctx.applicantName || 'A member'} · ${ctx.preferredContactLabel || 'Call'}${ctx.preferredTime ? ` · ${ctx.preferredTime}` : ''}`,
                    highlight: ctx.priceLabel ? { label: 'Lifetime Membership', value: ctx.priceLabel, note: 'Collect at the office, then grant it in Super Admin → Membership.' } : null,
                    bodyHtml: `<p style="margin:0 0 12px 0;"><strong>${esc(ctx.applicantName || 'A member')}</strong> has asked to
                        become a Lifetime Member. Please contact them${ctx.preferredContactLabel
        ? ` by <strong>${esc(ctx.preferredContactLabel)}</strong>` : ''}${ctx.preferredTime ? ` (${esc(ctx.preferredTime)})` : ''}.</p>
                        ${ctx.message ? `<p style="margin:0 0 12px 0; padding:12px 14px; background-color:#eff6ff; border-left:3px solid #2563eb;
                                  border-radius:0 8px 8px 0;">${esc(ctx.message)}</p>` : ''}
                        <p style="margin:0;">Once the payment is received, grant Lifetime from Super Admin → Membership; the
                        request closes itself.</p>`,
                    facts: [
                        { label: 'Member', value: ctx.applicantName },
                        { label: 'Mobile', value: ctx.applicantPhone },
                        { label: 'Email', value: ctx.applicantEmail },
                        { label: 'Company', value: ctx.businessName },
                        ...regionFacts(ctx),
                        { label: 'Contact by', value: ctx.preferredContactLabel },
                        { label: 'Best time', value: ctx.preferredTime }
                    ],
                    actionButton: { label: 'Open Lifetime requests', url: review }
                }
            };
        },

        /* ------------------ an admin: a new application in your region (NEW) */
        ADMIN_NEW_APPLICATION: (ctx) => {
            const review = appUrl(ctx.reviewPath || '/admin/login');
            return {
                email: {
                    subject: `New membership application — ${ctx.applicantName || 'an applicant'}${ctx.reference ? ` (${ctx.reference})` : ''}`,
                    title: 'A new application is waiting for you',
                    badge: 'New application',
                    tone: 'info',
                    preheader: `${ctx.applicantName || 'An applicant'} · ${ctx.applicantRegion || ''}`,
                    highlight: ctx.reference ? { label: 'Application reference', value: ctx.reference } : null,
                    bodyHtml: `<p style="margin:0 0 12px 0;">A new membership application has been submitted in your
                        region, <strong>${esc(ctx.adminRegion || ctx.applicantRegion || '')}</strong>.</p>
                        <p style="margin:0;">Your ${esc(ctx.adminTierLabel || '')} Admin verdict is recorded on the file
                        for every tier to see${ctx.adminDecides ? ', and yours is the decision that grants the membership'
        : '; the State Admin grants the membership'}.</p>`,
                    facts: [
                        { label: 'Applicant', value: ctx.applicantName },
                        { label: 'Applying as', value: [ctx.memberTypeLabel, ctx.businessName].filter(Boolean).join(' · ') },
                        ...regionFacts(ctx),
                        { label: 'Mobile', value: ctx.applicantPhone },
                        { label: 'Email', value: ctx.applicantEmail },
                        { label: 'Submitted on', value: ctx.submittedLabel }
                    ],
                    actionButton: { label: 'Review the application', url: review }
                },
                whatsapp: {
                    ...chain2(TPL.adminNewApplicationV2,
                        [greet(ctx), orDash(ctx.applicantName, 'An applicant'),
                            orDash([ctx.memberTypeLabel, ctx.businessName].filter(Boolean).join(' · '), 'Membership'),
                            ...regionSlots(ctx), orDash(ctx.reference, '–'), orDash(ctx.submittedLabel, 'Today'), review],
                        TPL.adminNewApplication,
                        [greet(ctx), orDash(ctx.applicantName, 'An applicant'),
                            orDash([ctx.memberTypeLabel, ctx.businessName].filter(Boolean).join(' · '), 'Membership'),
                            orDash(ctx.applicantRegion, '–'), orDash(ctx.reference, '–'), orDash(ctx.submittedLabel, 'Today'), review],
                        null),
                    text: '📥 *New membership application*\n\n'
                        + `Dear ${greet(ctx)},\nA new application has been submitted in your region.\n\n`
                        + waLines([['👤', ctx.applicantName], ['🏢', [ctx.memberTypeLabel, ctx.businessName].filter(Boolean).join(' · ')],
                            ...regionLines(ctx), ['🔖', ctx.reference ? `Reference: ${ctx.reference}` : ''],
                            ['🗓', ctx.submittedLabel ? `Submitted on ${ctx.submittedLabel}` : '']])
                        + `\n\n👉 Review it: ${review}\n\n— ${ORG_SIGNATURE}`
                }
            };
        }
    };

    /* ================================================== Meta template specs */

    const FOOTER = 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV';
    const HELP = '📞 *Need help? Contact ACTIV Membership support*\n👤 *Name:* {{a}}\n📱 *Phone:* {{b}}\n📧 *Email:* {{c}}';
    const helpAt = (n) => HELP.replace('{{a}}', `{{${n}}}`).replace('{{b}}', `{{${n + 1}}}`).replace('{{c}}', `{{${n + 2}}}`);
    const OFFICE_SAMPLES = [contact.name, contact.phone, contact.email];
    const spec = (name, envKey, bodyWithVariables, params, samples) => ({
        name, envKey, category: 'Utility', meta: true, header: 'IMAGE', footer: FOOTER,
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables, params, samples
    });

    const WHATSAPP_TEMPLATES = [
        spec('activ_account_welcome_v1', 'BOTBEE_TPL_ACCOUNT_WELCOME',
            'Dear *{{1}}*,\n\n🎉 Welcome to ACTIV! Your account has been created.\n\n'
            + '📧 *Registered email:* {{2}}\n📍 *Region:* {{3}}\n\n'
            + '📝 *Your next step*\nComplete your membership application here:\n{{4}}\n\n'
            + '👥 Your Block, District and State Admins then review it together.\n\n'
            + `${helpAt(5)}\n\nWe are glad to have you with us!`,
            ['full name', 'email', 'region', 'application link', 'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'tharun@example.com', 'Guindy, Chennai, Tamil Nadu', 'https://activ.org.in/member/forms/personal',
                ...OFFICE_SAMPLES]),
        spec('activ_application_received_v1', 'BOTBEE_TPL_APPLICATION_RECEIVED',
            'Dear *{{1}}*,\n\n📨 Thank you, your ACTIV membership application has been submitted.\n\n'
            + '🔖 *Reference:* {{2}}\n🏢 *Applying as:* {{3}}\n📍 *Region:* {{4}}\n🗓 *Submitted on:* {{5}}\n\n'
            + '👥 Your Block, District and State Admins are reviewing it now. We will message you as each one decides.\n\n'
            + `🔎 *Track your application:* {{6}}\n\n${helpAt(7)}\n\nThank you for choosing ACTIV.`,
            ['full name', 'reference', 'applying as', 'region', 'submitted on', 'tracking link',
                'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'A1B2C3', 'Business membership · Sri Lakshmi Enterprises', 'Guindy, Chennai, Tamil Nadu',
                '27 September 2026', 'https://activ.org.in/member/application-status', ...OFFICE_SAMPLES]),
        spec('activ_application_progress_v1', 'BOTBEE_TPL_APPLICATION_PROGRESS',
            'Dear *{{1}}*,\n\n👍 Good news, the *{{2}}* has approved your ACTIV membership application.\n\n'
            + '🔖 *Reference:* {{3}}\n\n📋 *Review status*\n• *Block Admin:* {{4}}\n• *District Admin:* {{5}}\n'
            + '• *State Admin:* {{6}}\n\nThe State Admin gives the final decision. Nothing is needed from you.\n\n'
            + `🔎 *Track your application:* {{7}}\n\n${helpAt(8)}\n\nThank you for your patience.`,
            ['full name', 'admin who approved', 'reference', 'block status', 'district status', 'state status',
                'tracking link', 'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'Guindy Block Admin', 'A1B2C3', 'Approved', 'Reviewing', 'Reviewing (final decision)',
                'https://activ.org.in/member/application-status', ...OFFICE_SAMPLES]),
        spec('activ_membership_approved_v1', 'BOTBEE_TPL_MEMBERSHIP_APPROVED',
            'Dear *{{1}}*,\n\n🎉 Congratulations! Your ACTIV membership application has been *approved*.\n\n'
            + '🔖 *Reference:* {{2}}\n🏷 *Plan:* {{3}}\n💳 *Membership fee:* {{4}}\n\n'
            + '👉 *One step left, pay online:*\n{{5}}\n\nYour membership activates the moment payment is received.\n\n'
            + `${helpAt(6)}\n\nWelcome to ACTIV!`,
            ['full name', 'reference', 'plan', 'fee', 'payment link', 'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'A1B2C3', 'Growth Member', 'Rs 5,000', 'https://activ.org.in/payment/membership-plans',
                ...OFFICE_SAMPLES]),
        spec('activ_application_declined_v1', 'BOTBEE_TPL_APPLICATION_DECLINED',
            'Dear *{{1}}*,\n\nThank you for applying to ACTIV. After review, your membership application '
            + '(reference *{{2}}*) was not approved at this time.\n\n📝 *Reason:* {{3}}\n\n'
            + `If something can be corrected, ACTIV Membership support can guide you.\n\n${helpAt(4)}\n\nThank you for your interest in ACTIV.`,
            ['full name', 'reference', 'reason', 'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'A1B2C3', 'The business registration document could not be read', ...OFFICE_SAMPLES]),
        spec('activ_payment_pending_v1', 'BOTBEE_TPL_PAYMENT_PENDING',
            'Dear *{{1}}*,\n\n⏳ Your ACTIV membership payment is still pending.\n\n'
            + '💳 *Amount:* {{2}}\n🏷 *Plan:* {{3}}\n🔖 *Order:* {{4}}\n\n👉 *Complete it here:*\n{{5}}\n\n'
            + `Already paid? Please ignore this message.\n\n${helpAt(6)}\n\nThank you.`,
            ['full name', 'amount', 'plan', 'order reference', 'payment link', 'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'Rs 5,000', 'Growth Member', 'ORD-8F2K1Q', 'https://activ.org.in/payment/membership-plans',
                ...OFFICE_SAMPLES]),
        spec('activ_membership_active_v1', 'BOTBEE_TPL_MEMBERSHIP_ACTIVE',
            'Dear *{{1}}*,\n\n🎉 Thank you! Your payment has been received and your ACTIV membership is now *active*.\n\n'
            + '🪪 *Member ID:* {{2}}\n🏷 *Plan:* {{3}}\n💳 *Amount paid:* {{4}}\n📅 *Valid until:* {{5}}\n\n'
            + '📊 *Your dashboard:* {{6}}\n📜 *Your certificate:* {{7}}\n\n'
            + `${helpAt(8)}\n\nWelcome to the ACTIV family!`,
            ['full name', 'member ID', 'plan', 'amount paid', 'valid until', 'dashboard link', 'certificate link',
                'office name', 'office phone', 'office email'],
            ['Tharun Kumar', '64F0C0FF', 'Growth Member', 'Rs 5,000', '31 March 2027',
                'https://activ.org.in/payment/member-dashboard', 'https://activ.org.in/member/certificate/membership',
                ...OFFICE_SAMPLES]),
        spec('activ_membership_renewal_v1', 'BOTBEE_TPL_MEMBERSHIP_RENEWAL',
            'Dear *{{1}}*,\n\n🔔 A reminder about your ACTIV membership.\n\n'
            + '🪪 *Member ID:* {{2}}\n🏷 *Plan:* {{3}}\n📅 *Valid until:* {{4}}\n\n'
            + 'Your membership {{5}}. Renew online to keep every member benefit:\n{{6}}\n\n'
            + `${helpAt(7)}\n\nThank you for being part of ACTIV.`,
            ['full name', 'member ID', 'plan', 'valid until', 'expires in / has expired', 'renewal link',
                'office name', 'office phone', 'office email'],
            ['Tharun Kumar', '64F0C0FF', 'Growth Member', '31 March 2027', 'expires in 30 days',
                'https://activ.org.in/member/plan', ...OFFICE_SAMPLES]),
        spec('activ_admin_new_application_v1', 'BOTBEE_TPL_ADMIN_NEW_APPLICATION',
            'Dear *{{1}}*,\n\n📥 A new membership application has been submitted in your region.\n\n'
            + '👤 *Applicant:* {{2}}\n🏢 *Applying as:* {{3}}\n📍 *Region:* {{4}}\n🔖 *Reference:* {{5}}\n'
            + '🗓 *Submitted on:* {{6}}\n\n👉 *Review it here:*\n{{7}}\n\nThank you for serving ACTIV.',
            ['admin name', 'applicant', 'applying as', 'region', 'reference', 'submitted on', 'review link'],
            ['Guindy Block Admin', 'Tharun Kumar', 'Business membership · Sri Lakshmi Enterprises',
                'Guindy, Chennai, Tamil Nadu', 'A1B2C3', '27 September 2026', 'https://activ.org.in/block-admin/approvals']),

        /* v2 — the region as Block / District / State, one line each. */
        spec('activ_account_welcome_v2', 'BOTBEE_TPL_ACCOUNT_WELCOME_V2',
            'Dear *{{1}}*,\n\n🎉 Welcome to ACTIV! Your account has been created.\n\n'
            + '📧 *Registered email:* {{2}}\n🏘 *Block:* {{3}}\n🏙 *District:* {{4}}\n🗺 *State:* {{5}}\n\n'
            + '📝 *Your next step*\nComplete your membership application here:\n{{6}}\n\n'
            + '👥 Your Block, District and State Admins then review it together.\n\n'
            + `${helpAt(7)}\n\nWe are glad to have you with us!`,
            ['full name', 'email', 'block', 'district', 'state', 'application link', 'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'tharun@example.com', 'Guindy', 'Chennai', 'Tamil Nadu', 'https://activ.org.in/member/forms/personal',
                ...OFFICE_SAMPLES]),
        spec('activ_application_received_v2', 'BOTBEE_TPL_APPLICATION_RECEIVED_V2',
            'Dear *{{1}}*,\n\n📨 Thank you, your ACTIV membership application has been submitted.\n\n'
            + '🔖 *Reference:* {{2}}\n🏢 *Applying as:* {{3}}\n🏘 *Block:* {{4}}\n🏙 *District:* {{5}}\n🗺 *State:* {{6}}\n'
            + '🗓 *Submitted on:* {{7}}\n\n'
            + '👥 Your Block, District and State Admins are reviewing it now. We will message you as each one decides.\n\n'
            + `🔎 *Track your application:* {{8}}\n\n${helpAt(9)}\n\nThank you for choosing ACTIV.`,
            ['full name', 'reference', 'applying as', 'block', 'district', 'state', 'submitted on', 'tracking link',
                'office name', 'office phone', 'office email'],
            ['Tharun Kumar', 'A1B2C3', 'Business membership · Sri Lakshmi Enterprises', 'Guindy', 'Chennai', 'Tamil Nadu',
                '27 September 2026', 'https://activ.org.in/member/application-status', ...OFFICE_SAMPLES]),
        spec('activ_admin_new_application_v2', 'BOTBEE_TPL_ADMIN_NEW_APPLICATION_V2',
            'Dear *{{1}}*,\n\n📥 A new membership application has been submitted in your region.\n\n'
            + '👤 *Applicant:* {{2}}\n🏢 *Applying as:* {{3}}\n🏘 *Block:* {{4}}\n🏙 *District:* {{5}}\n🗺 *State:* {{6}}\n'
            + '🔖 *Reference:* {{7}}\n🗓 *Submitted on:* {{8}}\n\n👉 *Review it here:*\n{{9}}\n\nThank you for serving ACTIV.',
            ['admin name', 'applicant', 'applying as', 'block', 'district', 'state', 'reference', 'submitted on', 'review link'],
            ['Guindy Block Admin', 'Tharun Kumar', 'Business membership · Sri Lakshmi Enterprises', 'Guindy', 'Chennai',
                'Tamil Nadu', 'A1B2C3', '27 September 2026', 'https://activ.org.in/block-admin/approvals'])
    ];

    return { TEMPLATES, WHATSAPP_TEMPLATES, journeySteps };
};
