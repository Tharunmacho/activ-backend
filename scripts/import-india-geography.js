/** Import a downloaded LGD CSV snapshot; never changes database records. */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../src/core/utils/csv');

const [directory, snapshot = '03Oct2026'] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node scripts/import-india-geography.js <csv-directory> [03Oct2026]');
const read = (kind) => {
    const [headers, ...rows] = parseCsv(fs.readFileSync(path.join(directory, `${kind}.${snapshot}.csv`), 'utf8'));
    return rows.map(cells => Object.fromEntries(headers.map((header, i) => [header, String(cells[i] || '').trim()])));
};
const states = new Map();
const districts = new Map();
const blockCodes = new Set();
for (const row of read('states')) {
    const code = row['State Code'];
    if (!code || !row['State Name (In English)']) throw new Error('Invalid state row');
    states.set(code, { state: row['State Name (In English)'], code, type: row['State or UT'], districts: [] });
}
for (const row of read('districts')) {
    const state = states.get(row['State Code']);
    const code = row['District Code'];
    if (!state || !code || !row['District Name(In English)'] || districts.has(code)) throw new Error('Invalid district row');
    const district = { district: row['District Name(In English)'], code, block: [] };
    state.districts.push(district);
    districts.set(code, { state, district });
}
for (const row of read('blocks')) {
    const parent = districts.get(row['District Code']);
    const name = row['Development Block Name (In English)'];
    const code = row['Development Block Code'];
    if (!parent || parent.state.code !== row['State Code'] || !name || !code) throw new Error('Invalid block parent');
    if (!parent.district.block.includes(name)) parent.district.block.push(name);
    // LGD can associate one development block with multiple districts.
    blockCodes.add(code);
}
const result = {
    source: {
        name: 'Government of India Local Government Directory (LGD)',
        url: 'https://lgdirectory.gov.in/',
        snapshot,
        mirror: `https://github.com/ramSeraph/opendata/releases/tag/lgd-latest-extra1`,
        files: ['states', 'districts', 'blocks'].map(kind =>
            `https://github.com/ramSeraph/opendata/releases/download/lgd-latest-extra1/${kind}.${snapshot}.csv.7z`),
        counts: { states: states.size, districts: districts.size, developmentBlocks: blockCodes.size },
        note: 'Development blocks, not subdistricts. Districts without development blocks have an empty block list. Blocks spanning districts appear under each LGD parent.'
    },
    states: [...states.values()].sort((a, b) => a.state.localeCompare(b.state))
};
for (const state of result.states) {
    state.districts.sort((a, b) => a.district.localeCompare(b.district));
    for (const district of state.districts) district.block.sort((a, b) => a.localeCompare(b));
}
fs.writeFileSync(path.resolve(__dirname, '../src/modules/regions/data/india-geography.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(result.source.counts);
