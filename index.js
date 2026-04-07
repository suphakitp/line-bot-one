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

/* ================= GOOGLE AUTH (FIXED) ================= */
// ฟังก์ชันจัดการ Private Key ให้รองรับรูปแบบ \n จาก Environment Variables
let rawKey = process.env.GOOGLE_PRIVATE_KEY;
if (rawKey) {
  rawKey = rawKey.replace(/"/g, ''); // ลบฟันหนูถ้ามี
  rawKey = rawKey.split('\\n').join('\n'); // แปลงตัวอักษร \n เป็นการขึ้นบรรทัดใหม่จริง
}

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  rawKey,
  ['https://www.googleapis.com/auth/drive']
);

const drive = google.drive({ version: 'v3', auth });

/* ================= MEMORY ================= */
const groupState = {};

/* ================= HEALTH ================= */
app.get('/', (req, res) => {
  res.send('🟢 Bot Google Drive Final Fixed is running');
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
  const cleanText = text.replace(/[^\w\sก-๙:]/g, '').trim();
  let match = cleanText.match(/location\s*([a-z0-9ก-๙]+)/i);
  if (match) return match[1].toUpperCase();
  match = cleanText.match(/แปลง\s*([a-z0-9ก-๙]+)/i);
  if (match) return match[1].toUpperCase();
  if (/^[a-z0-9ก-๙]$/i.test(cleanText)) return cleanText.toUpperCase();
  return null;
}

/* ================= MAIN LOGIC ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;
  if (!groupState[groupId]) {
    groupState[groupId] = { buffer: [], currentLocation: null };
  }
  const state = groupState[groupId];

  /* ===== 1. รับรูปภาพ (เข้าคิว) ===== */
  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.currentLocation // ถ้าเซตไว้ก่อนแล้วก็ดึงมาใช้เลย
    });
    console.log(`📸 Added image to queue (Total: ${state.buffer.length})`);
    return;
  }

  /* ===== 2. รับข้อความ ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    /* --- พิมพ์ชื่อสถานที่ (A, B, แปลง 1) --- */
    if (loc) {
      state.currentLocation = loc;
      let updatedCount = 0;
      state.buffer.forEach(item => {
        if (!item.location) {
          item.location = loc;
          updatedCount++;
        }
      });
      return reply(event.replyToken, `📍 ระบุสถานที่: ${loc}\n(อัปเดตให้รูปเดิม ${updatedCount} รูป)`);
    }

    /* --- พิมพ์ "บันทึกรูปภาพ" --- */
    if (text === 'บันทึกรูปภาพ') {
      const readyToSave = state.buffer.filter(item => item.location !== null);

      if (state.buffer.length === 0) return reply(event.replyToken, "❌ ไม่มีรูปในคิว");
      if (readyToSave.length === 0) return reply(event.replyToken, "⚠️ กรุณาพิมพ์ระบุสถานที่ก่อนบันทึก");

      // ส่งข้อความแจ้งผู้ใช้เบื้องต้น
      await reply(event.replyToken, `💾 กำลังบันทึก ${readyToSave.length} รูป... กรุณารอสักครู่`);

      let successCount = 0;
      let hasError = false;

      for (let item of readyToSave) {
        const dateStr = new Date(item.timestamp).toISOString().split('T')[0];
        try {
          await saveToDrive(item.id, item.location, dateStr);
          successCount++;
        } catch (err) {
          console.error("❌ Save Error:", err.message);
          hasError = true;
        }
      }

      // เคลียร์รูปภาพที่ถูกจัดการไปแล้ว
      state.buffer = state.buffer.filter(item => !readyToSave.includes(item));

      let resultMsg = `✅ บันทึกสำเร็จ ${successCount} รูป`;
      if (hasError) {
        resultMsg += `\n❌ มีบางรูปพลาด (โปรดเช็คการแชร์ Folder หรือสิทธิ์ Google Drive)`;
      }
      
      // ส่ง Push Message สรุป (หรือใช้ Reply ถ้า Token ยังไม่หมดอายุ)
      return client.pushMessage(groupId, { type: 'text', text: resultMsg });
    }
  }
}

/* ================= SAVE TO DRIVE ================= */
async function saveToDrive(messageId, location, dateStr) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) { chunks.push(chunk); }
  const buffer = Buffer.concat(chunks);

  const streamData = new Readable();
  streamData.push(buffer);
  streamData.push(null);

  const fileMetadata = {
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
  return client.replyMessage(token, { type: 'text', text });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server is ready on port ${PORT}`));