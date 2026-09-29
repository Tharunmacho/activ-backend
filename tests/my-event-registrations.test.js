/**
 * A member's own events: Book Now bookings read as their registration.
 *
 * PURE UNIT, NO DB. The mapping and the ownership rule are what decide whether
 * a booked-and-paid member is shown "Registered" or offered "Book Now" again.
 *
 *   node tests/my-event-registrations.test.js
 */
const { bookingAsRegistration, ownerClause } = require('../src/modules/events/eventbooking.service');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

const base = {
    _id: 'b1', eventId: 'e1', userId: '', bookingRef: 'ACTIVB-X1', noOfPersons: 2, totalAmount: 1000,
    bookedBy: { name: 'Tharun', email: 'tharun@example.com', phone: '9876543210' },
    participants: [{ email: 'tharun@example.com' }, { email: 'friend@example.com' }],
    createdAt: new Date('2026-09-01'), expiresAt: new Date('2026-09-01T00:30:00Z'),
};

console.log('\nbooking -> myRegistration');
const paid = bookingAsRegistration({ ...base, status: 'active', payment: { status: 'paid', mode: 'upi', reference: 'P1' } });
check('paid active -> registered', paid.status === 'registered' && paid.payment.status === 'paid');
check('carries source + booking ref', paid.source === 'booking' && paid.bookingRef === 'ACTIVB-X1');
check('seats from noOfPersons', paid.seats === 2);
check('amount is the booking total', paid.payment.amount === 1000 && paid.payment.method === 'upi');
check('no expiry on a paid seat', paid.expiresAt === null);

const pending = bookingAsRegistration({ ...base, status: 'active', payment: { status: 'pending' } });
check('unpaid active -> registered + payment pending', pending.status === 'registered' && pending.payment.status === 'pending');
check('pending keeps its hold expiry', !!pending.expiresAt);

const free = bookingAsRegistration({ ...base, status: 'active', payment: { status: 'not_required' } });
check('free -> registered, not_required', free.status === 'registered' && free.payment.status === 'not_required');

const wait = bookingAsRegistration({ ...base, status: 'waitlist', payment: { status: 'pending' } });
check('waitlist -> waitlist', wait.status === 'waitlist');

const sweptPaid = bookingAsRegistration({ ...base, status: 'expired', payment: { status: 'paid' } });
check('paid but swept to expired -> still registered', sweptPaid.status === 'registered');

check('empty booking does not throw', bookingAsRegistration({}).status === 'registered');

console.log('\nwhose booking');
const both = ownerClause({ id: 'u1', email: 'Tharun@Example.com ' });
const keys = JSON.stringify(both);
check('matches by id', keys.includes('"userId":"u1"'));
check('matches booker email, lowercased', keys.includes('"bookedBy.email":"tharun@example.com"'));
check('matches participant email', keys.includes('"participants.email":"tharun@example.com"'));
check('a bare id still works', JSON.stringify(ownerClause('u9')) === JSON.stringify({ $or: [{ userId: 'u9' }] }));
check('nobody -> null (no query at all)', ownerClause({}) === null && ownerClause('') === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
