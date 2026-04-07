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

/* ================= LOCATION ================= */
function extractLocation(text) {
  text = text.replace(/[^\w\s:]/g, '').trim();

  let match = text.match(/location\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  if (/^[a-z]$/i.test(text)) return text.toUpperCase();

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
    console.log("📸 image");

    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: state.currentLocation
    });

    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    console.log("💬", text);

    const loc = extractLocation(text);

    /* ===== LOCATION ===== */
    if (loc) {
      console.log("📍 location:", loc);
      state.currentLocation = loc;
      return;
    }

    /* ===== SAVE ===== */
    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 saving...");

      // 🔥 กัน event มาช้า
      await new Promise(r => setTimeout(r, 1500));

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) continue;

        const dateStr = new Date(item.timestamp)
          .toISOString()
          .split('T')[0];

        try {
          await saveToDrive(item.id, item.location, dateStr);

          count++;
          const key = `${item.location}/${dateStr}`;
          summary[key] = (summary[key] || 0) + 1;

        } catch (err) {
          console.error("❌ save error:", err);
        }
      }

      state.buffer = [];

      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;

      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= SAVE TO DRIVE ================= */
async function saveToDrive(messageId, location, dateStr) {
  console.log("⬆️ upload:", messageId, location);

  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  // 🔥 แปลงเป็น stream (สำคัญมาก)
  const streamData = new Readable();
  streamData.push(buffer);
  streamData.push(null);

  const fileMetadata = {
    name: `${location}_${messageId}.jpg`,
    parents: [process.env.GOOGLE_FOLDER_ID]
  };

  const media = {
    mimeType: 'image/jpeg',
    body: streamData
  };

  await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id'
  });

  console.log("✅ uploaded:", messageId);
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
  console.log('🚀 Server running GOOGLE DRIVE FINAL');
});