require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

// ===== CONFIG =====
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

// ===== MEMORY (สะสมข้ามวัน) =====
const groupState = {};

// ===== WEBHOOK =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// ===== LOCATION PARSER =====
function extractLocation(text) {
  text = text.replace(/[^\w\s:]/g, '').trim();

  let match = text.match(/location\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  match = text.match(/แปลง\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  if (/^[a-z]$/i.test(text)) return text.toUpperCase();

  return null;
}

// ===== MAIN =====
async function handleEvent(event) {
  if (event.type !== 'message') return null;

  const groupId = event.source.groupId || event.source.roomId;
  if (!groupId) return null;

  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],   // เก็บทั้งหมด
      pending: []   // รูปที่ยังไม่มี location
    };
  }

  const state = groupState[groupId];

  // ===== IMAGE =====
  if (event.message.type === 'image') {
    const item = {
      id: event.message.id,
      timestamp: event.timestamp,
      location: null
    };

    state.buffer.push(item);
    state.pending.push(item);

    return null;
  }

  // ===== TEXT =====
  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    // 📍 LOCATION
    const loc = extractLocation(text);
    if (loc) {
      for (let item of state.pending) {
        item.location = loc;
      }
      state.pending = [];
      return null;
    }

    // 💾 SAVE (กดทีเดียวจบทั้งหมด)
    if (text === 'บันทึกรูปภาพ') {

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {

        if (!item.location) continue;

        const date = new Date(item.timestamp);
        const dateStr = date.toISOString().split('T')[0];

        const res = await saveImage(item.id, item.location, dateStr);

        if (res) {
          count++;

          const key = `${item.location}/${dateStr}`;
          if (!summary[key]) summary[key] = 0;
          summary[key]++;
        }
      }

      // 🔥 ปิดรอบ = ล้างทั้งหมด
      state.buffer = [];
      state.pending = [];

      // ===== สรุป =====
      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;

      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      return reply(event.replyToken, replyText);
    }
  }

  return null;
}

// ===== SAVE (กันซ้ำถาวร) =====
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
        folder: `${location}/${dateStr}`,
        public_id: messageId, // กันซ้ำ
        overwrite: false
      },
      (err, result) => {
        if (err) {
          if (err.message && err.message.includes('already exists')) {
            return resolve(null); // ข้ามรูปซ้ำ
          }
          return reject(err);
        }

        resolve(result);
      }
    ).end(buffer);
  });
}

// ===== REPLY =====
function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text
  });
}

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
  console.log('Server running...');
});