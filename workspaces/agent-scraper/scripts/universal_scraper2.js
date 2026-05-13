const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') }); 

const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');

const CONFIG = {
  SESSION_DIR: path.join(__dirname, '../.openclaw'),
  ERROR_LOG: path.join(__dirname, '../.openclaw', 'scraper_errors.log'),
  IMAGES_DIR: path.join(__dirname, '../images') // Thư mục lưu ảnh
};

// Tạo các thư mục nếu chưa tồn tại
fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
fs.mkdirSync(CONFIG.IMAGES_DIR, { recursive: true });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function logError(message) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(CONFIG.ERROR_LOG, `[${timestamp}] ${message}\n`);
}

function detectPlatform(url) {
  if (url.includes('facebook.com')) return 'facebook';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('youtube.com')) return 'youtube';
  throw new Error(`Unsupported platform: ${url}`);
}

class VisionHelper {
  constructor() {
    this.apiKey = process.env.NINEROUTER_API_KEY;
    this.apiUrl = process.env.NINEROUTER_URL + '/chat/completions'; 
  }

  async analyzeImage(imageBuffer, prompt, isJsonFormat = true) {
    if (!this.apiKey) {
      console.log('❌ [Vision AI] LỖI: Không tìm thấy biến NINEROUTER_API_KEY trong .env');
      return null;
    }

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    const payload = {
      model: 'image-combo', 
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
          ]
        }
      ]
    };

    if (isJsonFormat) {
      payload.response_format = { type: 'json_object' };
    }

    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 60000
      });

      let content = response.data.choices[0].message.content;
      
      if (isJsonFormat) {
        content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(content);
      }
      return content;
      
    } catch (error) {
      const errorMsg = error.response?.data || error.message;
      console.log('❌ [Vision AI] API BÁO LỖI CHI TIẾT:', JSON.stringify(errorMsg, null, 2));
      return null;
    }
  }

  async extractFullPostData(imageBuffer) {
    const prompt = `Bạn là một chuyên gia phân tích dữ liệu mạng xã hội. Hãy đọc bức ảnh chụp một bài viết Facebook này và trích xuất dữ liệu:
    1. "content_text": Đọc và lấy TOÀN BỘ nội dung chữ của bài viết chính. Bỏ qua các bình luận bên dưới. Nếu ảnh/video không có chữ, trả về chuỗi rỗng "".
    2. "likes", "comments", "shares": Tìm số lượng người Thích/Cảm xúc, Bình luận, và Chia sẻ. Chuyển đổi K (nghìn), M/Tr (triệu) thành số nguyên (VD: 1.2K = 1200). Nếu không thấy, trả về 0.
    
    Trả về CHỈ MỘT OBJECT JSON định dạng: 
    {"content_text": "nội dung bài...", "likes": 0, "comments": 0, "shares": 0}`;
    
    return await this.analyzeImage(imageBuffer, prompt, true);
  }
}

class FacebookScraper {
  constructor(context) {
    this.context = context;
  }

  async handleLogin(page) {
    const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');
    await page.goto('https://facebook.com', { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000); 

    if (true) { 
      if (!process.env.FB_EMAIL || !process.env.FB_PASS) {
        throw new Error("Missing FB_EMAIL or FB_PASS in .env file");
      }

      console.log("[DOM] Đang tiến hành điền thông tin đăng nhập...");
      await page.fill('input[name="email"]', process.env.FB_EMAIL);
      await page.fill('input[name="pass"]', process.env.FB_PASS);
      await page.press('input[name="pass"]', 'Enter');
      console.log("[DOM] Đã gửi yêu cầu đăng nhập, đang đợi Facebook xử lý...");

      await page.waitForTimeout(20000); 
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); 
      
      await this.context.storageState({ path: sessionPath });    
      console.log("[DOM] Đã lưu session đăng nhập thành công!");
    }
  }

  async scrollFeed(page, limit = 20) {
    const scrolls = Math.max(1, Math.ceil(limit / 2));
    for (let i = 0; i < scrolls; i++) {
      await page.mouse.wheel(0, 1500);
      await sleep(1500);
    }
  }

  async extractPageInfo(page) {
    return await page.evaluate(() => {
      const result = { name: '', followers: 0 };
      const h1 = document.querySelector('h1');
      if (h1) result.name = h1.innerText.trim();

      const match = document.body.innerText.match(/([\d,.]+)\s*(?:K|M|N|Tr)?\s*(?:followers|người theo dõi)/i);
      if (match) result.followers = match[1];

      return result;
    });
  }

