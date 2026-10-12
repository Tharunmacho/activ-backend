const { createWorkbook, formatDateIST, number, label } = require('../../core/utils/spreadsheet');
const ApiError = require('../../core/utils/ApiError');

function selectRows(data, query = {}) {
    const tab = query.tab || 'members';
    if (!['members', 'payments', 'archived'].includes(tab)) throw ApiError.badRequest('Choose a valid membership report.');
    const filter = String(query.filter || 'all');
    const search = String(query.search || '').trim().toLowerCase();
    const rows = (tab === 'members' ? data.rows : data.payments.filter(row => tab === 'archived' ? row.registrationDeleted : !row.registrationDeleted))
        .filter(row => (filter === 'all' || (filter === 'submitted' ? !!row.applicationId
            : filter === 'waived' ? row.confirmation === 'Fee waived' || (row.mode === 'waived' && row.status === 'paid') : row.status === filter))
            && (!search || Object.values(row).some(value => String(value || '').toLowerCase().includes(search))));
    return { rows, tab, filter };
}

async function membershipWorkbook(data, query = {}) {
    const { rows, tab, filter } = selectRows(data, query);
    const members = tab === 'members';
    const title = members ? 'Membership registrations' : tab === 'archived' ? 'Archived membership payments' : 'Membership payments';
    const columns = members ? [
        { key: 'serial', header: 'S. No.', type: 'number', width: 9 },
        { key: 'memberNumber', header: 'Member number', width: 23 },
        { key: 'name', header: 'Member name', width: 28 },
        { key: 'phone', header: 'Mobile number', width: 20 },
        { key: 'email', header: 'Email address', width: 34 },
        { key: 'region', header: 'Region', width: 34 },
        { key: 'registeredAt', header: 'Registered on (IST)', type: 'date', width: 27 },
        { key: 'applicationStatus', header: 'Application status', width: 20 },
        { key: 'statusLabel', header: 'Membership status', width: 22 },
        { key: 'planName', header: 'Membership plan', width: 28 },
        { key: 'collected', header: 'Amount received (INR)', type: 'money', width: 23 },
        { key: 'activatedAt', header: 'Activated on (IST)', type: 'date', width: 27 },
        { key: 'validity', header: 'Valid until (IST)', width: 21 },
        { key: 'confirmation', header: 'Confirmation type', width: 22 }
    ] : [
        { key: 'serial', header: 'S. No.', type: 'number', width: 9 },
        { key: 'name', header: 'Member name', width: 28 },
        { key: 'email', header: 'Email address', width: 34 },
        { key: 'orderId', header: 'Order reference', width: 30 },
        { key: 'paymentId', header: 'Payment / receipt reference', width: 30 },
        { key: 'planName', header: 'Membership plan', width: 28 },
        { key: 'statusLabel', header: 'Payment status', width: 19 },
        { key: 'modeLabel', header: 'Payment mode', width: 19 },
        { key: 'amount', header: 'Order amount (INR)', type: 'money', width: 23 },
        { key: 'received', header: 'Amount received (INR)', type: 'money', width: 23 },
        { key: 'createdAt', header: 'Order created on (IST)', type: 'date', width: 27 },
        { key: 'paidAt', header: 'Paid on (IST)', type: 'date', width: 27 },
        { key: 'confirmedBy', header: 'Confirmed by', width: 30 },
        { key: 'confirmedAt', header: 'Office confirmed on (IST)', type: 'date', width: 27 },
        { key: 'note', header: 'Office notes', width: 40 }
    ];
    return createWorkbook({ name: 'membership-' + tab, sheets: [{
        name: members ? 'Members' : 'Payments', title,
        subtitle: rows.length + ' records · Filter: ' + label(filter) + (query.search ? ' · Search applied' : '') + ' · Payment history is retained, including failed and cancelled records.',
        columns, rows: rows.map((row, index) => ({
            ...row, serial: index + 1, statusLabel: label(row.status),
            modeLabel: row.mode === 'waived' ? 'Fee waived' : label(row.mode),
            validity: row.lifetime ? 'Lifetime' : formatDateIST(row.expiresAt, false),
            received: row.status === 'paid' ? number(row.amount) : 0,
            confirmedBy: row.manual?.byName, confirmedAt: row.manual?.at, note: row.manual?.note
        }))
    }] });
}

module.exports = { membershipWorkbook, selectRows };
