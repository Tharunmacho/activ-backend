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
    /**
     * The level at which this line counts as running low (BUS-002).
     *
     * Per product rather than one setting for the whole catalogue: a member
     * selling both cement by the tonne and safety helmets by the piece has two
     * completely different ideas of "nearly out", and a single global threshold
     * would flag one of them constantly and the other never.
     *
     * Zero means "do not warn me about this line" — not "warn me always", which
     * is what a zero threshold would mean if the comparison were `<=`. The
     * comparison is `stock <= minStock && minStock > 0`, in one place:
     * `stockState()` below.
     */
    minStock: {
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

/**
 * The one place a stock level is turned into a word.
 *
 * `out` — nothing left. `low` — at or under the member's own threshold for this
 * line. `ok` — everything else, including every line whose threshold is zero,
 * which is how a member says "this is not something I track".
 *
 * Exported rather than computed in each caller because the catalogue screen,
 * the low-stock list and the analytics tile all show this and all three have to
 * agree; a `<` in one of them and a `<=` in another is a product that appears
 * in the warning list without being marked as low on its own row.
 */
const stockState = (product = {}) => {
  const stock = Number(product.stock || 0);
  const minimum = Number(product.minStock || 0);

  if (stock <= 0) return 'out';
  if (minimum > 0 && stock <= minimum) return 'low';
  return 'ok';
};

module.exports = Product;
module.exports.stockState = stockState;
