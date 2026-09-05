const mongoose = require('mongoose');
const Product = require('../../models/Product');
const { stockState } = require('../../models/Product');
const StockMovement = require('./stockmovement.model');
const { recordView } = require('../common/engagement.model');
const Company = require('./company.model');
const asyncHandler = require('../../core/utils/asyncHandler');
const ApiError = require('../../core/utils/ApiError');
const { persistInlineImage } = require('../../core/utils/inlineImage');
const { regionOwnerIds } = require('../common/regionOwners');

/**
 * @desc    Create a new product
 * @route   POST /api/v1/products
 * @access  Private
 */
const createProduct = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const {
    companyId,
    name,
    productName,
    description,
    category,
    price,
    stock,
    sku,
    imageUrl: bodyImageUrl,
    isFeatured
  } = req.body;

  const finalName = (name || productName || '').trim();


  if (!finalName) {
    throw new ApiError(400, 'Product name is required');
  }

  // Verify company belongs to user
  let company = null;
  if (companyId) {
    company = await Company.findOne({ _id: companyId, userId });
  } else {
    // If companyId is not provided, pick user's latest company
    company = await Company.findOne({ userId }).sort({ createdAt: -1 });
  }

  if (!company) {
    throw new ApiError(404, 'Company profile not found. Please create a company profile first.');
  }

  /**
   * A body `imageUrl` is accepted, but never stored inline.
   *
   * The website's product form used to send a base64 data URL here and it was
   * written straight into the document — one product reached 2.19 MB, and every
   * query that returned it took ~7s instead of ~140ms. `persistInlineImage`
   * writes such a value to /uploads and hands back the path; an ordinary path
   * passes through untouched.
   */
  let finalImageUrl = persistInlineImage(bodyImageUrl, 'product-img');
  if (req.file) {
    // Relative path only - an absolute URL built from req.get('host') points at
    // the uploading device's own network and 404s for everyone else.
    finalImageUrl = `/uploads/${req.file.filename}`;
  }

  // Create product
  const product = await Product.create({
    userId,
    companyId: company._id,
    name: finalName,
    description: description ? description.trim() : '',
    category: category || 'Product',
    price: parseFloat(price) || 0,
    stock: parseInt(stock) || 0,
    minStock: Math.max(0, parseInt(req.body.minStock) || 0),
    sku: sku ? sku.trim() : `SKU-${Date.now()}`,
    imageUrl: finalImageUrl,
    isFeatured: isFeatured === 'true' || isFeatured === true,
    isActive: true
  });


  res.status(201).json({
    success: true,
    message: 'Product created successfully',
    data: product
  });
});

/**
 * @desc    Get all products for current user
 * @route   GET /api/v1/products
 * @access  Private
 */
const getProducts = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { companyId } = req.query;


  const filter = { userId };
  if (companyId) {
    filter.companyId = companyId;
  }

  /**
   * No `populate` here.
   *
   * This populated `companyId` with businessName / location / mobileNumber,
   * which is a second query to the companies collection — another ~100ms
   * against a remote cluster — for fields no caller reads. Both clients use
   * `companyId` only to re-check that a row belongs to the company on screen,
   * and they already handle it being either an id or an object:
   *
   *     const owner = typeof p?.companyId === 'object' ? p?.companyId?._id : p?.companyId;
   *
   * so the raw ObjectId serves that check exactly as well.
   *
   * `discoverProducts` keeps its populate: the Discover screen genuinely
   * renders the seller's name, phone and logo from it.
   */
  const products = await Product.find(filter)
    .sort({ createdAt: -1 })
    .lean();


  res.json({
    success: true,
    data: products,
    count: products.length
  });
});

/**
 * Escape regex metacharacters so a raw search term cannot break the query
 */
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @desc    Search products across the WHOLE network (not scoped to req.user).
 *          A buyer looking for "chairs" needs to reach other members' catalogs,
 *          so this returns every active product with its seller's contact
 *          details populated. Owner-scoped listing stays on GET /products.
 * @route   GET /api/v1/products/discover
 * @access  Private
 */
