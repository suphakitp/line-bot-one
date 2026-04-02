const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

// ===== LINE CONFIG =====
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

// ===== CLOUDINARY CONFIG =====
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// ===== MEMORY =====
const userBuffers = {};     // เก็บรูป
const userLocations = {};   // เก็บ location ล่าสุด
const savedImages = new Set(); // กันรูปซ้ำ

// ===== WEBHOOK =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// ===== 📍 SMART PARSER (รองรับ IoT หลายแบบ) =====
function extractLocation(text) {
  if (!text) return null;

  // แบบ: Location A, Location B
  let match = text.match(/Location\s*([A-Za-z0-9]+)/i);
  if (match) return match[1];

  // fallback: ถ้าพิมพ์สั้นๆ เช่น A หรือ B
  match = text.match(/^[A-Za-z]$/);
  if (match) return match[0];

  return null;
}

// ===== MAIN =====
async function handleEvent(event) {
  const source = event.source;
  const id = source.userId || source.groupId;
  if (!id) return null;

  if (event.type === 'message') {

    // ===== 📸 รับรูป =====
    if (event.message.type === 'image') {
      if (!userBuffers[id]) userBuffers[id] = [];
      userBuffers[id].push(event.message.id);
      console.log('📸 Image received:', event.message.id);
      return null;
    }

    // ===== 📝 รับข้อความ =====
    if (event.message.type === 'text') {
      const text = event.message.text.trim();

      // ===== 💾 คำสั่งบันทึก =====
      if (text === 'บันทึกรูปภาพ' || text === 'บันทึกรูป') {

        const images = userBuffers[id] || [];

        if (!images || images.length === 0) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ไม่มีรูปให้บันทึก'
          });
        }

        const location = userLocations[id] || 'ไม่ระบุ';
        const dateStr = new Date().toISOString().split('T')[0];

        let savedCount = 0;

        for (let imgId of images) {
          if (savedImages.has(imgId)) continue;

          await saveImage(imgId, location, dateStr);
          savedImages.add(imgId);
          savedCount++;
        }

        userBuffers[id] = [];

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `บันทึกรูปภาพแล้ว (${savedCount} รูป) จาก ${location}`
        });
      }

      // ===== 📍 parse location (IoT + manual) =====
      const loc = extractLocation(text);

      if (loc) {
        userLocations[id] = loc;
        console.log('📍 Location detected:', loc);
      }
    }
  }

  return null;
}

// ===== 📤 SAVE IMAGE =====
async function saveImage(messageId, location, dateStr) {
  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: `${location}/${dateStr}`
      },
      (error, result) => {
        if (error) return reject(error);
        console.log('✅ Uploaded:', result.secure_url);
        resolve(result);
      }
    ).end(buffer);
  });
}

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server running...');
});