const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');

const CONFIG = {
  SESSION_DIR: path.join(__dirname, '../.openclaw'),
  ERROR_LOG: path.join(__dirname, '../.openclaw', 'scraper_errors.log'),
  IMAGE_DIR: path.join(__dirname, '../images'),
  SCREENSHOT_DIR: path.join(__dirname, '../screenshots'),
  DEBUG_DIR: path.join(__dirname, '../debug')
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =========================
// CLEANUP OLD FILES
// =========================

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function clearFilesByExtensions(dirPath, extensions = []) {
  if (!fs.existsSync(dirPath)) return;

  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);

    try {
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) continue;

      const ext = path.extname(file).toLowerCase();

      if (extensions.includes(ext)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.log(`⚠️ Không thể xóa file: ${filePath} - ${err.message}`);
    }
  }
}

function logError(message) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(CONFIG.ERROR_LOG, `[${timestamp}] ${message}\n`);
}

function detectPlatform(url) {
  if (url.includes('facebook.com')) return 'facebook';
  throw new Error(`Unsupported platform: ${url}`);
}

function cleanFacebookData(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;

  if (Array.isArray(obj)) {
    return obj
      .map(cleanFacebookData)
      .filter(item => item !== undefined && item !== null && (typeof item !== 'object' || Object.keys(item).length > 0));
  }

  const cleaned = {};
  const garbageKeys = [
    'tracking', 'encrypted_tracking', 'encrypted_click_tracking',
    'click_tracking_linkshim_cb', 'extensions', 'server_metadata',
    'ghl_label', 'attributes', 'styles', 'trackingdata', 'viewability_config',
    'client_view_config', 'profile_picture', 'profile_picture_depth_0',
    'profile_picture_depth_1', 'profile_picture_depth_0_increased',
    'uri', 'uri_keyframes2', 'action_links', 'style_infos', 'associated_group',
    'debug_info', 'bumpers', 'color_ranges', 'image_ranges', 'inline_style_ranges'
  ];

  for (const key in obj) {
    if (garbageKeys.includes(key) || key.startsWith('__module_') || key.startsWith('__is')) continue;

    const value = obj[key];

    if (typeof value === 'string' && value.length > 200 && !value.includes(' ') && !value.startsWith('http')) {
      continue;
    }

    const cleanedValue = cleanFacebookData(value);

    if (cleanedValue !== null && cleanedValue !== undefined && cleanedValue !== '') {
      if (typeof cleanedValue === 'object' && Object.keys(cleanedValue).length === 0) continue;
      cleaned[key] = cleanedValue;
    }
  }

  return cleaned;
}

function parseMaybeJsonText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  let cleanText = rawText.trim();
  cleanText = cleanText.replace(/^for\s*\(\s*;\s*;\s*\)\s*;?/i, '').trim();

  const results = [];

  try {
    const parsed = JSON.parse(cleanText);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch (_) {
    // fallback
  }

  for (const line of cleanText.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) results.push(...parsed);
      else if (parsed && typeof parsed === 'object') results.push(parsed);
    } catch (_) {}
  }

  return results;
}

function toUnixSeconds(value) {
  if (value === null || value === undefined || value === '') return 0;

  if (typeof value === 'number') {
    if (value > 1e12) return Math.floor(value / 1000);
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;

    const n = Number(trimmed);
    if (!Number.isNaN(n) && Number.isFinite(n)) {
      if (n > 1e12) return Math.floor(n / 1000);
      return Math.floor(n);
    }

    const dt = new Date(trimmed);
    if (!Number.isNaN(dt.getTime())) return Math.floor(dt.getTime() / 1000);
  }

  return 0;
}

function formatUnixSeconds(unixSeconds) {
  if (!unixSeconds || Number.isNaN(Number(unixSeconds))) return '';
  const dateObj = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(dateObj.getTime())) return '';

  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const min = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function makePostKey(post) {
  if (!post || typeof post !== 'object') return '';
  if (post.url) return `url:${post.url}`;
  if (post.time && post.content) return `tc:${post.time}:${post.content.slice(0, 120)}`;
  if (post.content) return `c:${post.content.slice(0, 160)}`;
  return JSON.stringify(post).slice(0, 300);
}

class AIHelper {
  constructor() {
    this.apiKey = process.env.NINEROUTER_API_KEY;
    this.apiUrl = process.env.NINEROUTER_URL + '/chat/completions';
  }

