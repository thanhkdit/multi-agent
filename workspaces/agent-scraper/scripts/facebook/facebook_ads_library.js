#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const USER_DATA_DIR = path.join(__dirname, "../browser-data");

require("dotenv").config({
  path: path.join(__dirname, "../../.env")
});

const CONFIG = {
  DEBUG_DIR: path.join(__dirname, "../debug"),
  SCREENSHOT_DIR: path.join(__dirname, "../screenshots"),

  DEFAULT_LIMIT: 5,

  LOAD_WAIT_MS: 8000,
  INPUT_POPUP_WAIT_MS: 3000,
  AFTER_PAGE_CLICK_WAIT_MS: 5000
};

fs.mkdirSync(CONFIG.DEBUG_DIR, { recursive: true });
fs.mkdirSync(CONFIG.SCREENSHOT_DIR, { recursive: true });

async function createBrowser() {
  const context = await chromium.launchPersistentContext(
    USER_DATA_DIR,
    {
      headless: process.env.ENV === 'local' ? false : true,

      viewport: {
        width: 1440,
        height: 900
      },

      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",

      locale: "vi-VN",

      timezoneId: "Asia/Ho_Chi_Minh",

      permissions: [],

      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox"
      ]
    }
  );

  const page = await context.newPage();

  page.setDefaultTimeout(60000);

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false
    });
  });

  return {
    context,
    page,

    close: async () => {
      await context.close();
    }
  };
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

function normalizeText(str = "") {
  return String(str).toLowerCase().trim().replace(/\s+/g, " ");
}

function safeFileName(name) {
  return String(name).replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 100);
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

function isTargetGraphqlResponse(response) {
  try {
    const url = response.url();
    if (!url.includes("/api/graphql/")) return false;

    const postData = response.request().postData() || "";
    return (
      postData.includes("AdLibraryMobileFocusedStateProviderRefetchQuery") ||
      postData.includes("doc_id=24739843032379348")
    );
  } catch (_) {
    return false;
  }
}

function findSearchInputByValue(page, query) {
  return (async () => {
    const normalizedQuery = normalizeText(query);
    const inputs = page.locator("input");
    const count = await inputs.count();

    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);

      try {
        if (!(await input.isVisible())) continue;

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
  })();
}

