const express = require("express");
const line = require("@line/bot-sdk");
const cloudinary = require("cloudinary").v2;

const app = express();

// 🔐 LINE config (ใส่ของคุณ)
const config = {
  channelAccessToken: "wdDtLLdV3GVXalnmW928fdc9H5NFjFPARA9+iWD1MeqCH1t1R2KNmJPMQiYPMYh/0yTbmvBkbkZGB2PrN2HKcDO2iI7koUNJc6nBcxTcMPv/Zdl7Q77h9405dtVjXvYIWiS82f5K0gaYyD+EsN4b/wdB04t89/1O/w1cDnyilFU=",
  channelSecret: "89431474f227989b785d5ddd526fad26"
};

const client = new line.Client(config);

// ☁️ Cloudinary config (ใส่ของคุณ)
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// 🧠 เก็บสถานะ
const userState = {};
const userBuffers = {};
const userTimers = {};

// 🎯 webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// 🎯 handle event
async function handleEvent(event) {
  const userId = event.source.userId;

  // 🟡 รับข้อความ = ชื่อสถานที่
  if (event.type === "message" && event.message.type === "text") {
    userState[userId] = event.message.text.trim();
    return;
  }

  // 🔵 รับรูป
  if (event.type === "message" && event.message.type === "image") {
    const site = userState[userId] || "unknown";

    if (!userBuffers[userId]) {
      userBuffers[userId] = [];
    }

    userBuffers[userId].push({
      messageId: event.message.id,
      site
    });

    // เคลียร์ timer เก่า
    if (userTimers[userId]) {
      clearTimeout(userTimers[userId]);
    }

    // ⏳ รอ 3 วิ (กันส่งหลายรูป)
    userTimers[userId] = setTimeout(async () => {
      const images = userBuffers[userId];

      for (const img of images) {
        await saveImage(img.messageId, img.site);
      }

      // 💬 ตอบครั้งเดียว
      await client.pushMessage(userId, {
        type: "text",
        text: `บันทึกรูปภาพแล้ว (${images[0].site}) จำนวน ${images.length} รูป`
      });

      // ล้าง buffer
      userBuffers[userId] = [];
      userTimers[userId] = null;

    }, 3000);
  }
}

// ☁️ อัปโหลดรูป
async function saveImage(messageId, site) {
  const now = new Date();

  const dateStr = now.toLocaleDateString("en-CA", {
    timeZone: "Asia/Bangkok"
  });

  const stream = await client.getMessageContent(messageId);

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);

  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: `${site}/${dateStr}`
      },
      (error, result) => {
        if (error) {
          console.error(error);
          reject(error);
        } else {
          console.log("Uploaded:", result.secure_url);
          resolve(result);
        }
      }
    ).end(buffer);
  });
}

// 🚀 start server
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running...");
});