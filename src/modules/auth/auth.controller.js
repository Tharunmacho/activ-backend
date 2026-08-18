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
    const user = await authService.getCurrentUser(req.user.userId);

    res.json(
        ApiResponse.success(user, 'User fetched successfully')
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
    changePassword
};