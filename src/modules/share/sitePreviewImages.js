const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const images = new Map(['activ-conference', 'preview-placeholder'].map(name => {
    const bytes = fs.readFileSync(path.join(__dirname, 'assets', `${name}.jpg`));
    const version = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20);
    return [name, { bytes, version }];
}));

const imagePath = name => `/api/v1/share/site-images/${name}/${images.get(name).version}.jpg`;
const imageOf = (name, version) => {
    const image = images.get(name);
    return image && image.version === version ? image : null;
};

module.exports = { imagePath, imageOf };