  async analyzeImage(imageBuffer, prompt, isJsonFormat = true) {
    if (!this.apiKey) return null;

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

    if (isJsonFormat) payload.response_format = { type: 'json_object' };

    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 45000
      });
      let content = response.data.choices[0].message.content;
      if (isJsonFormat) return JSON.parse(content.replace(/```json/gi, '').replace(/```/g, '').trim());
      return content;
    } catch (error) {
      return null;
    }
  }

  async extractPostsFromData(jsonData) {
    if (!this.apiKey) {
      console.log('❌ [AI] Không tìm thấy API KEY');
      return [];
    }

    const sanitizedData = cleanFacebookData(jsonData);

    const MAX_CHUNK_SIZE = 150000;

    const sourceArray = Array.isArray(sanitizedData)
      ? sanitizedData
      : [sanitizedData];

    const chunks = [];

    let currentChunk = [];
    let currentLength = 0;

    for (const item of sourceArray) {
      const serialized = JSON.stringify(item);
      const len = serialized.length;

      if (
        currentChunk.length > 0 &&
        currentLength + len > MAX_CHUNK_SIZE
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentLength = 0;
      }

      currentChunk.push(item);
      currentLength += len;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    console.log(
      `[AI Chunking] total_objects=${sourceArray.length} chunks=${chunks.length}`
    );

    const allPosts = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const jsonString = JSON.stringify(chunk);

      const prompt = `
  Bạn là một chuyên gia bóc tách dữ liệu từ Facebook GraphQL API.

  Nhiệm vụ:
  - Trích xuất TẤT CẢ bài viết thật.
  - Clean text.
  - Bỏ metadata/tracking.
  - Không bỏ sót bài.

  Schema:
  {
    "posts": [
      {
        "header": "",
        "content": "",
        "url": "",
        "reaction": 0,
        "comments": 0,
        "shares": 0,
        "time": 0
      }
    ]
  }

  QUAN TRỌNG:
  - Chỉ trả JSON hợp lệ.
  - Không markdown.
  - Không giải thích.
  - Không copy text quá dư thừa.
  - Không lặp nội dung.
  - Chỉ giữ nội dung post cần thiết.
  `;

      const payload = {
        model: 'free-combo',
        messages: [
          {
            role: 'system',
            content: 'You are a precise JSON extraction engine.'
          },
          {
            role: 'user',
            content: `${prompt}\n\nDATA:\n${jsonString}`
          }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 12000,
        temperature: 0.1
      };

      let success = false;

      for (let retry = 0; retry < 3; retry++) {
        try {
          console.log(`[AI Data] Chunk ${i + 1}/${chunks.length} retry=${retry}`);

          const response = await axios.post(this.apiUrl, payload, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`
            },
            timeout: 300000
          });

          let content = response.data.choices?.[0]?.message?.content || '';

          fs.writeFileSync(
            path.join(CONFIG.DEBUG_DIR, `ai_raw_${Date.now()}_${i}.txt`),
            content
          );

          content = content
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

          const firstBrace = content.indexOf('{');
          const lastBrace = content.lastIndexOf('}');

          if (firstBrace !== -1 && lastBrace !== -1) {
            content = content.slice(firstBrace, lastBrace + 1);
          }

          const parsed = JSON.parse(content);

          if (Array.isArray(parsed.posts)) {
            allPosts.push(...parsed.posts);
          }

          success = true;
          break;
        } catch (err) {
          console.log(`❌ [AI Chunk Error] ${err.message}`);

          if (retry === 2) {
            fs.writeFileSync(
              path.join(CONFIG.DEBUG_DIR, `ai_error_${Date.now()}_${i}.txt`),
              err.stack || err.message
            );
          }

          await sleep(1500);
        }
      }

      if (!success) {
        console.log(`❌ [AI] Failed chunk ${i + 1}`);
      }
    }

    return allPosts;
  }
}

class FacebookScraper {
  constructor(context) {
    this.context = context;
    this.graphqlQueue = [];
    this.responseListenerInstalled = false;
  }

  installGraphqlListener(page) {
    if (this.responseListenerInstalled) return;
    this.responseListenerInstalled = true;

    page.on('response', async (response) => {
      try {
        const reqUrl = response.url();
        if (!reqUrl.includes('/api/graphql/')) return;

        const request = response.request();
        if (request.method() !== 'POST') return;

        const postData = request.postData() || '';
        const interesting =
          postData.includes('ProfileCometTimelineFeedRefetchQuery') ||
          postData.includes('CometTimelineFeedRefetchQuery') ||
          postData.includes('ProfileCometTimelineFeedQuery') ||
          postData.includes('UFI2CommentsProviderQuery') ||
          postData.includes('CometUFICommentsProviderRefetchQuery');

        if (!interesting) return;

        const rawText = await response.text();
        const parsedObjects = parseMaybeJsonText(rawText);
        if (parsedObjects.length === 0) return;

        this.graphqlQueue.push({
          url: reqUrl,
          rawText,
          objects: parsedObjects,
          ts: Date.now()
        });
      } catch (e) {
        console.log('❌ [NETWORK] Lỗi đọc GraphQL response:', e.message);
      }
    });
  }

  drainGraphqlQueue() {
    const batches = this.graphqlQueue;
    this.graphqlQueue = [];
    return batches;
  }

  async handleLogin(page) {
    const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');
    console.log('🚀 [MANUAL LOGIN] Đang mở Facebook để kiểm tra trạng thái đăng nhập...');
    await page.goto('https://facebook.com', { waitUntil: 'networkidle', timeout: 60000 });

    const isAlreadyLoggedIn = await page.locator('div[role="navigation"]').count() > 0;

    if (!isAlreadyLoggedIn) {
      console.log('👉 Cần đăng nhập thủ công trên trình duyệt.');
      console.log('⏳ Đang chờ vào được Newsfeed...');
      try {
        await page.waitForSelector('div[role="navigation"]', { timeout: 300000 });
        console.log('✅ [MANUAL LOGIN] Đã nhận diện đăng nhập thành công!');
      } catch (e) {
        throw new Error('❌ [MANUAL LOGIN] Quá thời gian chờ đăng nhập.');
      }
    } else {
      console.log('✅ [MANUAL LOGIN] Tài khoản đã ở trạng thái đăng nhập sẵn.');
    }

    await this.context.storageState({ path: sessionPath });
  }

  async extractPageInfo(page) {
    console.log('[VISION] Lấy thông tin Page...');
    const ai = new AIHelper();

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(1500);

    const screenshotPath = path.join(CONFIG.IMAGE_DIR, `page_info_${Date.now()}.jpg`);
    await page.screenshot({ path: screenshotPath });
    const imageBuffer = fs.readFileSync(screenshotPath);

    const prompt = 'Phân tích ảnh lấy thông tin page Facebook. Trả JSON: {"name":"","followers":"","likes":"","description":""}';
    const aiData = await ai.analyzeImage(imageBuffer, prompt, true);

    if (aiData && aiData.name) return aiData;
    return { name: '', followers: '0', likes: '0', description: '' };
  }

  async scrape(url, limitStr = '10', needManualLogin = false) {
    const page = await this.context.newPage();
    const ai = new AIHelper();

    const normalizedLimit = String(limitStr).trim();
    const isDateLimit = /^\d{4}-\d{2}-\d{2}$/.test(normalizedLimit);
    const limitCount = isDateLimit ? Infinity : Math.max(parseInt(normalizedLimit, 10) || 10, 1);
    const limitDate = isDateLimit ? new Date(normalizedLimit) : null;
    const limitDateUnix = isDateLimit && !Number.isNaN(limitDate.getTime()) ? Math.floor(limitDate.getTime() / 1000) : 0;

    const seenPosts = new Set();
    const allExtractedPosts = [];

    try {
      if (needManualLogin) {
        await this.handleLogin(page);
      }

      this.installGraphqlListener(page);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      const pageInfo = await this.extractPageInfo(page);

      console.log(`[DOM] Bắt đầu cuộn trang để kích hoạt API load bài... (Mục tiêu: ${limitStr})`);

      let scrollAttempts = 0;
      const maxScrolls = isDateLimit ? 200 : Math.max(limitCount * 3, 50);

      while (scrollAttempts < maxScrolls) {
        if (!isDateLimit && allExtractedPosts.length >= limitCount) break;
        if (isDateLimit && allExtractedPosts.length > 0) {
          const oldest = allExtractedPosts[allExtractedPosts.length - 1];
          const oldestUnix = toUnixSeconds(oldest.time);
          if (oldestUnix && oldestUnix < limitDateUnix) break;
        }

        await page.mouse.wheel(0, 2400);

        await Promise.race([
          page.waitForResponse(
            r => r.url().includes('/api/graphql/'),
            { timeout: 5000 }
          ).catch(() => null),
          sleep(5000)
        ]);

        await sleep(1200);

        const batches = this.drainGraphqlQueue();
        if (batches.length === 0) {
          scrollAttempts++;
          continue;
        }

        let postsFromAPI = [];

        for (const batch of batches) {
          const batchData = batch.objects || [];

          if (!batchData.length) continue;

          const rawStringCheck = JSON.stringify(batchData);

          if (
            !rawStringCheck.includes('creation_time') &&
            !rawStringCheck.includes('story') &&
            !rawStringCheck.includes('comet_sections')
          ) {
            console.log('⏩ [SKIP] Batch không có dấu hiệu post');
            continue;
          }

          const extracted = await ai.extractPostsFromData(batchData);

          if (Array.isArray(extracted) && extracted.length > 0) {
            postsFromAPI.push(...extracted);
          }
        }

        if (postsFromAPI.length > 0) {
          console.log(`✅ [AI] Bóc tách được ${postsFromAPI.length} bài viết từ GraphQL batch`);

          for (const p of postsFromAPI) {
            const post = {
              header: p?.header || '',
              content: p?.content || '',
              url: p?.url || '',
              reaction: Number(p?.reaction || 0),
              comments: Number(p?.comments || 0),
              shares: Number(p?.shares || 0),
              time: toUnixSeconds(p?.time),
              time_text: ''
            };

            post.time_text = formatUnixSeconds(post.time);

            const key = makePostKey(post);
            if (!key || seenPosts.has(key)) continue;
            seenPosts.add(key);

            allExtractedPosts.push({
              ...post,
              platform: 'facebook',
              source: 'api_graphql'
            });

            if (!isDateLimit && allExtractedPosts.length >= limitCount) break;
            if (isDateLimit && post.time && post.time < limitDateUnix) break;
          }
        }

        if (isDateLimit && allExtractedPosts.length > 0) {
          const lastPost = allExtractedPosts[allExtractedPosts.length - 1];
          if (lastPost.time && lastPost.time < limitDateUnix) break;
        }

        scrollAttempts++;
      }

      await page.close();

      if (!isDateLimit && allExtractedPosts.length > limitCount) {
        allExtractedPosts.length = limitCount;
      }

      const result = {
        status: 'success',
        platform: 'facebook',
        url,
        scraped_at: new Date().toISOString(),
        page_info: pageInfo,
        total_extracted: allExtractedPosts.length,
        posts: allExtractedPosts
      };

      fs.writeFileSync(
        path.join(CONFIG.SESSION_DIR, 'temp_posts.json'),
        JSON.stringify(allExtractedPosts, null, 2)
      );

      return result;
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
  }
}

async function universalScrape(url, limitStr = '10') {
  detectPlatform(url);

  const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');
  const hasSession = fs.existsSync(sessionPath);
  const needManualLogin = !hasSession;

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const contextOptions = {
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  };

  if (hasSession) {
    contextOptions.storageState = sessionPath;
  }

  const context = await browser.newContext(contextOptions);

  try {
    const scraper = new FacebookScraper(context);
    const result = await scraper.scrape(url, limitStr, needManualLogin);
    console.log(JSON.stringify(result));
  } catch (err) {
    logError(err.message);
    let partialPosts = [];
    const tempFile = path.join(CONFIG.SESSION_DIR, 'temp_posts.json');
    if (fs.existsSync(tempFile)) {
      try {
        partialPosts = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
      } catch (e) {}
    }
    console.log(JSON.stringify({ status: 'error', error: err.message, url, posts: partialPosts }));
  } finally {
    await browser.close();
  }
}

const targetUrl = process.argv[2];
const targetLimit = process.argv[3] || '10';

if (!targetUrl) {
  console.log(JSON.stringify({ status: 'error', error: 'Missing URL' }));
  process.exit(1);
}

// RUN SCRIPT

// Tạo folder nếu chưa có
ensureDir(CONFIG.SESSION_DIR);
ensureDir(CONFIG.IMAGE_DIR);
ensureDir(CONFIG.SCREENSHOT_DIR);
ensureDir(CONFIG.DEBUG_DIR);

// Xóa file debug json
clearFilesByExtensions(CONFIG.DEBUG_DIR, ['.json','.txt']);

// Xóa toàn bộ ảnh cũ
clearFilesByExtensions(CONFIG.IMAGE_DIR, [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp'
]);

// Xóa screenshot cũ
clearFilesByExtensions(CONFIG.SCREENSHOT_DIR, [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp'
]);

universalScrape(targetUrl, targetLimit);