const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function generateSession() {
  const SESSION_PATH = path.join(__dirname, '../.openclaw/fb_session.json');
  
  // Mở trình duyệt có giao diện
  const browser = await chromium.launch({
    headless: process.env.ENV === 'local' ? false : true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("🚀 Đang mở Facebook...");
  await page.goto('https://www.facebook.com');

  console.log("👉 HÀNH ĐỘNG: Hãy đăng nhập và giải CAPTCHA thủ công trên trình duyệt.");
  console.log("⏳ Script sẽ đợi cho đến khi bạn vào được Newsfeed...");

  // Đợi cho đến khi thấy biểu tượng Newsfeed hoặc thanh tìm kiếm (chứng tỏ đã login thành công)
  try {
    await page.waitForSelector('div[role="navigation"]', { timeout: 300000 }); // Đợi tối đa 5 phút
    
    console.log("✅ Đã phát hiện trạng thái Đăng nhập thành công!");
    
    // Lưu session
    await context.storageState({ path: SESSION_PATH });
    console.log(`💾 Session đã được lưu tại: ${SESSION_PATH}`);
    
  } catch (e) {
    console.log("❌ Quá thời gian chờ hoặc có lỗi xảy ra.");
  } finally {
    await browser.close();
    process.exit();
  }
}

generateSession();