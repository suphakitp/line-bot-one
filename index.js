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

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ webhook error:", err);
    res.sendStatus(500);
  }
});

/* ================= ฟังก์ชันดึงชื่อโลเคชั่น (Flexible) ================= */
function extractLocation(text) {
  text = text.trim();
  // ดึงคำหลัง Location หรือ แปลง จนถึงเครื่องหมาย : หรือจบประโยค
  let match = text.match(/(?:Location|แปลง)\s*(.*?)\s*(?::|$)/i);
  if (match && match[1]) {
    return match[1].trim(); 
  }
  // รองรับพิมพ์แค่ตัวอักษรเดียว (A-Z)
  if (/^[a-z]$/i.test(text)) {
    return text.toUpperCase();
  }
  return null;
}

/* ================= ฟังก์ชันบันทึกรูปภาพ (Sequential + Sorted A-Z) ================= */
async function processSaveImages(groupId, state, isAuto = false) {
  if (state.buffer.length === 0) return;

  const total = state.buffer.length;
  const pushTarget = groupId;
  const modeText = isAuto ? "⏰ ระบบบันทึกอัตโนมัติ (ครบ 5 วัน)" : "⏳ กำลังบันทึกรูปภาพ";
  
  await client.pushMessage(pushTarget, { 
    type: 'text', 
    text: `${modeText} ทั้งหมด ${total} รูป... กรุณารอสักครู่` 
  });

  let count = 0;
  const summary = {};

  for (let i = 0; i < state.buffer.length; i++) {
    const item = state.buffer[i];
    const targetLoc = item.location || state.lastLocation || "UNKNOWN";
    const dateStr = new Date(item.timestamp + (7 * 60 * 60 * 1000)).toISOString().split('T')[0];

    try {
      await saveImage(item.id, targetLoc, dateStr, item.timestamp);
      count++;
      const key = `${targetLoc}/${dateStr}`;
      summary[key] = (summary[key] || 0) + 1;

      if (count > 0 && count % 20 === 0) {
        await client.pushMessage(pushTarget, { type: 'text', text: `🔄 บันทึกไปแล้ว ${count}/${total} รูป...` });
      }
    } catch (err) {
      console.error(`❌ Save error:`, err.message);
    }
  }

  state.buffer = []; // เคลียร์คิว = เริ่มนับ 5 วันใหม่สำหรับรูปถัดไป

  let summaryText = `✅ ${isAuto ? 'บันทึกอัตโนมัติ' : 'บันทึก'} เสร็จสิ้น! ได้ทั้งหมด ${count}/${total} รูป\n`;
  summaryText += `📅 ระบบเริ่มนับเวลา 5 วันใหม่แล้ว\n\n`;

  if (count > 0) {
    // 🔥 จัดเรียงสรุปผล A-Z
    const sortedKeys = Object.keys(summary).sort(); 
    for (const key of sortedKeys) {
      summaryText += `📁 ${key} → ${summary[key]} รูป\n`;
    }
  }
  
  await client.pushMessage(pushTarget, { type: 'text', text: summaryText });
}

/* ================= MAIN LOGIC ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;
  if (!groupState[groupId]) {
    groupState[groupId] = { buffer: [], lastLocation: null };
  }
  const state = groupState[groupId];

  // 1. 🔥 ตรวจสอบเงื่อนไข 5 วัน (Auto-save)
  if (state.buffer.length > 0) {
    const fiveDaysInMs = 5 * 24 * 60 * 60 * 1000;
    if (Date.now() - state.buffer[0].timestamp >= fiveDaysInMs) {
      return await processSaveImages(groupId, state, true);
    }
  }

  // 2. รับรูปภาพ
  if (event.message.type === 'image') {
    state.buffer.push({ 
      id: event.message.id, 
      timestamp: event.timestamp, 
      location: state.lastLocation 
    });
    return;
  }

  // 3. รับข้อความ
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    if (loc) {
      state.lastLocation = loc;
      for (let item of state.buffer) { if (!item.location) item.location = loc; }
      return;
    }

    if (text === 'บันทึก' || text === 'บันทึกรูปภาพ') {
      if (state.buffer.length === 0) return reply(event.replyToken, "⚠️ ไม่มีรูปค้างในระบบ");
      await reply(event.replyToken, "👌 รับทราบครับ กำลังเริ่มบันทึก...");
      await processSaveImages(groupId, state, false);
      return;
    }
  }
}

/* ================= SAVE TO CLOUDINARY ================= */
async function saveImage(messageId, location, dateStr, timestamp) {
  const thaiTime = new Date(timestamp + (7 * 60 * 60 * 1000));
  const isoString = thaiTime.toISOString();
  const datePart = isoString.split('T')[0];
  const timePart = isoString.split('T')[1].substring(0, 5).replace(/:/g, '-');

  const finalFileName = `Location ${location} ${datePart}_Time ${timePart}_${messageId.slice(-4)}`;

  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  const buffer = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: `${location}/${dateStr}`, public_id: finalFileName, overwrite: true, resource_type: "image" },
      (err, result) => { if (err) return reject(err); resolve(result); }
    ).end(buffer);
  });
}

function reply(token, text) { return client.replyMessage(token, { type: 'text', text }); }

app.listen(process.env.PORT || 3000, () => console.log('🚀 Hybrid Bot Ready (Sorted + Flexible Location)'));