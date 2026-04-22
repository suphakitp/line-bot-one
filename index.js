require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

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

app.get('/', (req, res) => {
  res.send('🟢 Bot is running');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook error:", err);
    res.sendStatus(500);
  }
});

/* ================= LOCATION EXTRACTOR ================= */
function extractLocation(text) {
  text = text.replace(/[^\w\s:]/g, '').trim();
  let match = text.match(/location\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();
  match = text.match(/แปลง\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();
  if (/^[a-z]$/i.test(text)) return text.toUpperCase();
  return null;
}

/* ================= MAIN LOGIC ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;

  // สร้าง State ถ้ายังไม่มี
  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],
      lastLocation: null // 🔥 เก็บโลเคชั่นล่าสุดที่เคยพิมพ์ไว้
    };
  }

  const state = groupState[groupId];

  /* ===== 1. ถ้าเป็น IMAGE ===== */
  if (event.message.type === 'image') {
    console.log("📸 image received");
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      // 🔥 ถ้ารู้โลเคชั่นอยู่แล้ว (เคยพิมพ์ทิ้งไว้) ให้ใส่ไปเลย
      location: state.lastLocation 
    });
    return;
  }

  /* ===== 2. ถ้าเป็น TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    // --- กรณีพิมพ์โลเคชั่นใหม่เข้ามา ---
    if (loc) {
      console.log("📍 New location set:", loc);
      state.lastLocation = loc; // อัปเดตโลเคชั่นล่าสุด

      // ไล่ใส่โลเคชั่นให้รูปภาพที่ค้างอยู่ใน Buffer (กรณีส่งรูปก่อนพิมพ์โลเคชั่น)
      for (let item of state.buffer) {
        if (!item.location) item.location = loc;
      }
      return;
    }

    // --- กรณีสั่งบันทึกรูปภาพ ---
    if (text === 'บันทึกรูปภาพ') {
      if (state.buffer.length === 0) {
        return reply(event.replyToken, "⚠️ ไม่มีรูปภาพที่รอการบันทึก");
      }

      console.log("💾 saving images...");
      await new Promise(r => setTimeout(r, 1000));

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        // ถ้ารูปไหนไม่มีโลเคชั่น (ยังไม่ได้พิมพ์บอก) ให้ข้ามไป
        if (!item.location) continue;

        const dateStr = new Date(item.timestamp + (7 * 60 * 60 * 1000))
          .toISOString().split('T')[0];

        try {
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

      // หลังบันทึกเสร็จ เคลียร์แค่รูปภาพ แต่ยังจำ lastLocation ไว้เหมือนเดิม
      state.buffer = [];

      if (count === 0) {
        return reply(event.replyToken, "⚠️ ไม่สามารถบันทึกได้ (กรุณาระบุโลเคชั่นก่อน)");
      }

      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;
      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }
      return reply(event.replyToken, replyText);
    }
    
    // 🔥 ถ้าพิมพ์ข้อความอื่นๆ บอทจะไม่ทำอะไร (แต่จะไม่ทำลาย Buffer เดิม)
    console.log("💬 Other text:", text);
  }
}

/* ================= SAVE IMAGE ================= */
async function saveImage(messageId, location, dateStr, timestamp) {
  const thaiTime = new Date(timestamp + (7 * 60 * 60 * 1000));
  const isoString = thaiTime.toISOString();
  const datePart = isoString.split('T')[0];
  const timePart = isoString.split('T')[1].substring(0, 5).replace(/:/g, '-');

  const finalFileName = `Location ${location} ${datePart}_Time ${timePart}_${messageId.slice(-4)}`;

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
        public_id: finalFileName, 
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

function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server is running (Improved Location Persistence)');
});