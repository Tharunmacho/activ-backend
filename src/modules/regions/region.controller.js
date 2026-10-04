const regionService = require('./region.service');
const geography = require('./geography');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

/**
 * The applicant-facing region endpoints.
 *
 * These are read-only and deliberately unauthenticated: registration is the
 * first thing a new applicant does, before any token exists. They expose only
 * region names and staffing counts — never an admin's email or identity.
 */

const publicNode = (node) => ({
    name: node.name,
    admins: node.admins
});

const getStates = asyncHandler(async(req, res) => {
    const tree = await regionService.getLocationTree();
    res.json(ApiResponse.success({
        states: tree.map(publicNode),
        // A client that gets an empty list needs to know the difference between
        // "the platform is not staffed yet" and "the request failed".
        coverageAvailable: tree.length > 0
    }));
});

const getDistricts = asyncHandler(async(req, res) => {
    const state = String(req.query.state || '').trim();
    const tree = await regionService.getLocationTree();
    const node = tree.find(entry => entry.name.toLowerCase() === state.toLowerCase());

    res.json(ApiResponse.success({
        state: node ? node.name : state,
        districts: node ? node.districts.map(publicNode) : [],
        coverageAvailable: tree.length > 0
    }));
});

const getBlocks = asyncHandler(async(req, res) => {
    const state = String(req.query.state || '').trim();
    const district = String(req.query.district || '').trim();

    const tree = await regionService.getLocationTree();
    const stateNode = tree.find(entry => entry.name.toLowerCase() === state.toLowerCase());
    const districtNode = stateNode
        ? stateNode.districts.find(entry => entry.name.toLowerCase() === district.toLowerCase())
        : null;

    res.json(ApiResponse.success({
        state: stateNode ? stateNode.name : state,
        district: districtNode ? districtNode.name : district,
        blocks: districtNode ? districtNode.blocks.map(publicNode) : [],
        coverageAvailable: tree.length > 0
    }));
});

/**
 * The whole tree in one call.
 *
 * A mobile client on a slow connection would otherwise make three round-trips
 * while the applicant waits between dropdowns. Names and counts only.
 *
 * Both include modes expose the national location directory. Coverage counts
 * still report actual staffing; they do not restrict member registration.
 */
const getTree = asyncHandler(async(req, res) => {
    const includeAll = String(req.query.include || '').toLowerCase() === 'all';
    const tree = await regionService.getLocationTree();

    res.json(ApiResponse.success({
        // What this listing actually is, echoed back. A client cannot otherwise
        // tell a platform with one staffed state from a narrower listing of a
        // platform with several, and that ambiguity is the bug that prompted the
        // parameter.
        include: includeAll ? 'all' : 'selectable',
        coverageAvailable: tree.length > 0,
        source: geography.metadata(),
        states: tree.map(stateNode => ({
            name: stateNode.name,
            admins: stateNode.admins,
            districts: stateNode.districts.map(districtNode => ({
                name: districtNode.name,
                admins: districtNode.admins,
                blocks: districtNode.blocks.map(publicNode)
            }))
        }))
    }));
});

/** Pre-flight check so the client can show the problem before submitting. */
const validate = asyncHandler(async(req, res) => {
    const result = await regionService.validateRegion({
        state: req.query.state,
        district: req.query.district,
        block: req.query.block
    });

    res.json(ApiResponse.success(result));
});

/**
 * The canonical India reference, for the super admin's own pickers only.
 *
 * A state admin is the root of the tree, so there is no parent admin to inherit
 * a state name from — this is what stops the first admin in a region being
 * created with a typo that every admin beneath them then inherits.
 */
const getGeography = asyncHandler(async(req, res) => {
    const state = String(req.query.state || '').trim();
    const district = String(req.query.district || '').trim();

    if (state && district) {
        return res.json(ApiResponse.success({ level: 'block', blocks: geography.listBlocks(state, district) }));
    }
    if (state) {
        return res.json(ApiResponse.success({ level: 'district', districts: geography.listDistricts(state) }));
    }
    return res.json(ApiResponse.success({ level: 'state', states: geography.listStates() }));
});

module.exports = {
    getStates,
    getDistricts,
    getBlocks,
    getTree,
    validate,
    getGeography
};
