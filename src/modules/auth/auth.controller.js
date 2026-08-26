const authService = require('./auth.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

const register = asyncHandler(async(req, res) => {
    const result = await authService.register(req.body);

    res.status(201).json(
        ApiResponse.created(result, 'Registration successful')
    );
});

const login = asyncHandler(async(req, res) => {
    const { email, password } = req.body;

    const result = await authService.login(email, password);

    res.json(
        ApiResponse.success(result, 'Login successful')
    );
});

const refreshToken = asyncHandler(async(req, res) => {
    const { refreshToken } = req.body;

    const tokens = await authService.refreshToken(refreshToken);

    res.json(
        ApiResponse.success(tokens, 'Token refreshed')
    );
});

const logout = asyncHandler(async(req, res) => {
    await authService.logout(req.user.userId);

    res.json(
        ApiResponse.success(null, 'Logout successful')
    );
});

const getCurrentUser = asyncHandler(async(req, res) => {
    // The whole token is passed, not just the id: admins have no row in `users`
    // and are located by the email claim instead.
    const user = await authService.getCurrentUser(req.user.userId, req.user);

    res.json(
        ApiResponse.success(user, 'User fetched successfully')
    );
});

/**
 * Always answers the same way, whether or not the address is registered.
 * See the note in authService.requestPasswordReset.
 */
const forgotPassword = asyncHandler(async(req, res) => {
    const { email } = req.body;

    const result = await authService.requestPasswordReset(email);

    res.json(ApiResponse.success(result, result.message));
});

const verifyResetToken = asyncHandler(async(req, res) => {
    const token = req.query.token || req.body.token;

    const result = await authService.verifyResetToken(token);

    res.json(ApiResponse.success(result));
});

const resetPassword = asyncHandler(async(req, res) => {
    const { token, newPassword, password } = req.body;

    // `password` is accepted as an alias so a client that reuses its
    // change-password form field does not silently send nothing.
    await authService.resetPassword(token, newPassword || password);

    res.json(
        ApiResponse.success(null, 'Password reset successfully. You can now sign in.')
    );
});

const changePassword = asyncHandler(async(req, res) => {
    const { oldPassword, newPassword } = req.body;

    await authService.changePassword(req.user.userId, oldPassword, newPassword);

    res.json(
        ApiResponse.success(null, 'Password changed successfully')
    );
});

module.exports = {
    register,
    login,
    refreshToken,
    logout,
    getCurrentUser,
    changePassword,
    forgotPassword,
    verifyResetToken,
    resetPassword
};