const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios');
const sessionManager = require('./session_manager');

const CONFIG = {
  SESSION_DIR: path.join(__dirname, '../../.openclaw'),
  ERROR_LOG: path.join(__dirname, '../../.openclaw', 'scraper_errors.log'),
  IMAGE_DIR: path.join(__dirname, '../../images'),
  SCREENSHOT_DIR: path.join(__dirname, '../../screenshots'),
  DEBUG_DIR: path.join(__dirname, '../../debug')
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
      // console.log(`⚠️ Không thể xóa file: ${filePath} - ${err.message}`);
    }
  }
}

function cleanupImages() {
  const dirs = [
    path.join(__dirname, '../../debug'),
    path.join(__dirname, '../../images'),
    path.join(__dirname, '../../screenshots')
  ];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.match(/\\.(jpg|jpeg|png)$/i)) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch(e) {}
        }
      }
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

function sortPostsByTime(posts) {
  return [...posts].sort((a, b) => {
    const ta = Number(a?.time || 0);
    const tb = Number(b?.time || 0);
    return tb - ta;
  });
}

function cleanFolderName(name) {
  if (!name) return 'default';
  return name
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
      // console.log('❌ [AI] Không tìm thấy API KEY');
      return [];
    }

    const sanitizedData = cleanFacebookData(jsonData);
    const MAX_CHUNK_SIZE = 180000;

    const sourceArray = Array.isArray(sanitizedData)
      ? sanitizedData
      : [sanitizedData];

    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const item of sourceArray) {
      const serialized = JSON.stringify(item);
      const len = serialized.length;

      if (currentChunk.length > 0 && currentLength + len > MAX_CHUNK_SIZE) {
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

    // console.log(`[AI Chunking] total_objects=${sourceArray.length} chunks=${chunks.length}`);

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
        model: process.env.MODEL,
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
        max_tokens: process.env.MAX_TOKEN,
        temperature: 0.1
      };

      let success = false;

      for (let retry = 0; retry < 3; retry++) {
        try {
          // console.log(`[AI Data] Chunk ${i + 1}/${chunks.length} retry=${retry}`);

          const response = await axios.post(this.apiUrl, payload, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`
            },
            timeout: 300000
          });

          let content = response.data.choices?.[0]?.message?.content || '';

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
          // console.log(`❌ [AI Chunk Error] ${err.message}`);

          await sleep(1500);
        }
      }

      if (!success) {
        // console.log(`❌ [AI] Failed chunk ${i + 1}`);
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
    this.pendingAiTasks = [];
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
        // console.log('❌ [NETWORK] Lỗi đọc GraphQL response:', e.message);
      }
    });
  }

  drainGraphqlQueue() {
    const batches = this.graphqlQueue;
    this.graphqlQueue = [];
    return batches;
  }

  async handleLogin(page) {
    await page.goto('https://facebook.com', { waitUntil: 'networkidle', timeout: 60000 });

    const needLogin = await sessionManager.isLoginPage(page);

    if (needLogin) {
      const loginSuccess = await sessionManager.waitForManualLogin(page, 300000);
      if (!loginSuccess) {
        throw new Error('❌ [MANUAL LOGIN] Quá thời gian chờ đăng nhập.');
      }
    }

    await sessionManager.saveSession(this.context);
  }

  async extractPageInfo(page) {
    // console.log('[VISION] Lấy thông tin Page...');
    const ai = new AIHelper();

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(1500);

    const screenshotPath = path.join(CONFIG.IMAGE_DIR, `page_info_${Date.now()}.jpg`);
    await page.screenshot({ path: screenshotPath });
    const imageBuffer = fs.readFileSync(screenshotPath);
    try { fs.unlinkSync(screenshotPath); } catch (_) {}

    const prompt = 'Phân tích ảnh lấy thông tin page Facebook. Trả JSON: {"name":"","followers":"","likes":"","description":""}';
    const aiData = await ai.analyzeImage(imageBuffer, prompt, true);

    if (aiData && aiData.name) return aiData;
    return { name: '', followers: '0', likes: '0', description: '' };
  }

  normalizePost(p) {
    return {
      header: p?.header || '',
      content: p?.content || '',
      url: p?.url || '',
      reaction: Number(p?.reaction || 0),
      comments: Number(p?.comments || 0),
      shares: Number(p?.shares || 0),
      time: toUnixSeconds(p?.time),
      time_text: '',
      platform: 'facebook',
      source: 'api_graphql'
    };
  }

  mergeExtractedPosts(posts, seenPosts, allExtractedPosts) {
    for (const p of posts || []) {
      const post = this.normalizePost(p);
      post.time_text = formatUnixSeconds(post.time);

      const key = makePostKey(post);
      if (!key || seenPosts.has(key)) continue;
      seenPosts.add(key);

      allExtractedPosts.push(post);
    }
  }

  submitAiJob(batchData, ai, seenPosts, allExtractedPosts, batchLabel) {
    const task = ai.extractPostsFromData(batchData)
      .then((posts) => {
        if (Array.isArray(posts) && posts.length > 0) {
          // console.log(`✅ [AI] ${batchLabel} bóc tách được ${posts.length} bài viết`);
          this.mergeExtractedPosts(posts, seenPosts, allExtractedPosts);
        } else {
          // console.log(`⚠️ [AI] ${batchLabel} không có bài viết hợp lệ`);
        }
      })
      .catch((err) => {
        // console.log(`❌ [AI] ${batchLabel} lỗi: ${err.message}`);
      });

    this.pendingAiTasks.push(task);
    return task;
  }

  async scrape(url, limitStr = '6', needManualLogin = false) {
    const page = await this.context.newPage();
    const ai = new AIHelper();

    const normalizedLimit = String(limitStr).trim();
    const isDateLimit = /^\d{4}-\d{2}-\d{2}$/.test(normalizedLimit);
    const limitCount = isDateLimit ? Infinity : Math.max(parseInt(normalizedLimit, 10) || 6, 1);
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

      // Check if session is expired
      const currentUrl = page.url();
      const loginFormExists = await page.$('form[id="login_form"]') !== null;
      if (currentUrl.includes('/login') || loginFormExists) {
        throw new Error("Phiên đăng nhập (Session) đã hết hạn. Vui lòng báo admin đăng nhập lại Facebook.");
      }

      const pageInfo = await this.extractPageInfo(page);

      // console.log(`[DOM] Bắt đầu cuộn trang để kích hoạt API load bài... (Mục tiêu: ${limitStr})`);
      // console.log('[ASYNC] AI jobs sẽ được gửi ngay khi GraphQL xuất hiện, không chờ từng lần phân tích.');

      let scrollAttempts = 0;
      let submittedGraphqlCount = 0;
      const estimatedGraphqlTarget = isDateLimit ? 200 : Math.ceil(limitCount / 3) + 1;
      const maxScrolls = isDateLimit ? 200 : estimatedGraphqlTarget * 2 + 5;

      while (scrollAttempts < maxScrolls) {
        if (!isDateLimit && submittedGraphqlCount >= estimatedGraphqlTarget) {
          break;
        }

        await page.mouse.wheel(0, 2400);
        await sleep(700);

        const batches = this.drainGraphqlQueue();
        if (batches.length === 0) {
          scrollAttempts++;
          continue;
        }

        for (let i = 0; i < batches.length; i++) {
          if (!isDateLimit && submittedGraphqlCount >= estimatedGraphqlTarget) break;

          const batch = batches[i];
          const batchData = batch.objects || [];

          if (!batchData.length) continue;

          const rawStringCheck = JSON.stringify(batchData);
          if (
            !rawStringCheck.includes('creation_time') &&
            !rawStringCheck.includes('story') &&
            !rawStringCheck.includes('comet_sections')
          ) {
            // console.log('⏩ [SKIP] Batch không có dấu hiệu post');
            continue;
          }

          submittedGraphqlCount++;
          const batchLabel = `GraphQL batch #${submittedGraphqlCount}`;
          this.submitAiJob(batchData, ai, seenPosts, allExtractedPosts, batchLabel);
        }

        if (isDateLimit && allExtractedPosts.length > 0) {
          const newestKnownOldest = sortPostsByTime(allExtractedPosts)[allExtractedPosts.length - 1];
          const oldestUnix = toUnixSeconds(newestKnownOldest?.time);
          if (oldestUnix && oldestUnix < limitDateUnix) {
            break;
          }
        }

        scrollAttempts++;
      }

      // console.log(`[ASYNC] Đã submit ${submittedGraphqlCount} GraphQL batch, chờ toàn bộ AI jobs hoàn tất...`);
      await Promise.allSettled(this.pendingAiTasks);

      let finalPosts = sortPostsByTime(allExtractedPosts);

      if (isDateLimit) {
        finalPosts = finalPosts.filter(p => Number(p.time || 0) >= limitDateUnix);
      } else if (finalPosts.length > limitCount) {
        finalPosts = finalPosts.slice(0, limitCount);
      }

      await page.close();

      const result = {
        status: 'success',
        platform: 'facebook',
        url,
        scraped_at: new Date().toISOString(),
        page_info: pageInfo,
        total_extracted: finalPosts.length,
        posts: finalPosts
      };

      return result;
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
  }
}

