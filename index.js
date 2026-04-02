require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

// ===== CONFIG (ใช้ ENV เท่านั้น) =====
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ===== MEMORY =====
const groupState = {};
const usedMessageIds = new Set();

// ===== WEBHOOK (กัน 500) =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(200).end(); // ❗ LINE ต้องได้ 200 เท่านั้น
  }
});

// ===== MAIN =====
async function handleEvent(event) {
  try {
    if (event.type !== 'message') return null;

    const groupId = event.source.groupId || event.source.roomId;
    if (!groupId) return null;

    if (!groupState[groupId]) {
      groupState[groupId] = {
        location: null,
        buffer: [],
        waiting: false
      };
    }

    const state = groupState[groupId];

    // ===== TEXT =====
    if (event.message.type === 'text') {
      const text = event.message.text.trim();

      // 📍 ตั้ง location
      if (text.toLowerCase().startsWith('location:')) {
        const loc = text.split(':')[1]?.trim();

        if (!loc) {
          return reply(event.replyToken, '❌ ใช้ format: location: แปลง A');
        }

        state.location = loc;
        return reply(event.replyToken, `📍 ตั้ง location = ${loc}`);
      }

      // 📸 เริ่ม
      if (text === 'บันทึกรูปภาพ') {
        if (!state.location) {
          return reply(event.replyToken, '❌ กรุณาตั้ง location ก่อน');
        }

        state.buffer = [];
        state.waiting = true;

        return reply(event.replyToken, '📸 ส่งรูปมาได้เลย');
      }

      // 💾 บันทึก
      if (text === 'ยืนยันบันทึก') {
        if (state.buffer.length === 0) {
          return reply(event.replyToken, '❌ ไม่มีรูป');
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
        state.waiting = false;

        return reply(
          event.replyToken,
          `✅ บันทึกแล้ว ${count} รูป\n📁 ${state.location}/${dateStr}`
        );
      }
    }

    // ===== IMAGE =====
    if (event.message.type === 'image') {
      if (!state.waiting) {
        return reply(event.replyToken, '❌ พิมพ์ "บันทึกรูปภาพ" ก่อน');
      }

      state.buffer.push(event.message.id);

      return reply(event.replyToken, `📥 รับรูปแล้ว (${state.buffer.length})`);
    }

    return null;

  } catch (err) {
    console.error('handleEvent error:', err);
    return null;
  }
}

// ===== SAVE IMAGE =====
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