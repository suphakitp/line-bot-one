const express = require("express");
const line = require("@line/bot-sdk");
const cloudinary = require("cloudinary").v2;

const app = express();

// 🔐 LINE
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

// ☁️ Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

// 🧠 เก็บข้อมูลระดับกลุ่ม
const groupData = {};

// webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

// 🎯 handle event
async function handleEvent(event) {
  if (event.type !== "message") return;

  const groupId = event.source.groupId;
  if (!groupId) return;

  if (!groupData[groupId]) {
    groupData[groupId] = {
      images: [],
      location: ""
    };
  }

  const data = groupData[groupId];

  // 📸 รูป
  if (event.message.type === "image") {
    data.images.push(event.message.id);
    return;
  }

  // 💬 ข้อความ
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    // 👉 สั่งบันทึก
    if (text === "บันทึกรูปภาพ") {
      if (data.images.length === 0) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "ไม่มีรูปให้บันทึก"
        });
      }

      const dateStr = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Bangkok"
      });

      let count = 0;

      for (const id of data.images) {
        await saveImage(id, data.location || "unknown", dateStr);
        count++;
      }

      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `บันทึกรูปภาพแล้ว (${data.location}) จำนวน ${count} รูป`
      });

      // reset
      groupData[groupId] = {
        images: [],
        location: ""
      };

      return;
    }

    // 📍 เก็บสถานที่
    data.location = text;
  }
}

// ☁️ upload
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
        console.log(result.secure_url);
        resolve(result);
      }
    ).end(buffer);
  });
}

// run
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running...");
});