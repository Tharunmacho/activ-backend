const Product = require('../../models/Product');
const Company = require('./company.model');
const asyncHandler = require('../../core/utils/asyncHandler');
const ApiError = require('../../core/utils/ApiError');

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

  console.log('Creating product for user:', userId);
  console.log('Product data:', { companyId, name: finalName, category, price });
  console.log('Product file uploaded:', req.file);

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

  // Process uploaded image file saved in local /uploads directory
  let finalImageUrl = bodyImageUrl || '';
  if (req.file) {
    // Relative path only - an absolute URL built from req.get('host') points at
    // the uploading device's own network and 404s for everyone else.
    finalImageUrl = `/uploads/${req.file.filename}`;
    console.log('Product image saved to disk:', finalImageUrl);
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

  console.log('✅ Product created:', product._id);

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

  console.log('Fetching products for user:', userId);

  const filter = { userId };
  if (companyId) {
    filter.companyId = companyId;
  }

  const products = await Product.find(filter)
    .populate('companyId', 'businessName location mobileNumber')
    .sort({ createdAt: -1 })
    .lean();

  console.log(`✅ Found ${products.length} products`);

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
    console.log('Updated product image saved to disk:', product.imageUrl);
  } else if (bodyImageUrl !== undefined) {
    product.imageUrl = bodyImageUrl;
  }

  await product.save();

  console.log('✅ Product updated:', product._id);

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

  console.log('✅ Product deleted:', id);

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

  // Build filter
  const filter = { userId };
  if (companyId) {
    filter.companyId = companyId;
  }

  const totalProducts = await Product.countDocuments(filter);
  const featuredProducts = await Product.countDocuments({ ...filter, isFeatured: true });
  const activeProducts = await Product.countDocuments({ ...filter, isActive: true });

  res.json({
    success: true,
    data: {
      total: totalProducts,
      featured: featuredProducts,
      active: activeProducts
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
  const recentProducts = await Product.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('companyId', 'businessName')
    .lean();

  const activities = recentProducts.map(product => ({
    type: 'product_created',
    label: 'Product created',
    description: product.name,
    productId: product._id,
    companyName: product.companyId?.businessName,
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
