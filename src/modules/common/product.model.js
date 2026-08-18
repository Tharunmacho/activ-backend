const mongoose = require('mongoose');

// Products Schema
const productSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberAuth',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    category: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    price: {
        type: Number,
        min: 0
    },
    priceUnit: {
        type: String,
        enum: ['per_piece', 'per_kg', 'per_ton', 'per_liter', 'per_meter', 'per_sqft', 'custom'],
        default: 'per_piece'
    },
    featured: {
        type: Boolean,
        default: false,
        index: true
    },
    imageUrl: {
        type: String,
        trim: true
    },
    images: [{
        type: String,
        trim: true
    }],
    status: {
        type: String,
        enum: ['draft', 'active', 'inactive'],
        default: 'draft',
        index: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed
    }
}, {
    collection: 'products',
    timestamps: true
});

// Text index for search
productSchema.index({ name: 'text', description: 'text', category: 'text' });
productSchema.index({ companyId: 1, status: 1 });
productSchema.index({ category: 1, featured: -1 });

module.exports = mongoose.model('Product', productSchema);