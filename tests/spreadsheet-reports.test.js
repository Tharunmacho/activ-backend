// Isolated workbook and route fixtures. No database connection or notifications.
process.env.JWT_SECRET = 'spreadsheet-test-secret-not-production';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { formatDateIST, excelDateIST, reportDay, csvCell, XLSX_MIME, HEADER_ROW } = require('../src/core/utils/spreadsheet');
const { bookingsWorkbook, attendanceWorkbook } = require('../src/modules/events/eventReports');
const { membershipWorkbook, selectRows } = require('../src/modules/admin/membershipReports');

const eventId = '507f1f77bcf86cd799439011';
const event = { title: 'ACTIV registration report', startAt: '2026-10-11T18:30:00Z', venue: 'Chennai', archivedAt: new Date() };
const base = {
    bookingRef: 'ACTIVB-SAMPLE-001', createdAt: '2026-10-11T18:35:00Z', isGuest: false,
    bookedBy: { name: 'தமிழ் Member', email: 'member@example.test', phone: '+919000000001' },
    noOfPersons: 2, unitAmount: 1000, totalAmount: 2000, status: 'active', note: '=HYPERLINK("https://invalid.test")',
    participants: [{ name: 'Attendee One', email: 'one@example.test', phone: '09000000001' },
        { name: 'Attendee Two', email: 'two@example.test', phone: '+91 90923 17264' }],
    payment: { status: 'paid', mode: 'upi', paidAt: '2026-10-12T07:30:00Z', gatewayPaymentId: 'MOJO-SAMPLE-001' },
    manageToken: 'must-never-appear-in-export'
};
const bookings = [base, { ...base, bookingRef: 'ACTIVB-SAMPLE-002', status: 'expired', payment: { status: 'failed' } },
    { ...base, bookingRef: 'ACTIVB-SAMPLE-003', status: 'cancelled', cancelledAt: '2026-10-12T08:00:00Z', deletedAt: new Date() }];
const load = async report => {
    assert.equal(report.mimeType, XLSX_MIME);
    assert.match(report.filename, /\.xlsx$/);
    assert.equal(report.buffer.subarray(0, 2).toString(), 'PK', 'report is a real zipped XLSX');
    return new ExcelJS.Workbook().xlsx.load(report.buffer);
};
const column = (sheet, title) => sheet.getRow(HEADER_ROW).values.indexOf(title);
const cell = (sheet, title, offset = 1) => sheet.getCell(HEADER_ROW + offset, column(sheet, title));

