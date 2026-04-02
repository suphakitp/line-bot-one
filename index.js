require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cloudinary = require('cloudinary').v2;

const app = express();

// ===== CONFIG =====
const config = {
  channelAccessToken: "wdDtLLdV3GVXalnmW928fdc9H5NFjFPARA9+iWD1MeqCH1t1R2KNmJPMQiYPMYh/0yTbmvBkbkZGB2PrN2HKcDO2iI7koUNJc6nBcxTcMPv/Zdl7Q77h9405dtVjXvYIWiS82f5K0gaYyD+EsN4b/wdB04t89/1O/w1cDnyilFU=",
  channelSecret: "cJ5RstkSdLthTpvZYmtfIdbWhwE"
};

const client = new line.Client(config);

cloudinary.config({
  cloud_name: "dyq0intl6",
  api_key: "843765847354289",
  api_secret: "89431474f227989b785d5ddd526fad26"
});

// ===== MEMORY =====
const groupState = {}; 
// { groupId: { location, buffer[], waiting } }

const usedMessageIds = new Set();

// ===== WEBHOOK =====
app.post('/webhook', line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// ===== MAIN =====
async function handleEvent(event) {
  if (event.type !== 'message') return null;

  const groupId = event.source.groupId || event.source.roomId;
  if (!groupId) return null; // รับเฉพาะ group

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

    // 📸 เริ่มบันทึก
    if (text === 'บันทึกรูปภาพ') {
      if (!state.location) {
        return reply(event.replyToken, '❌ กรุณาตั้ง location ก่อน');
      }

      state.buffer = [];
      state.waiting = true;

      return reply(event.replyToken, '📸 ส่งรูปมาได้เลย');
    }

    // 💾 เซฟ
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