/**
 * session_manager.js
 * 
 * Module quản lý session Facebook tập trung cho agent-scraper.
 * 
 * Chức năng:
 * - Kiểm tra trạng thái session (valid / expired / missing)
 * - Nạp session từ file storageState JSON
 * - Lưu session sau khi login thành công
 * - Ghi log vào debug/ khi session thay đổi trạng thái
 * 
 * Session được lưu ở 2 nơi (đồng bộ):
 * 1. .openclaw/fb_session.json  — dùng bởi universal_scraper, universal_scraper_vision
 * 2. browser-data/              — dùng bởi facebook_discovery (persistent context)
 */

const fs = require('fs');
const path = require('path');

// ── Paths ────────────────────────────────────────────────────────────
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const SESSION_DIR = path.join(WORKSPACE_ROOT, '.openclaw');
const SESSION_FILE = path.join(SESSION_DIR, 'fb_session.json');
const BROWSER_DATA_DIR = path.join(WORKSPACE_ROOT, 'browser-data');
const DEBUG_DIR = path.join(WORKSPACE_ROOT, 'debug');
const SESSION_LOG = path.join(DEBUG_DIR, 'session.log');

// Đảm bảo các thư mục tồn tại
function ensureDirs() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
}

// ── Logging ──────────────────────────────────────────────────────────

function logSession(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = { info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' }[level] || '📝';
  const line = `[${timestamp}] [${level.toUpperCase()}] ${prefix} ${message}`;

  // Console
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }

  // File log
  try {
    ensureDirs();
    fs.appendFileSync(SESSION_LOG, line + '\n');
  } catch (_) { /* ignore */ }
}

// ── Session Status ──────────────────────────────────────────────────

/**
 * Kiểm tra trạng thái session Facebook.
 * 
 * @returns {{ status: 'valid'|'expired'|'missing'|'corrupted', detail: string, cUser?: string, expiresAt?: string }}
 */
function checkSessionStatus() {
  ensureDirs();

  if (!fs.existsSync(SESSION_FILE)) {
    logSession('warn', 'Session file not found: ' + SESSION_FILE);
    return { status: 'missing', detail: 'File fb_session.json không tồn tại.' };
  }

  let sessionData;
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    sessionData = JSON.parse(raw);
  } catch (e) {
    logSession('error', 'Session file corrupted: ' + e.message);
    return { status: 'corrupted', detail: 'File fb_session.json bị lỗi JSON: ' + e.message };
  }

  // Validate cấu trúc storageState
  if (!sessionData.cookies || !Array.isArray(sessionData.cookies)) {
    logSession('error', 'Session file missing cookies array.');
    return { status: 'corrupted', detail: 'File session không có trường cookies.' };
  }

  // Tìm cookie c_user (chứng tỏ đã login Facebook)
  const cUserCookie = sessionData.cookies.find(c => c.name === 'c_user');
  if (!cUserCookie) {
    logSession('warn', 'Session missing c_user cookie — chưa login.');
    return { status: 'expired', detail: 'Không tìm thấy cookie c_user (chưa đăng nhập).' };
  }

  // Kiểm tra hạn cookie
  const nowUnix = Date.now() / 1000;
  if (cUserCookie.expires && cUserCookie.expires < nowUnix) {
    const expiredAt = new Date(cUserCookie.expires * 1000).toISOString();
    logSession('warn', `Session expired at ${expiredAt}. c_user=${cUserCookie.value}`);
    return {
      status: 'expired',
      detail: `Cookie c_user đã hết hạn vào ${expiredAt}.`,
      cUser: cUserCookie.value,
      expiresAt: expiredAt
    };
  }

  // Kiểm tra thêm cookie xs (session token)
  const xsCookie = sessionData.cookies.find(c => c.name === 'xs');
  if (!xsCookie) {
    logSession('warn', 'Session missing xs cookie — có thể đã bị revoke.');
    return { status: 'expired', detail: 'Không tìm thấy cookie xs (session token).' };
  }

  if (xsCookie.expires && xsCookie.expires < nowUnix) {
    const expiredAt = new Date(xsCookie.expires * 1000).toISOString();
    logSession('warn', `xs cookie expired at ${expiredAt}.`);
    return {
      status: 'expired',
      detail: `Cookie xs (session token) đã hết hạn vào ${expiredAt}.`,
      cUser: cUserCookie.value,
      expiresAt: expiredAt
    };
  }

  const expiresAt = new Date(cUserCookie.expires * 1000).toISOString();
  logSession('info', `Session valid. c_user=${cUserCookie.value}, expires=${expiresAt}`);
  return {
    status: 'valid',
    detail: `Session hợp lệ. Hết hạn: ${expiresAt}`,
    cUser: cUserCookie.value,
    expiresAt
  };
}