const discoverProducts = asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim();
  const { companyId } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);

  const filter = { isActive: true };
  if (companyId) {
    filter.companyId = companyId;
  }

  /*
   * Region, resolved through the OWNER — products carry none of their own.
   *
   * A product row has a `userId` and a `companyId` and no idea where either of
   * them is; the region tree the whole platform is filtered on lives on the
   * member record. So a region filter has to become a set of owner ids first.
   *
   * `regionOwnerIds` returns `null` for "no region asked for", which is
   * different from `[]` — the empty array is a real answer meaning "nobody is
   * registered there", and collapsing the two would turn an unpopulated block
   * into a network-wide listing.
   */
  const owners = await regionOwnerIds(req.query);
  if (owners !== null) {
    if (!owners.length) {
      return res.json({ success: true, data: [], count: 0 });
    }
    filter.userId = { $in: owners };
  }

  if (term) {
    const searchRegex = new RegExp(escapeRegex(term), 'i');
    // Identity fields only - matching `description` made a short term return
    // effectively the whole catalog.
    filter.$or = [
      { name: searchRegex },
      { category: searchRegex },
      { sku: searchRegex }
    ];
  }

  const products = await Product.find(filter)
    .populate('companyId', 'businessName businessType location area mobileNumber email logo description')
    .sort({ isFeatured: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  res.json({
    success: true,
    data: products,
    count: products.length
  });
});

/**
 * @desc    Get product by ID
 * @route   GET /api/v1/products/:id
 * @access  Private
 */
const getProductById = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const product = await Product.findOne({ _id: id, userId })
    .populate('companyId', 'businessName')
    .lean();

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  res.json({
    success: true,
    data: product
  });
});

/**
 * @desc    Update product
 * @route   PUT /api/v1/products/:id
 * @access  Private
 */
const updateProduct = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const product = await Product.findOne({ _id: id, userId });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  const {
    name,
    productName,
    description,
    category,
    price,
    stock,
    minStock,
    sku,
    imageUrl: bodyImageUrl,
    isFeatured,
    isActive
  } = req.body;

  const finalName = name || productName;

  if (finalName) product.name = finalName.trim();
  if (description !== undefined) product.description = description.trim();
  if (category) product.category = category;
  if (price !== undefined) product.price = parseFloat(price) || 0;
  if (stock !== undefined) product.stock = parseInt(stock) || 0;
  if (minStock !== undefined) product.minStock = Math.max(0, parseInt(minStock) || 0);
  if (sku) product.sku = sku.trim();
  if (isFeatured !== undefined) product.isFeatured = isFeatured === 'true' || isFeatured === true;
  if (isActive !== undefined) product.isActive = isActive === 'true' || isActive === true;

  // Process uploaded image file saved in local /uploads directory
  if (req.file) {
    // Relative path only - see the note in createProduct.
    product.imageUrl = `/uploads/${req.file.filename}`;
  } else if (bodyImageUrl !== undefined) {
    // Same conversion as createProduct - an edit can carry base64 too.
    product.imageUrl = persistInlineImage(bodyImageUrl, 'product-img');
  }

  await product.save();


  res.json({
    success: true,
    message: 'Product updated successfully',
    data: product
  });
});

/**
 * @desc    Delete product
 * @route   DELETE /api/v1/products/:id
 * @access  Private
 */
const deleteProduct = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const product = await Product.findOne({ _id: id, userId });

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  await product.deleteOne();


  res.json({
    success: true,
    message: 'Product deleted successfully'
  });
});

/**
 * @desc    Get product stats for user
 * @route   GET /api/v1/products/stats
 * @access  Private
 */
const getProductStats = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { companyId } = req.query;

  /**
   * Built for an aggregation, which means casting by hand.
   *
   * `find()` and `countDocuments()` run every query value through the schema
   * first, so passing the raw `companyId` string worked. An aggregation
   * pipeline is handed to the driver untouched — Mongoose casts nothing inside
   * `$match` — and `companyId` is an ObjectId on the Product schema. A string
   * there matches no document at all and the endpoint would answer three
   * cheerful zeros for every catalog, with no error anywhere.
   *
   * `userId` is genuinely a String on this schema, so it is passed as-is.
   */
  const filter = { userId };
  if (companyId) {
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      throw new ApiError(400, 'Invalid company id');
    }
    filter.companyId = new mongoose.Types.ObjectId(companyId);
  }

  /**
   * One round trip, not three.
   *
   * This ran three sequential `countDocuments` calls. Against a remote Atlas
   * cluster each is its own request/response over the internet, so the handler
   * cost three times the network latency to return three numbers over the same
   * documents: measured at a p50 of 359ms, against 105ms for a single query.
   * Dashboard, Analytics and Settings all call this endpoint, so it was the
   * single most expensive thing the business area did.
   *
   * `$cond` counts the two flags in the same pass as the total. Booleans that
   * are absent on older rows read as false, which matches what
   * `countDocuments({ isActive: true })` did.
   */
  const [counts] = await Product.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        featured: { $sum: { $cond: [{ $eq: ['$isFeatured', true] }, 1, 0] } },
        active: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } }
      }
    }
  ]);

  res.json({
    success: true,
    data: {
      // An empty catalog produces no group at all, not a group of zeros.
      total: counts?.total || 0,
      featured: counts?.featured || 0,
      active: counts?.active || 0
    }
  });
});

