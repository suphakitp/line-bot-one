require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');
const stream = require('stream');

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
      location: null
    });

    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    console.log("💬", text);

    const loc = extractLocation(text);

    /* ===== SET LOCATION ===== */
    if (loc) {
      state.currentLocation = loc;

      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
        }
      }

      return reply(event.replyToken, `📍 ตั้ง Location = ${loc}`);
    }

    /* ===== SAVE ===== */
    if (text === 'บันทึกรูปภาพ') {

      if (state.buffer.length === 0) {
        return reply(event.replyToken, '❗ ไม่มีรูปให้บันทึก');
      }

      console.log("💾 saving...");

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {

        if (!item.location) {
          console.log("❗ skip no location");
          continue;
        }

        const dateStr = new Date(item.timestamp)
          .toISOString()
          .split('T')[0];

        try {
          const folderId = await getOrCreateFolder(
            item.location,
            dateStr
          );

          const res = await saveImage(
            item.id,
            folderId,
            item.location,
            dateStr
          );

          if (res) {
            count++;
            const key = `${item.location}/${dateStr}`;
            summary[key] = (summary[key] || 0) + 1;
          }

        } catch (err) {
          console.error("❌ save error:", err);
        }
      }

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

/* ================= GOOGLE AUTH (FIX NEWLINE) ================= */
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  // 🔥 FIX สำคัญที่สุด
  const fixedKey = credentials.private_key.replace(/\\n/g, '\n');

  return new google.auth.JWT(
    credentials.client_email,
    null,
    fixedKey,
    ['https://www.googleapis.com/auth/drive']
  );
}

/* ================= CREATE FOLDER ================= */
async function getOrCreateFolder(location, dateStr) {
  const auth = getAuth();
  await auth.authorize();

  const drive = google.drive({ version: 'v3', auth });

  const folderName = `${location}/${dateStr}`;

  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
    fields: 'files(id, name)'
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.GOOGLE_FOLDER_ID]
    }
  });

  return folder.data.id;
}

/* ================= SAVE IMAGE ================= */
async function saveImage(messageId, folderId, location, dateStr) {
  console.log("⬆️ upload:", messageId);

  const streamData = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of streamData) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  const auth = getAuth();
  await auth.authorize();

  const drive = google.drive({ version: 'v3', auth });

  const fileName = `${location}_${dateStr}_${messageId}.jpg`;

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType: 'image/jpeg',
      body: stream.Readable.from(buffer)
    }
  });

  console.log("✅ upload success:", fileName);

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
  console.log('🚀 BOT READY FINAL 100%');
});