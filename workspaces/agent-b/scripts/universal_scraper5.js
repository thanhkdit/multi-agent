const path = require('path');
// Nạp file .env từ thư mục gốc của dự án (lùi lại số cấp thư mục tương ứng)
require('dotenv').config({ path: path.join(__dirname, '../.env') }); 

const { chromium } = require('playwright');
const fs = require('fs');
const axios = require('axios'); // Chuẩn bị cho Bước 2 gọi 9router

const CONFIG = {
  SESSION_DIR: path.join(__dirname, '../.openclaw'),
  ERROR_LOG: path.join(__dirname, '../.openclaw', 'scraper_errors.log')
};

fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true });

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

function parseCount(text = '') {
  // Tìm con số (có thể chứa dấu chấm thập phân) và hậu tố (K, M, Tr)
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*([KMNTR]*)/i);
  if (!match) return 0;
  
  let num = parseFloat(match[1]);
  let suffix = (match[2] || '').toUpperCase();
  
  if (suffix.includes('K') || suffix.includes('N')) num *= 1000;
  if (suffix.includes('M') || suffix.includes('TR')) num *= 1000000;
  
  return isNaN(num) ? 0 : Math.floor(num);
}

class VisionHelper {
  constructor() {
    this.apiKey = process.env.NINEROUTER_API_KEY;
    // URL này là endpoint chuẩn của OpenAI, bạn thay đổi nếu 9router cung cấp URL /v1/chat/completions riêng
    this.apiUrl = process.env.NINEROUTER_URL + '/chat/completions'; 
  }

  async analyzeImage(imageBuffer, prompt, isJsonFormat = true) {
    if (!this.apiKey) {
      // Đổi logError thành console.log để thấy ngay trên terminal
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
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } } // Đổi detail sang low cho nhẹ và nhanh
          ]
        }
      ]
    };

    // [CHÚ Ý] Nếu 9router báo lỗi ở đây, chúng ta sẽ thử tắt response_format
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
      console.log(`[Vision AI] Phản hồi thô từ AI: ${content}`);
      
      if (isJsonFormat) {
        // Loại bỏ các thẻ markdown ```json và ``` mà AI thường tự ý thêm vào
        content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(content);
      }
      return content;
      
    } catch (error) {
      // In thẳng chi tiết lỗi API ra màn hình
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
}

class FacebookScraper {
  constructor(context) {
    this.context = context;
  }

