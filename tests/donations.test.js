/* Pure unit tests for donations — no database. `npm run test:donations` */
const U = require('../src/modules/donations/donation.util');

let passed = 0;
let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { passed++; console.log(`  ok    ${name}`); } else {
        failed++; console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
    }
};

console.log('financial year (IST, April-March)');
check('mid-year', U.financialYearOf('2026-09-29T06:00:00Z'), '2026-27');
check('31 Mar 23:30 IST is the old year', U.financialYearOf('2027-03-31T18:00:00Z'), '2026-27');
check('1 Apr 00:30 IST is the new year (still 31 Mar in UTC)', U.financialYearOf('2027-03-31T19:00:00Z'), '2027-28');
check('January belongs to the previous start year', U.financialYearOf('2027-01-15T06:00:00Z'), '2026-27');
check('century roll-over label', U.financialYearOf('2099-06-01T00:00:00Z'), '2099-00');
check('valid FY label', U.isFinancialYear('2026-27'), true);
check('invalid FY label', U.isFinancialYear('2026-28'), false);
const b = U.financialYearBounds('2026-27');
check('FY starts 1 Apr 00:00 IST', b.start.toISOString(), '2026-03-31T18:30:00.000Z');
check('FY ends 1 Apr next year 00:00 IST', b.end.toISOString(), '2027-03-31T18:30:00.000Z');
check('FY not ended on 31 Mar', U.financialYearEnded('2026-27', new Date('2027-03-31T18:29:59Z')), false);
check('FY ended on 1 Apr IST', U.financialYearEnded('2026-27', new Date('2027-03-31T18:30:00Z')), true);

console.log('numbers');
check('first receipt', U.receiptNumberFor('2026-27', 1), 'ACTIV-DON-2026-27-001');
check('42nd receipt', U.receiptNumberFor('2026-27', 42), 'ACTIV-DON-2026-27-042');
check('1000th receipt grows a digit', U.receiptNumberFor('2026-27', 1000), 'ACTIV-DON-2026-27-1000');
check('statement number', U.statementNumberFor('2026-27', '6a947616aadfbdb863b4bd34'), 'ACTIV-DON-ST-2026-27-B4BD34');

console.log('amount in words (Indian)');
check('1,000', U.amountInWords(1000), 'Rupees One Thousand Only');
check('500', U.amountInWords(500), 'Rupees Five Hundred Only');
check('2,500', U.amountInWords(2500), 'Rupees Two Thousand Five Hundred Only');
check('1,50,000', U.amountInWords(150000), 'Rupees One Lakh Fifty Thousand Only');
check('10,00,000', U.amountInWords(1000000), 'Rupees Ten Lakh Only');
check('1,23,45,678', U.amountInWords(12345678), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
check('11,019', U.amountInWords(11019), 'Rupees Eleven Thousand Nineteen Only');

console.log('PAN');
check('valid', U.isValidPan('ABCDE1234F'), true);
check('lower case is accepted (normalised)', U.isValidPan('abcde1234f'), true);
check('too short', U.isValidPan('ABCDE123F'), false);
check('digit in wrong place', U.isValidPan('ABCD11234F'), false);

console.log('amount bounds');
check('100 ok', U.checkAmount(100).ok, true);
check('99 refused', U.checkAmount(99).ok, false);
check('10,00,000 ok', U.checkAmount(1000000).ok, true);
check('10,00,001 refused', U.checkAmount(1000001).ok, false);
check('fraction refused', U.checkAmount(500.5).ok, false);
check('text refused', U.checkAmount('abc').ok, false);
check('numeric string ok', U.checkAmount('1000').amount, 1000);

console.log('paise');
check('to paise', U.toPaise(1000), 100000);
check('to rupees', U.toRupees(100000), 1000);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
