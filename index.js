require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const Jimp = require('jimp'); // ต้องมีบรรทัดนี้

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
  res.send('🟢 Bot is running with Photo Watermark');
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

/* ================= LOCATION (ดึงค่าแม่นยำขึ้น) ================= */
function extractLocation(text) {
  let match = text.match(/(?:location|แปลง)\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();
  if (/^[a-z0-9]+$/i.test(text.trim())) return text.trim().toUpperCase();
  return null;
}

/* ================= MAIN ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;

  if (!groupState[groupId]) {
    groupState[groupId] = { buffer: [], currentLocation: null };
  }

  const state = groupState[groupId];

  /* ===== รับรูปภาพ ===== */
  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: null
    });
    return;
  }

  /* ===== รับข้อความ ===== */
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

    /* ===== คำสั่งบันทึก ===== */
    if (text === 'บันทึกรูปภาพ') {
      await new Promise(r => setTimeout(r, 1500));
      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) continue;

        const dateObj = new Date(item.timestamp);
        const dateStr = dateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
        const timeStr = dateObj.toLocaleTimeString('th-TH', { 
            timeZone: 'Asia/Bangkok', 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        }).replace(/:/g, '-');

        const fileName = `${item.location}_${dateStr}_${timeStr}`;
        const label = `${item.location} | ${dateStr} | ${timeStr.replace(/-/g, ':')}`;

        try {
          const res = await saveImageWithWatermark(item.id, item.location, dateStr, fileName, label);
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
      let replyText = `✅ บันทึกและเขียนชื่อสำเร็จ ${count} รูป\n\n`;
      for (let key in summary) replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      if (count === 0) replyText = "⚠️ ไม่พบรูปภาพที่ระบุสถานที่";

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= ฟังก์ชันเขียนชื่อลงรูปและอัปโหลด ================= */
async function saveImageWithWatermark(messageId, location, dateStr, fileName, label) {
  // 1. ดึงรูปจาก LINE
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  // 2. เขียนข้อความลงรูป
  const image = await Jimp.read(buffer);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE); // ใช้ฟอนต์สีขาวขนาด 32
  
  // วางข้อความมุมขวาล่าง
  const x = image.bitmap.width - Jimp.measureText(font, label) - 20;
  const y = image.bitmap.height - 50;
  image.print(font, x, y, label);

  const finalBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);

  // 3. อัปโหลดไป Cloudinary
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: `${location}/${dateStr}`, public_id: fileName, overwrite: true },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    ).end(finalBuffer);
  });
}

function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server is running with Watermark Feature');
});