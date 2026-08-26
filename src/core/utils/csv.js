/**
 * A small RFC 4180 CSV reader.
 *
 * Written rather than pulled in as a dependency because bulk admin onboarding
 * is the only consumer and the file it reads is authored by the super admin, so
 * the surface is tiny and well understood. It handles what a spreadsheet export
 * actually produces: quoted fields, embedded commas, embedded newlines, escaped
 * double quotes, CRLF line endings and a UTF-8 BOM.
 *
 * Fields are returned verbatim. Trimming and type coercion belong to the caller,
 * which knows what each column means.
 */

/** Split raw CSV text into rows of string cells. Blank lines are dropped. */
const parseCsv = (text) => {
    // Excel and Google Sheets both prepend a BOM; left in place it becomes part
    // of the first header name and every lookup for that column misses.
    const input = String(text || '').replace(/^﻿/, '');

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let fieldWasQuoted = false;

    const endField = () => {
        row.push(field);
        field = '';
        fieldWasQuoted = false;
    };

    const endRow = () => {
        endField();
        // A trailing newline would otherwise yield a final row of one empty cell.
        const isBlank = row.every(cell => String(cell || '').trim() === '');
        if (!isBlank) rows.push(row);
        row = [];
    };

    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];

        if (inQuotes) {
            if (char === '"') {
                if (input[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"' && field === '') {
            inQuotes = true;
            fieldWasQuoted = true;
            continue;
        }

        if (char === ',') {
            endField();
            continue;
        }

        if (char === '\r') {
            // Swallow CR; the LF that follows ends the row.
            if (input[i + 1] === '\n') continue;
            endRow();
            continue;
        }

        if (char === '\n') {
            endRow();
            continue;
        }

        field += char;
    }

    // Whatever is buffered when the input runs out is a final field.
    if (field !== '' || fieldWasQuoted || row.length > 0) endRow();

    return rows;
};

/** Normalise a header cell into a lookup key: `"Full Name"` -> `fullname`. */
const headerKey = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

/**
 * Parse CSV into objects keyed by normalised header name.
 *
 * Returns `{ headers, rows }` where each row carries its 1-based `lineNumber`
 * from the source file, counting the header. Row numbers are what the super
 * admin sees in the validation report, so they have to match what they see in
 * their spreadsheet.
 */
const parseCsvRecords = (text) => {
    const raw = parseCsv(text);
    if (raw.length === 0) return { headers: [], rows: [] };

    const headers = raw[0].map(headerKey);

    const rows = raw.slice(1).map((cells, index) => {
        const record = { lineNumber: index + 2 };
        headers.forEach((name, column) => {
            if (!name) return;
            record[name] = cells[column] === undefined ? '' : String(cells[column]).trim();
        });
        return record;
    });

    return { headers, rows };
};

module.exports = { parseCsv, parseCsvRecords, headerKey };