async function clickFirstPopupPageOption(page) {
  let option = page
    .locator('li[role="option"][aria-selected="false"][id^="pageID:"]')
    .first();

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

function extractJsonObjectsFromText(text) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function parseResponseFragments(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {}

  const fragments = extractJsonObjectsFromText(trimmed);
  const results = [];

  for (const fragment of fragments) {
    try {
      results.push(JSON.parse(fragment));
    } catch (_) {}
  }

  return results;
}

function isMeaningfulText(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (/^\{\{.*\}\}$/.test(text)) return false;
  return true;
}

function normalizeImage(image = {}) {
  return {
    original_image_url: image.original_image_url || "",
    resized_image_url: image.resized_image_url || "",
    watermarked_resized_image_url: image.watermarked_resized_image_url || ""
  };
}

function normalizeVideo(video = {}) {
  return {
    video_hd_url: video.video_hd_url || "",
    video_sd_url: video.video_sd_url || "",
    video_preview_image_url: video.video_preview_image_url || "",
    watermarked_video_hd_url: video.watermarked_video_hd_url || "",
    watermarked_video_sd_url: video.watermarked_video_sd_url || ""
  };
}

function normalizeCard(card = {}) {
  return {
    body: card.body || "",
    caption: card.caption || "",
    cta_text: card.cta_text || "",
    cta_type: card.cta_type || "",
    link_url: card.link_url || "",
    link_description: card.link_description || "",
    title: card.title || "",
    original_image_url: card.original_image_url || "",
    resized_image_url: card.resized_image_url || "",
    video_hd_url: card.video_hd_url || "",
    video_sd_url: card.video_sd_url || ""
  };
}

function pickBestBodyText(item = {}) {
  const bodyText = item?.body?.text;
  if (isMeaningfulText(bodyText)) return bodyText;

  if (Array.isArray(item?.cards)) {
    const cardBodies = item.cards
      .map((c) => c?.body)
      .filter(isMeaningfulText);

    if (cardBodies.length > 0) {
      return cardBodies.join("\n\n");
    }
  }

  return "";
}

function normalizeAdItem(item = {}, pageInfo = {}) {
  const snapshot = item?.snapshot || {};
  const bodyText = pickBestBodyText(item);
  const adArchiveId = String(item?.ad_archive_id || "").trim();

  return {
    ad_archive_id: adArchiveId,
    url: adArchiveId
      ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adArchiveId)}`
      : "",

    collation_id: item?.collation_id || "",
    collation_count: item?.collation_count ?? null,
    is_active: item?.is_active ?? null,

    page_id: item?.page_id || snapshot?.page_id || pageInfo?.id || "",
    page_name:
      snapshot?.page_name ||
      item?.page_name ||
      pageInfo?.name ||
      "",

    page_profile_uri: snapshot?.page_profile_uri || "",
    page_profile_picture_url: snapshot?.page_profile_picture_url || "",
    page_like_count: item?.page_like_count ?? snapshot?.page_like_count ?? null,
    page_categories: item?.page_categories || snapshot?.page_categories || [],

    caption: item?.caption ?? snapshot?.caption ?? null,
    cta_text: item?.cta_text ?? snapshot?.cta_text ?? null,
    cta_type: item?.cta_type ?? snapshot?.cta_type ?? null,
    display_format: item?.display_format ?? snapshot?.display_format ?? null,
    title: item?.title ?? snapshot?.title ?? null,
    link_url: item?.link_url ?? snapshot?.link_url ?? null,
    link_description: item?.link_description ?? snapshot?.link_description ?? null,

    body_text: bodyText,
    cards: Array.isArray(item?.cards) ? item.cards.map(normalizeCard) : [],

    images: Array.isArray(item?.images) ? item.images.map(normalizeImage) : [],
    videos: Array.isArray(item?.videos) ? item.videos.map(normalizeVideo) : [],

    publisher_platform: item?.publisher_platform || [],
    start_date: item?.start_date ?? null,
    end_date: item?.end_date ?? null,
    total_active_time: item?.total_active_time ?? null,

    has_user_reported: item?.has_user_reported ?? null,
    report_count: item?.report_count ?? null,
    contains_sensitive_content: item?.contains_sensitive_content ?? null,
    hide_data_status: item?.hide_data_status ?? null,

    raw: item
  };
}

function shouldKeepAdByArchiveId(ad, seenArchiveIds) {
  const adArchiveId = String(ad?.ad_archive_id || "").trim();

  if (!adArchiveId) {
    return false;
  }

  if (seenArchiveIds.has(adArchiveId)) {
    return false;
  }

  seenArchiveIds.add(adArchiveId);
  return true;
}

function collectAdCandidatesFromObject(
  obj,
  pageInfo = {},
  out = [],
  seenArchiveIds = new Set(),
  limit = Infinity
) {
  if (!obj || typeof obj !== "object") return out;
  if (out.length >= limit) return out;

  if (Array.isArray(obj)) {
    for (const entry of obj) {
      if (out.length >= limit) break;
      collectAdCandidatesFromObject(entry, pageInfo, out, seenArchiveIds, limit);
    }
    return out;
  }

  if (obj.ad_archive_id || obj.snapshot?.page_name || obj.body?.text || obj.cards) {
    const normalized = normalizeAdItem(obj, pageInfo);

    if (shouldKeepAdByArchiveId(normalized, seenArchiveIds)) {
      out.push(normalized);
      if (out.length >= limit) {
        return out;
      }
    }
  }

  for (const value of Object.values(obj)) {
    if (out.length >= limit) break;

    if (value && typeof value === "object") {
      collectAdCandidatesFromObject(
        value,
        pageInfo,
        out,
        seenArchiveIds,
        limit
      );
    }
  }

  return out;
}

function extractAdsFromResponseText(responseText, seenArchiveIds = new Set(), limit = Infinity) {
  const fragments = parseResponseFragments(responseText);
  const allAds = [];

  for (const fragment of fragments) {
    if (allAds.length >= limit) break;

    const pageInfo = fragment?.data?.page || fragment?.page || {};
    collectAdCandidatesFromObject(
      fragment,
      pageInfo,
      allAds,
      seenArchiveIds,
      limit
    );
  }

  return allAds;
}

async function handleAdsLibraryLookup(query, limit = CONFIG.DEFAULT_LIMIT) {
  const { page, close } = await createBrowser();

  const rawResponses = [];
  const pendingResponseTasks = [];
  const extractedAds = [];
  const seenArchiveIds = new Set();

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

    page.on("response", (response) => {
      if (!isTargetGraphqlResponse(response)) return;

      const task = (async () => {
        try {
          const text = await response.text();

          console.log(
            `[DEBUG] GraphQL Response Intercepted. Length: ${text.length}`
          );

          fs.writeFileSync(
            path.join(CONFIG.DEBUG_DIR, `graphql_response_${Date.now()}.json`),
            text
          );

          rawResponses.push(text);
        } catch (err) {
          console.log(`[GRAPHQL READ ERROR] ${err.message}`);
        }
      })();

      pendingResponseTasks.push(task);
    });

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

    await Promise.allSettled(pendingResponseTasks);

    console.log(`[DEBUG] Total GraphQL Responses: ${rawResponses.length}`);

    for (const responseText of rawResponses) {
      if (extractedAds.length >= limit) break;

      const remaining = limit - extractedAds.length;
      const ads = extractAdsFromResponseText(
        responseText,
        seenArchiveIds,
        remaining
      );

      if (ads.length > 0) {
        extractedAds.push(...ads);
      }

      if (extractedAds.length >= limit) break;
    }

    console.log(`[DEBUG] Extracted Ads Count: ${seenArchiveIds.size}`);
    console.log(`[DEBUG] Returned Ads Count: ${Math.min(extractedAds.length, limit)}`);

    fs.writeFileSync(
      path.join(CONFIG.DEBUG_DIR, "temp_ads.json"),
      JSON.stringify(extractedAds, null, 2)
    );

    const selectedPageUrl = page.url();
    const selectedPageId = extractPageIdFromUrl(selectedPageUrl);

    let selectedPageName = "";
    try {
      selectedPageName = String(
        (await page.locator("h1").first().innerText({ timeout: 5000 })) || ""
      ).trim();
    } catch (_) {}

    return output({
      type: "ads_library_lookup",
      query,
      limit,
      scraped_at: new Date().toISOString(),
      selected_page_name: selectedPageName || "",
      selected_page_id: selectedPageId || "",
      selected_page_url: selectedPageUrl,
      total_found: extractedAds.length,
      results: extractedAds.slice(0, limit)
    });
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
      expected: "node facebook_ads_library.js <query> [limit]"
    });
  }

  try {
    const tempFile = path.join(CONFIG.DEBUG_DIR, "temp_ads.json");
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }

    await handleAdsLibraryLookup(query, limit);
  } catch (err) {
    const tempFile = path.join(CONFIG.DEBUG_DIR, "temp_ads.json");
    let partialResults = [];

    if (fs.existsSync(tempFile)) {
      try {
        partialResults = JSON.parse(fs.readFileSync(tempFile, "utf8"));
      } catch (_) {}
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