const path = require('path');
// Nạp file .env từ thư mục gốc của dự án (lùi lại số cấp thư mục tương ứng)
require('dotenv').config({ path: path.join(__dirname, '../.env') }); 

const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios'); // Chuẩn bị cho Bước 2 gọi 9router
const sharp = require('sharp');

const CONFIG = {
  SESSION_DIR: path.join(__dirname, '../.openclaw'),
  ERROR_LOG: path.join(__dirname, '../.openclaw', 'scraper_errors.log'),
  IMAGE_DIR: path.join(__dirname, '../images')
};

fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });
fs.mkdirSync(CONFIG.IMAGE_DIR, { recursive: true });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function safeFileName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .slice(0, 80);
}

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

async function cropImage(inputPath, outputPath, box) {
  await sharp(inputPath)
    .extract({
      left: Math.max(0, Math.floor(box.left)),
      top: Math.max(0, Math.floor(box.top)),
      width: Math.max(1, Math.floor(box.width)),
      height: Math.max(1, Math.floor(box.height))
    })
    .toFile(outputPath);
}

function parseCount(text = '') {
  const cleaned = text
    .replace(/,/g, '')
    .replace(/\./g, '')
    .toUpperCase();

  let multiplier = 1;

  if (cleaned.includes('K') || cleaned.includes('N')) {
    multiplier = 1000;
  }

  if (cleaned.includes('M') || cleaned.includes('TR')) {
    multiplier = 1000000;
  }

  const num = parseFloat(cleaned.replace(/[^0-9]/g, ''));

  return isNaN(num)
    ? 0
    : Math.floor(num * multiplier);
}

class VisionHelper {
  constructor() {
    this.apiKey = process.env.NINEROUTER_API_KEY;
    // URL này là endpoint chuẩn của OpenAI, bạn thay đổi nếu 9router cung cấp URL /v1/chat/completions riêng
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
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
          ]
        }
      ]
    };

    if (isJsonFormat) {
      payload.response_format = { type: 'json_object' };
    }

    console.log(`[Vision AI] Đang gửi ảnh cho model ${payload.model} phân tích...`);

    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 45000 
      });

      let content = response.data.choices[0].message.content;
      console.log(`[Vision AI] Phản hồi thô từ AI: \n${content}`);
      
      if (isJsonFormat) {
        // Gọt bỏ các thẻ markdown code block (```json và ```) để lấy JSON thuần
        const cleanContent = content.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleanContent);
      }
      
      return content;
      
    } catch (error) {
      const errorMsg = error.response?.data || error.message;
      console.log('❌ [Vision AI] API BÁO LỖI CHI TIẾT:', JSON.stringify(errorMsg, null, 2));
      return null;
    }
  }

  // 1. Hàm bọc cho luồng kiểm tra màn hình Login
  async checkLoginScreen(imageBuffer) {
    const prompt = `Ảnh này có phải là màn hình yêu cầu đăng nhập (Login), điền email/mật khẩu, hoặc bị Checkpoint của Facebook không? 
    Chỉ trả về JSON định dạng chính xác: {"is_login_screen": true} hoặc {"is_login_screen": false}.`;
    
    return await this.analyzeImage(imageBuffer, prompt, true);
  }

  // 2. Hàm bọc cho luồng Fallback bóc tách Data bài viết
  async extractPostData(imageBuffer) {
    const prompt = `Trích xuất các chỉ số tương tác từ ảnh thẻ bài viết Facebook này. 
    Tìm kỹ số lượng người Thích/Cảm xúc (Likes/Reactions), Bình luận (Comments), và Chia sẻ (Shares).
    Trả về JSON với format: {"likes": <số>, "comments": <số>, "shares": <số>}. 
    Lưu ý chuyển đổi K (nghìn), M/Tr (triệu) thành số nguyên. Nếu không tìm thấy, để giá trị là 0.`;
    
    return await this.analyzeImage(imageBuffer, prompt, true);
  }

  async analyzePostLayout(imageBuffer) {
    const prompt = `
  Bạn đang nhìn thấy screenshot của 1 Facebook post.

  Hãy xác định:

  1. vùng nội dung chính
  2. vùng metrics/reactions
  3. vùng comments preview

  Trả JSON:

  {
    "is_post": true,
    "content_box": {
      "top": 0,
      "left": 0,
      "width": 0,
      "height": 0
    },
    "metrics_box": {
      "top": 0,
      "left": 0,
      "width": 0,
      "height": 0
    }
  }

  Chỉ trả JSON.
  `;

    return await this.analyzeImage(
      imageBuffer,
      prompt,
      true
    );
  }

  async extractContentFromImage(imageBuffer) {
    const prompt = `
  Đây là vùng content của Facebook post.

  Trả JSON:

  {
    "content": ""
  }

  Chỉ trả JSON.
  `;

    return await this.analyzeImage(
      imageBuffer,
      prompt,
      true
    );
  }

  async extractMetricsFromImage(imageBuffer) {
    const prompt = `
  Đây là vùng metrics Facebook.

  Trả JSON:

  {
    "likes": 0,
    "comments": 0,
    "shares": 0
  }

  Chỉ trả JSON.
  `;

    return await this.analyzeImage(
      imageBuffer,
      prompt,
      true
    );
  }

  async extractPostCard(imageBuffer, meta = {}) {
    const prompt = `
  Bạn đang nhìn thấy 1 bài viết Facebook trong ảnh.

  Nhiệm vụ:
  - Xác định đây có phải là post thật không
  - Đọc nội dung bài viết hiển thị trên ảnh
  - Lấy số likes, comments, shares nếu thấy
  - Nếu có tên page/author thì lấy luôn
  - Nếu bài đang bị cắt ngắn, chỉ lấy phần hiển thị được

  Trả về JSON đúng format:
  {
    "is_post": true,
    "content": "string",
    "author": "string",
    "likes": 0,
    "comments": 0,
    "shares": 0,
    "confidence": 0.0
  }

  Chỉ trả JSON, không thêm giải thích.
  `;

    return await this.analyzeImage(imageBuffer, prompt, true);
  }
}

