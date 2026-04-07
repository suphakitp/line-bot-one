require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();

/* ================= CONFIG ================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

/* ================= GOOGLE AUTH ================= */
const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/drive']
);

const drive = google.drive({ version: 'v3', auth });

/* ================= MEMORY ================= */
const groupState = {};

/* ================= HEALTH ================= */
app.get('/', (req, res) => {
  res.send('🟢 Bot Google Drive is running');
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

/* ================= LOCATION PARSER ================= */
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

  // สร้างสถานะเริ่มต้นของกลุ่มถ้ายังไม่มี
  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],
      currentLocation: null
    };
  }

  const state = groupState[groupId];

  /* ===== 1. รับรูปภาพ ===== */
  if (event.message.type === 'image') {
    console.log("📸 Image received and added to buffer");

    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: null // ยังไม่มี Location ในตอนแรก
    });
    return;
  }

  /* ===== 2. รับข้อความ ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    /* --- พิมพ์ชื่อสถานที่ --- */
    if (loc) {
      console.log("📍 Location identified:", loc);
      state.currentLocation = loc;

      // 🔥 หัวใจสำคัญ: เอา Location ล่าสุดไปแปะให้ทุกรูปที่ค้างอยู่ใน Buffer
      let updatedCount = 0;
      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
          updatedCount++;
        }
      }

      return reply(event.replyToken, `📍 ระบุสถานที่: ${loc}\n(อัปเดตให้กับ ${updatedCount} รูปในคิว)`);
    }

    /* --- พิมพ์ "บันทึกรูปภาพ" --- */
    if (text === 'บันทึกรูปภาพ') {
      if (state.buffer.length === 0) {
        return reply(event.replyToken, "❌ ยังไม่มีรูปภาพในคิว");
      }

      // เช็คว่ามีรูปไหนที่ยังไม่มี location บ้าง
      const readyToSave = state.buffer.filter(item => item.location !== null);
      
      if (readyToSave.length === 0) {
        return reply(event.replyToken, "⚠️ รูปในคิวยังไม่ได้ระบุสถานที่\nกรุณาพิมพ์ชื่อ Location ก่อนบันทึก");
      }

      console.log("💾 Starting upload to Google Drive...");
      let count = 0;
      const summary = {};

      for (let item of readyToSave) {
        const dateStr = new Date(item.timestamp).toISOString().split('T')[0];

        try {
          await saveToDrive(item.id, item.location, dateStr);
          count++;
          
          const key = `${item.location}/${dateStr}`;
          summary[key] = (summary[key] || 0) + 1;
        } catch (err) {
          console.error("❌ Save error for image", item.id, ":", err);
        }
      }

      // ลบรูปที่บันทึกสำเร็จแล้วออกจาก Buffer
      state.buffer = state.buffer.filter(item => item.location === null);

      let replyText = `✅ บันทึกสำเร็จทั้งหมด ${count} รูป\n\n`;
      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= GOOGLE DRIVE UPLOAD ================= */
async function saveToDrive(messageId, location, dateStr) {
  const stream = await client.getMessageContent(messageId);
  
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  const streamData = new Readable();
  streamData.push(buffer);
  streamData.push(null);

  const fileMetadata = {
    // ตั้งชื่อไฟล์ให้รู้ว่ามาจาก Location ไหน
    name: `${location}_${dateStr}_${messageId}.jpg`,
    parents: [process.env.GOOGLE_FOLDER_ID]
  };

  const media = {
    mimeType: 'image/jpeg',
    body: streamData
  };

  return drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id'
  });
}

/* ================= REPLY HELPER ================= */
function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text
  });
}

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running with Google Drive Logic at port ${PORT}`);
});