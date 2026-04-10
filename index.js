require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

/* ================= CONFIG ================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

/* ================= MEMORY ================= */
const groupState = {};

/* ================= HEALTH ================= */
app.get('/', (req, res) => {
  res.send('🟢 Bot is running');
});

/* ================= WEBHOOK ================= */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook error:", err);
    res.sendStatus(500);
  }
});

/* ================= LOCATION ================= */
function extractLocation(text) {
  text = text.replace(/[^\w\s:]/g, '').trim();

  let match = text.match(/location\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  match = text.match(/แปลง\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  if (/^[a-z]$/i.test(text)) return text.toUpperCase();

  return null;
}

/* ================= MAIN ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId =
    event.source.groupId ||
    event.source.roomId ||
    event.source.userId;

  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],
      currentLocation: null
    };
  }

  const state = groupState[groupId];

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    console.log("📸 image");

    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: null
    });

    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    console.log("💬", text);

    const loc = extractLocation(text);

    /* ===== LOCATION ===== */
    if (loc) {
      console.log("📍 location:", loc);

      state.currentLocation = loc;

      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
        }
      }

      return;
    }

    /* ===== SAVE ===== */
    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 saving...");

      await new Promise(r => setTimeout(r, 1500));

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) continue;

        // --- ส่วนที่แก้ไข: จัดฟอร์แมตวันที่และเวลาไทย ---
        const dateObj = new Date(item.timestamp);
        // วันที่ format: 2024-05-20
        const dateStr = dateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
        // เวลา format: 14-30-05
        const timeStr = dateObj.toLocaleTimeString('th-TH', { 
            timeZone: 'Asia/Bangkok', 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        }).replace(/:/g, '-');

        // ชื่อไฟล์ใหม่: สถานที่_วันที่_เวลา
        const customFileName = `${item.location}_${dateStr}_${timeStr}`;

        try {
          // ส่ง customFileName ไปที่ saveImage
          const res = await saveImage(item.id, item.location, dateStr, customFileName);

          if (res) {
            count++;
            const key = `${item.location}/${dateStr}`;
            summary[key] = (summary[key] || 0) + 1;
          }

        } catch (err) {
          console.error("❌ save error:", err);
        }
      }

      state.buffer = [];

      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;
      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= SAVE ================= */
// เพิ่มพารามิเตอร์ customFileName
async function saveImage(messageId, location, dateStr, customFileName) {
  console.log("⬆️ upload:", customFileName);

  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: `${location}/${dateStr}`,
        public_id: customFileName, // ใช้ชื่อไฟล์ที่เราตั้งแทน messageId
        overwrite: true
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    ).end(buffer);
  });
}

/* ================= REPLY ================= */
function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text
  });
}

/* ================= START ================= */
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server running with Custom Filename ICT');
});