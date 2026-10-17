// Adapt pre-existing in-memory retry fixtures to the new persistent claim.
// Atomic database behavior is covered separately against loopback MongoDB.
module.exports = (Log, getRow) => {
    const previous = Log.updateOne;
    Log.updateOne = async (filter, update) => {
        if (!Object.hasOwn(filter, 'retryClaim.token')) return previous.call(Log, filter, update);
        const row = await getRow(filter._id);
        const expected = filter['retryClaim.token'];
        if (!row || (typeof expected === 'string' ? row.retryClaim?.token !== expected : !!row.retryClaim?.token)) return { matchedCount: 0 };
        for (const [key, value] of Object.entries(update.$set || {})) {
            const parts = key.split('.');
            const leaf = parts.pop();
            let target = row;
            for (const part of parts) target = target[part] ||= {};
            target[leaf] = value;
        }
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        return { matchedCount: 1 };
    };
};