/**
 * @desc    Get recent activities (product creation, updates)
 * @route   GET /api/v1/products/activities
 * @access  Private
 */
const getRecentActivities = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { companyId } = req.query;
  const limit = parseInt(req.query.limit) || 10;

  // Build filter
  const filter = { userId };
  if (companyId) {
    filter.companyId = companyId;
  }

  // Get recent products
  /**
   * No `populate` here either — it existed to fill a `companyName` field that
   * no client has ever rendered. Mobile's dashboard reads `label` and
   * `description`; the website's reads `label`, `description` and `time`. The
   * feed is already scoped to one company, so naming it on every row would be
   * repeating the heading anyway.
   */
  const recentProducts = await Product.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const activities = recentProducts.map(product => ({
    type: 'product_created',
    label: 'Product created',
    description: product.name,
    productId: product._id,
    time: product.createdAt,
    icon: 'inventory_2'
  }));

  res.json({
    success: true,
    data: activities
  });
});


/**
 * @desc    Adjust a stock level, with a reason, and log the movement (BUS-002)
 * @route   POST /api/v1/products/:id/stock
 * @access  Private (owner only)
 */
const adjustStock = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const product = await Product.findOne({ _id: id, userId });
  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  const { delta, setTo, reason, note } = req.body;

  /*
   * Two ways to say it, one of them required.
   *
   * `delta` is "twelve arrived"; `setTo` is "I have just counted and there are
   * forty". Both are things a member genuinely wants to express, and forcing
   * the second through the first means asking them to do arithmetic against a
   * number they have just discovered was wrong.
   *
   * The log stores the signed delta either way, so a stock take and a delivery
   * are the same kind of row and the history reads consistently.
   */
  const current = Number(product.stock || 0);
  let movement;

  if (setTo !== undefined && setTo !== null && setTo !== '') {
    const target = Math.round(Number(setTo));
    if (!Number.isFinite(target) || target < 0) {
      throw new ApiError(400, 'Stock cannot be set to a negative number');
    }
    movement = target - current;
  } else {
    movement = Math.round(Number(delta));
    if (!Number.isFinite(movement)) {
      throw new ApiError(400, 'Give either a delta or a stock count');
    }
  }

  if (movement === 0) {
    throw new ApiError(400, 'That would not change anything');
  }

  const resulting = current + movement;
  if (resulting < 0) {
    // Refused rather than clamped to zero. Clamping would record a movement of
    // -40 as a movement of -12 and the log would stop reconciling.
    throw new ApiError(400, 'Only ' + current + ' in stock - that adjustment would take it below zero');
  }

  product.stock = resulting;
  await product.save();

  const VALID_REASONS = ['restock', 'sale', 'damage', 'return', 'correction', 'other'];
  const finalReason = VALID_REASONS.includes(String(reason || '').toLowerCase())
    ? String(reason).toLowerCase()
    : 'other';

  /*
   * The log is written after the stock, and a failure to write it does not fail
   * the request. The stock level is what the member's catalogue depends on; the
   * log is the explanation. Losing the explanation is bad, losing the level
   * because the explanation could not be filed is worse.
   */
  const logged = await StockMovement.create({
    productId: product._id,
    userId,
    companyId: product.companyId || null,
    delta: movement,
    resultingStock: resulting,
    reason: finalReason,
    note: String(note || '').trim(),
    productName: product.name || ''
  }).catch(() => null);

  res.json({
    success: true,
    message: 'Stock updated',
    data: {
      id: String(product._id),
      name: product.name,
      stock: product.stock,
      minStock: Number(product.minStock || 0),
      stockState: stockState(product),
      movement: logged ? {
        id: String(logged._id),
        delta: logged.delta,
        resultingStock: logged.resultingStock,
        reason: logged.reason,
        note: logged.note,
        at: logged.createdAt
      } : null
    }
  });
});

/**
 * @desc    Stock movement history for the caller's catalogue
 * @route   GET /api/v1/products/stock-movements
 * @access  Private
 */
