#!/usr/bin/env node

const { createBrowser } = require("./browser");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

require('dotenv').config({ path: path.join(__dirname, '../.env') }); 

const CONFIG = {
  DEBUG_DIR: path.join(__dirname, "..", "debug"),
  SCREENSHOT_DIR: path.join(__dirname, "..", "screenshots"),

  DEFAULT_LIMIT: 5,

  LOAD_WAIT_MS: 8000,
  INPUT_POPUP_WAIT_MS: 3000,
  AFTER_PAGE_CLICK_WAIT_MS: 5000,
  SCROLL_WAIT_MS: 2500,

  MAX_SCROLL_ROUND: 10
};

fs.mkdirSync(CONFIG.DEBUG_DIR, { recursive: true });
fs.mkdirSync(CONFIG.SCREENSHOT_DIR, { recursive: true });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupImages() {
  const dirs = [
    path.join(__dirname, '../debug'),
    path.join(__dirname, '../images'),
    path.join(__dirname, '../screenshots')
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

function normalizeText(str = "") {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function safeFileName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9-_]/g, "_")
    .slice(0, 100);
}

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function outputError(reason, extra = {}) {
  output({
    type: "error",
    reason,
    ...extra
  });
}

function parseMaybeJson(raw) {
  if (!raw) return null;

  if (typeof raw === "object") {
    return raw;
  }

  const cleaned = String(raw)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch (_) {}
  }

  return null;
}

function extractPageIdFromUrl(url = "") {
  try {
    const u = new URL(url);
    return (
      u.searchParams.get("view_all_page_id") ||
      u.searchParams.get("page_id") ||
      ""
    );
  } catch (_) {
    return "";
  }
}

class VisionHelper {
  constructor() {
    this.apiKey = process.env.NINEROUTER_API_KEY;
    this.apiUrl = `${process.env.NINEROUTER_URL || ""}/chat/completions`;
    this.model = process.env.NINEROUTER_MODEL || "image-combo";
  }

