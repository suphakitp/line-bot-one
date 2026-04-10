require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const Jimp = require('jimp'); 

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

const groupState = {};

app.get('/', (req, res) => {
  res.send('🟢 Bot is running with Watermark & Smart Location');
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

/* ================= แก้ไขจุดนี้: ดึง Location ได้แม้มีข้อความอื่นปน ================= */
function extractLocation(text) {
  // รองรับ "Location A : 11:05 AM" -> จะได้ "A"
  let match = text.match(/(?:location|แปลง)\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  // รองรับพิมพ์ "A" หรือ "A1" เฉยๆ
  if (/^[a-z0-9]+$/i.test(text.trim())) return text.trim().toUpperCase();

  return null;
}

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;

  if (!groupState[groupId]) {
    groupState[groupId] = { buffer: [], currentLocation: null };
  }

  const state = groupState[groupId];

  if (event.message.type === 'image') {
    console.log("📸 ได้รับรูปภาพ");
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.currentLocation // ใส่ Location ล่าสุดที่บอทจำได้ให้ทันที
    });
    return;
  }

  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    if (loc) {
      console.log("📍 ตรวจพบสถานที่:", loc);
      state.currentLocation = loc;
      // อัปเดตย้อนหลังให้รูปที่ส่งมาก่อนหน้าในชุดเดียวกัน
      for (let item of state.buffer) {
        if (!item.location) item.location = loc;
      }
      return;
    }

    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 กำลังประมวลผล...");
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

      state.buffer = []; // ล้าง Buffer
      let replyText = `✅ บันทึกพร้อมเขียนชื่อสำเร็จ ${count} รูป\n\n`;
      for (let key in summary) replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      if (count === 0) replyText = "⚠️ ไม่พบรูปภาพที่ระบุสถานที่ โปรดส่งรูปแล้วระบุ Location ก่อนกดบันทึก";

      return reply(event.replyToken, replyText);
    }
  }
}

async function saveImageWithWatermark(messageId, location, dateStr, fileName, label) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  try {
    const image = await Jimp.read(buffer);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    
    // วางมุมขวาล่าง
    const x = image.bitmap.width - Jimp.measureText(font, label) - 20;
    const y = image.bitmap.height - 60;
    image.print(font, x, y, label);

    const finalBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);

    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: `${location}/${dateStr}`, public_id: fileName, overwrite: true },
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      ).end(finalBuffer);
    });
  } catch (err) { throw err; }
}

function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 บอททำงานแล้ว!');
});