class FacebookScraper {
  constructor(context) {
    this.context = context;
  }

  async captureFullPost(page, article, outputPath) {
    const elementHandle =
      await article.elementHandle();

    if (!elementHandle) {
      throw new Error('Cannot get elementHandle');
    }

    await article.scrollIntoViewIfNeeded();

    await page.waitForTimeout(1500);

    const box =
      await elementHandle.boundingBox();

    if (!box) {
      throw new Error('Cannot get bounding box');
    }

    const totalHeight =
      Math.ceil(box.height);

    console.log(
      `[CAPTURE] full post height=${totalHeight}`
    );

    const segmentHeight = 1000;

    let currentOffset = 0;

    let index = 0;

    const segmentPaths = [];

    while (currentOffset < totalHeight) {

      // =====================================================
      // scroll article
      // =====================================================

      await page.evaluate(
        ({ el, offset }) => {

          const rect =
            el.getBoundingClientRect();

          window.scrollBy({
            top: rect.top + offset - 100,
            behavior: 'instant'
          });

        },
        {
          el: elementHandle,
          offset: currentOffset
        }
      );

      await page.waitForTimeout(1800);

      // =====================================================
      // screenshot current rendered article
      // =====================================================

      const segmentPath = outputPath.replace(
        '.jpg',
        `_segment_${index}.jpg`
      );

      await elementHandle.screenshot({
        path: segmentPath,
        type: 'jpeg',
        quality: 90
      });

      console.log(
        `[CAPTURE] saved segment ${index}`
      );

      segmentPaths.push(segmentPath);

      currentOffset += segmentHeight;

      index++;
    }

    // =====================================================
    // stitch images
    // =====================================================

    const images = [];

    for (const p of segmentPaths) {

      const meta =
        await sharp(p).metadata();

      images.push({
        path: p,
        width: meta.width,
        height: meta.height
      });
    }

    const finalWidth =
      images[0].width;

    const finalHeight =
      images.reduce(
        (sum, img) => sum + img.height,
        0
      );

    let top = 0;

    const composite = [];

    for (const img of images) {

      composite.push({
        input: img.path,
        top,
        left: 0
      });

      top += img.height;
    }

    await sharp({
      create: {
        width: finalWidth,
        height: finalHeight,
        channels: 3,
        background: {
          r: 255,
          g: 255,
          b: 255
        }
      }
    })
      .composite(composite)
      .jpeg()
      .toFile(outputPath);

    console.log(
      `[CAPTURE] stitched => ${outputPath}`
    );

    return outputPath;
  }

