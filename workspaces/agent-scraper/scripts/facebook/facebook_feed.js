/**
 * Facebook Page Feed Analytics Script (RapidAPI)
 *
 * Nhận vào params: URL page Facebook, limit số bài viết
 * - Gọi API lấy page_id từ URL
 * - Gọi API lấy danh sách bài viết theo cơ chế phân trang ngược theo ngày
 * - Tổng hợp và trả về JSON output
 *
 * Usage: node facebook_feed.js <page_url> [limit] [competitorName]
 * Example: node facebook_feed.js https://www.facebook.com/calmngao 10
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const RAPIDAPI_HOST = "facebook-scraper3.p.rapidapi.com";
const keysStr = process.env.RAPIDAPI_KEYS || "";
const RAPIDAPI_KEYS = keysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);

if (RAPIDAPI_KEYS.length === 0) {
  console.error("[FATAL] Missing RAPIDAPI_KEYS in .env");
  process.exit(1);
}

const BASE_URL = `https://${RAPIDAPI_HOST}`;

/**
 * Gọi API với retry qua nhiều API keys
 */
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

      // RapidAPI error handling (e.g., rate limits)
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

/**
 * Lấy page_id từ URL Facebook page
 * GET /page/page_id?url=<encoded_url>
 */
async function getPageId(pageUrl) {
  const url = `${BASE_URL}/page/page_id?url=${encodeURIComponent(pageUrl)}`;
  const data = await fetchWithRetry(url);

  if (!data.page_id) {
    throw new Error(`getPageId API error: Cannot find page_id for ${pageUrl}`);
  }

  return data.page_id;
}

/**
 * Lấy danh sách bài viết của page theo ngày
 * GET /page/posts?page_id=<id>&start_date=<date>&end_date=<date>
 *
 * Nếu start_date/end_date rỗng thì không truyền param đó
 */
async function getPagePosts(pageId, startDate = '', endDate = '') {
  let url = `${BASE_URL}/page/posts?page_id=${encodeURIComponent(pageId)}`;

  if (startDate) {
    url += `&start_date=${encodeURIComponent(startDate)}`;
  }
  if (endDate) {
    url += `&end_date=${encodeURIComponent(endDate)}`;
  }

  const data = await fetchWithRetry(url);
  return data;
}

/**
 * Format unix timestamp to YYYY-MM-DD
 */
