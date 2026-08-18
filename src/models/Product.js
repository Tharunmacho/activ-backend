const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
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
      trim: true
    },
    price: {
      type: Number,
      default: 0,
      min: 0
    },
    stock: {
      type: Number,
      default: 0,
      min: 0
    },
    sku: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },
    imageUrl: {
      type: String,
      trim: true
    },
    isFeatured: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true
    },
    views: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true,
    collection: 'products'
  }
);

// Indexes for better query performance
productSchema.index({ userId: 1, companyId: 1 });
productSchema.index({ userId: 1, isFeatured: 1 });
productSchema.index({ userId: 1, isActive: 1 });
productSchema.index({ createdAt: -1 });

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