(async () => {
    assert.equal(formatDateIST('2026-10-11T18:30:00Z'), '12-10-2026 12:00 AM');
    assert.equal(formatDateIST('2026-10-12T06:30:00Z'), '12-10-2026 12:00 PM');
    assert.equal(formatDateIST('2026-10-12T16:59:00Z'), '12-10-2026 10:29 PM');
    assert.equal(formatDateIST('invalid'), '');
    assert.equal(formatDateIST(null), '');
    assert.equal(reportDay('2026-10-11T18:30:00Z'), '2026-10-12');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(excelDateIST('2026-10-11T18:35:00Z').toISOString(), '2026-10-12T00:05:00.000Z');
    assert.ok(csvCell('  =SUM(1,2)').startsWith('"\''));
    assert.equal(csvCell('09000000001', true), '"\'09000000001"');
    console.log('PASS: IST dates, midnight/noon AM/PM, server time-zone independence and safe CSV fallback.');

    const report = await bookingsWorkbook(event, bookings);
    const book = await load(report);
    assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['Summary', 'Bookings', 'Participants']);
    const sheet = book.getWorksheet('Bookings');
    assert.equal(sheet.rowCount - HEADER_ROW, 3, 'paid, failed and archived/cancelled bookings remain');
    assert.equal(cell(sheet, 'Mobile number').value, '+919000000001');
    assert.equal(cell(sheet, 'Mobile number').type, ExcelJS.ValueType.String);
    assert.equal(cell(sheet, 'Mobile number').numFmt, '@');
    assert.equal(cell(sheet, 'Office notes').value, base.note, 'formula-like text preserved exactly');
    assert.equal(cell(sheet, 'Office notes').formula, undefined);
    assert.equal(cell(sheet, 'Booked by').value, 'தமிழ் Member');
    assert.equal(cell(sheet, 'Booked on (IST)').value.toISOString(), '2026-10-12T00:05:00.000Z');
    assert.match(cell(sheet, 'Booked on (IST)').numFmt, /AM\/PM/);
    assert.equal(cell(sheet, 'Amount received (INR)').value, 2000);
    assert.equal(cell(sheet, 'Amount received (INR)', 2).value, 0, 'failed amount not counted as received');
    assert.equal(cell(sheet, 'Booking status', 3).value, 'Cancelled', 'archival does not overwrite original booking state');
    assert.equal(cell(sheet, 'Record state', 3).value, 'Archived');
    assert.equal(sheet.getRow(HEADER_ROW).getCell(2).font.bold, true);
    assert.equal(sheet.views[0].ySplit, HEADER_ROW);
    assert.equal(sheet.views[0].xSplit, 1);
    assert.ok(sheet.autoFilter);
    assert.ok(sheet.getColumn(column(sheet, 'Mobile number')).width >= 20);
    assert.ok(sheet.getColumn(column(sheet, 'Booked on (IST)')).width >= 27);
    const participants = book.getWorksheet('Participants');
    assert.equal(participants.rowCount - HEADER_ROW, 6);
    assert.equal(cell(participants, 'Mobile number').value, '09000000001');
    assert.equal(cell(participants, 'Mobile number', 2).value, '+91 90923 17264');
    assert.ok(!participants.getRow(HEADER_ROW).values.some(value => String(value).includes('Amount')), 'financial totals never repeated per participant');
    assert.ok(!JSON.stringify(book.model).includes(base.manageToken));
    console.log('PASS: readable XLSX headers/widths/frozen filters, exact phone text, numeric money, separate participants and complete evidence.');

    const attendance = { event, rows: [{ registrationNo: 'ACTIVB-SAMPLE-001-P1', bookingRef: base.bookingRef,
        participantNumber: 1, name: 'Door attendee', email: 'private@example.test', phone: '9000000001',
        phoneMasked: '•••• 7264', checkedIn: true, admittedAt: '2026-10-12T07:30:00Z',
        admittedBy: 'Gate staff', method: 'manual', payment: 'Paid' }] };
    const staff = (await load(await attendanceWorkbook(attendance, false))).getWorksheet('Attendance');
    assert.equal(cell(staff, 'Mobile (last 4 digits)').value, '•••• 7264');
    assert.ok(!JSON.stringify(staff.model).includes('private@example.test'));
    assert.ok(!JSON.stringify(staff.model).includes('9000000001'));
    const office = (await load(await attendanceWorkbook(attendance, true))).getWorksheet('Attendance');
    assert.equal(cell(office, 'Mobile number').value, '9000000001');
    assert.equal(cell(office, 'Checked in on (IST)').value.toISOString(), '2026-10-12T13:00:00.000Z');
    console.log('PASS: attendance contact permissions and clock time preserved.');

    const data = { rows: [{ name: 'Tamil Member', phone: '09000000001', memberNumber: 'ACTIV-2026-001',
        registeredAt: base.createdAt, lifetime: true, status: 'active', planName: 'Lifetime Membership', collected: 200000 }],
        payments: [{ name: 'Member', orderId: 'OFF-1', amount: 200000, status: 'paid', paidAt: base.createdAt },
            { name: 'Member', orderId: 'OFF-2', amount: 1000, status: 'failed' },
            { name: 'Deleted account', orderId: 'OFF-3', amount: 1000, status: 'paid', registrationDeleted: true }] };
    const members = (await load(await membershipWorkbook(data))).getWorksheet('Members');
    assert.equal(cell(members, 'Mobile number').value, '09000000001');
    assert.equal(cell(members, 'Valid until (IST)').value, 'Lifetime');
    assert.equal(cell(members, 'Amount received (INR)').value, 200000);
    assert.equal(selectRows(data, { tab: 'payments' }).rows.length, 2);
    assert.equal(selectRows(data, { tab: 'archived' }).rows.length, 1);
    assert.equal(selectRows(data, { tab: 'payments', filter: 'failed' }).rows[0].orderId, 'OFF-2');
    assert.equal(selectRows(data, { search: '09000000001' }).rows.length, 1);
    assert.throws(() => selectRows(data, { tab: 'other' }), /valid membership report/);
    const payments = (await load(await membershipWorkbook(data, { tab: 'payments' }))).getWorksheet('Payments');
    assert.equal(cell(payments, 'Amount received (INR)', 2).value, 0);
    console.log('PASS: membership filters, retained archived payments, Lifetime validity and received-only totals.');

    const bookingService = require('../src/modules/events/eventbooking.service');
    const Event = require('../src/modules/events/event.model');
    const Booking = require('../src/modules/events/eventbooking.model');
    Event.collection.findOne = async () => event;
    Booking.collection.find = (query, options) => {
        assert.equal(String(query.eventId), eventId);
        assert.equal(options.projection.manageToken, undefined);
        return { sort() { return this; }, toArray: async () => bookings };
    };
    const archived = await bookingService.exportBookingsXlsx(eventId);
    assert.equal((await load(archived)).getWorksheet('Bookings').rowCount - HEADER_ROW, 3);
    await assert.rejects(bookingService.exportBookingsXlsx('invalid'), /valid event id/);
    const memberService = require('../src/modules/admin/adminMembershipDashboard.service');
    await assert.rejects(memberService.overview({ role: 'events_admin' }), /Super Admin/);
    memberService.overview = async actor => { assert.equal(actor.role, 'super_admin'); return data; };
    const checkinService = require('../src/modules/events/eventcheckin.service');
    checkinService.liveService = () => ({ attendanceXlsx: async (id, options) => attendanceWorkbook(attendance, options.includeContact) });
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const config = require('../src/config');
    const { errorHandler } = require('../src/core/middleware/errorHandler');
    const app = express();
    app.use('/events', require('../src/modules/events/event.routes'));
    app.use('/admin', require('../src/modules/admin/admin.routes'));
    app.use(errorHandler);
    const token = role => 'Bearer ' + jwt.sign({ userId: eventId, role, email: 'fixture@example.test' }, config.jwt.secret);
    const bookingPath = '/events/' + eventId + '/bookings/export?format=xlsx&encoding=base64';
    assert.equal((await request(app).get(bookingPath)).status, 401);
    assert.equal((await request(app).get(bookingPath).set('Authorization', token('events_admin'))).status, 403);
    const downloaded = await request(app).get(bookingPath).set('Authorization', token('super_admin'));
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.body.data.mimeType, XLSX_MIME);
    assert.match(downloaded.headers['cache-control'], /no-store/);
    assert.equal(Buffer.from(downloaded.body.data.base64, 'base64').subarray(0, 2).toString(), 'PK');
    const membershipPath = '/admin/super/membership/registrations/export?encoding=base64';
    assert.equal((await request(app).get(membershipPath).set('Authorization', token('member'))).status, 403);
    assert.equal((await request(app).get(membershipPath).set('Authorization', token('super_admin'))).status, 200);
    const staffDownload = await request(app).get('/events/' + eventId + '/attendance/export?format=xlsx&encoding=base64').set('Authorization', token('attendance_admin'));
    assert.equal(staffDownload.status, 200);
    const staffBook = await new ExcelJS.Workbook().xlsx.load(Buffer.from(staffDownload.body.data.base64, 'base64'));
    assert.ok(!JSON.stringify(staffBook.model).includes('private@example.test'));
    console.log('PASS: authorized download routes, XLSX/base64 transport, no caching and no widened contact access.');
    const output = path.resolve(__dirname, '../../artifacts/exports-20261012');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'sample-event-registrations.xlsx'), report.buffer);
    fs.writeFileSync(path.join(output, 'sample-membership-register.xlsx'), (await membershipWorkbook(data)).buffer);
    fs.writeFileSync(path.join(output, 'sample-event-attendance.xlsx'), (await attendanceWorkbook(attendance, true)).buffer);
    console.log('Sample workbooks saved to artifacts/exports-20261012. All spreadsheet report checks passed.');
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