  async extractPostByVision(page, article, index, vision) {
    console.log(
      `[VISION] Bắt đầu chụp bài ${index}...`
    );

    // =====================================================
    // ELEMENT HANDLE
    // =====================================================

    const elementHandle =
      await article.elementHandle();

    if (!elementHandle) {

      throw new Error(
        `Không lấy được elementHandle bài ${index}`
      );
    }

    // =====================================================
    // SCROLL INTO VIEW
    // =====================================================

    await article.scrollIntoViewIfNeeded();

    // =====================================================
    // WAIT RENDER
    // =====================================================

    await new Promise(r => setTimeout(r, 1500));

    // =====================================================
    // SAVE SCREENSHOT
    // =====================================================

    const imagePath = path.join(
      CONFIG.IMAGE_DIR,
      `vision_post_${Date.now()}_${index}.jpg`
    );

    await this.captureFullPost(
      page,
      article,
      imagePath
    );

    console.log(
      `[VISION] Saved full screenshot: ${imagePath}`
    );

    // =====================================================
    // READ IMAGE
    // =====================================================

    const imageBuffer =
      fs.readFileSync(imagePath);

    // =====================================================
    // AI ANALYZE
    // =====================================================

    const prompt = `
  Bạn đang nhìn thấy screenshot của 1 Facebook post.

  Hãy phân tích và trả JSON:

  {
    "is_post": true,
    "author": "",
    "content": "",
    "likes": 0,
    "comments": 0,
    "shares": 0,
    "confidence": 0
  }

  QUAN TRỌNG:
  - chỉ lấy nội dung post chính
  - bỏ qua comment
  - bỏ qua suggested content
  - bỏ qua ads
  - confidence từ 0-100
  - chỉ trả JSON
  `;

    const aiData = await vision.analyzeImage(
      imageBuffer,
      prompt,
      true
    );

    console.log(
      `[VISION RESULT ${index}]`,
      JSON.stringify(aiData, null, 2)
    );

    return aiData;
  }

  async handleLogin(page) {
    const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');
    console.log("🚀 [MANUAL LOGIN] Đang mở Facebook để kiểm tra trạng thái đăng nhập...");
    await page.goto('https://facebook.com', { waitUntil: 'networkidle', timeout: 60000 });
    console.log(
      await page.locator('div[role="article"]').count()
    );

    // Kiểm tra xem có đang ở trang chủ (Newsfeed) không
    const isAlreadyLoggedIn = await page.locator('div[role="navigation"]').count() > 0;

    if (!isAlreadyLoggedIn) {
        console.log("👉 HÀNH ĐỘNG: Cần đăng nhập! Hãy gõ tài khoản và giải CAPTCHA thủ công trên trình duyệt.");
        console.log("⏳ Script đang ĐÓNG BĂNG chờ bạn vào được Newsfeed (Tối đa 5 phút)...");

        try {
            // Đứng đợi cho đến khi thanh Navigation (Menu của FB) xuất hiện
            await page.waitForSelector('div[role="navigation"]', { timeout: 300000 });
            console.log("✅ [MANUAL LOGIN] Đã nhận diện đăng nhập thành công!");
        } catch (e) {
            throw new Error("❌ [MANUAL LOGIN] Quá thời gian 5 phút không thấy đăng nhập. Hủy luồng!");
        }
    } else {
        console.log("✅ [MANUAL LOGIN] Tài khoản đã ở trạng thái đăng nhập sẵn.");
    }

    // Lưu lại session mới nhất để dùng cho các luồng ngầm sau này
    await this.context.storageState({ path: sessionPath });
    console.log("💾 [SYSTEM] Đã lưu Session. Kịch bản đang tự động di chuyển đến Page đích...");
  }

  async expandAllContent(page) {
    console.log('[DOM] Đang tìm và mở rộng các nút "Xem thêm"...');
    await page.evaluate(() => {
      // Các biến thể text của nút Xem thêm
      const labels = ['See more', 'Xem thêm', '... Xem thêm', 'See More'];
      
      // Quét toàn bộ các thẻ có khả năng là nút click
      const elements = document.querySelectorAll('div[role="button"], span');
      
      for (const el of elements) {
        if (el.innerText && labels.some(label => el.innerText.trim().includes(label))) {
          try {
            console.log("[DOM] Click See More");
            el.click();
          } catch(e) {
            console.log(e.message);
          }
        }
      }
    });
    // Chờ 1.5s để UI Facebook bung mở toàn bộ text sau khi click
    await sleep(1500); 
  }

  async scrollFeed(page, limit = 20) {
    console.log(`[DOM] Đang cuộn trang từ từ để tải ${limit} bài viết...`);
    // Tăng số lần cuộn để bù lại bước nhảy ngắn hơn
    const scrolls = Math.max(10, limit); 

    for (let i = 0; i < scrolls; i++) {
      // Cuộn mỗi lần 800px (khoảng 1 màn hình) thay vì 3000px
      await page.mouse.wheel(0, 800); 
      // Đợi 1.5s để Facebook kịp render DOM và nạp API
      await sleep(1500); 
    }
  }

