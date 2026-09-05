const express = require('express');
const controller = require('./memberExtras.controller');
const upload = require('../../core/middleware/upload');
const { verifyToken } = require('../../core/middleware/auth');
const { publicLimiter } = require('../../core/middleware/rateLimit');

/**
 * The endpoints the mobile app expected and this backend never had.
 *
 * Three separate routers rather than one, because they mount at three different
 * paths and the mobile app's endpoint map is what fixes those paths — they are
 * already shipped in an app on people's phones, so the server moves to meet
 * them, not the other way round.
 *
 * MOUNT ORDER: all three must be registered ABOVE `businessRoutes` in
 * `routes.js`. That router is mounted at '/' and calls `router.use(verifyToken)`
 * internally, which turns it into a catch-all auth gate for everything after
 * it — and `/membership/plans` has to stay readable by someone who has not
 * signed up yet.
 */

// ---------------------------------------------------------------- directory

const browseRouter = express.Router();

// Signed in, like the member listing it aliases: the directory is a member
// benefit, not public data.
browseRouter.get('/search', verifyToken, controller.searchMembers);
browseRouter.get('/', verifyToken, controller.browseMembers);

// ---------------------------------------------------------------- companies

const companyRouter = express.Router();

// Every route is scoped to the caller's own companies, from the token.
companyRouter.use(verifyToken);

companyRouter.get('/', controller.listCompanies);
companyRouter.post('/', upload.single('logo'), controller.createCompany);
companyRouter.get('/:id', controller.getCompany);
companyRouter.put('/:id', upload.single('logo'), controller.updateCompany);
companyRouter.delete('/:id', controller.deleteCompany);

// ---------------------------------------------------------------- plans

const membershipRouter = express.Router();

/**
 * Public, deliberately.
 *
 * Someone deciding whether to join has to see the price before they have an
 * account to sign in with, so gating this would mean asking people to register
 * before finding out what registration costs.
 */
membershipRouter.get('/plans', publicLimiter, controller.listPlans);

/**
 * The plans THIS applicant is offered, resolved from their commencement year.
 *
 * Authenticated, unlike the listing above, because the answer is about one
 * person. `verifyToken` explicitly rather than relying on the catch-all gate in
 * `businessRoutes`: this router is mounted ABOVE that one (see the note in
 * `routes.js`), so nothing else is guarding it.
 */
membershipRouter.get('/plans/mine', verifyToken, controller.listMyPlans);

module.exports = { browseRouter, companyRouter, membershipRouter };
