require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
// แก้ไขการนำเข้า Jimp ให้รองรับทั้ง v0 และ v1
const Jimp = require('jimp');

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
  res.send('🟢 Bot is running - All Issues Fixed');
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

/* ================= LOCATION EXTRACTOR (รองรับข้อความยาวๆ) ================= */
function extractLocation(text) {
  // ดึงเฉพาะตัวอักษร/ตัวเลขที่ตามหลังคำว่า location หรือ แปลง (รองรับ Location A : 11:05 AM)
  let match = text.match(/(?:location|แปลง)\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  // รองรับพิมพ์ชื่อสถานที่สั้นๆ เช่น "A"
  if (/^[a-z0-9]+$/i.test(text.trim())) return text.trim().toUpperCase();

  return null;
}

/* ================= MAIN EVENT HANDLER ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;

  if (!groupState[groupId]) {
    groupState[groupId] = { buffer: [], currentLocation: null };
  }

  const state = groupState[groupId];

  /* 📸 รับรูปภาพ */
  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.currentLocation // ถ้ามี Location ค้างในระบบอยู่แล้วให้ใส่เลย
    });
    return;
  }

  /* 💬 รับข้อความ */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    /* ระบุสถานที่ */
    if (loc) {
      state.currentLocation = loc;
      // อัปเดต Location ย้อนหลังให้รูปที่ส่งมาก่อนหน้านี้ในชุดเดียวกัน
      for (let item of state.buffer) {
        if (!item.location) item.location = loc;
      }
      return;
    }

    /* สั่งบันทึก */
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

      state.buffer = []; // เคลียร์รูปเก่าทิ้ง
      let replyText = `✅ บันทึกและเขียนชื่อสำเร็จ ${count} รูป\n\n`;
      for (let key in summary) replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      if (count === 0) replyText = "⚠️ ไม่พบรูปภาพที่ระบุสถานที่ โปรดส่งรูปใหม่แล้วระบุ Location ก่อนบันทึก";

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= ฟังก์ชันบันทึกภาพพร้อมลายน้ำ ================= */
async function saveImageWithWatermark(messageId, location, dateStr, fileName, label) {
  // 1. ดึงรูปจาก LINE
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  try {
    // 2. จัดการรูปภาพด้วย Jimp
    // รองรับการอ่านทั้งแบบ Jimp v0 (Jimp.read) และ v1 ({Jimp} = require)
    const jimpInstance = Jimp.read ? Jimp : (require('jimp').Jimp || Jimp);
    const image = await jimpInstance.read(buffer);
    
    // โหลดฟอนต์ (พยายามดึงฟอนต์มาตรฐานให้ได้มากที่สุด)
    const fontType = Jimp.FONT_SANS_32_WHITE || 'open-sans-32-white-all';
    const font = await jimpInstance.loadFont(fontType);
    
    // พิมพ์ข้อความที่มุมขวาล่าง
    const textWidth = jimpInstance.measureText ? jimpInstance.measureText(font, label) : (label.length * 15);
    const x = image.bitmap.width - textWidth - 20;
    const y = image.bitmap.height - 60;
    
    image.print(font, x > 0 ? x : 10, y, label);
    
    // แปลงเป็น Buffer
    const finalBuffer = await image.getBufferAsync ? await image.getBufferAsync(Jimp.MIME_JPEG) : await image.getBuffer("image/jpeg");

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
  } catch (err) {
    throw err;
  }
}

function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

app.listen(process.env.PORT || 10000, () => {
  console.log('🚀 บอททำงานแล้ว!');
});