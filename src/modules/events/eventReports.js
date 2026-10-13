const { createWorkbook, text, label, number, formatDateIST } = require('../../core/utils/spreadsheet');

const summaryColumns = [{ key: 'item', header: 'Report detail', width: 32 }, { key: 'value', header: 'Value', width: 65 }];
const money = value => '₹ ' + number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bookingColumns = [
    { key: 'serial', header: 'S. No.', type: 'number', width: 9 },
    { key: 'reference', header: 'Booking reference', width: 29 },
    { key: 'bookedAt', header: 'Booked on (IST)', type: 'date', width: 27 },
    { key: 'name', header: 'Booked by', width: 28 },
    { key: 'phone', header: 'Mobile number', width: 20 },
    { key: 'email', header: 'Email address', width: 34 },
    { key: 'member', header: 'Registration type', width: 19 },
    { key: 'seats', header: 'Participants', type: 'number', width: 14 },
    { key: 'unitAmount', header: 'Price per person (INR)', type: 'money', width: 23 },
    { key: 'totalAmount', header: 'Booking amount (INR)', type: 'money', width: 23 },
    { key: 'received', header: 'Amount received (INR)', type: 'money', width: 23 },
    { key: 'paymentMode', header: 'Payment mode', width: 18 },
    { key: 'paymentStatus', header: 'Payment status', width: 18 },
    { key: 'status', header: 'Booking status', width: 18 },
    { key: 'paidAt', header: 'Paid on (IST)', type: 'date', width: 27 },
    { key: 'paymentReference', header: 'Payment / receipt reference', width: 30 },
    { key: 'rate', header: 'Rate applied', width: 18 },
    { key: 'cancelledAt', header: 'Cancelled on (IST)', type: 'date', width: 27 },
    { key: 'note', header: 'Office notes', width: 38 },
    { key: 'recordState', header: 'Record state', width: 18 }
];

async function bookingsWorkbook(event, bookings, { events = [], filters = {} } = {}) {
    const title = event?.title || (events.length ? 'Filtered booking details' : bookings[0]?.eventTitle) || 'Event bookings';
    const byId = new Map(events.map(row => [String(row._id), row]));
    const questions = [...new Map(bookings.flatMap(row => (row.responses || []).map(answer => [answer.key, answer.label || answer.key]))).entries()];
    const contextColumns = [
        { key: 'eventTitle', header: 'Event', width: 38 }, { key: 'eventDate', header: 'Event date (IST)', type: 'date', width: 26 },
        { key: 'history', header: 'Booking history', width: 16 }, { key: 'category', header: 'Category', width: 22 },
        { key: 'eventMode', header: 'Online / offline', width: 18 }, { key: 'language', header: 'Event language', width: 20 },
        { key: 'state', header: 'Event state', width: 24 }, { key: 'venue', header: 'Venue', width: 32 },
    ];
    const eventValues = row => {
        const source = event || byId.get(String(row.eventId)) || { bookingHistoryOnly: true };
        return { eventTitle: source.title || row.eventTitle, eventDate: source.startAt || row.eventStartAt,
            history: label(require('./eventLifecycle').bookingHistoryCategory(source)), category: source.category,
            eventMode: label(source.mode), language: source.language, state: source.state, venue: source.venue || row.eventVenue };
    };
    const rows = bookings.map((row, index) => ({
        ...eventValues(row),
        ...Object.fromEntries(questions.map(([key], i) => ['answer' + i, (row.responses || []).find(answer => answer.key === key)?.value || ''])),
        serial: index + 1, reference: row.bookingRef, bookedAt: row.createdAt,
        name: row.bookedBy?.name, phone: row.bookedBy?.phone, email: row.bookedBy?.email,
        member: row.isGuest ? 'Guest' : 'Member', seats: row.noOfPersons,
        unitAmount: row.unitAmount, totalAmount: row.totalAmount,
        received: row.payment?.status === 'paid' ? number(row.totalAmount) : 0,
        paymentMode: label(row.payment?.mode), paymentStatus: label(row.payment?.status),
        status: label(row.status), recordState: row.deletedAt ? 'Archived' : 'Current',
        paidAt: row.payment?.paidAt, paymentReference: row.payment?.gatewayPaymentId || row.payment?.reference,
        rate: row.memberRateApplied ? 'Member price' : 'Standard price', cancelledAt: row.cancelledAt, note: row.note
    }));
    const people = [];
    bookings.forEach(row => {
        const count = Math.max((row.participants || []).length, 1);
        for (let index = 0; index < count; index += 1) {
            let person = row.participants?.[index] || {};
            const hasDetails = value => [value.name, value.phone, value.email].some(item => text(item));
            if (index === 0 && !hasDetails(person)) person = row.bookedBy || {};
            // Older bookings may contain empty seats. Keep the seat total on
            // Bookings, without inventing blank contact rows in Participants.
            if (!hasDetails(person)) continue;
            people.push({
                ...eventValues(row),
                serial: people.length + 1, reference: row.bookingRef, seat: index + 1,
                name: person.name, phone: person.phone, email: person.email, bookedBy: row.bookedBy?.name,
                status: label(row.status), recordState: row.deletedAt ? 'Archived' : 'Current', payment: label(row.payment?.status)
            });
        }
    });
    const paid = rows.filter(row => row.paymentStatus === 'Paid');
    return createWorkbook({ name: title + '-registrations', sheets: [
        { name: 'Summary', title: 'Event registration report', subtitle: title, columns: summaryColumns, rows: [
            { item: 'Event', value: title },
            { item: 'Event date and time (IST)', value: formatDateIST(event?.startAt || bookings[0]?.eventStartAt) },
            { item: 'Venue', value: text(event?.venue || bookings[0]?.eventVenue) },
            { item: 'Total bookings', value: rows.length },
            { item: 'Seats booked', value: rows.reduce((sum, row) => sum + number(row.seats), 0) },
            { item: 'Participant records', value: people.length },
            { item: 'Historical seats without participant details', value: Math.max(0, rows.reduce((sum, row) => sum + number(row.seats), 0) - people.length) },
            { item: 'Paid bookings', value: paid.length },
            { item: 'Amount received', value: money(rows.reduce((sum, row) => sum + row.received, 0)) },
            { item: 'Filters', value: Object.entries(filters).map(([key, value]) => key + ': ' + value).join(' · ') || 'All records for this event, including archived booking records.' },
            { item: 'Using this workbook', value: 'Bookings: one financial row per booking. Participants: one row per person; no duplicated booking amounts.' },
            { item: 'Payment totals', value: 'Amount received includes paid bookings even if later cancelled. Cancellation does not indicate a refund.' }
        ] },
        { name: 'Bookings', title: 'Event bookings', subtitle: title + ' · One row per booking. Amount received counts paid records only.',
            columns: [...bookingColumns, ...contextColumns, ...questions.map(([, label], i) => ({ key: 'answer' + i, header: 'Registration: ' + label, width: 28 }))], rows },
        { name: 'Participants', title: 'Event participants', subtitle: title + ' · All participant records linked by booking reference.', columns: [
            { key: 'serial', header: 'S. No.', type: 'number', width: 9 },
            { key: 'reference', header: 'Booking reference', width: 29 },
            { key: 'seat', header: 'Participant no.', type: 'number', width: 16 },
            { key: 'name', header: 'Participant name', width: 28 },
            { key: 'phone', header: 'Mobile number', width: 20 },
            { key: 'email', header: 'Email address', width: 34 },
            { key: 'bookedBy', header: 'Booked by', width: 28 },
            { key: 'status', header: 'Booking status', width: 18 },
            { key: 'payment', header: 'Payment status', width: 18 },
            { key: 'recordState', header: 'Record state', width: 18 }, ...contextColumns
        ], rows: people }
    ] });
}

