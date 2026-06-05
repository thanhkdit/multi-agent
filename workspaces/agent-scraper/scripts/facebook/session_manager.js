/**
 * session_manager.js
 * 
 * Module quản lý session Facebook tập trung cho agent-scraper.
 * 
 * Chức năng:
 * - Kiểm tra trạng thái session (valid / expired / missing)
 * - Nạp session từ file storageState JSON
 * - Lưu session sau khi login thành công
 * - Khởi tạo browser headful trên server (Xvfb + CDP remote debug)
 * - Ghi log vào debug/ khi session thay đổi trạng thái
 * 
 * Session được lưu ở 2 nơi (đồng bộ):
 * 1. .openclaw/fb_session.json  — dùng bởi facebook_feed, facebook_feed_vision
 * 2. browser-data/              — dùng bởi facebook_ads_library (persistent context)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const { startVncServer } = require('../vnc_server');

// ── Paths ────────────────────────────────────────────────────────────
const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const SESSION_DIR = path.join(WORKSPACE_ROOT, '.openclaw');
const SESSION_FILE = path.join(SESSION_DIR, 'fb_session.json');
const BROWSER_DATA_DIR = path.join(WORKSPACE_ROOT, 'browser-data');
const DEBUG_DIR = path.join(WORKSPACE_ROOT, 'debug');
const SESSION_LOG = path.join(DEBUG_DIR, 'session.log');

// Daemon coordination files
const DAEMON_PID_FILE = path.join(SESSION_DIR, 'session_daemon.pid');
const DAEMON_STATUS_FILE = path.join(SESSION_DIR, 'session_daemon_status.json');

// ── Config ───────────────────────────────────────────────────────────
const DISPLAY_NUM = process.env.DISPLAY_NUM || '99';
const LOGIN_TIMEOUT_MS = parseInt(process.env.LOGIN_TIMEOUT_MS) || 600000; // 10 phút
const CDP_PORT = parseInt(process.env.CDP_PORT) || 9222;
const VNC_PORT = parseInt(process.env.VNC_PORT) || 3000;

// Đảm bảo các thư mục tồn tại và dọn dẹp lock files cũ
function ensureDirs() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });

  // Dọn dẹp Chromium SingletonLock cũ nếu có để tránh lỗi "Failed to create a ProcessSingleton"
  const lockPath = path.join(BROWSER_DATA_DIR, 'SingletonLock');
  if (fs.existsSync(lockPath)) {
    try {
      fs.unlinkSync(lockPath);
      logSession('info', 'Đã dọn dẹp Chromium SingletonLock cũ.');
    } catch (_) {}
  }
}

// ── Logging ──────────────────────────────────────────────────────────

function logSession(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = { info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' }[level] || '📝';
  const line = `[${timestamp}] [${level.toUpperCase()}] ${prefix} ${message}`;

  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }

  try {
    ensureDirs();
    fs.appendFileSync(SESSION_LOG, line + '\n');
  } catch (_) { /* ignore */ }
}

// ── Session Status ──────────────────────────────────────────────────

/**
 * Kiểm tra trạng thái session Facebook.
 * @returns {{ status: 'valid'|'expired'|'missing'|'corrupted', detail: string, cUser?: string, expiresAt?: string }}
 */
