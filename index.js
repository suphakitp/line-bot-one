require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const Jimp = require('jimp'); // ต้องติดตั้งด้วยคำสั่ง npm install jimp ก่อน

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
  res.send('🟢 Bot is running with Watermark & Smart Location');
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

/* ================= LOCATION (ปรับปรุงให้อ่าน Location A : 11:05 AM ได้) ================= */
function extractLocation(text) {
  // ดึงเฉพาะตัวอักษร/ตัวเลขที่ตามหลังคำว่า location หรือ แปลง
  let match = text.match(/(?:location|แปลง)\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  // ถ้าส่งมาแค่ชื่อสถานที่สั้นๆ เช่น A หรือ B1
  if (/^[a-z0-9]+$/i.test(text.trim())) return text.trim().toUpperCase();

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

  /* ===== 📸 ส่วนรับรูปภาพ ===== */
  if (event.message.type === 'image') {
    console.log("📸 ได้รับรูปภาพ");
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.currentLocation // ถ้ามี location ค้างไว้ให้ใส่เลย
    });
    return;
  }

  /* ===== 💬 ส่วนรับข้อความ ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    console.log("💬 ข้อความ:", text);

    const loc = extractLocation(text);

    /* ===== ระบุสถานที่ ===== */
    if (loc) {
      console.log("📍 ตรวจพบสถานที่:", loc);
      state.currentLocation = loc;

      // อัปเดตสถานที่ให้รูปภาพที่ยังไม่มีสถานที่ใน Buffer
      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
        }
      }
      return;
    }

    /* ===== 💾 สั่งบันทึกรูปภาพ ===== */
    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 กำลังประมวลผลและบันทึก...");

      // รอเผื่อ Event ของ LINE มาช้า
      await new Promise(r => setTimeout(r, 1500));

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) continue;

        // จัดการวันที่และเวลาไทย (ICT)
        const dateObj = new Date(item.timestamp);
        const dateStr = dateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }); // 2024-05-22
        const timeStr = dateObj.toLocaleTimeString('th-TH', { 
            timeZone: 'Asia/Bangkok', 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        }).replace(/:/g, '-'); // 11-05-00

        // ชื่อไฟล์ และ ข้อความบนรูป
        const customFileName = `${item.location}_${dateStr}_${timeStr}`;
        const watermarkText = `${item.location} | ${dateStr} | ${timeStr.replace(/-/g, ':')}`;

        try {
          // เรียกฟังก์ชันเขียนลายน้ำและอัปโหลด
          const res = await saveImageWithWatermark(item.id, item.location, dateStr, customFileName, watermarkText);

          if (res) {
            count++;
            const key = `${item.location}/${dateStr}`;
            summary[key] = (summary[key] || 0) + 1;
          }
        } catch (err) {
          console.error("❌ save error:", err);
        }
      }

      // ล้างข้อมูลใน Buffer หลังทำงานเสร็จ
      state.buffer = [];

      // สรุปผลส่งกลับหาผู้ใช้
      let replyText = `✅ บันทึกพร้อมเขียนชื่อสำเร็จ ${count} รูป\n\n`;
      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }
      
      if (count === 0) replyText = "⚠️ ไม่พบรูปภาพที่ระบุสถานที่ โปรดส่งรูปแล้วระบุ Location ก่อนกดบันทึก";

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= 🛠 ฟังก์ชันเขียนลายน้ำและอัปโหลด ================= */
async function saveImageWithWatermark(messageId, location, dateStr, customFileName, watermarkText) {
  // 1. ดึงรูปภาพจาก LINE
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const originalBuffer = Buffer.concat(chunks);

  try {
    // 2. ใช้ Jimp จัดการรูปภาพ
    const image = await Jimp.read(originalBuffer);
    
    // โหลดฟอนต์มาตรฐานของ Jimp (สีขาว)
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    
    // คำนวณตำแหน่งวางข้อความ (มุมขวาล่าง)
    const textWidth = Jimp.measureText(font, watermarkText);
    const x = image.bitmap.width - textWidth - 20;
    const y = image.bitmap.height - 50;

    // พิมพ์ข้อความลงบนภาพ
    image.print(font, x, y, watermarkText);

    // แปลงเป็น Buffer สำหรับอัปโหลด
    const finalBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);

    // 3. อัปโหลดไปยัง Cloudinary
    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          folder: `${location}/${dateStr}`,
          public_id: customFileName,
          overwrite: true
        },
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      ).end(finalBuffer);
    });

  } catch (err) {
    console.error("Jimp/Upload error:", err);
    throw err;
  }
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
  console.log('🚀 บอททำงานแล้ว พร้อมระบบเขียนชื่อลงรูป!');
});