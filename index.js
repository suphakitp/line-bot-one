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
  res.send('🟢 Bot is running and ready for heavy upload');
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

/* ================= EXTRACTOR ================= */
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

  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],
      lastLocation: null 
    };
  }

  const state = groupState[groupId];

  /* ===== 1. รับรูปภาพ ===== */
  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.lastLocation // ใส่โลเคชั่นล่าสุดที่มีในความจำ
    });
    return;
  }

  /* ===== 2. รับข้อความ ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    // กรณีพิมพ์ Location เข้ามา
    if (loc) {
      state.lastLocation = loc;
      // อัปเดตรูปในคิวที่ยังไม่มีโลเคชั่นให้เป็นอันใหม่นี้
      for (let item of state.buffer) {
        if (!item.location) item.location = loc;
      }
      return;
    }

    // กรณีสั่งบันทึก
    if (text === 'บันทึก' || text === 'บันทึกรูปภาพ') {
      if (state.buffer.length === 0) {
        return reply(event.replyToken, "⚠️ ไม่พบรูปภาพใหม่ในระบบ");
      }

      const total = state.buffer.length;
      const pushTarget = groupId;
      
      // ตอบกลับก่อนเพื่อให้ LINE ไม่ Timeout
      await reply(event.replyToken, `⏳ กำลังบันทึกทั้งหมด ${total} รูป... ระบบจะทำทีละรูปเพื่อความเสถียรครับ`);

      let count = 0;
      const summary = {};

      // 🔥 วนลูปบันทึกทีละรูป (Sequential) เพื่อป้องกัน RAM เต็มบน Render
      for (let i = 0; i < state.buffer.length; i++) {
        const item = state.buffer[i];
        
        // ถ้ารูปไหนไม่มีโลเคชั่นจริงๆ ให้ข้าม
        if (!item.location) continue;

        const dateStr = new Date(item.timestamp + (7 * 60 * 60 * 1000)).toISOString().split('T')[0];

        try {
          const res = await saveImage(item.id, item.location, dateStr, item.timestamp);
          if (res) {
            count++;
            const key = `${item.location}/${dateStr}`;
            summary[key] = (summary[key] || 0) + 1;
          }

          // ส่ง Progress ทุกๆ 20 รูป
          if (count > 0 && count % 20 === 0) {
            await client.pushMessage(pushTarget, { type: 'text', text: `🔄 บันทึกสำเร็จแล้ว ${count}/${total} รูป...` });
          }
        } catch (err) {
          console.error(`❌ Error index ${i}:`, err.message);
        }
      }

      // 🧹 เคลียร์คิวรูปภาพทิ้ง (ป้องกันการบันทึกซ้ำรอบหน้า)
      state.buffer = [];

      // สรุปยอด
      let summaryText = `✅ บันทึกเสร็จสิ้น! ได้ทั้งหมด ${count}/${total} รูป\n\n`;
      if (count > 0) {
        for (let key in summary) {
          summaryText += `📁 ${key} → ${summary[key]} รูป\n`;
        }
      } else {
        summaryText = "❌ ไม่สามารถบันทึกได้ เนื่องจากรูปทั้งหมดไม่มีข้อมูล Location";
      }
      
      return client.pushMessage(pushTarget, { type: 'text', text: summaryText });
    }
  }
}

/* ================= SAVE FUNCTION ================= */
async function saveImage(messageId, location, dateStr, timestamp) {
  const thaiTime = new Date(timestamp + (7 * 60 * 60 * 1000));
  const isoString = thaiTime.toISOString();
  
  const datePart = isoString.split('T')[0];
  const timePart = isoString.split('T')[1].substring(0, 5).replace(/:/g, '-');

  // รูปแบบ: Location A 2026-04-22_Time 09-29_ID
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
  console.log('🚀 Server is running with Full Optimization');
});