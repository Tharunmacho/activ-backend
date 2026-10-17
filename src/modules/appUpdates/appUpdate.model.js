const mongoose = require('mongoose');
const dataLayout = require('../../config/dataLayout');

const schema = new mongoose.Schema({
    _id: { type: String, default: 'android' },
    enabled: { type: Boolean, default: true },
    requireLatestAvailable: { type: Boolean, default: true },
    minimumVersionCode: { type: Number, default: 1, min: 1, max: 2100000000 },
    message: { type: String, default: 'Please update ACTIV to continue.' },
    productionAvailableConfirmedAt: { type: Date, default: null },
    updatedBy: { type: String, default: '' },
}, { timestamps: true });

module.exports = dataLayout.model('AppUpdatePolicy', schema);
