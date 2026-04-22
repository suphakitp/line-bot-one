/* ===== ปรับปรุงส่วนบันทึกรูปภาพใน handleEvent ===== */
if (text === 'บันทึก' || text === 'บันทึกรูปภาพ') {
    if (state.buffer.length === 0) return reply(event.replyToken, "⚠️ ไม่พบรูปภาพใหม่");

    const total = state.buffer.length;
    await reply(event.replyToken, `⏳ กำลังบันทึกทั้งหมด ${total} รูป... (อาจใช้เวลาสักครู่)`);

    let count = 0;
    const summary = {};
    const pushTarget = groupId;

    // 🔥 ใช้ for...of เพื่อให้มันทำงานทีละรูป (Sequential) ป้องกัน Server ล่ม
    for (let i = 0; i < state.buffer.length; i++) {
        const item = state.buffer[i];
        if (!item.location) continue;

        const dateStr = new Date(item.timestamp + (7 * 60 * 60 * 1000)).toISOString().split('T')[0];

        try {
            await saveImage(item.id, item.location, dateStr, item.timestamp);
            count++;
            const key = `${item.location}/${dateStr}`;
            summary[key] = (summary[key] || 0) + 1;

            // 📢 ทุกๆ 20 รูป ให้ส่งข้อความบอกความคืบหน้า (กัน Timeout)
            if (count % 20 === 0) {
                await client.pushMessage(pushTarget, { type: 'text', text: `🔄 บันทึกไปแล้ว ${count}/${total} รูป...` });
            }
        } catch (err) {
            console.error(`❌ Error at image ${i}:`, err.message);
        }
    }

    state.buffer = []; // เคลียร์คิว
    let summaryText = `✅ บันทึกสำเร็จ ${count}/${total} รูป\n\n`;
    for (let key in summary) summaryText += `📁 ${key} → ${summary[key]} รูป\n`;
    return client.pushMessage(pushTarget, { type: 'text', text: summaryText });
}