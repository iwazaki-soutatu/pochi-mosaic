const express = require('express')
const multer = require('multer')
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const { Image } = require('image-js');
const sharp = require('sharp')

const app = express()
app.use(express.static('public'))
const port = 3001

//multerライブラリ使うやつ
const upload = multer({ storage: multer.memoryStorage() })

//supabaseの操作のやつ
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

//0~255に対して0~63は1、64~127は2、的なの返す関数、4分割で近い値を探すためのrgb_nearを出すやつ
function classifyValue(value) {
    if (value >= 0 && value <= 31) {
        return 1;
    } else if (value >= 32 && value <= 63) {
        return 2;
    } else if (value >= 64 && value <= 95) {
        return 3;
    } else if (value >= 96 && value <= 127) {
        return 4;
    } else if (value >= 128 && value <= 159) {
        return 5;
    } else if (value >= 160 && value <= 191) {
        return 6;
    } else if (value >= 192 && value <= 223) {
        return 7;
    } else if (value >= 224 && value <= 255) {
        return 8;
    } else {
        throw new Error('Value out of range (0-255)');
    }
}

async function createMosaic(pixelImages, width, height, tileSize, mosaicSize) {
    const canvasWidth = width * tileSize;
    const canvasHeight = height * tileSize;

    const resizePromises = pixelImages.map((image, index) => {

        return sharp(image).resize(tileSize, tileSize).toBuffer()
    });
    const resizedBuffers = await Promise.all(resizePromises);

    const compositeList = resizedBuffers.map((buffer, index) => ({
        input: buffer,
        top: Math.floor(index / width) * tileSize,
        left: (index % width) * tileSize,
    }));

    await sharp({
        create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
    })
        .composite(compositeList)
        .toFile(`public/outputs/output-${mosaicSize}-${tileSize}.png`);

    console.log('Mosaic created as output.png');
}

app.post('/mosaicArt', upload.single('image'),  async (req, res) => {
    try{

        //モザイクの強度決定
        const mosaicSize = 80
        //モザイクアートの位置ピクセルの画像サイズ
        const tileSize = 15
        //storageのバケット名
        const bucketName = 'images'

        //rgb_nearの値に合致するデータがなかったとき用の真っ白な画像のBuffer
        const whiteBuffer = await sharp({
            create: {
                width: tileSize,
                height: tileSize,
                channels: 4,
                background: {r: 255, g: 255, b: 255, alpha: 1},
            },
        }).png().toBuffer()

        //画像の読み込み
        const uploadedBuffer = req.file.buffer
        const image = await Image.load(uploadedBuffer)

        //ピクセル化のためにリサイズ（縮小）
        const smallImage = image.resize({
            width: Math.floor(image.width / mosaicSize),
            height: Math.floor(image.width / mosaicSize),
            interpolation: 'nearestNeighbor', // ピクセル化のため「最近傍法」を使用
        });

        console.log("Resize complete")

        //プログラムを動かした時点でのrgb_nearが111から444まで全てのデータを格納するやつ
        // rgb_near_data の取得を一括化
        const rgb_near_data = {};
        const { data: allData, error } = await supabase.from('test-table').select('*');
        if (error) {
            console.error('Error fetching data from Supabase:', error);
            return res.status(500).send('Failed to fetch data from Supabase');
        }

        // データを rgb_near ごとに整理
        allData.forEach(item => {
            const key = item.rgb_near.toString();
            if (!rgb_near_data[key]) {
                rgb_near_data[key] = [];
            }
            rgb_near_data[key].push(item);
        });

        console.log("Table import complete")

        const downloadPromises = [];

        const smallImage_data_length = smallImage.data.length
        const smallImage_data_length_four = smallImage_data_length / 4

        for (let i = 0; i < smallImage_data_length; i += 4) {
            const r = smallImage.data[i];
            const g = smallImage.data[i + 1];
            const b = smallImage.data[i + 2];

            const rgb_near = classifyValue(r) * 100 + classifyValue(g) * 10 + classifyValue(b);
            let rgb_near_data_length = rgb_near_data[rgb_near.toString()]?.length || 0;

            if (rgb_near_data_length === 0) {
                //データがなかった場合
                downloadPromises.push(whiteBuffer)
                console.log(`${i/4}/${smallImage_data_length_four}`, "whiteBuffer")
                continue;
            }

            const imagePath = rgb_near_data[rgb_near.toString()][
                Math.floor(Math.random() * rgb_near_data_length)
            ].imageURL;

            // ファイル名を抽出
            const PathSlice = imagePath.split('/').slice(-2);
            const result = `${PathSlice[0]}/${PathSlice[1]}`
            console.log(`${i/4}/${smallImage_data_length_four}`,result)

            // Supabaseから画像をダウンロードするPromiseを作成
            downloadPromises.push(
                await supabase.storage.from(bucketName).download(result)
                    .then(({ data, error }) => {
                        if (error) {
                            console.error('Supabase download error:', error);
                            return whiteBuffer; // ダウンロード失敗の場合はnullを返す
                        }
                        return data.arrayBuffer();
                    })
                    .then(buffer => {
                        if (buffer) {
                            return sharp(Buffer.from(buffer))
                                .resize(tileSize, tileSize)
                                .toBuffer();
                        }
                        return null;
                    })
            );
        }

        // すべてのPromiseを並列処理
        const pixelImages = (await Promise.all(downloadPromises)).filter(img => img !== null);

        console.log("pixelImages import complete")

        const gridWidth = Math.sqrt(pixelImages.length)
        const gridHeight = gridWidth

        //モザイク画像を作る関数
        createMosaic(pixelImages, gridWidth, gridHeight, tileSize, mosaicSize)

        res.send({ message: "mosaicArt created successfully" })
    }catch(err){
        console.log(err)
    }
});


app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

// 引用: https://expressjs.com/en/starter/hello-world.html


/**
curl -X POST -F "image=@rgb-0-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-0-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-31-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-63-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-95-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-127-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-159-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-191-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-223-255-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-0-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-31-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-63-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-95-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-127-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-159-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-191-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-223-255.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-0.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-31.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-63.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-95.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-127.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-159.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-191.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-223.png" http://localhost:3000/upload/rgb-data
curl -X POST -F "image=@rgb-255-255-255.png" http://localhost:3000/upload/rgb-data
 */