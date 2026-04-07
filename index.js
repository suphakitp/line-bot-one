require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();

/* ================= CONFIGURATION ================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

/* ================= GOOGLE AUTH (แก้ไขเรื่อง KEY) ================= */
// ฟังก์ชันล้างค่า Private Key ให้ถูกต้องตามฟอร์แมตของ Google
let rawKey = process.env.GOOGLE_PRIVATE_KEY;
if (rawKey) {
  // ลบเครื่องหมายคำพูด และแปลง \n (ตัวอักษร) ให้เป็นการขึ้นบรรทัดใหม่จริงๆ
  rawKey = rawKey.replace(/"/g, '').split('\\n').join('\n');
}

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  rawKey,
  ['https://www.googleapis.com/auth/drive']
);

const drive = google.drive({ version: 'v3', auth });

/* ================= MEMORY STATE ================= */
const groupState = {};

/* ================= WEBHOOK ENDPOINT ================= */
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.sendStatus(500);
  }
});

/* ================= LOCATION PARSER ================= */
function extractLocation(text) {
  const cleanText = text.replace(/[^\w\sก-๙:]/g, '').trim();
  let match = cleanText.match(/(?:location|แปลง)\s*([a-z0-9ก-๙]+)/i);
  if (match) return match[1].toUpperCase();
  if (/^[a-z0-9ก-๙]$/i.test(cleanText)) return cleanText.toUpperCase();
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

  /* --- 1. รับรูปภาพ (เก็บลงคิว) --- */
  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.currentLocation // แปะป้ายถ้ามีค่าค้างไว้
    });
    console.log(`📸 เพิ่มรูปภาพลงคิว (รูปที่ ${state.buffer.length})`);
    return;
  }

  /* --- 2. รับข้อความ --- */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    // ถ้าพิมพ์ระบุสถานที่ (เช่น A, B, แปลง 1)
    if (loc) {
      state.currentLocation = loc;
      let updateCount = 0;
      state.buffer.forEach(item => {
        if (!item.location) {
          item.location = loc;
          updateCount++;
        }
      });
      return reply(event.replyToken, `📍 ระบุสถานที่: ${loc}\n(อัปเดตให้รูปเดิม ${updateCount} รูป)`);
    }

    // ถ้าพิมพ์ "บันทึกรูปภาพ"
    if (text === 'บันทึกรูปภาพ') {
      const readyToSave = state.buffer.filter(item => item.location !== null);

      if (state.buffer.length === 0) return reply(event.replyToken, "❌ ไม่มีรูปในคิว");
      if (readyToSave.length === 0) return reply(event.replyToken, "⚠️ กรุณาระบุสถานที่ก่อน");

      // แจ้งสถานะเบื้องต้น
      await reply(event.replyToken, `💾 กำลังบันทึก ${readyToSave.length} รูป...`);

      let successCount = 0;
      let errorOccurred = false;

      for (let item of readyToSave) {
        const dateStr = new Date(item.timestamp).toISOString().split('T')[0];
        try {
          await saveToDrive(item.id, item.location, dateStr);
          successCount++;
        } catch (err) {
          console.error("❌ Drive Error:", err.message);
          errorOccurred = true;
        }
      }

      // เคลียร์เฉพาะรูปที่พยายามบันทึกไปแล้ว
      state.buffer = state.buffer.filter(item => !readyToSave.includes(item));

      const resultMsg = `✅ บันทึกสำเร็จ ${successCount} รูป` + 
                        (errorOccurred ? `\n❌ บางรูปพลาด (เช็คการแชร์ Folder)` : "");
      
      // ใช้ Push Message เพื่อป้องกัน Reply Token หมดอายุ
      return client.pushMessage(groupId, { type: 'text', text: resultMsg });
    }
  }
}

/* ================= SAVE TO DRIVE FUNCTION ================= */
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

  const media = { mimeType: 'image/jpeg', body: streamData };

  return drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id'
  });
}

/* ================= HELPERS ================= */
function reply(token, text) {
  return client.replyMessage(token, { type: 'text', text });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot is running on port ${PORT}`));