function formatDateFromTimestamp(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Trích xuất thông tin page từ kết quả post (author info)
 */
function extractPageInfo(posts) {
  if (!posts || posts.length === 0) return { name: '', followers: '', likes: '', description: '' };

  const firstPost = posts[0];
  const author = firstPost.author || {};

  return {
    name: author.name || '',
    url: author.url || '',
    profile_picture_url: author.profile_picture_url || '',
  };
}

/**
 * Normalize một post từ RapidAPI response sang format chuẩn
 */
function normalizePost(post) {
  return {
    post_id: post.post_id || '',
    type: post.type || 'post',
    header: post.author?.name || '',
    content: post.message || post.message_rich || '',
    url: post.url || '',
    reaction: Number(post.reactions_count || 0),
    comments: Number(post.comments_count || 0),
    shares: Number(post.reshare_count || 0),
    time: Number(post.timestamp || 0),
    time_text: post.timestamp ? new Date(post.timestamp * 1000).toISOString() : '',
    platform: 'facebook',
    source: 'rapidapi',
    image: post.image || null,
    video: post.video || null,
    reactions_detail: post.reactions || null,
  };
}

/**
 * Logic quét post theo cơ chế phân trang ngược theo ngày:
 * 
 * Bước 1: Gọi API không truyền start_date, end_date => lấy posts mới nhất
 * Bước 2: Nếu chưa đủ limit, lấy date của post cũ nhất => đặt làm end_date, gọi tiếp
 * Bước 3: Lặp lại cho đến khi đủ limit hoặc dữ liệu trống
 * Bước 4: Tối đa 5 lần gọi API
 */
async function fetchPostsWithPagination(pageId, limit) {
  const MAX_ITERATIONS = 5;
  const allPosts = [];
  const seenPostIds = new Set();

  let endDate = '';
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    const response = await getPagePosts(pageId, '', endDate);
    const results = response?.results || [];

    if (results.length === 0) {
      break;
    }

    // Gom kết quả, loại bỏ trùng lặp theo post_id
    let newPostsCount = 0;
    for (const post of results) {
      const postId = post.post_id || post.url || JSON.stringify(post).slice(0, 200);
      if (seenPostIds.has(postId)) continue;

      seenPostIds.add(postId);
      allPosts.push(post);
      newPostsCount++;
    }

    // Nếu không có post mới nào => hết dữ liệu
    if (newPostsCount === 0) {
      break;
    }

    // Đã đủ limit
    if (allPosts.length >= limit) {
      break;
    }

    // Lấy timestamp cũ nhất trong batch hiện tại để làm end_date cho lần gọi tiếp
    const oldestPost = results.reduce((oldest, post) => {
      const ts = post.timestamp || 0;
      if (!oldest || ts < (oldest.timestamp || Infinity)) return post;
      return oldest;
    }, null);

    if (!oldestPost || !oldestPost.timestamp) {
      break;
    }

    const oldestDate = formatDateFromTimestamp(oldestPost.timestamp);
    if (!oldestDate || oldestDate === endDate) {
      // Tránh loop vô hạn nếu date không thay đổi
      break;
    }

    endDate = oldestDate;
  }

  return allPosts;
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

/**
 * Hàm chính: phân tích Facebook Page
 */
async function analyzeFacebookPage(pageUrl, limit) {
  // 1. Lấy page_id từ URL
  const pageId = await getPageId(pageUrl);

  // 2. Lấy danh sách posts với cơ chế phân trang ngược
  const rawPosts = await fetchPostsWithPagination(pageId, limit);

  // 3. Trích xuất page info từ posts
  const pageInfo = extractPageInfo(rawPosts);

  // 4. Normalize và sắp xếp posts theo thời gian (mới nhất trước)
  let normalizedPosts = rawPosts.map(normalizePost);
  normalizedPosts.sort((a, b) => (b.time || 0) - (a.time || 0));

  // 5. Cắt theo limit
  if (normalizedPosts.length > limit) {
    normalizedPosts = normalizedPosts.slice(0, limit);
  }

  // 6. Tổng hợp kết quả
  const result = {
    status: 'success',
    platform: 'facebook',
    url: pageUrl,
    page_id: pageId,
    scraped_at: new Date().toISOString(),
    page_info: pageInfo,
    total_extracted: normalizedPosts.length,
    posts: normalizedPosts,
  };

  return result;
}

// --- Main ---
(async () => {
  const pageUrl = process.argv[2];
  const limitStr = process.argv[3] || '6';
  const competitorName = process.argv[4];

  if (!pageUrl) {
    console.error("Usage: node facebook_feed.js <page_url> [limit] [competitorName]");
    console.error("Example: node facebook_feed.js https://www.facebook.com/calmngao 10");
    process.exit(1);
  }

  const limit = Math.max(parseInt(limitStr, 10) || 6, 1);

  try {
    const result = await analyzeFacebookPage(pageUrl, limit);

    // Output JSON
    console.log(JSON.stringify(result, null, 2));

    // Lưu vào shared/result
    if (result && result.page_info) {
      const nameSource = competitorName || result.page_info.name || 'default';
      const folderName = cleanFolderName(nameSource);
      if (folderName) {
        const resultDir = path.join(__dirname, '../../../shared/result', folderName);
        if (!fs.existsSync(resultDir)) {
          fs.mkdirSync(resultDir, { recursive: true });
        }
        const resultFilePath = path.join(resultDir, 'feeds.json');
        fs.writeFileSync(resultFilePath, JSON.stringify(result, null, 2));
      }
    }
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
  }
})();
