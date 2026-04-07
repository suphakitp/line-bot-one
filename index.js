require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(config);

/* ================= GOOGLE AUTH (THE FIX) ================= */
let rawKey = process.env.GOOGLE_PRIVATE_KEY;
if (rawKey) {
  rawKey = rawKey.replace(/"/g, '').split('\\n').join('\n');
}

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  rawKey,
  ['https://www.googleapis.com/auth/drive']
);
const drive = google.drive({ version: 'v3', auth });

/* ================= LOGIC ================= */
const groupState = {};

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  const groupId = event.source.groupId || event.source.userId;
  if (!groupState[groupId]) groupState[groupId] = { buffer: [], currentLocation: null };
  const state = groupState[groupId];

  if (event.message.type === 'image') {
    state.buffer.push({ id: event.message.id, timestamp: event.timestamp, location: state.currentLocation });
    return;
  }

  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    
    // Extract Location
    const cleanText = text.replace(/[^\w\sก-๙:]/g, '').trim();
    let loc = cleanText.match(/(?:location|แปลง)\s*([a-z0-9ก-๙]+)/i)?.[1] || 
              (/^[a-z0-9ก-๙]$/i.test(cleanText) ? cleanText : null);

    if (loc) {
      loc = loc.toUpperCase();
      state.currentLocation = loc;
      state.buffer.forEach(item => { if (!item.location) item.location = loc; });
      return client.replyMessage(event.replyToken, { type: 'text', text: `📍 สถานที่: ${loc}\n(อัปเดต ${state.buffer.length} รูปในคิว)` });
    }

    if (text === 'บันทึกรูปภาพ') {
      const ready = state.buffer.filter(i => i.location);
      if (ready.length === 0) return client.replyMessage(event.replyToken, { type: 'text', text: "⚠️ ยังไม่มีรูปหรือลืมระบุสถานที่" });

      await client.replyMessage(event.replyToken, { type: 'text', text: `💾 กำลังบันทึก ${ready.length} รูป...` });

      let success = 0;
      for (const item of ready) {
        try {
          const dateStr = new Date(item.timestamp).toISOString().split('T')[0];
          await saveToDrive(item.id, item.location, dateStr);
          success++;
        } catch (e) { console.error(e.message); }
      }

      state.buffer = state.buffer.filter(i => !ready.includes(i));
      return client.pushMessage(groupId, { 
        type: 'text', 
        text: `✅ สำเร็จ ${success} รูป\n${success < ready.length ? '❌ มีบางรูปพลาด (เช็คสิทธิ์การแชร์ Folder)' : ''}` 
      });
    }
  }
}

async function saveToDrive(messageId, location, dateStr) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const streamData = new Readable();
  streamData.push(buffer);
  streamData.push(null);

  return drive.files.create({
    resource: { name: `${location}_${dateStr}_${messageId}.jpg`, parents: [process.env.GOOGLE_FOLDER_ID] },
    media: { mimeType: 'image/jpeg', body: streamData },
    fields: 'id'
  });
}

app.listen(process.env.PORT || 3000);