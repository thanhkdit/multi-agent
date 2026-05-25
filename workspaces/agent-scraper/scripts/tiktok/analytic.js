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
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const RAPIDAPI_HOST = "tiktok-api23.p.rapidapi.com";
const keysStr = process.env.TIKTOK_RAPIDAPI_KEYS || "";
const RAPIDAPI_KEY = keysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);

if (RAPIDAPI_KEY.length === 0) {
  console.error("[FATAL] Missing TIKTOK_RAPIDAPI_KEYS in .env");
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
      console.warn(`[WARN] API key index ${i} failed: ${err.message}. Trying next...`);
      lastError = err;
    }
  }
  
  throw new Error(`All API keys failed. Last error: ${lastError?.message}`);
}

const LATEST_POSTS_COUNT = 3;

/**
 * Gọi API lấy thông tin user
 * GET /api/user/info?uniqueId=<username>
 */
async function getUserInfo(uniqueId) {
  const url = `${BASE_URL}/user/info?uniqueId=${encodeURIComponent(uniqueId)}`;
  console.log(`[INFO] Fetching user info for: ${uniqueId}`);

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
  console.log(`[INFO] Fetching user video list (count=${count})`);

  const data = await fetchWithRetry(url);

  if (data?.data?.statusCode !== 0 && data?.data?.status_code !== 0) {
    throw new Error(`getUserListVideo API error: ${data?.data?.status_msg || "Unknown error"}`);
  }

  return data;
}

/**
 * Gọi API lấy chi tiết video
 * GET /api/post/detail?videoId=<videoId>
 */
async function getVideoDetail(videoId) {
  const url = `${BASE_URL}/post/detail?videoId=${encodeURIComponent(videoId)}`;
  console.log(`[INFO] Fetching video detail for: ${videoId}`);

  const data = await fetchWithRetry(url);

  if (data.statusCode !== 0) {
    throw new Error(`getVideoDetail API error for ${videoId}: ${data.statusMsg || "Unknown error"}`);
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
 * Lấy author.createTime từ video detail response
 * (API getUserInfo không trả createTime, nhưng getVideoDetail có)
 */
function getAuthorCreateTimeFromVideoDetail(apiResponse) {
  const author = apiResponse?.itemInfo?.itemStruct?.author || {};
  return author.createTime || null;
}

/**
 * Trích xuất thông tin video từ response getVideoDetail
 */
function extractVideoDetail(apiResponse, uniqueId) {
  const item = apiResponse?.itemInfo?.itemStruct || {};
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
async function analyzeTikTokChannel(uniqueId) {
  // 1. Lấy thông tin user
  const userInfoResponse = await getUserInfo(uniqueId);
  const channelInfo = extractChannelInfo(userInfoResponse);
  console.log(`[OK] Channel info fetched: ${channelInfo.title}`);

  // 2. Lấy secUid để gọi API list video
  const secUid = userInfoResponse?.userInfo?.user?.secUid;
  if (!secUid) {
    throw new Error("Cannot find secUid from user info response");
  }

  // 3. Lấy danh sách video
  const listVideoResponse = await getUserListVideo(secUid, LATEST_POSTS_COUNT);
  const itemList = listVideoResponse?.data?.itemList || [];

  if (itemList.length === 0) {
    console.log("[WARN] No videos found for this user");
  }

  // 4. Lấy 3 video mới nhất (sort theo createTime giảm dần)
  const latestItems = itemList
    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
    .slice(0, LATEST_POSTS_COUNT);

  console.log(`[INFO] Found ${latestItems.length} latest video(s), fetching details...`);

  // 5. Gọi API get video detail cho từng video
  const latestPosts = [];
  let firstDetailResponse = null;
  for (const item of latestItems) {
    const videoId = item.id;
    if (!videoId) {
      console.log("[WARN] Skipping item without video ID");
      continue;
    }

    try {
      const detailResponse = await getVideoDetail(videoId);
      if (!firstDetailResponse) firstDetailResponse = detailResponse;
      const videoDetail = extractVideoDetail(detailResponse, uniqueId);
      latestPosts.push(videoDetail);
      console.log(`[OK] Video detail fetched: ${videoId}`);
    } catch (err) {
      console.error(`[ERROR] Failed to fetch detail for video ${videoId}: ${err.message}`);
    }
  }

  // 6. Bổ sung channelCreatedAt từ video detail (nếu chưa có)
  if (!channelInfo.channelCreatedAt && firstDetailResponse) {
    const authorCreateTime = getAuthorCreateTimeFromVideoDetail(firstDetailResponse);
    if (authorCreateTime) {
      channelInfo.channelCreatedAt = new Date(authorCreateTime * 1000).toISOString();
      console.log(`[OK] Channel created at: ${channelInfo.channelCreatedAt}`);
    }
  }

  // 7. Tổng hợp kết quả
  const result = {
    channel: channelInfo,
    latestPosts: latestPosts,
    fetchedAt: new Date().toISOString(),
  };

  return result;
}

// --- Main ---
(async () => {
  const uniqueId = process.argv[2];

  if (!uniqueId) {
    console.error("Usage: node analytic.js <uniqueId>");
    console.error("Example: node analytic.js taylorswift");
    process.exit(1);
  }

  try {
    const result = await analyzeTikTokChannel(uniqueId);

    // Output JSON
    console.log("\n--- RESULT ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  }
})();
