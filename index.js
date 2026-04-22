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

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;

  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],
      currentLocation: null
    };
  }

  const state = groupState[groupId];

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp, // เก็บเวลาที่ส่งภาพไว้
      location: null
    });
    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    if (loc) {
      state.currentLocation = loc;
      for (let item of state.buffer) {
        if (!item.location) item.location = loc;
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

        // แยกโฟลเดอร์ตามวันที่
        const dateStr = new Date(item.timestamp + (7 * 60 * 60 * 1000))
          .toISOString()
          .split('T')[0];

        try {
          // 🔥 ส่ง item.timestamp เข้าไปเพื่อใช้ตั้งชื่อไฟล์
          const res = await saveImage(item.id, item.location, dateStr, item.timestamp);

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

/* ================= SAVE (UPDATED) ================= */
async function saveImage(messageId, location, dateStr, timestamp) {
  console.log("⬆️ upload:", messageId);

  // 1. จัดการเวลาให้เป็น Timezone ไทย (GMT+7)
  const thaiTime = new Date(timestamp + (7 * 60 * 60 * 1000));
  
  // 2. สร้างชื่อไฟล์: YYYY-MM-DD_HH-mm-ss (เช่น 2026-04-22_14-30-05)
  const timeName = thaiTime.toISOString()
    .replace(/T/, '_')      // เปลี่ยน T เป็น _
    .replace(/\..+/, '')    // ตัดเสี้ยววินาทีออก
    .replace(/:/g, '-');    // เปลี่ยน : เป็น - เพื่อความปลอดภัยของชื่อไฟล์

  // 3. ป้องกันชื่อซ้ำ (กรณีส่งหลายรูปในวินาทีเดียว) โดยการต่อท้ายด้วย 4 ตัวท้ายของ Message ID
  const finalFileName = `${timeName}_${messageId.slice(-4)}`;

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
        public_id: finalFileName, // ใช้ชื่อไฟล์ที่เราสร้างตามวันเวลา
        overwrite: true,
        resource_type: "image"
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
  console.log('🚀 Server is running with Date-Time Filename support');
});