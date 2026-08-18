class ApiResponse {
    constructor(statusCode, data, message = 'Success') {
        this.statusCode = statusCode;
        this.success = statusCode >= 200 && statusCode < 300;
        this.message = message;
        this.data = data;
    }

    static success(data, message = 'Success', statusCode = 200) {
        return new ApiResponse(statusCode, data, message);
    }

    static created(data, message = 'Created') {
        return new ApiResponse(201, data, message);
    }

    static noContent(message = 'No Content') {
        return new ApiResponse(204, null, message);
    }

    static error(message = 'Error', statusCode = 400) {
        return new ApiResponse(statusCode, null, message);
    }
}

module.exports = ApiResponse;