async function universalScrape(url, limitStr = '6', competitorName) {
  detectPlatform(url);

  let status = sessionManager.checkSessionStatus();
  let sessionPath = sessionManager.getValidSessionPath();

  // Session hết hạn → báo lỗi ngay lập tức
  if (status.status !== 'valid') {
    console.log(JSON.stringify({
      status: 'error',
      error_type: 'SESSION_EXPIRED',
      error_details: `Phiên đăng nhập Facebook không hợp lệ hoặc đã hết hạn: ${status.detail}`
    }, null, 2));
    process.exit(0);
  }

  const browser = await chromium.launch({
    headless: process.env.ENV === 'local' ? false : true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  const contextOptions = {
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    storageState: sessionPath
  };

  const context = await browser.newContext(contextOptions);

  try {
    const scraper = new FacebookScraper(context);
    const result = await scraper.scrape(url, limitStr, false);
    console.log(JSON.stringify(result, null, 2));

    if (result) {
      const folderSource = competitorName || (result.posts && result.posts.length > 0 && result.posts[0].header) || (result.page_info && result.page_info.name) || 'default';
      const folderName = cleanFolderName(folderSource);
      if (folderName) {
        const resultDir = path.join(__dirname, '../../../shared/result', folderName);
        ensureDir(resultDir);
        const resultFilePath = path.join(resultDir, 'feeds.json');
        fs.writeFileSync(resultFilePath, JSON.stringify(result, null, 2));
      }
    }
  } catch (err) {
    logError(err.message);
  } finally {
    await browser.close();
  }
}

const targetUrl = process.argv[2];
const targetLimit = process.argv[3] || '6';
const competitorName = process.argv[4];

if (!targetUrl) {
  // console.log(JSON.stringify({ status: 'error', error: 'Missing URL' }));
  process.exit(1);
}

ensureDir(CONFIG.SESSION_DIR);
ensureDir(CONFIG.IMAGE_DIR);
ensureDir(CONFIG.SCREENSHOT_DIR);
ensureDir(CONFIG.DEBUG_DIR);

clearFilesByExtensions(CONFIG.DEBUG_DIR, ['.json', '.txt']);
clearFilesByExtensions(CONFIG.IMAGE_DIR, ['.jpg', '.jpeg', '.png', '.webp']);
clearFilesByExtensions(CONFIG.SCREENSHOT_DIR, ['.jpg', '.jpeg', '.png', '.webp']);

universalScrape(targetUrl, targetLimit, competitorName);