  async extractPosts(page, limit = 20) {
    const articles = page.locator('//div[@role="article" and not(ancestor::div[@role="article"])]');
    await page.waitForTimeout(2000); 
    const count = await articles.count();
    const finalCount = Math.min(count, limit);
    const posts = [];
    
    const vision = new VisionHelper();

    for (let i = 0; i < finalCount; i++) {
      try {
        const article = articles.nth(i);
        await article.scrollIntoViewIfNeeded();

        const loadingState = article.locator('[data-visualcompletion="loading-state"]');
        if (await loadingState.count() > 0) {
            console.log(`[DOM] Bài ${i + 1} đang tải khung ảo, chờ...`);
            try { await loadingState.waitFor({ state: 'hidden', timeout: 6000 }); } 
            catch (e) { continue; }
        }

        await page.waitForTimeout(1000); 

        // [SỬA LỖI]: Dùng JavaScript tiêm trực tiếp để vượt mặt lớp chặn (overlay) của FB
        const isClicked = await article.evaluate((node) => {
            const labels = ['See more', 'Xem thêm', 'See More'];
            // Lấy cả div, span, b... miễn là nó chứa text "Xem thêm"
            const elements = node.querySelectorAll('div[role="button"], div, span');
            let clicked = false;
            
            for (const el of elements) {
                const text = el.innerText ? el.innerText.trim() : '';
                if (labels.some(label => text === label || text.endsWith(label) || text.includes('… Xem thêm') || text.includes('... Xem thêm'))) {
                    el.click();
                    clicked = true;
                }
            }
            return clicked;
        });

        if (isClicked) {
            console.log(`[DOM] Đã nhấn "Xem thêm" ở bài ${i + 1}, đang chờ văn bản mở rộng...`);
            await page.waitForTimeout(2000); // Đợi 2s để DOM đổ text mới vào
        }

        const html = await article.evaluate(el => el.outerHTML);
        const links = await article.locator('a').evaluateAll(nodes => nodes.map(n => n.href).filter(Boolean));
        let postUrl = '';
        for (const link of links) {
          if (link.includes('/posts/') || link.includes('/videos/') || link.includes('/permalink/')) {
            postUrl = link; break;
          }
        }

        console.log(`[Vision AI] Đang chụp ảnh bài ${i + 1}...`);
        const imgBuffer = await article.screenshot({ type: 'jpeg', quality: 85 });
        
        // [CẬP NHẬT]: Lưu file ảnh vào workspace/agent-orchestrator/images
        const imgFilename = `post_${i + 1}_${Date.now()}.jpg`;
        const imgPath = path.join(CONFIG.IMAGES_DIR, imgFilename);
        fs.writeFileSync(imgPath, imgBuffer);
        console.log(`[Local] Đã lưu ảnh chụp màn hình tại: images/${imgFilename}`);

        console.log(`[Vision AI] Đang gửi bài ${i + 1} cho model AI phân tích...`);
        const aiData = await vision.extractFullPostData(imgBuffer);

        let content_text = "";
        let likes = 0, comments = 0, shares = 0;

        if (aiData) {
          content_text = aiData.content_text || "";
          likes = aiData.likes || 0;
          comments = aiData.comments || 0;
          shares = aiData.shares || 0;

          console.log(`\n[NỘI DUNG BÀI VIẾT ${i + 1} (BÓC TÁCH BỞI AI)]`);
          console.log(content_text);
          console.log(`-> Likes: ${likes} | Comments: ${comments} | Shares: ${shares}`);
          console.log(`----------------------------------------\n`);
        } else {
          console.log(`❌ [Vision AI] Lỗi bóc tách bài ${i + 1}`);
        }

        posts.push({
          platform: 'facebook',
          index: i,
          post_url: postUrl,
          timestamp: '',
          content_text: content_text.substring(0, 5000),
          metrics: { likes, comments, shares },
          raw_html: html // Nếu thấy HTML quá nặng, bạn có thể cân nhắc gỡ bỏ dòng này
        });

      } catch (err) {
        logError(`Post parse failed at index ${i}: ${err.message}`);
      }
    }

    return posts;
  }

  async scrape(url, limit = 20, requireLogin = false) {
    const page = await this.context.newPage();

    try {
      if (requireLogin) await this.handleLogin(page);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      await this.scrollFeed(page, limit);

      const pageInfo = await this.extractPageInfo(page);
      const posts = await this.extractPosts(page, limit);

      await page.close();

      return {
        status: 'success',
        platform: 'facebook',
        url,
        scraped_at: new Date().toISOString(),
        page_info: pageInfo,
        posts
      };
    } catch (err) {
      await page.close();
      throw err;
    }
  }
}

async function universalScrape(url, limit = 20, requireLogin = false) {
  const platform = detectPlatform(url);

  const browser = await chromium.launch({
    headless: false, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications']
  });

  const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');
  let contextOptions = {
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  };

  if (fs.existsSync(sessionPath)) {
    contextOptions.storageState = sessionPath;
  }

  const context = await browser.newContext(contextOptions);

  try {
    let scraper;
    if (platform === 'facebook') {
      scraper = new FacebookScraper(context);
    } else {
      throw new Error(`${platform} scraper not implemented`);
    }

    const result = await scraper.scrape(url, limit, requireLogin);
    
    console.log("=== FINAL RESULT START ===");
    console.log(JSON.stringify(result));
    console.log("=== FINAL RESULT END ===");

  } catch (err) {
    logError(err.message);
    console.log(JSON.stringify({ status: 'error', error: err.message, url }));
  } finally {
    await browser.close();
  }
}

const targetUrl = process.argv[2];
const targetLimit = parseInt(process.argv[3]) || 20;
const requireLogin = process.argv[4] === 'require_login'; 

if (!targetUrl) {
  console.log(JSON.stringify({ status: 'error', error: 'Missing URL' }));
  process.exit(1);
}

universalScrape(targetUrl, targetLimit, requireLogin);