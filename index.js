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

/* ================= HEALTH CHECK (สำคัญมาก) ================= */
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

/* ================= WEBHOOK ================= */
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

/* ================= LOCATION ================= */
function extractLocation(text) {
  let match = text.match(/(?:location|แปลง)\s*([a-z0-9]+)/i);
  if (match) return match[1].toUpperCase();

  if (/^[a-z0-9]+$/i.test(text.trim())) return text.trim().toUpperCase();

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
      lastImageTime: 0
    };
  }

  const state = groupState[groupId];

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    console.log("📸 receive image");

    const item = {
      id: event.message.id,
      timestamp: event.timestamp,
      location: null,
      bufferData: null,
      isLoading: true
    };

    state.buffer.push(item);
    state.lastImageTime = Date.now();

    cacheImage(item); // async

    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    /* ===== SET LOCATION ===== */
    if (loc) {
      console.log("📍 set location:", loc);

      // รอให้รูปหยุดเข้าจริง
      let idle = 0;
      while (true) {
        const diff = Date.now() - state.lastImageTime;
        if (diff > 2000) break;

        await new Promise(r => setTimeout(r, 300));
        idle += 300;

        if (idle > 10000) break;
      }

      let assigned = 0;

      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
          assigned++;
        }
      }

      return reply(event.replyToken, `📍 ${loc} → ${assigned} รูป`);
    }

    /* ===== SAVE ===== */
    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 saving...");

      // 🔥 รอ cache ให้ครบจริง
      let waitTime = 0;

      while (true) {
        const loading = state.buffer.filter(item => item.isLoading);

        if (loading.length === 0) break;

        if (waitTime > 15000) {
          console.log("⚠️ cache timeout");
          break;
        }

        console.log(`⏳ ยังโหลดไม่เสร็จ ${loading.length} รูป`);

        await new Promise(r => setTimeout(r, 300));
        waitTime += 300;
      }

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location || !item.bufferData) {
          console.log("⚠️ skip:", item.id);
          continue;
        }

        const dateObj = new Date(item.timestamp);

        const dateStr = dateObj.toLocaleDateString('sv-SE', {
          timeZone: 'Asia/Bangkok'
        });

        const timeStr = dateObj.toLocaleTimeString('th-TH', {
          timeZone: 'Asia/Bangkok',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).replace(/:/g, '-');

        const fileName = `Location_${item.location}_${dateStr}_Time-${timeStr}`;

        await new Promise((resolve) => {
          cloudinary.uploader.upload_stream(
            {
              folder: `${item.location}/${dateStr}`,
              public_id: fileName,
              overwrite: true
            },
            (err) => {
              if (!err) {
                count++;
                const key = `${item.location}/${dateStr}`;
                summary[key] = (summary[key] || 0) + 1;
              }
              resolve();
            }
          ).end(item.bufferData);
        });
      }

      state.buffer = [];

      let replyText = `✅ บันทึก ${count} รูป\n\n`;

      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      if (count === 0) replyText = "⚠️ ไม่มีรูป";

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= CACHE IMAGE ================= */
async function cacheImage(item) {
  let retries = 3;

  while (retries > 0) {
    try {
      const stream = await client.getMessageContent(item.id);
      const chunks = [];

      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      item.bufferData = Buffer.concat(chunks);
      item.isLoading = false;

      console.log("✅ cached:", item.id);
      return;

    } catch (err) {
      retries--;
      console.log("🔁 retry cache...");
    }
  }

  item.isLoading = false;
  console.log("❌ cache fail:", item.id);
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
  console.log("🚀 Bot running (final stable version)");
});