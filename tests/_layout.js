/**
 * Live tests reach collections through config/dataLayout.js — the server's own
 * map — never by a name of their own. `col()` takes a model name
 * ('MemberDetails') or the collection's old Atlas name ('users'); an unknown
 * name throws, so a test cannot quietly read or clean up the wrong place.
 */
const mongoose = require('mongoose');
const layout = require('../src/config/dataLayout');

const PLAN = layout.migrationPlan();

const col = (name) => {
    const model = layout.MODELS[name];
    const move = model
        ? { toDb: layout.dbName(model[0]), toColl: model[1] }
        : PLAN.find((m) => m.fromColl === name) || PLAN.find((m) => m.toColl === name);
    if (!move) throw new Error(`tests/_layout: no collection '${name}' in config/dataLayout.js`);
    return mongoose.connection.getClient().db(move.toDb).collection(move.toColl);
};

/** The tier collection an admin of this role is stored in. */
const ADMIN_MODEL = {
    super_admin: 'SuperAdmin',
    state_admin: 'StateAdmin',
    district_admin: 'DistrictAdmin',
    block_admin: 'BlockAdmin',
};

module.exports = { col, ADMIN_MODEL };
