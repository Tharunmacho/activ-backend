const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TIME_ZONE = 'Asia/Kolkata';
const HEADER_ROW = 5;
const dateParts = (value, withTime = true) => {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        ...(withTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {})
    }).formatToParts(date).map(part => [part.type, part.value]));
};
const reportDay = (value = new Date()) => {
    const parts = dateParts(value, false);
    return parts ? [parts.year, parts.month, parts.day].join('-') : '';
};
const formatDateIST = (value, withTime = true) => {
    const parts = dateParts(value, withTime);
    if (!parts) return '';
    const day = [parts.day, parts.month, parts.year].join('-');
    if (!withTime) return day;
    const hour = Number(parts.hour);
    return day + ' ' + String(hour % 12 || 12).padStart(2, '0') + ':' + parts.minute + (hour >= 12 ? ' PM' : ' AM');
};
// Excel dates have no time zone. Store IST wall-clock fields in the serial value
// so neither the server nor the reader's locale can shift the displayed time.
const excelDateIST = (value) => {
    const parts = dateParts(value);
    return parts ? new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second))) : null;
};
const text = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const number = (value) => {
    const result = Number(value);
    return Number.isFinite(result) ? result : 0;
};
const label = (value) => text(value).replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
const filename = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'activ-report';
// CSV has no typed cells. Keep a safe legacy fallback; XLSX preserves the exact
// original text, including a leading + or 0, without an apostrophe prefix.
const csvCell = (value, forceText = false) => {
    let result = text(value);
    if ((forceText && result) || /^\s*[=+@\-\t\r]/.test(result)) result = "'" + result;
    return '"' + result.replace(/"/g, '""') + '"';
};

function addSheet(workbook, { name, title, subtitle = '', columns, rows }, generatedAt) {
    const sheet = workbook.addWorksheet(name, {
        properties: { tabColor: { argb: 'FF243E84' }, defaultRowHeight: 30 },
        views: [{ state: 'frozen', xSplit: 1, ySplit: HEADER_ROW, showGridLines: false }],
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5' }
    });
    sheet.columns = columns.map(column => ({ key: column.key, width: column.width || 24 }));
    [1, 2, 3].forEach(row => sheet.mergeCells(row, 1, row, columns.length));
    sheet.getCell(1, 1).value = 'ACTIV | ' + title;
    sheet.getCell(1, 1).font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FF172B55' } };
    sheet.getRow(1).height = 34;
    sheet.getCell(2, 1).value = subtitle;
    sheet.getCell(3, 1).value = 'Generated: ' + formatDateIST(generatedAt) + ' IST · All dates and times: India (UTC+05:30)';
    [2, 3].forEach(index => {
        sheet.getCell(index, 1).font = { name: 'Calibri', size: 11, color: { argb: 'FF526078' } };
        sheet.getCell(index, 1).alignment = { vertical: 'middle', wrapText: true };
        sheet.getRow(index).height = index === 2 ? 32 : 25;
    });
    sheet.getRow(4).height = 8;
    const header = sheet.getRow(HEADER_ROW);
    header.height = 36;
    columns.forEach((column, index) => {
        const cell = header.getCell(index + 1);
        cell.value = column.header;
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243E84' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
    });
    rows.forEach((record, rowIndex) => {
        const row = sheet.getRow(HEADER_ROW + rowIndex + 1);
        let lines = 1;
        columns.forEach((column, index) => {
            const cell = row.getCell(index + 1);
            const value = record[column.key];
            // Never assign a user object, formula, or hyperlink to an Excel cell.
            if (column.type === 'date') {
                cell.value = excelDateIST(value);
                cell.numFmt = column.dateOnly ? 'dd mmm yyyy' : 'dd mmm yyyy, hh:mm AM/PM';
            } else if (column.type === 'money' || column.type === 'number') {
                cell.value = number(value);
                cell.numFmt = column.type === 'money' ? '"₹ "#,##0.00;[Red]-"₹ "#,##0.00' : '0';
            } else {
                cell.value = text(value);
                cell.numFmt = '@';
            }
            const content = column.type === 'date' ? formatDateIST(value) : text(value);
            lines = Math.max(lines, ...content.split(/\r?\n/).map(line => Math.ceil(line.length / (column.width || 24))));
            cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF23324D' } };
            cell.alignment = { vertical: 'middle', wrapText: true, horizontal: ['money', 'number'].includes(column.type) ? 'right' : 'left' };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowIndex % 2 ? 'FFF1F5FB' : 'FFFFFFFF' } };
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9E2F0' } } };
        });
        row.height = Math.max(30, Math.min(90, lines * 15 + 8));
    });
    sheet.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: Math.max(HEADER_ROW, HEADER_ROW + rows.length), column: columns.length } };
    sheet.pageSetup.printArea = 'A1:' + sheet.getColumn(columns.length).letter + Math.max(HEADER_ROW, sheet.rowCount);
    sheet.headerFooter.oddFooter = '&LACTIV · Confidential administrative report&CPage &P of &N&RIndia Standard Time';
    return sheet;
}

async function createWorkbook({ name, sheets, generatedAt = new Date() }) {
    // Load the Excel writer only when an administrator requests a report.
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ACTIV';
    workbook.subject = 'Administrative report';
    workbook.created = generatedAt;
    workbook.modified = generatedAt;
    sheets.forEach(sheet => addSheet(workbook, sheet, generatedAt));
    return { filename: filename(name) + '-' + reportDay(generatedAt) + '.xlsx', mimeType: XLSX_MIME, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
}

function sendWorkbook(req, res, report) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.query.encoding === 'base64') {
        return res.json({ success: true, data: {
            filename: report.filename, mimeType: XLSX_MIME, base64: report.buffer.toString('base64')
        } });
    }
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="' + report.filename + '"');
    return res.send(report.buffer);
}

module.exports = { XLSX_MIME, HEADER_ROW, formatDateIST, excelDateIST, reportDay, text, number, label, filename, csvCell, createWorkbook, sendWorkbook };
