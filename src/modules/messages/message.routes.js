const express = require('express');
const controller = require('./message.controller');
const { verifyToken } = require('../../core/middleware/auth');
const upload = require('../../core/middleware/upload');

/**
 * `/messages` — member-to-member direct messages.
 *
 * MOUNT ORDER: register this ABOVE `businessRoutes` in `routes.js`. That router
 * is mounted at '/' and calls `router.use(verifyToken)` internally, which makes
 * it a catch-all gate for everything registered after it — see the note in
 * `memberExtras.routes.js`, which is here for the same reason.
 *
 * Every route is signed in. There is no public shape of this: the WHOLE feature
 * is a member benefit, and the paid check on both participants lives in the
 * service so that no route can be added later that skips it.
 */
const router = express.Router();

router.use(verifyToken);

// The bell's badge. Declared before `/:id` so the literal is not eaten by the
// parameter route — the same trap the membership routes carry a note about.
router.get('/unread-count', controller.unreadCount);

router.get('/', controller.listConversations);

/*
 * A picture, stored and handed back as a url. Declared ABOVE `/:id` for the
 * same reason `/unread-count` is: a literal behind a parameter route is a
 * literal the parameter captures.
 */
router.post('/attachment', upload.single('image'), controller.uploadAttachment);

/** Open or start the thread with one member, from their directory profile. */
router.post('/with/:memberId', controller.openWith);

router.get('/:id', controller.listMessages);
router.post('/:id', controller.send);
router.post('/:id/read', controller.markRead);

module.exports = router;
