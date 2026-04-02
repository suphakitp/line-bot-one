require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

// ===== CONFIG =====
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

// ===== MEMORY =====
const groupState = {};
const usedMessageIds = new Set();
const saveTimeouts = {};

// ===== WEBHOOK =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// ===== LOCATION PARSER =====
function extractLocation(text) {
  text = text.replace(/[^\w\s:]/g, '').trim();

  let match = text.match(/location\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  match = text.match(/แปลง\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  if (/^[a-z]$/i.test(text)) {
    return text.toUpperCase();
  }

  return null;
}

// ===== MAIN =====
async function handleEvent(event) {
  if (event.type !== 'message') return null;

  const groupId = event.source.groupId || event.source.roomId;
  if (!groupId) return null;

  if (!groupState[groupId]) {
    groupState[groupId] = {
      location: null,
      buffer: []
    };
  }

  const state = groupState[groupId];

  // ===== TEXT =====
  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    // 📍 จับ location (เงียบ)
    const loc = extractLocation(text);
    if (loc) {
      state.location = loc;
      return null;
    }

    // 💾 บันทึกรูป
    if (text === 'บันทึกรูปภาพ') {
      if (!state.location) {
        return reply(event.replyToken, '❌ ยังไม่มี location');
      }

      if (saveTimeouts[groupId]) {
        clearTimeout(saveTimeouts[groupId]);
      }

      saveTimeouts[groupId] = setTimeout(async () => {
        if (state.buffer.length === 0) {
          await reply(event.replyToken, '❌ ไม่มีรูปให้บันทึก');
          return;
        }

        const dateStr = new Date().toISOString().split('T')[0];
        let count = 0;

        for (let id of state.buffer) {
          if (usedMessageIds.has(id)) continue;

          await saveImage(id, state.location, dateStr);
          usedMessageIds.add(id);
          count++;
        }

        state.buffer = [];

        await reply(
          event.replyToken,
          `✅ บันทึกแล้ว ${count} รูป\n📁 ${state.location}/${dateStr}`
        );

      }, 2000); // ⏳ รอ 2 วิ

      return null;
    }
  }

  // ===== IMAGE =====
  if (event.message.type === 'image') {
    state.buffer.push(event.message.id);
    return null; // เงียบ
  }

  return null;
}

// ===== SAVE =====
async function saveImage(messageId, location, dateStr) {
  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: `${location}/${dateStr}`
      },
      (err, result) => {
        if (err) return reject(err);
        console.log('Uploaded:', result.secure_url);
        resolve(result);
      }
    ).end(buffer);
  });
}

// ===== REPLY =====
function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text
  });
}

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
  console.log('Server running...');
});