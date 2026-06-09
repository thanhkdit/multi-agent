#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "../../.env")
});

const RAPIDAPI_HOST = "facebook-ads-library-scraper-api.p.rapidapi.com";
// Sử dụng mảng key từ .env, fallback về key mặc định bạn cung cấp nếu chưa có
const keysStr = process.env.RAPIDAPI_KEYS;
const RAPIDAPI_KEYS = keysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);

if (RAPIDAPI_KEYS.length === 0) {
  console.error("[FATAL] Missing RAPIDAPI_KEYS in .env");
  process.exit(1);
}

const BASE_URL = `https://${RAPIDAPI_HOST}`;

async function fetchWithRetry(url) {
  let lastError;
  for (let i = 0; i < RAPIDAPI_KEYS.length; i++) {
    const key = RAPIDAPI_KEYS[i];
    const headers = {
      "Content-Type": "application/json",
      "x-rapidapi-host": RAPIDAPI_HOST,
      "x-rapidapi-key": key,
    };

    try {
      const res = await fetch(url, { headers });

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();

      // Kiểm tra các lỗi API phổ biến
      if (data.message && (data.message.includes("exceeded") || data.message.includes("subscribed"))) {
        throw new Error(`RapidAPI Error: ${data.message}`);
      }

      return data;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`All API keys failed. Last error: ${lastError?.message}`);
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

async function searchCompanyAndGetPageId(query) {
  const url = `${BASE_URL}/search/companies?query=${encodeURIComponent(query)}`;
  const data = await fetchWithRetry(url);

  if (!data || !data.success || !data.searchResults || data.searchResults.length === 0) {
    throw new Error(`No company found for query: ${query}`);
  }

  // Lấy ra page có lượng like cao nhất
  const bestMatch = data.searchResults.reduce((prev, current) => {
    return (current.likes > prev.likes) ? current : prev;
  });

  return bestMatch;
}

async function getCompanyAds(pageId, limit) {
  const url = `${BASE_URL}/company/ads?pageId=${encodeURIComponent(pageId)}&status=ACTIVE&country=ALL&media_type=ALL&sort_by=total_impressions&trim=false`;
  const data = await fetchWithRetry(url);

  if (!data || !data.success || !data.results) {
    throw new Error(`Failed to fetch ads for pageId: ${pageId}`);
  }

  let results = data.results;
  if (results.length > limit) {
    results = results.slice(0, limit);
  }

  const mappedAds = results.map(ad => {
    return {
      ad_archive_id: ad.ad_archive_id,
      text: ad.snapshot?.body?.text || "",
      page_profile_uri: ad.snapshot?.page_profile_uri || "",
      page_categories: ad.snapshot?.page_categories || ad.page_categories || [],
      page_like_count: ad.snapshot?.page_like_count || ad.page_like_count || 0,
      end_date_string: ad.end_date_string || "",
      start_date_string: ad.start_date_string || "",
      url: ad.url || ""
    };
  });

  return mappedAds;
}

async function main() {
  const query = process.argv[2];
  const limitArg = process.argv[3];
  const limit = Number(limitArg) > 0 ? Number(limitArg) : 5;
  const competitorName = process.argv[4];

  if (!query) {
    console.error(JSON.stringify({
      type: "error",
      reason: "missing_arguments",
      expected: "node facebook_ads_library.js <query> [limit] [competitorName]"
    }, null, 2));
    process.exit(1);
  }

  try {
    // Bước 1: Tìm pageId
    const pageInfo = await searchCompanyAndGetPageId(query);
    
    // Bước 2: Lấy danh sách quảng cáo
    const ads = await getCompanyAds(pageInfo.page_id, limit);

    const resultData = {
      type: "ads_library_lookup",
      query,
      limit,
      scraped_at: new Date().toISOString(),
      selected_page_name: pageInfo.name || "",
      selected_page_id: pageInfo.page_id || "",
      selected_page_url: pageInfo.page_id ? `https://facebook.com/${pageInfo.page_id}` : "",
      total_found: ads.length,
      results: ads
    };

    console.log(JSON.stringify(resultData, null, 2));

    const headerName = competitorName || pageInfo.name || query || 'default';
    const folderName = cleanFolderName(headerName);

    if (folderName) {
      const resultDir = path.join(__dirname, "../../../shared/result", folderName);
      if (!fs.existsSync(resultDir)) {
        fs.mkdirSync(resultDir, { recursive: true });
      }
      const resultFilePath = path.join(resultDir, "ads_library.json");
      fs.writeFileSync(resultFilePath, JSON.stringify(resultData, null, 2));
    }
  } catch (err) {
    console.log(JSON.stringify({
      type: "ads_library_lookup",
      query,
      limit,
      error: err.message,
      results: []
    }, null, 2));
  }
}

main();