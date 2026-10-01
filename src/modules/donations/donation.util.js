/**
 * Pure helpers for donations — no database, so `tests/donations.test.js` can
 * check every rule a tax officer will read on a receipt.
 */

const MIN_AMOUNT = 100;          // rupees
const MAX_AMOUNT = 1000000;      // ₹10,00,000
const PAN_RX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The Indian financial year a moment belongs to, as `2026-27`.
 *
 * April to March, judged on the IST calendar: a donation at 11:30 pm IST on
 * 31 March is 6 pm UTC the same day and belongs to the OLD year; one at
 * 00:30 am IST on 1 April is still 31 March in UTC and belongs to the NEW one.
 * Reading the UTC month would put that second donation in the wrong year.
 */
const financialYearOf = (value = new Date()) => {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    const year = ist.getUTCFullYear();
    const start = ist.getUTCMonth() >= 3 ? year : year - 1; // month 3 = April
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

/**
 * The instant the IST calendar month containing `value` began. "This month"
 * on the donations summary rolls at IST midnight on the 1st, not at the
 * server's local midnight (05:30 IST on a server running in UTC).
 */
const istMonthStart = (value = new Date()) => {
    const d = new Date(value);
    const at = Number.isNaN(d.getTime()) ? new Date() : d;
    const ist = new Date(at.getTime() + IST_OFFSET_MS);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS);
};

const isFinancialYear = (fy) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(fy || ''));
    return !!m && (Number(m[1]) + 1) % 100 === Number(m[2]);
};

/** 1 April 00:00 IST .. 1 April next year 00:00 IST (exclusive), as real instants. */
const financialYearBounds = (fy) => {
    if (!isFinancialYear(fy)) return null;
    const start = Number(String(fy).slice(0, 4));
    return {
        start: new Date(Date.UTC(start, 3, 1) - IST_OFFSET_MS),
        end: new Date(Date.UTC(start + 1, 3, 1) - IST_OFFSET_MS)
    };
};

/** Has this financial year finished (so its statement is final)? */
const financialYearEnded = (fy, now = new Date()) => {
    const b = financialYearBounds(fy);
    return !!b && new Date(now).getTime() >= b.end.getTime();
};

/** `ACTIV-DON-2026-27-001`; the 1000th is `-1000` — padding never truncates. */
const receiptNumberFor = (fy, seq) => `ACTIV-DON-${fy}-${String(seq).padStart(3, '0')}`;

const statementNumberFor = (fy, donorId) =>
    `ACTIV-DON-ST-${fy}-${String(donorId || '').slice(-6).toUpperCase()}`;

const isValidPan = (pan) => PAN_RX.test(String(pan || '').trim().toUpperCase());

/** Whole rupees within bounds, else an error sentence. */
const checkAmount = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: 'Enter the amount in whole rupees.' };
    if (n < MIN_AMOUNT) return { ok: false, error: `The smallest donation is ₹${MIN_AMOUNT}.` };
    if (n > MAX_AMOUNT) return { ok: false, error: 'For a donation above ₹10,00,000 please contact the ACTIV office.' };
    return { ok: true, amount: n };
};

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const belowHundred = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const belowThousand = (n) => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
};

/** Indian numbering: 1,50,000 -> "Rupees One Lakh Fifty Thousand Only". Paise are dropped. */
const amountInWords = (value) => {
    let n = Math.floor(Math.abs(Number(value) || 0));
    if (!n) return 'Rupees Zero Only';
    const parts = [];
    const crore = Math.floor(n / 10000000); n %= 10000000;
    const lakh = Math.floor(n / 100000); n %= 100000;
    const thousand = Math.floor(n / 1000); n %= 1000;
    if (crore) parts.push(`${crore >= 100 ? belowThousand(crore) : belowHundred(crore)} Crore`);
    if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
    if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
    if (n) parts.push(belowThousand(n));
    return `Rupees ${parts.join(' ')} Only`;
};

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;

module.exports = {
    MIN_AMOUNT, MAX_AMOUNT, PAN_RX,
    financialYearOf, isFinancialYear, istMonthStart, financialYearBounds, financialYearEnded,
    receiptNumberFor, statementNumberFor, isValidPan, checkAmount, amountInWords,
    toPaise, toRupees
};