  async analyzeImage(imageBuffer, prompt) {
    if (!this.apiKey || !process.env.NINEROUTER_URL) {
      throw new Error("Missing NINEROUTER_API_KEY or NINEROUTER_URL");
    }

    const base64 = imageBuffer.toString("base64");

    const payload = {
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64}`,
                detail: "low"
              }
            }
          ]
        }
      ],
      response_format: { type: "json_object" }
    };

    const response = await axios.post(this.apiUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      timeout: 60000
    });

    const content = response?.data?.choices?.[0]?.message?.content || "";
    const parsed = parseMaybeJson(content);

    if (!parsed) {
      throw new Error(`Cannot parse AI response: ${content.slice(0, 700)}`);
    }

    return parsed;
  }

  async extractAllInfoFromScreenshot(imageBuffer) {
    const prompt = `
Bạn đang nhìn thấy screenshot của một trang web (Facebook Ads Library hoặc Facebook Page).
Nhiệm vụ: Trích xuất toàn bộ thông tin hiển thị trong ảnh. Bao gồm tên trang, thông tin người dùng, nội dung bài viết/quảng cáo, số lượng tương tác, thời gian, mô tả, trạng thái, và mọi text hiển thị khác.

Trả về một JSON object chứa toàn bộ dữ liệu bạn có thể đọc được.
Ví dụ cấu trúc trả về (có thể tự do tuỳ biến thêm tuỳ theo nội dung ảnh để giữ lại toàn bộ thông tin):
{
  "page_info": { "name": "...", "followers": "..." },
  "items": [
    {
      "content": "...",
      "status": "...",
      "metrics": { ... }
    }
  ],
  "other_text": "..."
}
Tuyệt đối chỉ trả về định dạng JSON hợp lệ, không kèm bất kỳ giải thích nào. Nếu có lỗi thì trả về json rỗng kèm lỗi.
`;

    const data = await this.analyzeImage(imageBuffer, prompt);
    return data;
  }
}

async function expandAdDetails(page) {
  await page.evaluate(() => {
    const labels = [
      "See ad details",
      "Xem chi tiết quảng cáo",
      "See summary details",
      "See more",
      "Xem thêm"
    ];

    const nodes = document.querySelectorAll('div[role="button"], span, a');

    for (const node of nodes) {
      const text = node.innerText?.trim();
      if (!text) continue;

      if (labels.some(label => text.includes(label))) {
        try {
          node.click();
        } catch (_) {}
      }
    }
  });
}

async function findSearchInputByValue(page, query) {
  const normalizedQuery = normalizeText(query);
  const inputs = page.locator("input");
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);

    try {
      const visible = await input.isVisible();
      if (!visible) continue;

      const value = await input.inputValue().catch(() => "");
      const normalizedValue = normalizeText(value);

      if (
        normalizedValue === normalizedQuery ||
        normalizedValue.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedValue)
      ) {
        return input;
      }
    } catch (_) {}
  }

  return null;
}

async function clickFirstPopupPageOption(page) {
  let option = page.locator('li[role="option"][aria-selected="false"][id^="pageID:"]').first();

  try {
    await option.waitFor({
      state: "visible",
      timeout: 10000
    });
  } catch (_) {
    option = page.locator('li[role="option"][id^="pageID:"]').first();
    await option.waitFor({
      state: "visible",
      timeout: 10000
    });
  }

  try {
    await option.click({
      timeout: 10000,
      force: true
    });
    return;
  } catch (_) {
    const box = await option.boundingBox();
    if (!box) {
      throw new Error("Cannot click first page option");
    }

    await page.mouse.click(
      box.x + box.width / 2,
      box.y + box.height / 2
    );
  }
}



async function handleAdsLibraryLookup(query, limit = CONFIG.DEFAULT_LIMIT) {
  const { page, close } = await createBrowser();
  const vision = new VisionHelper();
  const rawResults = [];
  const screenshots = [];

  try {
    const adsUrl =
      "https://www.facebook.com/ads/library/" +
      `?active_status=active` +
      `&ad_type=all` +
      `&country=VN` +
      `&is_targeted_country=false` +
      `&media_type=all` +
      `&q=${encodeURIComponent(query)}` +
      `&search_type=page` +
      `&sort_data[direction]=desc` +
      `&sort_data[mode]=total_impressions`;

    console.log(`[ADS LIBRARY URL] ${adsUrl}`);

    await page.goto(adsUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(CONFIG.LOAD_WAIT_MS);

    const searchInput = await findSearchInputByValue(page, query);

    if (!searchInput) {
      await page.screenshot({
        path: path.join(
          CONFIG.DEBUG_DIR,
          `ads_library_no_input_${safeFileName(query)}_${Date.now()}.png`
        ),
        fullPage: true
      });

      throw new Error("Cannot find search input with value=query");
    }

    await searchInput.click({
      timeout: 10000,
      force: true
    });

    await page.waitForTimeout(CONFIG.INPUT_POPUP_WAIT_MS);

    await clickFirstPopupPageOption(page);

    await page.waitForTimeout(CONFIG.AFTER_PAGE_CLICK_WAIT_MS);

    const selectedPageUrl = page.url();
    const selectedPageId = extractPageIdFromUrl(selectedPageUrl);

    let selectedPageName = "";
    try {
      selectedPageName = await page.locator("h1").first().innerText({ timeout: 5000 });
      selectedPageName = String(selectedPageName || "").trim();
    } catch (_) {}

    const selectedShot = path.join(
      CONFIG.DEBUG_DIR,
      `ads_library_selected_${safeFileName(query)}_${Date.now()}.png`
    );

    await page.screenshot({
      path: selectedShot,
      fullPage: false
    });

    for (let round = 0; round < limit; round++) {
      console.log(`[SCAN ROUND] ${round + 1}`);

      const shotPath = path.join(
        CONFIG.SCREENSHOT_DIR,
        `ads_${safeFileName(query)}_${round + 1}.png`
      );

      await page.screenshot({
        path: shotPath,
        fullPage: false
      });

      screenshots.push(shotPath);

      const imageBuffer = fs.readFileSync(shotPath);

      try {
        const extractedJson = await vision.extractAllInfoFromScreenshot(imageBuffer);
        if (extractedJson) {
           rawResults.push(extractedJson);
           fs.writeFileSync(path.join(CONFIG.DEBUG_DIR, 'temp_ads.json'), JSON.stringify(rawResults, null, 2));
        }
      } catch (err) {
        console.log(`[VISION ERROR] ${err.message}`);
      }

      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(CONFIG.SCROLL_WAIT_MS);
    }

    return output({
      type: "ads_library_lookup",
      query,
      limit,
      scraped_at: new Date().toISOString(),
      selected_page_name: selectedPageName || "",
      selected_page_id: selectedPageId || "",
      selected_page_url: selectedPageUrl,
      total_found: rawResults.length,
      screenshots,
      results: rawResults    });
  } finally {
    await close();
  }
}

async function main() {
  cleanupImages();
  
  const query = process.argv[2];
  const limitArg = process.argv[3];
  const limit = Number(limitArg) > 0 ? Number(limitArg) : CONFIG.DEFAULT_LIMIT;

  if (!query) {
    return outputError("missing_arguments", {
      expected: "node facebook_discovery.js <query> [limit]"
    });
  }

  try {
    if (fs.existsSync(path.join(CONFIG.DEBUG_DIR, 'temp_ads.json'))) {
      fs.unlinkSync(path.join(CONFIG.DEBUG_DIR, 'temp_ads.json'));
    }
    await handleAdsLibraryLookup(query, limit);
  } catch (err) {
    let partialResults = [];
    const tempFile = path.join(CONFIG.DEBUG_DIR, 'temp_ads.json');
    if (fs.existsSync(tempFile)) {
      try { partialResults = JSON.parse(fs.readFileSync(tempFile, 'utf8')); } catch(e){}
    }
    output({
      type: "ads_library_lookup",
      query,
      limit,
      error: err.message,
      results: partialResults
    });
  } finally {
  }
}

main();