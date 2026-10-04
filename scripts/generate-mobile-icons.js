// Package the approved runner + ACTIV artwork into native launcher assets.
// Run from backend: node scripts/generate-mobile-icons.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '../../frontend');
const input = path.join(root, 'assets/branding/activ-launcher-foreground.png');
const background = '#c8d2db';
const write = (name, content) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, content); };
async function main() {
    const logo = await sharp(input).trim().toBuffer();
    const square = async(size, fraction) => {
        const mark = await sharp(logo).resize(Math.round(size * fraction), Math.round(size * fraction), { fit: 'inside' }).toBuffer();
        return sharp({ create: { width: size, height: size, channels: 4, background } }).composite([{ input: mark, gravity: 'centre' }]).flatten({ background }).png().toBuffer();
    };
    const res = path.join(root, 'android/app/src/main/res');
    for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
        // Legacy launchers: inset artwork also stays visible under a round mask.
        const bytes = await square(48 * scale, 0.76);
        for (const name of ['ic_launcher', 'ic_launcher_round']) write(path.join(res, `mipmap-${density}/${name}.png`), bytes);
        // Android adaptive foreground: the full mark fits inside the 66dp safe area.
        const mark = await sharp(logo).resize(Math.round(62 * scale), Math.round(62 * scale), { fit: 'inside' }).toBuffer();
        const foreground = await sharp({ create: { width: 108 * scale, height: 108 * scale, channels: 4, background: '#00000000' } }).composite([{ input: mark, gravity: 'centre' }]).png().toBuffer();
        write(path.join(res, `drawable-${density}/ic_launcher_foreground.png`), foreground);
    }
    write(path.join(res, 'values/launcher_colors.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">${background}</color></resources>\n`);
    const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n    <monochrome android:drawable="@drawable/ic_launcher_foreground" />\n</adaptive-icon>\n`;
    for (const name of ['ic_launcher', 'ic_launcher_round']) write(path.join(res, `mipmap-anydpi-v26/${name}.xml`), adaptive);
    const ios = path.join(root, 'ios/Activ/Images.xcassets/AppIcon.appiconset');
    const images = [];
    const add = async(idiom, points, scale) => {
        const filename = `activ-${idiom}-${points}@${scale}x.png`;
        write(path.join(ios, filename), await square(Math.round(points * scale), 0.86));
        images.push({ idiom, size: `${points}x${points}`, scale: `${scale}x`, filename });
    };
    for (const points of [20, 29, 40, 60]) for (const scale of [2, 3]) await add('iphone', points, scale);
    for (const points of [20, 29, 40, 76]) for (const scale of [1, 2]) await add('ipad', points, scale);
    await add('ipad', 83.5, 2);
    await add('ios-marketing', 1024, 1);
    write(path.join(ios, 'Contents.json'), JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
    write(path.join(root, 'assets/branding/activ-launcher-preview.png'), await square(512, 0.86));
    console.log('Generated Android legacy/adaptive/themed launcher assets and all iPhone/iPad icon sizes.');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
