const mongoose = require('mongoose');
const Product = require('../../models/Product');
const Company = require('./company.model');
const asyncHandler = require('../../core/utils/asyncHandler');
const ApiError = require('../../core/utils/ApiError');
const { persistInlineImage } = require('../../core/utils/inlineImage');

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

module.exports = {
  createProduct,
  getProducts,
  discoverProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  getProductStats,
  getRecentActivities
};
