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

/* ================= HEALTH CHECK ================= */
app.get('/', (req, res) => {
  res.send('🟢 Bot is running');
});

/* ================= WEBHOOK ================= */
app.post('/webhook', line.middleware(config), async (req, res) => {
  console.log("📩 webhook hit");

  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook error:", err);
    res.sendStatus(500);
  }
});

/* ================= LOCATION PARSER ================= */
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

  console.log("📨 event:", event.message.type);

  // 🔥 รองรับทุกกรณี
  const groupId =
    event.source.groupId ||
    event.source.roomId ||
    event.source.userId;

  if (!groupId) return;

  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],
      pending: []
    };
  }

  const state = groupState[groupId];

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    console.log("📸 image received");

    const item = {
      id: event.message.id,
      timestamp: event.timestamp,
      location: null
    };

    state.buffer.push(item);
    state.pending.push(item);

    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    console.log("💬 text:", text);

    // 📍 LOCATION
    const loc = extractLocation(text);
    if (loc) {
      console.log("📍 location:", loc);

      for (let item of state.pending) {
        item.location = loc;
      }

      state.pending = [];
      return;
    }

    // 💾 SAVE
    if (text === 'บันทึกรูปภาพ') {

      console.log("💾 saving...");

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {

        if (!item.location) continue;

        const date = new Date(item.timestamp);
        const dateStr = date.toISOString().split('T')[0];

        try {
          const res = await saveImage(item.id, item.location, dateStr);

          if (res) {
            count++;

            const key = `${item.location}/${dateStr}`;
            if (!summary[key]) summary[key] = 0;
            summary[key]++;
          }

        } catch (err) {
          console.error("❌ save error:", err);
        }
      }

      // reset
      state.buffer = [];
      state.pending = [];

      // ===== SUMMARY =====
      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;

      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= SAVE ================= */
async function saveImage(messageId, location, dateStr) {
  console.log("⬆️ uploading:", messageId);

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
        public_id: messageId,
        overwrite: false
      },
      (err, result) => {
        if (err) {
          if (err.message && err.message.includes('already exists')) {
            return resolve(null);
          }
          return reject(err);
        }

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
  console.log('🚀 Server running FIXED version');
});