// ── Save Session ────────────────────────────────────────────────────

/**
 * Lưu storageState từ Playwright context vào file.
 * Tự động backup file cũ trước khi ghi đè.
 * 
 * @param {import('playwright').BrowserContext} context - Playwright browser context
 * @returns {Promise<boolean>} - true nếu lưu thành công
 */
async function saveSession(context) {
  ensureDirs();

  try {
    // Backup file cũ (nếu có)
    if (fs.existsSync(SESSION_FILE)) {
      const backupPath = SESSION_FILE + '.bak';
      fs.copyFileSync(SESSION_FILE, backupPath);
      logSession('info', 'Backed up old session to fb_session.json.bak');
    }

    // Lưu storageState mới
    await context.storageState({ path: SESSION_FILE });
    logSession('success', 'Session saved to ' + SESSION_FILE);

    // Verify file đã ghi thành công
    const status = checkSessionStatus();
    if (status.status !== 'valid') {
      logSession('warn', 'Session saved but verification failed: ' + status.detail);
      return false;
    }

    return true;
  } catch (e) {
    logSession('error', 'Failed to save session: ' + e.message);
    return false;
  }
}

// ── Load Session ────────────────────────────────────────────────────

/**
 * Trả về đường dẫn session file nếu session hợp lệ, null nếu không.
 * Dùng cho contextOptions.storageState khi tạo browser context.
 * 
 * @returns {string|null}
 */
function getValidSessionPath() {
  const status = checkSessionStatus();
  if (status.status === 'valid') {
    return SESSION_FILE;
  }
  return null;
}

// ── Detect Login on Page ────────────────────────────────────────────

/**
 * Kiểm tra trang hiện tại có phải trang login / checkpoint không.
 * 
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true nếu đang ở trang login (chưa đăng nhập)
 */
async function isLoginPage(page) {
  const currentUrl = page.url();

  // URL-based checks
  if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
    return true;
  }

  // DOM-based check: có form login không
  const loginFormExists = await page.$('form[id="login_form"]') !== null;
  if (loginFormExists) return true;

  // DOM-based check: KHÔNG có navigation bar (đã đăng nhập sẽ có)
  const hasNavigation = await page.locator('div[role="navigation"]').count() > 0;
  if (!hasNavigation) {
    // Chờ thêm 3s để trang load xong
    await page.waitForTimeout(3000);
    const hasNavigationRetry = await page.locator('div[role="navigation"]').count() > 0;
    if (!hasNavigationRetry) return true;
  }

  return false;
}

/**
 * Đợi user login thủ công trên browser, timeout mặc định 5 phút.
 * 
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs - Timeout tính bằng ms (mặc định 300000 = 5 phút)
 * @returns {Promise<boolean>} true nếu login thành công
 */
async function waitForManualLogin(page, timeoutMs = 300000) {
  logSession('info', `Đợi user login thủ công (timeout: ${timeoutMs / 1000}s)...`);

  try {
    await page.waitForSelector('div[role="navigation"]', { timeout: timeoutMs });
    logSession('success', 'Phát hiện đăng nhập thành công (navigation bar xuất hiện).');
    return true;
  } catch (e) {
    logSession('error', 'Quá thời gian chờ đăng nhập: ' + e.message);
    return false;
  }
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  // Paths
  WORKSPACE_ROOT,
  SESSION_DIR,
  SESSION_FILE,
  BROWSER_DATA_DIR,
  DEBUG_DIR,

  // Functions
  ensureDirs,
  logSession,
  checkSessionStatus,
  saveSession,
  getValidSessionPath,
  isLoginPage,
  waitForManualLogin
};
