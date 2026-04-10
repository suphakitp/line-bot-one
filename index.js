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

  // ✅ รองรับ Location A : 11:05 AM
  let match = text.match(/location\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  match = text.match(/แปลง\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  // ✅ รองรับ A หรือ A 11:05
  match = text.match(/^([a-z])(\s|$)/i);
  if (match) return match[1].toUpperCase();

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
      location: state.currentLocation || null
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

        const dateStr = new Date(item.timestamp)
          .toISOString()
          .split('T')[0];

        try {
          // ✅ ส่ง timestamp เข้าไป
          const res = await saveImage(
            item.id,
            item.location,
            dateStr,
            item.timestamp
          );

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
async function saveImage(messageId, location, dateStr, timestamp) {
  console.log("⬆️ upload:", messageId, location);

  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  // ===== FORMAT วันที่ + เวลา =====
  const d = new Date(timestamp);

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear() + 543).slice(-2);

  const hours24 = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');

  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = String(hours24 % 12 || 12).padStart(2, '0');

  // ✅ ชื่อไฟล์
  const fileName = `${location}_${day}-${month}-${year}_${hours24}-${minutes}`;

  // ✅ ข้อความบนรูป
  const overlayText = `Location ${location} : ${hours12}:${minutes} ${ampm}`;

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: `${location}/${dateStr}`,
        public_id: fileName,
        overwrite: false,

        // ✅ เขียนข้อความลงรูป
        transformation: [
          {
            overlay: {
              font_family: "Arial",
              font_size: 40,
              text: overlayText
            },
            gravity: "south_east",
            x: 20,
            y: 20,
            color: "#ffffff",
            background: "rgba(0,0,0,0.5)"
          }
        ]
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
  console.log('🚀 Server running FINAL FIXED');
});