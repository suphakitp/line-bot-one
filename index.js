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
  match = text.match(/แปลง\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();
  if (/^[a-z]$/i.test(text)) return text.toUpperCase();
  return null;
}

/* ================= MAIN ================= */
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const groupId = event.source.groupId || event.source.roomId || event.source.userId;

  if (!groupState[groupId]) {
    groupState[groupId] = {
      buffer: [],
      currentLocation: null
    };
  }

  const state = groupState[groupId];

  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: null
    });
    return;
  }

  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    if (loc) {
      state.currentLocation = loc;
      for (let item of state.buffer) {
        if (!item.location) item.location = loc;
      }
      return;
    }

    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 saving...");
      await new Promise(r => setTimeout(r, 1500));

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) continue;

        const dateStr = new Date(item.timestamp + (7 * 60 * 60 * 1000))
          .toISOString()
          .split('T')[0];

        try {
          const res = await saveImage(item.id, item.location, dateStr, item.timestamp);
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
      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;
      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }
      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= SAVE (ตัดวินาทีออก) ================= */
async function saveImage(messageId, location, dateStr, timestamp) {
  const thaiTime = new Date(timestamp + (7 * 60 * 60 * 1000));
  const isoString = thaiTime.toISOString(); // "2026-04-22T09:29:42.000Z"

  const datePart = isoString.split('T')[0]; // "2026-04-22"
  
  // ตัดวินาทีออก: เอาเฉพาะ HH:mm
  const timePart = isoString.split('T')[1].substring(0, 5).replace(/:/g, '-'); // "09-29"

  // รูปแบบ: Location A 2026-04-22_Time 09-29_ID
  const finalFileName = `Location ${location} ${datePart}_Time ${timePart}_${messageId.slice(-4)}`;

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
        public_id: finalFileName, 
        overwrite: true,
        resource_type: "image"
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    ).end(buffer);
  });
}

function reply(token, text) {
  return client.replyMessage(token, {
    type: 'text',
    text
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server is running (No Seconds in Filename)');
});