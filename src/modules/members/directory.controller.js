const directoryService = require('./directory.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const asyncHandler = require('../../core/utils/asyncHandler');
const { recordView } = require('../common/engagement.model');
const { resolveMemberContext } = require('../common/memberContext');
const mongoose = require('mongoose');

/**
 * The filters this endpoint accepts, named explicitly.
 *
 * `req.query` is NOT spread into the service. `memberService.getMembers` does
 * exactly that, which lets a caller filter the member collection on any field
 * of the schema — and a filter is an oracle: `?aadhaarNumber=1234` answers
 * whether anyone holds that number. Naming the five filters here means a query
 * parameter nobody planned for does nothing at all.
 */
const FILTERS = ['q', 'state', 'district', 'block', 'sector', 'memberType'];

const pickFilters = (query = {}) => FILTERS.reduce((acc, key) => {
    if (query[key] !== undefined) acc[key] = query[key];
    return acc;
}, {});

const searchDirectory = asyncHandler(async(req, res) => {
    const query = req.query || {};

    /*
     * The viewer's own region travels back with the results.
     *
     * It is NOT applied here. A member looking for a supplier almost always
     * wants their own block first, and the screen should open there — but a
     * region filter the server applies invisibly is one the member cannot see,
     * cannot account for and cannot widen. What they would report is "the
     * directory is empty", not "my block has two members in it". So the region
     * comes back as data, the screen pre-fills its dropdowns with it and shows
     * them as active filters, and clearing them searches the association.
     *
     * Read from the member record rather than the token: `auth.service` mints
     * some member tokens without the location claims, so half of all callers
     * would get an empty region and silently fall through to a national search.
     * See `resolveMemberContext`.
     */
    const viewer = await resolveMemberContext(req);

    const data = await directoryService.search(pickFilters(query), query.page, query.limit);

    res.json(ApiResponse.success({
        ...data,
        viewerRegion: directoryService.viewerRegion(viewer)
    }));
});

const listSectors = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success({ sectors: directoryService.listSectors() }));
});

const getDirectoryEntry = asyncHandler(async(req, res) => {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) {
        throw ApiError.badRequest('That is not a valid member id');
    }

    const entry = await directoryService.getEntry(req.params.id);
    // A member who is not listed and one who does not exist get the same
    // answer, so the directory cannot be used to probe for either.
    if (!entry) throw ApiError.notFound('Member not found');

    /*
     * This is what a profile view IS.
     *
     * Recorded here rather than anywhere the profile happens to be rendered,
     * because this is the one request that means "somebody opened this member's
     * card". `recordView` ignores a member viewing themselves and collapses
     * repeat views to one per viewer per day — see its own note — and it never
     * throws, so a failure to count cannot fail the read.
     *
     * Not awaited: the viewer is waiting for a profile, not for a counter.
     */
    recordView({
        kind: 'profile',
        targetId: entry.id,
        ownerId: entry.id,
        viewerId: String((req.user || {}).userId || (req.user || {}).id || '')
    });

    res.json(ApiResponse.success(entry));
});

module.exports = { searchDirectory, listSectors, getDirectoryEntry };