  async extractPageInfo(page) {
    return await page.evaluate(() => {
      const result = {
        name: '',
        followers: 0
      };

      const h1 = document.querySelector('h1');

      if (h1) {
        result.name = h1.innerText.trim();
      }

      const bodyText = document.body.innerText;

      const followerRegex =
        /([\d,.]+)\s*(?:K|M|N|Tr)?\s*(?:followers|người theo dõi)/i;

      const match = bodyText.match(followerRegex);

      if (match) {
        result.followers = match[1];
      }

      return result;
    });
  }

  async extractPosts(page, limit = 20) {
    console.log(
      `[DOM] Bắt đầu bóc tách tuần tự ${limit} bài viết...`
    );

    const posts = [];
    const vision = new VisionHelper();

    const processedUrls = new Set();

    for (let i = 0; i < limit; i++) {
      try {

        // =====================================================
        // LOAD ARTICLES
        // =====================================================

        let articles = page.locator(`
          div[role="article"],
          div[aria-posinset]
        `);

        let currentCount = await articles.count();

        console.log(
          `[DEBUG] current article count: ${currentCount}`
        );

        // =====================================================
        // DEBUG NO ARTICLE
        // =====================================================

        if (currentCount === 0) {

          console.log(
            "[DEBUG] Không tìm thấy article. Screenshot debug..."
          );

          await page.screenshot({
            path: path.join(
              CONFIG.IMAGE_DIR,
              `debug_no_article_${Date.now()}.jpg`
            ),
            fullPage: true
          });
        }

        // =====================================================
        // SCROLL LOAD MORE
        // =====================================================

        let retry = 0;

        while (i >= currentCount && retry < 3) {

          console.log(
            `[DOM] Scroll load thêm bài viết...`
          );

          await page.mouse.wheel(0, 1200);

          await page.waitForTimeout(3000);

          articles = page.locator(`
            div[role="article"],
            div[aria-posinset]
          `);

          const newCount = await articles.count();

          if (newCount === currentCount) {

            console.log(
              `[DOM] Không load thêm được article`
            );

            break;
          }

          currentCount = newCount;

          retry++;
        }

        // =====================================================
        // END FEED
        // =====================================================

        if (i >= currentCount) {

          console.log(
            `[DOM] Feed kết thúc ở bài ${i}`
          );

          break;
        }

        // =====================================================
        // ARTICLE
        // =====================================================

        const article = articles.nth(i);

        await article.scrollIntoViewIfNeeded();

        await page.waitForTimeout(1500);

        // =====================================================
        // WAIT SKELETON
        // =====================================================

        const loadingState = article.locator(
          '[data-visualcompletion="loading-state"]'
        );

        if (await loadingState.count() > 0) {

          console.log(
            `[DOM] Bài ${i + 1} đang skeleton...`
          );

          await loadingState
            .waitFor({
              state: 'hidden',
              timeout: 5000
            })
            .catch(() => {});

          await page.waitForTimeout(1000);
        }

        // =====================================================
        // CLICK SEE MORE
        // =====================================================

        console.log(
          `[DOM] Expand content bài ${i + 1}`
        );

        await article.evaluate((node) => {

          const labels = [
            'See more',
            'Xem thêm',
            'See More',
            '... Xem thêm'
          ];

          const clickables = node.querySelectorAll(
            'div[role="button"], span, a'
          );

          for (const el of clickables) {

            const text = el.innerText?.trim();

            if (!text) continue;

            const matched = labels.some(
              label =>
                text === label ||
                text.endsWith(label)
            );

            if (matched) {

              try {
                el.click();
              } catch (e) {}
            }
          }
        });

        await page.waitForTimeout(1200);

        // =====================================================
        // HTML
        // =====================================================

        const html = await article.evaluate(
          el => el.outerHTML
        );

        // =====================================================
        // POST URL
        // =====================================================

        const links = await article
          .locator('a')
          .evaluateAll(nodes => {
            return nodes
              .map(n => n.href)
              .filter(Boolean);
          });

        let postUrl = '';

        for (const link of links) {

          if (
            link.includes('/posts/') ||
            link.includes('/videos/') ||
            link.includes('/permalink/')
          ) {
            postUrl = link;
            break;
          }
        }

        // =====================================================
        // DUPLICATE CHECK
        // =====================================================

        if (processedUrls.has(postUrl)) {

          console.log(
            `[SKIP] Duplicate post`
          );

          continue;
        }

        if (postUrl) {
          processedUrls.add(postUrl);
        }

        // =====================================================
        // SAVE RAW ARTICLE SCREENSHOT
        // =====================================================

        const rawShotPath = path.join(
          CONFIG.IMAGE_DIR,
          `raw_article_${Date.now()}_${i}.jpg`
        );

        await article.screenshot({
          path: rawShotPath,
          type: 'jpeg',
          quality: 85
        });

        console.log(
          `[VISION] Đang analyze bài ${i + 1}`
        );

        // =====================================================
        // AI EXTRACT
        // =====================================================

        const aiData = await this.extractPostByVision(
          page,
          article,
          i + 1,
          vision
        );

        // =====================================================
        // DEFAULT DATA
        // =====================================================

        let contentText = '';
        let likes = 0;
        let comments = 0;
        let shares = 0;
        let author = '';
        let confidence = 0;

        // =====================================================
        // AI SUCCESS
        // =====================================================

        if (aiData && aiData.is_post) {

          contentText = aiData.content || '';

          likes = aiData.likes || 0;

          comments = aiData.comments || 0;

          shares = aiData.shares || 0;

          author = aiData.author || '';

          confidence = aiData.confidence || 0;
        }

        // =====================================================
        // AI FAILED
        // =====================================================

        if (!aiData || !aiData.is_post) {

          logError(
            `Vision failed at post ${i + 1}`
          );

          posts.push({
            platform: 'facebook',
            index: i,
            post_url: postUrl,
            timestamp: '',
            author: '',
            content_text: '',
            metrics: {
              likes: 0,
              comments: 0,
              shares: 0
            },
            confidence: 0,
            source: 'vision_failed',
            raw_html: html
          });

          continue;
        }

        // =====================================================
        // PUSH POST
        // =====================================================

        posts.push({
          platform: 'facebook',
          index: i,
          post_url: postUrl,
          timestamp: '',
          author,
          content_text: contentText,
          metrics: {
            likes,
            comments,
            shares
          },
          confidence,
          source: 'vision',
          raw_html: html
        });

        console.log(
          `✅ [DONE] Post ${i + 1}`
        );

      } catch (err) {

        logError(
          `Lỗi bóc tách bài ${i + 1}: ${err.message}`
        );

        console.log(
          `[ERROR] Post ${i + 1}: ${err.message}`
        );
      }
    }

    return posts;
  }

