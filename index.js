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
  res.send('🟢 Bot running (ultimate stable)');
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
      buffer: [],
      lastImageTime: 0
    };
  }

  const state = groupState[groupId];

  /* ===== IMAGE ===== */
  if (event.message.type === 'image') {
    state.buffer.push({
      id: event.message.id,
      timestamp: event.timestamp,
      location: null
    });

    state.lastImageTime = Date.now();
    return;
  }

  /* ===== TEXT ===== */
  if (event.message.type === 'text') {
    const text = event.message.text.trim();
    const loc = extractLocation(text);

    /* ===== SET LOCATION ===== */
    if (loc) {
      console.log("📍 location:", loc);

      // ⏳ รอจนรูปหยุดเข้า
      while (Date.now() - state.lastImageTime < 1500) {
        await new Promise(r => setTimeout(r, 300));
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
      console.log("📦 buffer:", state.buffer.length);

      let count = 0;
      const summary = {};

      const concurrency = 2; // 🔥 สำคัญมาก (อย่าเกิน 3)

      async function uploadOne(item) {
        if (!item.location) return null;

        let retries = 3;

        while (retries > 0) {
          try {
            // ⏳ หน่วงกัน timeout
            await new Promise(r => setTimeout(r, 300));

            const stream = await client.getMessageContent(item.id);
            const chunks = [];

            for await (const chunk of stream) {
              chunks.push(chunk);
            }

            const buffer = Buffer.concat(chunks);

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

            return await new Promise((resolve) => {
              cloudinary.uploader.upload_stream(
                {
                  folder: `${item.location}/${dateStr}`,
                  public_id: customFileName,
                  overwrite: true
                },
                (err, result) => {
                  if (err) {
                    console.error("❌ upload fail:", err);
                    return resolve(null);
                  }

                  resolve({
                    location: item.location,
                    date: dateStr
                  });
                }
              ).end(buffer);
            });

          } catch (err) {
            retries--;
            console.error(`🔁 retry ${3 - retries} for`, item.id);

            if (retries === 0) {
              console.error("❌ final fail:", item.id);
              return null;
            }
          }
        }
      }

      // 🔁 upload แบบ batch (กันพัง)
      for (let i = 0; i < state.buffer.length; i += concurrency) {
        const chunk = state.buffer.slice(i, i + concurrency);

        const results = await Promise.all(chunk.map(uploadOne));

        for (let res of results) {
          if (!res) continue;

          count++;
          const key = `${res.location}/${res.date}`;
          summary[key] = (summary[key] || 0) + 1;
        }
      }

      state.buffer = [];

      let replyText = `✅ บันทึกทั้งหมด ${count} รูป\n\n`;

      for (let key in summary) {
        replyText += `📁 ${key} → ${summary[key]} รูป\n`;
      }

      if (count === 0) {
        replyText = "⚠️ ไม่มีรูปที่บันทึกได้";
      }

      return reply(event.replyToken, replyText);
    }
  }
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
  console.log('🚀 Bot running (ultimate fixed)');
});