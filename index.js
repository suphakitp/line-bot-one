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
const userBuffers = {};
const userLocations = {};
const savedImages = new Set(); // กันซ้ำ

// ===== WEBHOOK =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// ===== 📍 EXTRACT LOCATION (IoT) =====
function extractLocation(text) {
  // รองรับ Location A, B, C...
  const match = text.match(/Location\s*([A-Za-z0-9]+)/i);
  if (match) {
    return match[1]; // เช่น A, B
  }
  return text; // fallback
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
      return null;
    }

    // ===== 📝 ข้อความ =====
    if (event.message.type === 'text') {
      const text = event.message.text.trim();

      // ===== 💾 คำสั่งบันทึก =====
      if (text === 'บันทึกรูปภาพ' || text === 'บันทึกรูป') {

        const images = userBuffers[id] || [];
        const location = userLocations[id] || 'ไม่ระบุ';
        const dateStr = new Date().toISOString().split('T')[0];

        if (images.length === 0) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ไม่มีรูปให้บันทึก'
          });
        }

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

      // ===== 📍 เก็บ location (รองรับ IoT) =====
      userLocations[id] = extractLocation(text);
      return null;
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
        console.log('Uploaded:', result.secure_url);
        resolve(result);
      }
    ).end(buffer);
  });
}

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
  console.log('Server running...');
});