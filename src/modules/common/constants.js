// Application Status
const APPLICATION_STATUS = {
    PENDING_BLOCK: 'pending_block',
    PENDING_DISTRICT: 'pending_district',
    PENDING_STATE: 'pending_state',
    APPROVED: 'approved',
    REJECTED: 'rejected'
};

// User Roles
const USER_ROLES = {
    MEMBER: 'member',
    BLOCK_ADMIN: 'block_admin',
    DISTRICT_ADMIN: 'district_admin',
    STATE_ADMIN: 'state_admin',
    SUPER_ADMIN: 'super_admin'
};

// Application Types
const APPLICATION_TYPES = {
    MEMBERSHIP: 'membership',
    BUSINESS_PROFILE: 'business_profile',
    UDYAM_REGISTRATION: 'udyam_registration'
};

module.exports = {
    APPLICATION_STATUS,
    USER_ROLES,
    APPLICATION_TYPES
};