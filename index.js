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
      buffer: []
    };
  }

  const state = groupState[groupId];

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    console.log("📸 image received");

    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: null // ❗ รอ assign ทีหลัง
    });

    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    console.log("💬 text:", text);

    const loc = extractLocation(text);

    /* ===== SET LOCATION (Assign ให้ทุกภาพที่ยังไม่มี) ===== */
    if (loc) {
      console.log("📍 location detected:", loc);

      let assigned = 0;

      for (let item of state.buffer) {
        if (!item.location) {
          item.location = loc;
          assigned++;
        }
      }

      console.log(`✅ assigned ${assigned} images to ${loc}`);
      return reply(event.replyToken, `📍 ตั้งค่า ${loc} ให้ ${assigned} รูป`);
    }

    /* ===== SAVE ===== */
    if (text === 'บันทึกรูปภาพ') {
      console.log("💾 saving...");

      await new Promise(r => setTimeout(r, 1500));

      let count = 0;
      const summary = {};

      for (let item of state.buffer) {
        if (!item.location) {
          console.log("⚠️ skipped no location:", item.id);
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

        const customFileName = `Location_${item.location}_${dateStr}_Time-${timeStr}`;

        try {
          const res = await saveImage(
            item.id,
            item.location,
            dateStr,
            customFileName
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

      // ล้าง buffer หลังบันทึก
      state.buffer = [];

      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;

      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      if (count === 0) {
        replyText = "⚠️ ไม่มีรูปที่มี location";
      }

      return reply(event.replyToken, replyText);
    }
  }
}

/* ================= SAVE ================= */
async function saveImage(messageId, location, dateStr, customFileName) {
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
        public_id: customFileName,
        overwrite: true
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    ).end(buffer);
  });
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
  console.log('🚀 Bot running (fixed version)');
});