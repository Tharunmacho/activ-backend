const mongoose = require('mongoose');

/**
 * Every change to a stock level, and why (BUS-002).
 *
 * A stock figure on its own answers "how many are there"; a member running a
 * catalogue needs "and where did the other forty go". Without a log the only
 * record of an adjustment is the number it produced, so a typo — 5 typed as 50
 * — is indistinguishable from a real delivery and cannot be traced back.
 *
 * `delta` is signed and `resultingStock` is stored alongside it. Storing both
 * is redundant by design: the running total can then be read straight off any
 * row without replaying the whole log, and a row whose `resultingStock` does
 * not match the previous row plus its delta is visible evidence that something
 * wrote the stock field without going through here.
 */
const stockMovementSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        required: true,
        index: true
    },
    /** The owner, so a member's whole stock history is one query. */
    userId: {
        type: String,
        required: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        default: null
    },

    /** Signed: +12 received, -3 sold. Never zero — the service rejects those. */
    delta: {
        type: Number,
        required: true
    },
    resultingStock: {
        type: Number,
        required: true,
        min: 0
    },

    /**
     * Why it moved.
     *
     * `correction` is the one that matters for trust: it marks an adjustment
     * the member made because the number was wrong, as opposed to one caused by
     * something happening in the world. Keeping them apart is what makes the
     * log worth reading.
     */
    reason: {
        type: String,
        enum: ['restock', 'sale', 'damage', 'return', 'correction', 'other'],
        default: 'other',
        index: true
    },
    note: { type: String, trim: true, default: '' },
    productName: { type: String, trim: true, default: '' }
}, {
    collection: 'stock_movements',
    timestamps: true
});

stockMovementSchema.index({ userId: 1, createdAt: -1 });
stockMovementSchema.index({ productId: 1, createdAt: -1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);
