require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const Redis = require("ioredis");

const app = express();

/* ================= CONFIG ================= */
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

/* ================= DB ================= */
mongoose.connect(process.env.MONGO_URI);

const Image = mongoose.model("Image", {
  messageId: { type: String, unique: true },
  imageUrl: String,
  location: String,
  date: String,
  createdAt: { type: Date, default: Date.now }
});

/* ================= REDIS ================= */
const redis = new Redis(process.env.REDIS_URL);

/* ================= CLOUDINARY ================= */
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET
});

/* ================= UTIL ================= */
function getToday() {
  return new Date().toISOString().split("T")[0];
}

function keyImages(gid) {
  return `images:${gid}`;
}

function keyLocations(gid) {
  return `locations:${gid}`;
}

/* ================= WEBHOOK ================= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body.events;

  await Promise.all(events.map(handleEvent));

  res.sendStatus(200);
});

/* ================= CORE ================= */
async function handleEvent(event) {
  if (event.type !== "message") return;

  const gid = event.source.groupId || event.source.userId;

  /* ========= IMAGE ========= */
  if (event.message.type === "image") {
    const messageId = event.message.id;

    // กันซ้ำ
    const exists = await Image.findOne({ messageId });
    if (exists) return;

    const stream = await client.getMessageContent(messageId);

    const upload = cloudinary.uploader.upload_stream(
      { folder: "temp" },
      async (err, result) => {
        if (err) return console.error(err);

        const data = JSON.stringify({
          messageId,
          url: result.secure_url
        });

        // 🔥 push เข้า queue
        await redis.rpush(keyImages(gid), data);

        console.log("📸 image queued");

        await tryMatch(gid);
      }
    );

    stream.pipe(upload);
  }

  /* ========= TEXT ========= */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* ===== SUMMARY ===== */
    if (text === "สรุป") {
      const today = getToday();

      const result = await Image.aggregate([
        { $match: { date: today } },
        {
          $group: {
            _id: "$location",
            count: { $sum: 1 }
          }
        }
      ]);

      let msg = `📊 สรุป (${today})\n`;

      if (result.length === 0) {
        msg += "ไม่มีข้อมูล";
      } else {
        result.forEach(r => {
          msg += `Location ${r._id}: ${r.count} รูป\n`;
        });
      }

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: msg
      });
    }

    /* ===== LOCATION ===== */
    let location = null;

    if (text.includes("A")) location = "A";
    if (text.includes("B")) location = "B";

    if (!location) return;

    // 🔥 push location
    await redis.rpush(keyLocations(gid), location);

    console.log("📍 location queued");

    await tryMatch(gid);
  }
}

/* ================= MATCH ENGINE ================= */
async function tryMatch(gid) {
  while (true) {
    const imageData = await redis.lpop(keyImages(gid));
    const location = await redis.lpop(keyLocations(gid));

    if (!imageData || !location) {
      // ❗ ถ้าไม่ครบ ต้องคืนกลับ
      if (imageData) await redis.lpush(keyImages(gid), imageData);
      if (location) await redis.lpush(keyLocations(gid), location);
      break;
    }

    const image = JSON.parse(imageData);

    // กันซ้ำ DB
    const exists = await Image.findOne({ messageId: image.messageId });
    if (exists) continue;

    const folder = `${location}/${getToday()}`;

    // ย้ายรูปเข้า folder จริง
    const finalUrl = image.url.replace("/upload/", `/upload/${folder}/`);

    await Image.create({
      messageId: image.messageId,
      imageUrl: finalUrl,
      location,
      date: getToday()
    });

    console.log(`✅ saved ${location}`);
  }
}

/* ================= SERVER ================= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("🚀 Running"));