const ApiError = require('../../core/utils/ApiError');

/** Capture only the organiser's declared questions, preserving their labels. */
const buildResponses = (fields = [], payload = {}) => {
    const answers = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const errors = {};
    const rows = (fields || []).filter((field) => field && field.key).map((field) => {
        const raw = Object.prototype.hasOwnProperty.call(answers, field.key) ? answers[field.key] : '';
        const scalar = ['string', 'number', 'boolean'].includes(typeof raw) ? String(raw).trim() : '';
        let value = field.type === 'checkbox' ? (raw === true || raw === 'true' ? 'Yes' : 'No') : scalar;
        const label = field.label || field.key;
        const invalid = (message) => { errors[`responses.${field.key}`] = message; };
        if (field.required && field.type === 'checkbox' && value !== 'Yes') invalid(`${label} must be ticked`);
        else if (field.required && !value) invalid(`${label} is required`);
        else if (value.length > 2000) invalid(`${label} must be 2000 characters or fewer`);
        else if (value && field.type === 'select') {
            const option = (field.options || []).find((item) => String(item).toLowerCase() === value.toLowerCase());
            if (option === undefined) invalid(`Choose an option for ${label}`);
            else value = String(option);
        } else if (value && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) invalid(`Enter a valid email for ${label}`);
        else if (value && field.type === 'number' && !Number.isFinite(Number(value))) invalid(`Enter a number for ${label}`);
        else if (value && field.type === 'phone' && !/^\+?[\d\s().-]{7,25}$/.test(value)) invalid(`Enter a valid phone number for ${label}`);
        else if (value && field.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) invalid(`Enter a valid date for ${label}`);
        return { key: field.key, label, value };
    });
    if (Object.keys(errors).length) {
        const error = ApiError.badRequest(Object.values(errors)[0]);
        error.fields = errors;
        throw error;
    }
    return rows;
};

module.exports = { buildResponses };