  async scrape(url, limit = 20, needManualLogin = false) {
    const page = await this.context.newPage();

    try {
      if (needManualLogin) {
        await this.handleLogin(page);
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      const pageInfo = await this.extractPageInfo(page);

      console.log("[DOM] Warmup scroll để Facebook render feed...");

      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(3000);

      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(3000);

      await page.mouse.wheel(0, -800);
      await page.waitForTimeout(2000);

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
  const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');
  
  const hasSession = fs.existsSync(sessionPath);

  // LOGIC ĐÓNG MỞ GIAO DIỆN:
  // Nếu chưa có file session HOẶC Agent-Orchestrator ép buộc requireLogin -> Bật giao diện (false) để tương tác
  const needManualLogin = requireLogin || !hasSession;
  const isHeadless = !needManualLogin;

  const browser = await chromium.launch({
    headless: false, 
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-notifications'
    ]
  });

  let contextOptions = {
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  };

  if (hasSession) {
    console.log("🔑 [SYSTEM] Đã tìm thấy file session. Đang nạp Cookies...");
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

    // Truyền biến needManualLogin xuống để kích hoạt luồng handleLogin
    const result = await scraper.scrape(url, limit, needManualLogin);
    
    // In ra kết quả JSON cuối cùng để Agent-Orchestrator hứng lấy
    console.log(JSON.stringify(result));

  } catch (err) {
    logError(err.message);
    console.log(JSON.stringify({ status: 'error', error: err.message, url }));
  } finally {
    await browser.close();
  }
}

const targetUrl = process.argv[2];
const targetLimit = parseInt(process.argv[3]) || 20;
// Tham số thứ 4 từ agent-orchestrator truyền vào (nếu có)
const requireLogin = process.argv[4] === 'require_login'; 

if (!targetUrl) {
  console.log(JSON.stringify({ status: 'error', error: 'Missing URL' }));
  process.exit(1);
}

universalScrape(targetUrl, targetLimit, requireLogin);