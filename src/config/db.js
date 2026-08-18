const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');

const connectDB = async() => {
    try {
        const uri = config.env === 'test' ? config.db.testUri : config.db.uri;

        await mongoose.connect(uri, config.db.options);

        logger.info(`MongoDB connected: ${mongoose.connection.host}`);

        mongoose.connection.on('error', (err) => {
            logger.error('MongoDB connection error:', err);
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected');
        });

        process.on('SIGINT', async() => {
            await mongoose.connection.close();
            logger.info('MongoDB connection closed through app termination');
            process.exit(0);
        });

    } catch (error) {
        logger.error('MongoDB connection failed:', error);
        process.exit(1);
    }
};

module.exports = connectDB;