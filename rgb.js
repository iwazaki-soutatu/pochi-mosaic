const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// RGB値の組み合わせリスト
const rgbValues = [0, 31, 63, 95, 127, 159, 191, 223, 255];

// 保存先フォルダ
const outputDir = path.join(__dirname, 'public');

// フォルダを作成
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// 1x1画像を生成して保存
async function generateImages() {
    let count = 0;

    let string = "";

    for (const r of rgbValues) {
        for (const g of rgbValues) {
            for (const b of rgbValues) {
                // 1x1画像のピクセルデータ（RGBA: R, G, B, Alpha）
                const pixel = Buffer.from([r, g, b, 255]);

                // sharpで画像を生成
                const fileName = `rgb-${r}-${g}-${b}.png`;
                const filePath = path.join(outputDir, fileName);

                await sharp(pixel, {
                    raw: {
                        width: 1,
                        height: 1,
                        channels: 4,
                    },
                })
                    .toFile(filePath);

                string += `curl -X POST -F "image=@${fileName}" http://localhost:3000/upload/rgb-data\n`
                count++;
                console.log(`Generated ${fileName}`);
            }
        }
    }

    console.log(`Total images generated: ${count}`);
    console.log(string)
}

// 実行
generateImages().catch((err) => console.error(err));
