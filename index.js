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

/* ================= WEBHOOK ================= */
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
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

/* ================= MAIN ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;
  if (!groupId) return;

  if (!groupState[groupId]) {
    groupState[groupId] = {
      images: [],    // รูปรอ location
      locations: []  // location รอรูป
    };
  }

  const state = groupState[groupId];

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    const item = {
      id: event.message.id,
      timestamp: event.timestamp
    };

    state.images.push(item);
    console.log("📸 image received");

    tryMatch(groupId);
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();

    const loc = extractLocation(text);
    if (loc) {
      state.locations.push(loc);
      console.log("📍 location received:", loc);

      tryMatch(groupId);
    }
  }
}

/* ================= AUTO MATCH ================= */
async function tryMatch(groupId) {
  const state = groupState[groupId];

  let retry = 0;

  while (retry < 5) {
    const image = state.images[0];
    const location = state.locations[0];

    if (!image || !location) {
      retry++;
      await delay(1000);
      continue;
    }

    // มีครบ → เอาออกจาก queue
    state.images.shift();
    state.locations.shift();

    const date = new Date(image.timestamp);
    const dateStr = date.toISOString().split('T')[0];

    try {
      const res = await saveImage(image.id, location, dateStr);

      if (res) {
        console.log(`✅ saved ${location}`);
      } else {
        console.log("⚠️ duplicate skipped");
      }

    } catch (err) {
      console.error("❌ save error:", err);
    }

    retry = 0;
  }
}

/* ================= SAVE ================= */
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
        folder: `${location}/${dateStr}`,
        public_id: messageId,
        overwrite: false,
        transformation: [{ width: 800, quality: "auto" }] // 🔥 บีบรูป
      },
      (err, result) => {
        if (err) {
          if (err.message && err.message.includes('already exists')) {
            return resolve(null);
          }
          return reject(err);
        }

        resolve(result);
      }
    ).end(buffer);
  });
}

/* ================= UTIL ================= */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ================= START ================= */
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server running AUTO mode');
});