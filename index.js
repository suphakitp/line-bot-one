require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');

const app = express();

/* ================= CONFIG ================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

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
  text = text.toLowerCase();

  let match = text.match(/location\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  match = text.match(/แปลง\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  // รับ A เดี่ยว ๆ
  match = text.match(/^[a-z]$/i);
  if (match) return match[0].toUpperCase();

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
      location: state.currentLocation || null
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

      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
        }
      }

      return;
    }

    /* ===== SAVE ===== */
    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 saving...");

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) continue;

        const dateStr = new Date(item.timestamp)
          .toISOString()
          .split('T')[0];

        try {
          const res = await saveImage(item.id, item.location, dateStr);

          if (res) {
            count++;
            const key = `${item.location}/${dateStr}`;
            summary[key] = (summary[key] || 0) + 1;
          }

        } catch (err) {
          console.error("❌ save error:", err);
        }
      }

      // reset
      state.buffer = [];
      state.currentLocation = null;

      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;

      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= SAVE TO GOOGLE DRIVE ================= */
async function saveImage(messageId, location, dateStr) {
  console.log("⬆️ upload to drive:", messageId, location);

  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/drive']
  );

  const drive = google.drive({ version: 'v3', auth });

  const fileName = `${location}_${dateStr}_${messageId}.jpg`;

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [process.env.GOOGLE_FOLDER_ID]
    },
    media: {
      mimeType: 'image/jpeg',
      body: require('stream').Readable.from(buffer)
    }
  });

  return res.data;
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