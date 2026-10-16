// Notices for a changed saved record. Financial outcomes are supplied only by
// verified provider paths; these renderers never infer that money moved.
module.exports = ({ appUrl, oneLine, esc, TPL }) => {
    const TEMPLATE = 'activ_record_update_v1';
    const clean = (value, max = 400) => oneLine(value, max);
    const notice = (ctx, { title, detail, facts = [], url, actionLabel, secondaryButton, event = false, warning = false }) => {
        const support = event ? 'events@activ.org.in' : 'member@activ.org.in';
        const link = String(url || appUrl(event ? '/events' : '/member/dashboard'));
        const safeLink = link.length <= 240 ? link : appUrl(event ? '/events' : '/member/dashboard');
        const summary = clean(detail);
        return {
            inApp: { title, message: detail, type: warning ? 'warning' : 'info' },
            email: {
                subject: title, title, preheader: summary, tone: warning ? 'warning' : 'info',
                bodyHtml: `<p style="margin:0;">${esc(detail)}</p>`, facts,
                secondaryButton,
                actionButton: { label: actionLabel || (event ? 'View event details' : 'View your membership'), url: safeLink }
            },
            whatsapp: {
                template: TEMPLATE,
                params: [clean(ctx.name || ctx.firstName || 'Member', 60), clean(title, 80), summary, safeLink, support],
                // Existing approved notices remain usable during Meta review.
                fallback: event
                    ? { template: TPL.event, params: [ctx.firstName || 'Member', clean(`${title}: ${detail}`, 300), ctx.whenLabel || 'the date shown in your event record'] }
                    : { template: TPL.status, params: [ctx.firstName || 'Member', 'updated', clean(`${title}: ${detail}`, 300)] },
                text: `${title}\n\n${detail}\n\n${safeLink}\nQueries: ${support}`
            }
        };
    };
    const paymentFailed = (ctx, event = false) => notice(ctx, {
        title: event ? 'Event payment attempt unsuccessful' : ctx.orderType === 'company_listing'
            ? 'Business publishing payment attempt unsuccessful' : 'Membership payment attempt unsuccessful',
        detail: `Your payment attempt${ctx.orderId ? ` for order ${ctx.orderId}` : ''} was not successful. `
            + 'Your payment has not been confirmed. Check the payment status before trying again. '
            + 'If your bank shows a debit, contact us with the payment reference.',
        facts: [
            { label: event ? 'Event' : 'Plan', value: event ? ctx.eventTitle : ctx.planName },
            { label: 'Order', value: ctx.orderId }, { label: 'Payment reference', value: ctx.paymentId },
            { label: 'Attempted amount', value: ctx.amountLabel }
        ],
        url: ctx.retryUrl || ctx.viewUrl || appUrl(event ? '/events' : '/payment/membership-plans'),
        actionLabel: 'View payment status', event, warning: true
    });
    return {
        TEMPLATES: {
            COMPANY_PAYMENT_CONFIRMED: ctx => notice(ctx, {
                title: 'Business publishing payment confirmed',
                detail: `Your payment${ctx.amountLabel ? ` of ${ctx.amountLabel}` : ''} for ${ctx.companyName || 'your business listing'} is confirmed. `
                    + 'Your business publishing plan is active. This payment does not change your membership ID or paid membership validity.',
                facts: [{ label: 'Business', value: ctx.companyName }, { label: 'Publishing plan', value: ctx.planName },
                    { label: 'Order', value: ctx.orderId }, { label: 'Payment reference', value: ctx.paymentId },
                    { label: 'Amount paid', value: ctx.amountLabel }],
                url: ctx.receiptUrl || appUrl('/member/dashboard'), actionLabel: 'View receipt'
            }),
            MEMBERSHIP_STATUS_CHANGED: ctx => notice(ctx, {
                title: ctx.changeTitle || 'Membership request updated',
                detail: ctx.changeSummary || ctx.reason || 'The membership office updated your record. Open your dashboard to review the current status.',
                facts: [{ label: 'Reference', value: ctx.reference }], url: appUrl('/member/dashboard')
            }),
            EVENT_UPDATED: ctx => notice(ctx, {
                title: `Event details updated: ${ctx.eventTitle || 'ACTIV event'}`,
                detail: `${ctx.changeSummary || 'The organiser updated the event details.'} `
                    + [ctx.whenLabel && `When: ${ctx.whenLabel}.`, (ctx.venueLabel || ctx.venue) && `Where: ${ctx.venueLabel || ctx.venue}.`]
                        .filter(Boolean).join(' ') + ' Please review the latest event information before attending.',
                facts: [{ label: 'Event', value: ctx.eventTitle }, { label: 'When', value: ctx.whenLabel },
                    { label: 'Where', value: ctx.venueLabel || ctx.venue }, { label: 'Booking', value: ctx.bookingRef },
                    { label: 'Booking status', value: ctx.bookingStatus }],
                url: ctx.viewUrl || ctx.eventUrl, event: true,
                secondaryButton: ctx.registerUrl ? { label: 'Open online registration', url: ctx.registerUrl } : undefined
            }),
            EVENT_CANCELLED: ctx => notice(ctx, {
                title: `${ctx.cancelledScope === 'registration' ? 'Registration cancelled' : 'Event cancelled'}: ${ctx.eventTitle || 'ACTIV event'}`,
                detail: `${ctx.reason || 'The organiser has withdrawn this event.'} `
                    + 'This notice does not confirm a refund. Contact the events team for any payment questions.',
                facts: [{ label: 'Event', value: ctx.eventTitle }, { label: 'Scheduled for', value: ctx.whenLabel },
                    { label: 'Booking', value: ctx.bookingRef }],
                url: ctx.viewUrl || ctx.eventUrl, event: true, warning: true
            }),
            PAYMENT_FAILED: ctx => paymentFailed(ctx),
            EVENT_PAYMENT_FAILED: ctx => paymentFailed(ctx, true),
            MEMBERSHIP_PLAN_ADVANCED: ctx => notice(ctx, {
                title: `Your membership has advanced to ${ctx.planName || 'the next plan'}`,
                detail: `Congratulations! Your business now qualifies for ${ctx.planName || 'the next membership plan'}. `
                    + 'Your existing paid validity stays the same. No extra payment is due now; the new plan fee applies at renewal.',
                facts: [{ label: 'Member ID', value: ctx.membershipNumber },
                    { label: 'Previous plan', value: ctx.previousPlanName }, { label: 'Current plan', value: ctx.planName },
                    { label: 'Valid until', value: ctx.validUntilLabel }, { label: 'Fee at renewal', value: ctx.feeLabel },
                    { label: 'Plan benefits', value: (ctx.planFeatures || []).filter(Boolean).join(' · ') }],
                url: appUrl('/member/dashboard')
            })
        },
        WHATSAPP_TEMPLATES: [{
            name: TEMPLATE, meta: true, category: 'Utility', footer: require('./organizationBrand').FOOTER,
            bodyWithVariables: 'Dear {{1}},\n\n*Update to your ACTIV record*\n{{2}}\n\n*Details*\n{{3}}\n\nView your record: {{4}}\n\nFor questions about this update, contact {{5}}.\n\nThis notification relates to your existing ACTIV account or event registration.',
            params: ['name', 'update title', 'update details', 'record link', 'queries email'],
            samples: ['Test member', 'Event details updated: Business workshop',
                'The workshop now starts at 11 AM IST on 20 October 2026. Please review the updated schedule before attending.',
                'https://activ.org.in/events', 'events@activ.org.in']
        }]
    };
};
