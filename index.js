require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;
const { Jimp, Font } = require('jimp'); // นำเข้าแบบระบุตัวแปรสำหรับ v1+

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

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook error:", err);
    res.sendStatus(500);
  }
});

function extractLocation(text) {
  let match = text.match(/(?:location|แปลง)\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();
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
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.currentLocation
    });
    return;
  }

  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    if (loc) {
      state.currentLocation = loc;
      state.buffer.forEach(item => { if (!item.location) item.location = loc; });
      return;
    }

    if (text === 'บันทึกรูปภาพ') {
      if (state.buffer.length === 0) return reply(event.replyToken, "⚠️ ยังไม่มีรูปภาพในระบบ");
      
      let count = 0;
      for (let item of state.buffer) {
        if (!item.location) continue;

        const dateObj = new Date(item.timestamp);
        const dateStr = dateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' });
        const timeStr = dateObj.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false }).replace(/:/g, '-');
        
        const fileName = `${item.location}_${dateStr}_${timeStr}`;
        const label = `${item.location} | ${dateStr} | ${timeStr.replace(/-/g, ':')}`;

        try {
          await saveImageWithWatermark(item.id, item.location, dateStr, fileName, label);
          count++;
        } catch (err) { 
          console.error("❌ Detailed Save error:", err); 
        }
      }

      state.buffer = [];
      return reply(event.replyToken, count > 0 ? `✅ บันทึกสำเร็จ ${count} รูป` : "⚠️ ไม่พบรูปที่ระบุสถานที่");
    }
  }
}

/* ================= ฟังก์ชันบันทึกภาพ (ปรับปรุงสำหรับ Jimp v1) ================= */
async function saveImageWithWatermark(messageId, location, dateStr, fileName, label) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  try {
    // 1. อ่านรูปภาพ
    const image = await Jimp.read(buffer);
    
    // 2. โหลดฟอนต์ (ใช้คำสั่ง loadFont โดยตรงจาก Jimp)
    // หมายเหตุ: Jimp v1 ใช้ค่าคงที่ฟอนต์จาก enum หรือ string ตรงๆ
    const font = await Jimp.loadFont(Font.sans32White); 
    
    // 3. คำนวณตำแหน่ง
    const x = image.bitmap.width - (label.length * 18) - 20;
    const y = image.bitmap.height - 60;
    
    // 4. พิมพ์ข้อความ
    image.print({
        font: font,
        x: x > 0 ? x : 10,
        y: y,
        text: label
    });

    // 5. แปลงเป็น Buffer (ใช้เมธอดใหม่ของ v1)
    const finalBuffer = await image.getBuffer("image/jpeg");

    // 6. อัปโหลดไป Cloudinary
    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: `${location}/${dateStr}`, public_id: fileName, overwrite: true },
        (err, result) => { err ? reject(err) : resolve(result); }
      ).end(finalBuffer);
    });
  } catch (err) { 
    throw err; 
  }
}

function reply(token, text) { return client.replyMessage(token, { type: 'text', text }); }

app.listen(process.env.PORT || 10000);