  async handleLogin(page) {
    const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');

    // Truy cập trang chủ FB để check trạng thái
    await page.goto('https://facebook.com', { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(3000); // Chờ UI ổn định

    const vision = new VisionHelper();

    // Giảm dung lượng ảnh gửi đi API bằng cách format jpeg và quality thấp
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }); 

    // const loginCheck = await vision.checkLoginScreen(screenshot);

    // if (loginCheck && loginCheck.is_login_screen) {
    if (true) {
      if (!process.env.FB_EMAIL || !process.env.FB_PASS) {
        throw new Error("Missing FB_EMAIL or FB_PASS in .env file");
      }

      console.log("[DOM] Đang tiến hành điền thông tin đăng nhập...");

      // [CẬP NHẬT] Sử dụng name thay vì id
      await page.fill('input[name="email"]', process.env.FB_EMAIL);
      await page.fill('input[name="pass"]', process.env.FB_PASS);
      
      // Giả lập ấn phím Enter để login, bỏ qua việc phải tìm nút Đăng nhập
      await page.press('input[name="pass"]', 'Enter');

      console.log("[DOM] Đã gửi yêu cầu đăng nhập, đang kiểm tra kết quả...");

      // Đợi 20 giây để FB phản hồi (vào Newsfeed hoặc văng ra Captcha)
      await page.waitForTimeout(20000); 

      // ---------------------------------------------------------
      // CHỐT TRẠNG THÁI & LƯU SESSION
      // ---------------------------------------------------------
      console.log("[DOM] Đang đợi load trạng thái cuối cùng...");
      // Bắt lỗi timeout âm thầm để script không bị crash nếu mạng chậm
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); 
      
      await this.context.storageState({ path: sessionPath });    }
      console.log("[DOM] Đã lưu session đăng nhập (Cookie/Token) thành công!");
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
            el.click();
          } catch (e) {
            // Bỏ qua nếu DOM node không cho phép click
          }
        }
      }
    });
    // Chờ 1.5s để UI Facebook bung mở toàn bộ text sau khi click
    await sleep(1500); 
  }

  async scrollFeed(page, limit = 20) {
    // Chỉ cuộn số lần tương ứng với limit, mỗi bài FB cao khoảng 1000-1500px
    const scrolls = Math.max(1, Math.ceil(limit / 2)); 

    for (let i = 0; i < scrolls; i++) {
      await page.mouse.wheel(0, 1500); // Giảm độ dài cuộn để không bị lướt qua post
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
    // [FIX QUAN TRỌNG]: Bài viết chính ở Newsfeed/Page luôn có thuộc tính aria-posinset.
    // Dùng selector này để loại bỏ hoàn toàn các Comment (vốn cũng dùng role="article").
    const articles = page.locator('div[role="article"][aria-posinset]');
    await page.waitForTimeout(2000); 
    const count = await articles.count();
    const finalCount = Math.min(count, limit);
    const posts = [];
    
    const vision = new VisionHelper();

    for (let i = 0; i < finalCount; i++) {
      try {
        const article = articles.nth(i);
        
        // 1. Ép trình duyệt cuộn tới bài viết
        await article.scrollIntoViewIfNeeded();

        // 2. Xử lý Khung tải giả (Skeleton Loading)
        const loadingState = article.locator('[data-visualcompletion="loading-state"]');
        if (await loadingState.count() > 0) {
            console.log(`[DOM] Bài ${i + 1} đang là khung tải ảo, đứng chờ dữ liệu thật...`);
            try {
                await loadingState.waitFor({ state: 'hidden', timeout: 6000 });
            } catch (e) {
                console.log(`[Cảnh báo] Bài ${i + 1} load quá chậm do mạng hoặc FB chặn, bỏ qua...`);
                continue; 
            }
        }

        await page.waitForTimeout(800); 

        // 3. TÌM VÀ CLICK "XEM THÊM"
        const seeMoreBtns = article.locator('div[role="button"], span').filter({ hasText: /^([Ss]ee more|[Xx]em thêm|\.\.\. Xem thêm)$/i });
        if (await seeMoreBtns.count() > 0) {
            try {
                await seeMoreBtns.first().click();
                await page.waitForTimeout(1500); 
            } catch (e) {
                console.log(`[DOM] Không thể click "Xem thêm" ở bài ${i + 1}`);
            }
        }

        // 4. LẤY NỘI DUNG TEXT (TRÁNH LẤY COMMENT)
        let rawText = '';
        
        // Facebook lưu nội dung bài chính trong thẻ có data-ad-preview="message"
        const messageLocator = article.locator('div[data-ad-preview="message"]');
        if (await messageLocator.count() > 0) {
            rawText = await messageLocator.first().innerText();
        } else {
            // Fallback: Lấy thẻ div[dir="auto"] đầu tiên thay vì lấy toàn bộ bài (sẽ dính comment)
            const dirAuto = article.locator('div[dir="auto"]').first();
            if (await dirAuto.count() > 0) {
                rawText = await dirAuto.innerText();
            } else {
                rawText = await article.innerText(); 
            }
        }

        if (!rawText || rawText.trim() === '') {
            const imgAltText = await article.locator('img').evaluateAll(imgs => {
                return imgs.map(img => img.getAttribute('alt')).filter(Boolean).join('\n');
            });
            rawText = imgAltText || '(Bài viết dạng ảnh/video không có chú thích)';
        }

        console.log(`\n[NỘI DUNG BÀI VIẾT ${i + 1}]`);
        console.log(rawText);
        console.log(`----------------------------------------`);

        const html = await article.evaluate(el => el.outerHTML);

        const links = await article.locator('a').evaluateAll(nodes => {
          return nodes.map(n => n.href).filter(Boolean);
        });
        let timestamp = '';
        let postUrl = '';

        for (const link of links) {
          if (link.includes('/posts/') || link.includes('/videos/') || link.includes('/permalink/')) {
            postUrl = link;
            break;
          }
        }

        // 5. BÓC TÁCH CHỈ SỐ TƯƠNG TÁC
        const reactionText = await article.locator('span, div[role="button"]').allInnerTexts();

        let likes = 0;
        let comments = 0;
        let shares = 0;

        for (const txt of reactionText) {
          const cleanTxt = txt.toLowerCase().trim();
          if (cleanTxt === '') continue;

          if (/(comments|bình luận)/.test(cleanTxt)) {
            comments = Math.max(comments, parseCount(cleanTxt));
          } else if (/(shares|chia sẻ)/.test(cleanTxt)) {
            shares = Math.max(shares, parseCount(cleanTxt));
          } else if (/^[\d,.]+\s*(k|m|n|tr)?$/i.test(cleanTxt)) {
            likes = Math.max(likes, parseCount(cleanTxt));
          }
        }

        // 6. VISION AI FALLBACK
        if (likes === 0 && comments === 0 && shares === 0) {
          console.log(`[Fallback] DOM không đọc được số liệu bài ${i + 1}, đang gọi 9router Vision AI...`);
          try {
            await article.scrollIntoViewIfNeeded();
            await sleep(500); 

            const imgBuffer = await article.screenshot({ type: 'jpeg', quality: 80 });
            const aiData = await vision.extractPostData(imgBuffer);

            if (aiData) {
              likes = aiData.likes || 0;
              comments = aiData.comments || 0;
              shares = aiData.shares || 0;
              console.log(`[Vision AI] Cứu dữ liệu thành công bài ${i + 1} -> Likes: ${likes}, Comments: ${comments}, Shares: ${shares}`);
            }
          } catch (visionErr) {
            logError(`[Vision AI] Lỗi khi xử lý ảnh bài ${i + 1}: ${visionErr.message}`);
          }
        }

        posts.push({
          platform: 'facebook',
          index: i,
          post_url: postUrl,
          timestamp,
          content_text: rawText.substring(0, 5000),
          metrics: {
            likes,
            comments,
            shares
          },
          raw_html: html
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
      // Nếu task yêu cầu login, chạy luồng xử lý trước khi vào URL đích
      if (requireLogin) {
        await this.handleLogin(page);
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);

      await this.scrollFeed(page, limit);
      await this.expandAllContent(page);

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
    headless: false, // Nếu code chạy lỗi lúc login, bạn có thể đổi thành false để xem trình duyệt làm gì
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-notifications'
    ]
  });

  const sessionPath = path.join(CONFIG.SESSION_DIR, 'fb_session.json');
  let contextOptions = {
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  };

  // Nạp session cũ nếu đã từng đăng nhập thành công
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
// Tham số thứ 4 từ agent-b truyền vào (nếu có)
const requireLogin = process.argv[4] === 'require_login'; 

if (!targetUrl) {
  console.log(JSON.stringify({ status: 'error', error: 'Missing URL' }));
  process.exit(1);
}

universalScrape(targetUrl, targetLimit, requireLogin);
