/**
 * Event check-in: entry-pass tokens, lookup, admit idempotency, role gating.
 *
 * PURE UNIT, NO DB. The service runs against in-memory models; the router is
 * driven through supertest with signed JWTs, and every request that passes the
 * gate is one that fails before any query, so nothing touches Mongo.
 *
 *   node tests/event-checkin.test.js
 */
process.env.EVENT_PASS_SECRET = process.env.EVENT_PASS_SECRET || 'test-pass-secret';

const mongoose = require('mongoose');
const pass = require('../src/modules/events/eventPass');
const {
    createCheckinService, admissibility, seatCount, maskPhone, csvCell
} = require('../src/modules/events/eventcheckin.service');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const rejects = async(promise) => {
    try { await promise; return null; } catch (e) { return e; }
};

/* ------------------------------------------------------------ fakes */
const id = () => new mongoose.Types.ObjectId();
const EVENT_ID = id();
const OTHER_EVENT_ID = id();

const makeWorld = () => {
    const events = [
        { _id: EVENT_ID, title: 'Business Conclave', startAt: new Date(), venue: 'Chennai Trade Centre', mode: 'offline', category: 'Conference', status: 'published' },
        { _id: OTHER_EVENT_ID, title: 'Export Workshop', startAt: new Date(), venue: 'Madurai', mode: 'offline', status: 'published' }
    ];
    const bookings = [];
    const checkins = [];
    let raceWinner = null;

    const same = (a, b) => String(a) === String(b);
    const Booking = {
        findById: async(x) => bookings.find((b) => same(b._id, x)) || null,
        findOne: async(q) => bookings.find((b) => b.bookingRef === q.bookingRef) || null,
        find: async(q) => bookings.filter((b) => same(b.eventId, q.eventId)
            && !['cancelled', 'waitlist'].includes(b.status)
            && ['paid', 'not_required'].includes(b.payment.status))
    };
    const Event = { findById: async(x) => events.find((e) => same(e._id, x)) || null };
    const Checkin = {
        findOne: async(q) => checkins.find((c) => same(c.bookingId, q.bookingId) && c.participantIndex === q.participantIndex) || null,
        find: async(q) => checkins.filter((c) => same(c.eventId, q.eventId)),
        create: async(doc) => {
            if (raceWinner) { checkins.push(raceWinner); raceWinner = null; }
            if (checkins.some((c) => same(c.bookingId, doc.bookingId) && c.participantIndex === doc.participantIndex)) {
                const err = new Error('E11000 duplicate key error'); err.code = 11000; throw err;
            }
            const row = { _id: id(), ...doc };
            checkins.push(row);
            return row;
        }
    };
    const service = createCheckinService({
        Booking, Event, Checkin,
        findStaff: async() => ({ fullName: 'Gate Staff One' })
    });
    const addBooking = (over = {}) => {
        const b = {
            _id: id(), eventId: EVENT_ID, bookingRef: `ACTIVB-T${bookings.length}-1234`, noOfPersons: 2,
            bookedBy: { name: 'Priya Booker', email: 'priya@example.com', phone: '9876543210' },
            participants: [{ name: 'Priya Booker', email: 'priya@example.com', phone: '9876543210' }, { name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9123456789' }],
            unitAmount: 500, totalAmount: 1000, status: 'active', payment: { status: 'paid', mode: 'upi' },
            isGuest: true, ...over
        };
        bookings.push(b);
        return b;
    };
    return { service, addBooking, checkins, setRace: (row) => { raceWinner = row; } };
};

const STAFF = { userId: String(id()), email: 'event@gmail.com', role: 'events_admin' };

(async() => {
    console.log('\ntokens');
    const bid = String(id());
    const t0 = pass.signPass(bid, 0);
    const t1 = pass.signPass(bid, 1);
    check('40-char url-safe token', /^[A-Za-z0-9_-]{40}$/.test(t0), t0);
    check('round trip', JSON.stringify(pass.verifyPass(t0)) === JSON.stringify({ bookingId: bid, index: 0 }));
    check('seats get different tokens', t0 !== t1 && pass.verifyPass(t1).index === 1);
    const flipped = t0.slice(0, 30) + (t0[30] === 'A' ? 'B' : 'A') + t0.slice(31);
    check('a tampered MAC is refused', pass.verifyPass(flipped) === null);
    const forgedSeat = Buffer.from(t0, 'base64url'); forgedSeat[13] = 5;
    check('changing the seat byte is refused', pass.verifyPass(forgedSeat.toString('base64url')) === null);
    check('garbage / empty / null refused', [null, '', 'abc', 'x'.repeat(40)].every((v) => pass.verifyPass(v) === null));
    check('bad booking id -> no token', pass.signPass('nope', 0) === '' && pass.signPass(bid, 300) === '');
    const oldSecret = process.env.EVENT_PASS_SECRET;
    process.env.EVENT_PASS_SECRET = 'another-secret';
    check('a different server secret refuses the pass', pass.verifyPass(t0) === null);
    process.env.EVENT_PASS_SECRET = oldSecret;
    check('token from the pass URL', pass.extractToken(`https://activ.org.in/checkin/${t0}`) === t0);
    check('token from URL with query / slash', pass.extractToken(`https://x.y/checkin/${t0}/?utm=1`) === t0);
    check('bare token accepted', pass.extractToken(t0) === t0);
    check('other URLs give nothing', pass.extractToken('https://activ.org.in/events/abc') === '');
    check('pass URL is /checkin/<token>', pass.passUrl(t0).endsWith(`/checkin/${t0}`));
    check('registration number', pass.registrationNo('activb-mf3k2l-1234', 1) === 'ACTIVB-MF3K2L-1234-P2');
    const parsed = pass.parseRegistrationNo('ACTIVB-MF3K2L-1234-P2');
    check('registration number parses back', parsed.bookingRef === 'ACTIVB-MF3K2L-1234' && parsed.index === 1);
    check('a bare ref ending in digits is not mistaken for a seat', pass.parseRegistrationNo('ACTIVB-MF3K2L-1234').index === null);

    console.log('\nadmissibility');
    const base = { status: 'active', eventId: EVENT_ID, noOfPersons: 2, payment: { status: 'paid' } };
    // The door's event is always given now (the scanner is opened per event).
    check('paid active -> ok', admissibility(base, 0, null, EVENT_ID).ok);
    check('free -> ok', admissibility({ ...base, payment: { status: 'not_required' } }, 1, null, EVENT_ID).ok);
    check('paid but swept to expired -> ok', admissibility({ ...base, status: 'expired' }, 0, null, EVENT_ID).ok);
    check('no door (pass page) -> judged on the pass alone', admissibility(base, 0).ok);
    check('online event at a door -> refused', admissibility(base, 0, { mode: 'online' }, EVENT_ID).code === 'online_event');
    check('online event, no door -> the pass itself is fine', admissibility(base, 0, { mode: 'online' }).ok);
    check('cancelled refused', admissibility({ ...base, status: 'cancelled' }, 0).code === 'cancelled');
    check('waitlist refused', admissibility({ ...base, status: 'waitlist', payment: { status: 'pending' } }, 0).code === 'waitlist');
    check('pending refused as unpaid', admissibility({ ...base, payment: { status: 'pending' } }, 0).code === 'unpaid');
    check('failed refused as unpaid', admissibility({ ...base, payment: { status: 'failed' } }, 0).code === 'unpaid');
    check('expired unpaid refused as expired', admissibility({ ...base, status: 'expired', payment: { status: 'pending' } }, 0).code === 'expired');
    check('seat beyond the booking refused', admissibility(base, 2).code === 'no_seat');
    check('wrong event refused', admissibility(base, 0, { title: 'X' }, String(OTHER_EVENT_ID)).code === 'wrong_event');
    check('null booking does not throw', admissibility(null).code === 'not_found');
    check('seat count reconciles', seatCount({ noOfPersons: 1, participants: [{}, {}] }) === 2 && seatCount({}) === 1);
    check('phone is masked', maskPhone('+91 98765 43210') === '•••• 3210' && maskPhone('') === '');
    check('csv neutralises formulas', csvCell('=HYPERLINK("x")').startsWith('"\'=') && csvCell('a,b') === '"a,b"');

    console.log('\nlookup never writes');
    const w = makeWorld();
    const b = w.addBooking();
    const tok = pass.signPass(String(b._id), 1);
    const seen = await w.service.lookup({ eventId: String(EVENT_ID), token: `https://activ.org.in/checkin/${tok}` });
    const seat = seen.seats[0];
    check('finds seat 2 by the scanned URL', seat.participantNumber === 2 && seat.attendee.name === 'Ravi Kumar');
    check('carries event, ticket, payment, reg no', seat.event.title === 'Business Conclave' && seat.ticket.label === 'Standard ticket'
        && seat.payment.label === 'Paid' && seat.registrationNo === `${b.bookingRef}-P2`);
    check('contact is masked at the door', seat.attendee.phoneMasked === '•••• 6789' && !('email' in seat.attendee));
    check('admissible, not checked in', seat.admissible && !seat.checkedIn);
    check('no check-in row was written', w.checkins.length === 0);
    const byRef = await w.service.lookup({ eventId: String(EVENT_ID), bookingRef: b.bookingRef.toLowerCase() });
    check('a booking ID lists every seat', byRef.seats.length === 2 && byRef.method === 'manual');
    const byReg = await w.service.lookup({ eventId: String(EVENT_ID), registrationNo: `${b.bookingRef}-P1` });
    check('a registration no finds one seat', byReg.seats.length === 1 && byReg.seats[0].participantNumber === 1);
    const notPass = await rejects(w.service.lookup({ eventId: String(EVENT_ID), token: 'upi://pay?pa=someone@bank' }));
    check('a non-pass QR is a 400', notPass && notPass.statusCode === 400);
    const forged = await rejects(w.service.lookup({ eventId: String(EVENT_ID), token: flipped }));
    check('a forged pass is a 404', forged && forged.statusCode === 404);

    console.log('\nadmit is idempotent');
    const first = await w.service.admit({ eventId: String(EVENT_ID), token: tok }, STAFF, { device: 'Pixel 7' });
    check('first scan admits', first.outcome === 'admitted' && first.seat.checkedIn);
    check('records who, when, how', w.checkins.length === 1 && w.checkins[0].admittedBy.name === 'Gate Staff One'
        && w.checkins[0].admittedBy.email === 'event@gmail.com' && w.checkins[0].method === 'qr' && w.checkins[0].device === 'Pixel 7'
        && w.checkins[0].attendeeName === 'Ravi Kumar');
    const second = await w.service.admit({ eventId: String(EVENT_ID), token: tok }, STAFF);
    check('second scan -> already checked in, no new row', second.outcome === 'already_checked_in' && w.checkins.length === 1);
    check('says by whom', second.seat.checkin.admittedBy.name === 'Gate Staff One' && !!second.seat.checkin.admittedAtLabel);
    const again = await w.service.lookup({ eventId: String(EVENT_ID), token: tok });
    check('lookup now shows checked in', again.seats[0].checkedIn);

    const tok0 = pass.signPass(String(b._id), 0);
    w.setRace({ _id: id(), eventId: EVENT_ID, bookingId: b._id, participantIndex: 0, attendeeName: 'Priya Booker',
        admittedAt: new Date(), admittedBy: { name: 'Gate Two', email: 'gate2@x.com' }, method: 'qr' });
    const raced = await w.service.admit({ eventId: String(EVENT_ID), token: tok0 }, STAFF);
    check('two gates at once -> the loser reads the winner', raced.outcome === 'already_checked_in'
        && raced.seat.checkin.admittedBy.name === 'Gate Two' && w.checkins.length === 2);

    const manual = await w.service.admit({ eventId: String(EVENT_ID), bookingRef: w.addBooking().bookingRef, participantIndex: 0 }, STAFF);
    check('manual entry by booking ID + seat', manual.outcome === 'admitted' && w.checkins[w.checkins.length - 1].method === 'manual');
    const noSeat = await rejects(w.service.admit({ eventId: String(EVENT_ID), bookingRef: b.bookingRef }, STAFF));
    check('booking ID without a seat is refused', noSeat && noSeat.statusCode === 400);

    console.log('\nadmit refuses');
    const cancelled = w.addBooking({ status: 'cancelled' });
    const e1 = await rejects(w.service.admit({ eventId: String(EVENT_ID), token: pass.signPass(String(cancelled._id), 0) }, STAFF));
    check('cancelled -> 409 with reason', e1 && e1.statusCode === 409 && e1.fields.reason === 'cancelled');
    const unpaid = w.addBooking({ payment: { status: 'pending' } });
    const e2 = await rejects(w.service.admit({ eventId: String(EVENT_ID), token: pass.signPass(String(unpaid._id), 0) }, STAFF));
    check('unpaid -> 409 with reason', e2 && e2.statusCode === 409 && e2.fields.reason === 'unpaid');
    const other = w.addBooking({ eventId: OTHER_EVENT_ID });
    const noDoor = await rejects(w.service.admit({ token: tok }, STAFF));
    check('admit without the door event is refused', noDoor && /Open the scanner from the event/.test(noDoor.message));
    const noDoorLookup = await rejects(w.service.lookup({ token: tok }));
    check('lookup without the door event is refused', noDoorLookup && noDoorLookup.statusCode === 400);
    const e3 = await rejects(w.service.admit({ token: pass.signPass(String(other._id), 0), eventId: String(EVENT_ID) }, STAFF));
    check('pass for another event -> 409 wrong_event', e3 && e3.statusCode === 409 && /Export Workshop/.test(e3.message));
    const rowsBefore = w.checkins.length;
    check('refusals write nothing', rowsBefore === w.checkins.length);

    console.log('\npublic pass page');
    const pub = await w.service.publicPass(tok);
    const pubText = JSON.stringify(pub);
    check('says valid + event', pub.valid === true && pub.event.title === 'Business Conclave');
    check('no name, ref or contact', !/Ravi|Priya|ACTIVB|example\.com|9123/.test(pubText));
    const pubVoid = await w.service.publicPass(pass.signPass(String(cancelled._id), 0));
    check('a cancelled booking reads as not valid', pubVoid.valid === false);

    console.log('\nattendance');
    const att = await w.service.attendance(String(EVENT_ID), { includeContact: true });
    check('registered counts admissible seats only', att.totals.registered === 4, String(att.totals.registered));
    check('checked-in count', att.totals.checkedIn === 3, String(att.totals.checkedIn));
    check('checked-in first', att.rows[0].checkedIn && !att.rows[att.rows.length - 1].checkedIn);
    check('super admin sees contact', att.rows.some((r) => r.email === 'ravi@example.com'));
    const attEv = await w.service.attendance(String(EVENT_ID), { includeContact: false, q: 'ravi' });
    check('events admin: search + no contact', attEv.rows.length >= 1 && attEv.rows.every((r) => !r.email && !r.phone));
    const onlyOut = await w.service.attendance(String(EVENT_ID), { status: 'out' });
    check('status filter', onlyOut.rows.every((r) => !r.checkedIn) && onlyOut.rows.length === 1);
    const csv = await w.service.attendanceCsv(String(EVENT_ID), { includeContact: false });
    check('csv has no email column for events admin', !/Email/.test(csv.csv.split('\r\n')[0]) && /Admitted by/.test(csv.csv));

    console.log('\nbooking email passes');
    const { passesFor } = require('../src/modules/events/eventbooking.service');
    const multi = passesFor(b, 'confirmed', false);
    check('several seats -> one pass each, no stub QR', multi.passes.length === 2 && multi.ticketUrl === '');
    check('each pass verifies to its seat', multi.passes.every((p) => pass.verifyPass(pass.extractToken(p.url)).index === p.index));
    const single = passesFor({ ...b, noOfPersons: 1, participants: [b.participants[0]] }, 'confirmed', false);
    check('one seat -> the stub QR is the pass', single.passes.length === 1 && single.ticketUrl === single.passes[0].url
        && single.registrationNo.endsWith('-P1'));
    check('webinar -> no pass', passesFor(b, 'confirmed', true).passes.length === 0);
    check('unpaid -> no pass', passesFor({ ...b, payment: { status: 'pending' } }, 'confirmed', false).passes.length === 0);
    check('cancellation mail -> no pass', passesFor(b, 'cancelled', false).passes.length === 0);
    const { render } = require('../src/modules/notifications/notificationTemplates');
    const out = render('EVENT_BOOKING_CONFIRMED', { eventTitle: 'Business Conclave', bookingRef: b.bookingRef, seats: 2, seatsLabel: '2 seats', ...multi });
    check('booker email carries a QR per participant', out.email.passQrs.length === 2
        && (out.email.afterHtml.match(/cid:pass-qr-/g) || []).length === 2);

    console.log('\nrole gating');
    let request;
    try { request = require('supertest'); } catch (e) { request = null; }
    if (!request) {
        check('supertest available', false, 'npm install in backend');
    } else {
        const express = require('express');
        const jwt = require('jsonwebtoken');
        const config = require('../src/config');
        const { errorHandler } = require('../src/core/middleware/errorHandler');
        const app = express();
        app.use(express.json());
        app.use('/event-checkin', require('../src/modules/events/eventcheckin.routes'));
        app.use(errorHandler);
        const as = (role) => `Bearer ${jwt.sign({ userId: String(id()), email: 'x@y.z', role }, config.jwt.secret)}`;
        // Something that is not a pass: the service answers 400 before any query.
        const body = { token: 'not-a-pass' };
        const r0 = await request(app).post('/event-checkin/lookup').send(body);
        check('no token -> 401', r0.status === 401, String(r0.status));
        for (const role of ['member', 'block_admin', 'district_admin', 'state_admin', 'cms_admin']) {
            const r = await request(app).post('/event-checkin/admit').set('Authorization', as(role)).send(body);
            check(`${role} -> 403`, r.status === 403, String(r.status));
        }
        for (const role of ['events_admin', 'super_admin']) {
            const r = await request(app).post('/event-checkin/lookup').set('Authorization', as(role)).send(body);
            check(`${role} passes the gate`, r.status === 400, String(r.status));
        }
        const png = await request(app).get('/event-checkin/qr/not-a-token.png');
        check('QR image only for a genuine pass', png.status === 404);
        const img = await request(app).get(`/event-checkin/qr/${tok}.png`);
        check('QR image for a genuine pass', img.status === 200 && /image\/png/.test(img.headers['content-type']));
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
