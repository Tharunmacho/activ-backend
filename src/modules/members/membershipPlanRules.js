// Shared business-year rules for office admission, checkout and member progression.
const currentYear = (now = new Date()) => new Date(new Date(now).getTime() + 330 * 60000).getUTCFullYear();
const validYear = (value, now) => /^\d{4}$/.test(String(value || '')) && Number(value) >= 1800 && Number(value) <= currentYear(now);
const businessPlans = plans => plans.filter(p => p.active !== false && p.audience === 'business')
    .slice().sort((a, b) => Number(a.minYears || 0) - Number(b.minYears || 0) || a.key.localeCompare(b.key));
const entryPlan = plans => businessPlans(plans).find(p => Number(p.minYears || 0) === 0);
const matchesYear = (plan, value, now) => validYear(value, now)
    && currentYear(now) - Number(value) >= Number(plan.minYears || 0)
    && (plan.maxYears == null || currentYear(now) - Number(value) < Number(plan.maxYears));
const withYears = (plan, now) => {
    if (!plan) return null;
    const newest = currentYear(now) - Number(plan.minYears || 0);
    const oldest = plan.maxYears == null ? 1800 : Math.max(1800, currentYear(now) - Number(plan.maxYears) + 1);
    const commencementYears = plan.audience === 'business' ? Array.from({ length: Math.max(0, newest - oldest + 1) }, (_, i) => String(newest - i)) : [];
    return { ...plan, id: plan.key, commencementYears,
        commencementYearLabel: !commencementYears.length ? '' : plan.maxYears == null ? `${newest} or earlier` : `${oldest}–${newest}` };
};
const context = (member = {}, business, paid, plans = []) => {
    const held = plans.find(p => p.key === paid?.planId);
    const paidKind = paid?.upgradeKind || paid?.planAudience || held?.audience;
    const declared = business?.doingBusiness === true ? 'business' : business?.registrationType || member.memberType || member.registrationType;
    const kind = ['business', 'student', 'aspirant'].includes(paidKind) ? paidKind
        : ['business', 'student', 'aspirant'].includes(declared) ? declared : 'aspirant';
    return { kind, held, commencementYear: String(business?.businessCommencementYear || business?.commencementYear || paid?.membershipCommencementYear || paid?.upgradeCommencementYear || '') };
};
function officeOptions(member, business, paid, plans, now) {
    const info = context(member, business, paid, plans);
    const active = plans.filter(p => p.active !== false && p.audience === info.kind);
    let choices = active;
    if (info.kind === 'business') {
        choices = validYear(info.commencementYear, now) ? active.filter(p => matchesYear(p, info.commencementYear, now))
            : info.held ? active.filter(p => p.key === info.held.key) : businessPlans(active);
    }
    return { kind: info.kind, commencementYear: info.commencementYear,
        plans: choices.map(p => withYears(p, now)), requiresCommencementYear: info.kind === 'business' };
}
function progression(member, business, paid, plans, now) {
    const info = context(member, business, paid, plans);
    const bands = businessPlans(plans);
    const held = info.held;
    const matched = info.kind === 'business' ? bands.find(p => matchesYear(p, info.commencementYear, now)) : null;
    // Only progress a paid business membership forwards; profile edits cannot
    // convert a paid student/aspirant into a business member without payment.
    const promoted = !!paid && !!held && info.kind === 'business' && !!matched && Number(matched.minYears || 0) > Number(held.minYears || 0);
    const effective = promoted ? matched : held;
    const next = info.kind === 'business' && effective ? bands.find(p => Number(p.minYears || 0) > Number(effective.minYears || 0)) : bands[0];
    return { ...info, effective, promoted, next,
        nextEligibleYear: next && info.kind === 'business' && validYear(info.commencementYear, now) ? Number(info.commencementYear) + Number(next.minYears || 0) : null };
}
module.exports = { currentYear, validYear, matchesYear, withYears, businessPlans, entryPlan, context, officeOptions, progression };