function checkSessionStatus() {
  ensureDirs();

  if (!fs.existsSync(SESSION_FILE)) {
    return { status: 'missing', detail: 'File fb_session.json không tồn tại.' };
  }

  let sessionData;
  try {
    sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (e) {
    return { status: 'corrupted', detail: 'File fb_session.json bị lỗi JSON: ' + e.message };
  }

  if (!sessionData.cookies || !Array.isArray(sessionData.cookies)) {
    return { status: 'corrupted', detail: 'File session không có trường cookies.' };
  }

  const cUserCookie = sessionData.cookies.find(c => c.name === 'c_user');
  if (!cUserCookie) {
    return { status: 'expired', detail: 'Không tìm thấy cookie c_user (chưa đăng nhập).' };
  }

  const nowUnix = Date.now() / 1000;
  if (cUserCookie.expires && cUserCookie.expires < nowUnix) {
    const expiredAt = new Date(cUserCookie.expires * 1000).toISOString();
    return { status: 'expired', detail: `Cookie c_user đã hết hạn vào ${expiredAt}.`, cUser: cUserCookie.value, expiresAt: expiredAt };
  }

  const xsCookie = sessionData.cookies.find(c => c.name === 'xs');
  if (!xsCookie) {
    return { status: 'expired', detail: 'Không tìm thấy cookie xs (session token).' };
  }
  if (xsCookie.expires && xsCookie.expires < nowUnix) {
    const expiredAt = new Date(xsCookie.expires * 1000).toISOString();
    return { status: 'expired', detail: `Cookie xs đã hết hạn vào ${expiredAt}.`, cUser: cUserCookie.value, expiresAt: expiredAt };
  }

  const expiresAt = new Date(cUserCookie.expires * 1000).toISOString();
  return { status: 'valid', detail: `Session hợp lệ. Hết hạn: ${expiresAt}`, cUser: cUserCookie.value, expiresAt };
}

// ── Save Session ────────────────────────────────────────────────────

/**
 * Lưu storageState từ Playwright context vào file.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<boolean>}
 */
async function saveSession(context) {
  ensureDirs();
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.copyFileSync(SESSION_FILE, SESSION_FILE + '.bak');
    }
    await context.storageState({ path: SESSION_FILE });
    logSession('success', 'Session saved to ' + SESSION_FILE);

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

/**
 * Trả về đường dẫn session file nếu session hợp lệ, null nếu không.
 * @returns {string|null}
 */
function getValidSessionPath() {
  const status = checkSessionStatus();
  return status.status === 'valid' ? SESSION_FILE : null;
}

// ── Detect Login on Page ────────────────────────────────────────────

/**
 * Kiểm tra trang hiện tại có phải trang login / checkpoint không.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isLoginPage(page) {
  try {
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) return true;

    const loginFormExists = await page.$('form[id="login_form"]').catch(() => null) !== null;
    if (loginFormExists) return true;

    const hasNavigation = await page.locator('div[role="navigation"]').count().catch(() => 0) > 0;
    if (!hasNavigation) {
      await page.waitForTimeout(3000);
      const retry = await page.locator('div[role="navigation"]').count().catch(() => 0) > 0;
      if (!retry) return true;
    }
    return false;
  } catch (e) {
    // If page closes or context destroys during check, return true to force a login/retry
    return true;
  }
}

/**
 * Đợi user login thủ công trên browser.
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForManualLogin(page, timeoutMs = 300000) {
  logSession('info', `Đợi user login thủ công (timeout: ${timeoutMs / 1000}s)...`);
  try {
    await page.waitForSelector('div[role="navigation"]', { timeout: timeoutMs });
    logSession('success', 'Phát hiện đăng nhập thành công.');
    return true;
  } catch (e) {
    logSession('error', 'Quá thời gian chờ đăng nhập: ' + e.message);
    return false;
  }
}

// ── Xvfb helpers ────────────────────────────────────────────────────

function isXvfbRunning(displayNum) {
  try {
    const r = execSync(`ps aux | grep "Xvfb :${displayNum}" | grep -v grep`, { stdio: 'pipe' }).toString();
    return r.trim().length > 0;
  } catch (_) { return false; }
}

function startXvfb(displayNum) {
  if (isXvfbRunning(displayNum)) {
    logSession('info', `Xvfb đã chạy trên :${displayNum}`);
    return null;
  }
  logSession('info', `Khởi động Xvfb trên :${displayNum}...`);
  const proc = spawn('Xvfb', [`:${displayNum}`, '-screen', '0', '1280x720x24'], {
    stdio: 'ignore', detached: true
  });
  proc.unref();
  execSync('sleep 1');
  logSession('success', `Xvfb started on :${displayNum}`);
  return proc;
}

function getServerIP() {
  try {
    const result = execSync("hostname -I 2>/dev/null | awk '{print $1}'", { stdio: 'pipe' }).toString().trim();
    return result || 'localhost';
  } catch (_) { return 'localhost'; }
}

// ── Remote Login Flow ───────────────────────────────────────────────

/**
 * Khởi động browser headful trên server với persistent profile,
 * mở Facebook, cho user login từ xa qua CDP remote debug.
 * Sau khi login xong, lưu session về fb_session.json.
 *
 * @param {object} opts
 * @param {boolean} opts.force - Bắt buộc mở browser kể cả session còn valid
 * @returns {Promise<{success: boolean, url?: string, status?: object}>}
 */
async function startRemoteLoginSession(opts = {}) {
  // Dọn dẹp các tiến trình Chromium cũ đang chạy ngầm hoặc chiếm dụng port/profile
  try {
    if (process.platform === 'linux') {
      execSync(`fuser -k ${CDP_PORT}/tcp 2>/dev/null || true`, { stdio: 'ignore' });
      execSync(`pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch (_) {}

  ensureDirs();

  // Kiểm tra session hiện tại
  if (opts.force) {
    logSession('info', 'Bắt buộc login lại (--force). Đang xóa cache trình duyệt và session cũ...');
    try {
      if (fs.existsSync(SESSION_FILE)) {
        fs.rmSync(SESSION_FILE, { force: true });
      }
      if (fs.existsSync(BROWSER_DATA_DIR)) {
        fs.rmSync(BROWSER_DATA_DIR, { recursive: true, force: true });
      }
      logSession('success', 'Đã xóa sạch cache trình duyệt và session cũ.');
    } catch (e) {
      logSession('warn', 'Không thể xóa sạch hoàn toàn cache: ' + e.message);
    }
    ensureDirs();
  } else {
    const status = checkSessionStatus();
    if (status.status === 'valid') {
      logSession('info', 'Session vẫn valid, không cần login lại.');
      return { success: true, status };
    }
    logSession('warn', `Session cần renew: ${status.detail}`);
  }

  // Xác định chạy headless hay headful:
  // - Mặc định chạy headless trên VPS (khi process.env.ENV !== 'local') để tránh lỗi thiếu Xvfb/DISPLAY.
  // - Chạy headful nếu process.env.ENV === 'local' hoặc khi explicitly cấu hình HEADLESS=false.
  const isHeadless = process.env.HEADLESS === 'true' || (process.env.ENV !== 'local' && process.env.HEADLESS !== 'false');
  const startedProcesses = [];

  // Setup display (chỉ cần nếu chạy headful)
  if (!isHeadless) {
    let hasXvfb = false;
    try { execSync('which Xvfb', { stdio: 'pipe' }); hasXvfb = true; } catch (_) {}

    const hasDisplay = !!process.env.DISPLAY;

    if (!hasDisplay && hasXvfb) {
      const xvfbProc = startXvfb(DISPLAY_NUM);
      if (xvfbProc) startedProcesses.push(xvfbProc);
      process.env.DISPLAY = `:${DISPLAY_NUM}`;
    } else if (!hasDisplay && !hasXvfb) {
      logSession('error', 'Chạy headful nhưng không có DISPLAY và Xvfb. Hãy cài: sudo apt-get install -y xvfb hoặc cấu hình chạy headless.');
      return { success: false };
    }
  }

  // Launch persistent context (dùng browser-data/)
  logSession('info', `Khởi động Chromium persistent context (${isHeadless ? 'headless' : 'headful'}, dùng browser-data/)...`);

  let context;
  try {
    context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      headless: isHeadless,
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--window-size=1280,720',
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-debugging-address=0.0.0.0'
      ]
    });
  } catch (e) {
    logSession('error', 'Không thể khởi động Chromium: ' + e.message);
    cleanup(startedProcesses);
    return { success: false };
  }

  const page = context.pages()[0] || await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Mở Facebook
  logSession('info', 'Mở Facebook...');
  await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const serverIP = getServerIP();
  const cdpUrl = `http://${serverIP}:${CDP_PORT}`;
  let vncUrl = process.env.VNC_PUBLIC_URL || `http://${serverIP}:${VNC_PORT}`;
  if (!vncUrl.startsWith('http://') && !vncUrl.startsWith('https://')) {
    vncUrl = `http://${vncUrl}`;
  }

  const needLogin = await isLoginPage(page);

  if (!needLogin) {
    logSession('success', 'Đã đăng nhập sẵn trong persistent profile!');
    await saveSession(context);
    await context.close();
    cleanup(startedProcesses);
    const finalStatus = checkSessionStatus();
    if (opts.statusFilePath) {
      writeDaemonStatus(opts.statusFilePath, {
        state: 'already_logged_in',
        message: 'Đã đăng nhập sẵn trong persistent profile.',
        session: finalStatus
      });
    }
    return { success: true, status: finalStatus };
  }

  // Khởi chạy Web VNC Server
  const vncServer = startVncServer(page, VNC_PORT);

  // Ghi status file cho launcher biết VNC đã sẵn sàng
  if (opts.statusFilePath) {
    writeDaemonStatus(opts.statusFilePath, {
      state: 'waiting_login',
      vnc_url: vncUrl,
      pid: process.pid,
      started_at: new Date().toISOString()
    });
  }

  // Trả về URL cho admin kết nối (log ra stderr/console)
  console.error('');
  console.error('═'.repeat(64));
  console.error('🖥️  BROWSER ĐÃ MỞ TRÊN SERVER — CẦN LOGIN FACEBOOK');
  console.error('═'.repeat(64));
  console.error('');
  console.error('  Mở đường dẫn sau trên trình duyệt để đăng nhập thủ công:');
  console.error('');
  console.error(`  👉  ${vncUrl}`);
  console.error('');
  console.error('  Bước 1: Mở link trên, bạn sẽ thấy giao diện của trình duyệt');
  console.error('  Bước 2: Click vào ô Username/Password và sử dụng nút "Gửi Text" để nhập');
  console.error('  Bước 3: Bấm Enter hoặc click nút Đăng nhập để vào Facebook');
  console.error('  Bước 4: Script tự phát hiện login và lưu session');
  console.error(`  ⏳ Timeout: ${LOGIN_TIMEOUT_MS / 60000} phút`);
  console.error('');
  console.error('═'.repeat(64));

  const loginResult = { success: false, url: vncUrl };

  // Đợi login
  const loginSuccess = await waitForManualLogin(page, LOGIN_TIMEOUT_MS);

  if (loginSuccess) {
    await saveSession(context);
    const finalStatus = checkSessionStatus();
    loginResult.success = true;
    loginResult.status = finalStatus;

    console.log('');
    console.log('═'.repeat(64));
    console.log('✅ SESSION ĐÃ LƯU THÀNH CÔNG!');
    console.log(`   User:    ${finalStatus.cUser || 'N/A'}`);
    console.log(`   Hết hạn: ${finalStatus.expiresAt || 'N/A'}`);
    console.log(`   File:    ${SESSION_FILE}`);
    console.log('═'.repeat(64));
  } else {
    logSession('error', 'Login thất bại — quá thời gian chờ.');
    if (opts.statusFilePath) {
      writeDaemonStatus(opts.statusFilePath, {
        state: 'error',
        message: 'Login thất bại — quá thời gian chờ.'
      });
    }
  }

  vncServer.close();
  await context.close();
  cleanup(startedProcesses);
  return loginResult;
}

function cleanup(processes) {
  for (const proc of processes) {
    if (proc && proc.pid) {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {}
    }
  }
}

// ── Daemon Helpers ──────────────────────────────────────────────────

/**
 * Ghi status file cho daemon coordination.
 * @param {string} filePath
 * @param {object} data
 */
function writeDaemonStatus(filePath, data) {
  try {
    ensureDirs();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    logSession('error', 'Không thể ghi status file: ' + e.message);
  }
}

/**
 * Đọc status file. Trả về null nếu không tồn tại.
 * @param {string} filePath
 * @returns {object|null}
 */
function readDaemonStatus(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Kiểm tra daemon có đang chạy không (dựa trên PID file).
 * @returns {boolean}
 */
function isDaemonAlive() {
  try {
    if (!fs.existsSync(DAEMON_PID_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(DAEMON_PID_FILE, 'utf-8'));
    // Kiểm tra process còn sống không
    process.kill(data.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dọn dẹp các file daemon cũ.
 */
function cleanupDaemonFiles() {
  try { fs.unlinkSync(DAEMON_PID_FILE); } catch {}
  try { fs.unlinkSync(DAEMON_STATUS_FILE); } catch {}
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  WORKSPACE_ROOT, SESSION_DIR, SESSION_FILE, BROWSER_DATA_DIR, DEBUG_DIR,
  DAEMON_PID_FILE, DAEMON_STATUS_FILE,
  CDP_PORT, LOGIN_TIMEOUT_MS,
  ensureDirs, logSession,
  checkSessionStatus, saveSession, getValidSessionPath,
  isLoginPage, waitForManualLogin,
  startRemoteLoginSession, getServerIP,
  writeDaemonStatus, readDaemonStatus, isDaemonAlive, cleanupDaemonFiles,
};
