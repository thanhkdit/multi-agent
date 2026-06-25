/**
 * TikTok Channel Analytics Script
 *
 * Nhận vào params: tên page (uniqueId)
 * - Gọi API get user info => lấy thông tin chính của kênh
 * - Gọi API list video => lấy 3 post mới nhất
 * - Gọi API get video detail cho từng video => lấy nội dung chi tiết
 * - Tổng hợp và trả về JSON output
 *
 * Usage: node analytic.js <uniqueId>
 * Example: node analytic.js taylorswift
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const RAPIDAPI_HOST = "tiktok-api23.p.rapidapi.com";
const keysStr = process.env.RAPIDAPI_KEYS || "";
const RAPIDAPI_KEY = keysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);

if (RAPIDAPI_KEY.length === 0) {
  console.error("[FATAL] Missing RAPIDAPI_KEYS in .env");
  process.exit(1);
}
const BASE_URL = `https://${RAPIDAPI_HOST}/api`;

async function fetchWithRetry(url) {
  let lastError;
  for (let i = 0; i < RAPIDAPI_KEY.length; i++) {
    const key = RAPIDAPI_KEY[i];
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
      
      // RapidAPI error handling (e.g., rate limits)
      if (data.message && (data.message.includes("exceeded") || data.message.includes("subscribed"))) {
         throw new Error(`RapidAPI Error: ${data.message}`);
      }

      return data;
    } catch (err) {
      // console.warn(`[WARN] API key index ${i} failed: ${err.message}. Trying next...`);
      lastError = err;
    }
  }
  
  throw new Error(`All API keys failed. Last error: ${lastError?.message}`);
}


/**
 * Gọi API lấy thông tin user
 * GET /api/user/info?uniqueId=<username>
 */
async function getUserInfo(uniqueId) {
  const url = `${BASE_URL}/user/info?uniqueId=${encodeURIComponent(uniqueId)}`;
  // console.log(`[INFO] Fetching user info for: ${uniqueId}`);

  const data = await fetchWithRetry(url);

  if (data.statusCode !== 0) {
    throw new Error(`getUserInfo API error: ${data.status_msg || "Unknown error"}`);
  }

  return data;
}

/**
 * Gọi API lấy danh sách video của user
 * GET /api/user/posts?secUid=<secUid>&count=<count>&cursor=0
 */
async function getUserListVideo(secUid, count = 35) {
  const url = `${BASE_URL}/user/posts?secUid=${encodeURIComponent(secUid)}&count=${count}&cursor=0`;
  // console.log(`[INFO] Fetching user video list (count=${count})`);

  const data = await fetchWithRetry(url);

  if (data?.data?.statusCode !== 0 && data?.data?.status_code !== 0) {
    throw new Error(`getUserListVideo API error: ${data?.data?.status_msg || "Unknown error"}`);
  }

  return data;
}

/**
 * Trích xuất thông tin chính của kênh từ response getUserInfo
 */
function extractChannelInfo(apiResponse) {
  const user = apiResponse?.userInfo?.user || {};
  const stats = apiResponse?.userInfo?.stats || {};
  const shareMeta = apiResponse?.shareMeta || {};

  return {
    title: shareMeta.title || user.nickname || "",
    desc: user.signature || shareMeta.desc || "",
    nickname: user.nickname || "",
    uniqueId: user.uniqueId || "",
    avatarUrl: user.avatarLarger || user.avatarMedium || user.avatarThumb || "",
    diggCount: stats.diggCount || 0,
    heartCount: stats.heartCount || 0,
    videoCount: stats.videoCount || 0,
    followerCount: stats.followerCount || 0,
    followingCount: stats.followingCount || 0,
    likeCount: stats.heart || stats.heartCount || 0,
    bioLink: user.bioLink?.link || "",
    channelCreatedAt: user.createTime
      ? new Date(user.createTime * 1000).toISOString()
      : null,
    verified: user.verified || false,
  };
}