async function attendanceWorkbook(data, includeContact) {
    return createWorkbook({ name: data.event.title + '-attendance', sheets: [{
        name: 'Attendance', title: 'Event attendance', subtitle: data.event.title + ' · ' + data.rows.length + ' attendee records · ' + (includeContact ? 'Super Admin contact report' : 'Staff report with contact details masked'),
        columns: [
            { key: 'serial', header: 'S. No.', type: 'number', width: 9 },
            { key: 'registrationNo', header: 'Registration number', width: 30 },
            { key: 'bookingRef', header: 'Booking reference', width: 29 },
            { key: 'participantNumber', header: 'Participant no.', type: 'number', width: 16 },
            { key: 'name', header: 'Attendee name', width: 28 },
            ...(includeContact ? [
                { key: 'phone', header: 'Mobile number', width: 20 },
                { key: 'email', header: 'Email address', width: 34 }
            ] : [{ key: 'phoneMasked', header: 'Mobile (last 4 digits)', width: 22 }]),
            { key: 'bookedBy', header: 'Booked by', width: 28 },
            { key: 'payment', header: 'Payment status', width: 18 },
            { key: 'attendance', header: 'Attendance status', width: 26 },
            { key: 'admittedAt', header: 'Checked in on (IST)', type: 'date', width: 27 },
            { key: 'admittedBy', header: 'Admitted by', width: 28 },
            { key: 'method', header: 'Check-in method', width: 18 }
        ],
        rows: data.rows.map((row, index) => ({
            ...row, serial: index + 1,
            attendance: row.checkedIn ? (row.bookingStatus === 'changed' ? 'Checked in (booking changed)' : 'Checked in') : 'Not yet checked in',
            method: row.method === 'manual' ? 'Manual entry' : row.method ? 'QR scan' : ''
        }))
    }] });
}

module.exports = { bookingsWorkbook, attendanceWorkbook };