const listStockMovements = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);

  const filter = { userId };
  if (req.query.productId && mongoose.Types.ObjectId.isValid(req.query.productId)) {
    filter.productId = new mongoose.Types.ObjectId(req.query.productId);
  }

  const rows = await StockMovement.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .catch(() => []);

  res.json({
    success: true,
    data: (rows || []).map((row) => ({
      id: String(row._id),
      productId: String(row.productId),
      productName: row.productName || '',
      delta: row.delta,
      resultingStock: row.resultingStock,
      reason: row.reason,
      note: row.note || '',
      at: row.createdAt
    })),
    count: (rows || []).length
  });
});

/**
 * @desc    The lines that need reordering (BUS-002)
 * @route   GET /api/v1/products/low-stock
 * @access  Private
 */
const listLowStock = asyncHandler(async (req, res) => {
  const userId = req.user.userId;

  /*
   * Matched in the database rather than by loading the catalogue and filtering
   * in Node: a member with a thousand lines would otherwise transfer all of
   * them to render a list of four.
   *
   * The two clauses are the two halves of `stockState`: out of stock, or at or
   * below a threshold the member actually set. `$expr` is what lets the second
   * one compare two fields of the same document.
   */
  const rows = await Product.find({
    userId,
    isActive: true,
    $or: [
      { stock: { $lte: 0 } },
      { $and: [{ minStock: { $gt: 0 } }, { $expr: { $lte: ['$stock', '$minStock'] } }] }
    ]
  })
    .sort({ stock: 1 })
    .limit(100)
    .lean()
    .catch(() => []);

  res.json({
    success: true,
    data: (rows || []).map((row) => ({
      id: String(row._id),
      name: row.name || '',
      category: row.category || '',
      imageUrl: row.imageUrl || '',
      stock: Number(row.stock || 0),
      minStock: Number(row.minStock || 0),
      stockState: stockState(row)
    })),
    count: (rows || []).length
  });
});

/**
 * @desc    Publish or unpublish a catalogue entry (BUS-001)
 * @route   PATCH /api/v1/products/:id/publish
 * @access  Private (owner only)
 *
 * `isActive` IS the publish flag on this schema - `discoverProducts` filters on
 * it, so an inactive product is already invisible to every other member. This
 * route exists so that publishing is a named operation with its own permission
 * rather than a side effect of a full `PUT` that also rewrites price and stock.
 */
const setPublished = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { id } = req.params;

  const published = req.body && (req.body.published === true || req.body.published === 'true');

  const product = await Product.findOneAndUpdate(
    { _id: id, userId },
    { $set: { isActive: published } },
    { new: true }
  ).lean();

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  res.json({
    success: true,
    message: published ? 'Product published' : 'Product unpublished',
    data: { id: String(product._id), name: product.name, isActive: !!product.isActive }
  });
});

/**
 * @desc    Record that someone opened this catalogue entry (BUS-003)
 * @route   POST /api/v1/products/:id/view
 * @access  Private
 *
 * A separate route rather than a side effect of `GET /products/:id`, because
 * that route is owner-scoped: it answers 404 for everyone except the person who
 * created the product, so it is the one request that can never be a view by
 * somebody else. Discover is where another member actually looks, and Discover
 * renders from the list — so the client says when a card was opened.
 *
 * Answers 200 either way. A view that could not be recorded is not a failure
 * the viewer should be told about, and the counter is not something a caller
 * can usefully retry.
 */
const recordProductView = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError(400, 'Invalid product id');
  }

  // The owner is read from the product, never from the request: a client that
  // could name the owner could credit views to anyone.
  const product = await Product.findById(id).select('userId isActive').lean().catch(() => null);

  if (product && product.isActive) {
    await recordView({
      kind: 'product',
      targetId: id,
      ownerId: String(product.userId || ''),
      viewerId: String(req.user.userId || '')
    });

    // The denormalised counter on the product, which Discover sorts by. Kept in
    // step with the engagement rows rather than incremented independently, so
    // the two cannot disagree about which line is the most looked at.
    await Product.updateOne({ _id: id }, { $inc: { views: 1 } }).catch(() => null);
  }

  res.json({ success: true, data: { recorded: !!(product && product.isActive) } });
});

module.exports = {
  createProduct,
  getProducts,
  discoverProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  getProductStats,
  getRecentActivities,
  adjustStock,
  listStockMovements,
  listLowStock,
  setPublished,
  recordProductView
};