/**
 * Trích xuất thông্তি video từ item trong danh sách user/posts
 */
function extractVideoDetail(item, uniqueId) {
  const video = item.video || {};
  const stats = item.stats || {};

  return {
    id: item.id || "",
    url: "https://www.tiktok.com/@" + uniqueId + "/video/" + item.id,
    title: item.desc?.substring(0, 100) || "",
    desc: item.desc || "",
    createTime: item.createTime
      ? new Date(Number(item.createTime) * 1000).toISOString()
      : null,
    width: video.width || 0,
    height: video.height || 0,
    duration: video.duration || 0,
    ratio: video.ratio || "",
    cover: video.cover || "",
    diggCount: Number(stats.diggCount) || 0,
    shareCount: Number(stats.shareCount) || 0,
    commentCount: Number(stats.commentCount) || 0,
    playCount: Number(stats.playCount) || 0,
    collectCount: Number(stats.collectCount) || 0,
  };
}

/**
 * Hàm chính: phân tích kênh TikTok
 */
async function analyzeTikTokChannel(uniqueId, limit = 3) {
  // 1. Lấy thông tin user
  const userInfoResponse = await getUserInfo(uniqueId);
  const channelInfo = extractChannelInfo(userInfoResponse);
  // console.log(`[OK] Channel info fetched: ${channelInfo.title}`);

  // 2. Lấy secUid để gọi API list video
  const secUid = userInfoResponse?.userInfo?.user?.secUid;
  if (!secUid) {
    throw new Error("Cannot find secUid from user info response");
  }

  // 3. Lấy danh sách video
  const listVideoResponse = await getUserListVideo(secUid, Math.max(limit, 20));
  const itemList = listVideoResponse?.data?.itemList || [];

  if (itemList.length === 0) {
    // console.log("[WARN] No videos found for this user");
  }

  // 4. Lấy video mới nhất (sort theo createTime giảm dần)
  const latestItems = itemList
    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
    .slice(0, limit);

  // console.log(`[INFO] Found ${latestItems.length} latest video(s), fetching details...`);

  // 5. Trích xuất video detail cho từng video từ dữ liệu đã lấy
  const latestPosts = latestItems.map(item => extractVideoDetail(item, uniqueId));

  // 6. Tổng hợp kết quả
  const result = {
    channel: channelInfo,
    latestPosts: latestPosts,
    fetchedAt: new Date().toISOString(),
  };

  return result;
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

// --- Main ---
(async () => {
  let uniqueId = process.argv[2];
  if (uniqueId && uniqueId.startsWith('@')) {
    uniqueId = uniqueId.substring(1);
  }
  const limitArg = process.argv[3];
  
  let limit = parseInt(limitArg, 10);
  let competitorName;

  if (isNaN(limit)) {
    limit = 3;
    competitorName = process.argv[3];
  } else {
    limit = Math.min(Math.max(limit, 1), 15);
    competitorName = process.argv[4];
  }

  if (!uniqueId) {
    console.error("Usage: node analytic.js <uniqueId> [limit] [competitorName]");
    console.error("Example: node analytic.js taylorswift 5");
    process.exit(1);
  }

  try {
    const result = await analyzeTikTokChannel(uniqueId, limit);

    // Output JSON
    // console.log("\n--- RESULT ---");
    console.log(JSON.stringify(result, null, 2));

    if (result && result.channel) {
      const nameSource = competitorName || result.channel.nickname || result.channel.title || result.channel.uniqueId || 'default';
      const folderName = cleanFolderName(nameSource);
      if (folderName) {
        const resultDir = path.join(__dirname, '../../../shared/result', folderName);
        if (!fs.existsSync(resultDir)) {
          fs.mkdirSync(resultDir, { recursive: true });
        }
        const resultFilePath = path.join(resultDir, 'tiktok.json');
        fs.writeFileSync(resultFilePath, JSON.stringify(result, null, 2));
      }
    }
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  }
})();
