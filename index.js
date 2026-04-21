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

/* ================= LOCATION (แก้ไขให้ยืดหยุ่นขึ้น) ================= */
function extractLocation(text) {
  // ดึงคำแรกที่ตามหลังคำว่า location หรือ แปลง (เช่น "Location A : 11:05" จะได้ "A")
  let match = text.match(/(?:location|แปลง)\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  // ถ้าส่งมาแค่ตัวอักษรเดียวโดดๆ เช่น "A" หรือ "B1"
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

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    console.log("📸 image received");
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: null
    });
    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    console.log("💬 text:", text);

    const loc = extractLocation(text);

    /* ===== SET LOCATION ===== */
    if (loc) {
      console.log("📍 location detected:", loc);
      state.currentLocation = loc;

	// หา "รูปล่าสุดที่ยังไม่มี location"
	const lastImage = [...state.buffer].reverse().find(item => !item.location);

	if (lastImage) {
	  lastImage.location = loc;
	}
      return;
    }

    /* ===== SAVE (แก้ไขการตั้งชื่อไฟล์) ===== */
    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 saving...");

      await new Promise(r => setTimeout(r, 1500));

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) continue;

        // จัดการเรื่องวันที่และเวลา (เวลาไทย ICT)
        const dateObj = new Date(item.timestamp);
        const dateStr = dateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
	const timeStr = dateObj.toLocaleTimeString('th-TH', { 
  	  timeZone: 'Asia/Bangkok', 
	   hour12: false, 
	   hour: '2-digit', 
 	   minute: '2-digit', 
	   second: '2-digit' 
	}).replace(/:/g, '-');

        // ชื่อไฟล์: สถานที่_วันที่_เวลา (เช่น Location_A_2024-05-22_Time-11-05-00 )
        const customFileName = `Location_${item.location}_${dateStr}_Time-${timeStr}`;

        try {
          const res = await saveImage(item.id, item.location, dateStr, customFileName);

          if (res) {
            count++;
            const key = `${item.location}/${dateStr}`;
            summary[key] = (summary[key] || 0) + 1;
          }
        } catch (err) {
          console.error("❌ save error:", err);
        }
      }

      // Reset buffer หลังบันทึกเสร็จ
      state.buffer = [];

      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;
      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }
      
      if (count === 0) replyText = "⚠️ ไม่พบรูปภาพที่ระบุสถานที่ โปรดส่งรูปแล้วพิมพ์ Location ก่อนกดบันทึก";

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= SAVE (รองรับชื่อไฟล์ใหม่) ================= */
async function saveImage(messageId, location, dateStr, customFileName) {
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
        public_id: customFileName,
        overwrite: true
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
  console.log('🚀 Bot is updated and running');
});