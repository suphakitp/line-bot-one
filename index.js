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

/* ================= WEBHOOK ================= */
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
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

    const loc = extractLocation(text);

    if (loc) {
      state.currentLocation = loc;
      return;
    }

    /* ===== SAVE ===== */
    if (text === 'บันทึกรูปภาพ') {
      await new Promise(r => setTimeout(r, 1500));

      let count = 0;

      for (let item of state.buffer) {
        if (!item.location) continue;

        const dateStr = new Date(item.timestamp)
          .toISOString()
          .split('T')[0];

        await saveToDrive(item.id, item.location, dateStr);
        count++;
      }

      state.buffer = [];

      return reply(event.replyToken, `✅ บันทึก ${count} รูป`);
    }
  }
}

/* ================= SAVE TO DRIVE ================= */
async function saveToDrive(messageId, location, dateStr) {
  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  const fileMetadata = {
    name: `${messageId}.jpg`,
    parents: [process.env.GOOGLE_FOLDER_ID]
  };

  const media = {
    mimeType: 'image/jpeg',
    body: Buffer.from(buffer)
  };

  await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id'
  });

  console.log("✅ uploaded to drive:", messageId);
}

/* ================= REPLY ================= */
function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text
  });
}

/* ================= START ================= */
app.listen(process.env.PORT || 3000);