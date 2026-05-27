#!/usr/bin/env node

/**
 * session_generator.js
 *
 * Script để admin/user login Facebook thủ công trên server.
 * 
 * Hỗ trợ 2 chế độ:
 * 1. Local (ENV=local):  Mở Chromium có giao diện trực tiếp
 * 2. Server (mặc định):  Mở Chromium headful trong Xvfb, kết hợp VNC để user nhìn/điều khiển từ xa
 *
 * Sau khi login xong:
 * - Lưu session vào .openclaw/fb_session.json (storageState format)
 * - Đồng bộ cookies vào browser-data/ (persistent profile cho facebook_discovery)
 * - Ghi log vào debug/session.log
 *
 * Cách chạy:
 *   # Trên server (headful với Xvfb + VNC):
 *   node scripts/session_generator.js
 *
 *   # Trên máy local:
 *   ENV=local node scripts/session_generator.js
 *
 *   # Chỉ kiểm tra trạng thái session, không mở browser:
 *   node scripts/session_generator.js --check
 *
 *   # Force renew session (bỏ qua kiểm tra, luôn mở browser):
 *   node scripts/session_generator.js --force
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  WORKSPACE_ROOT,
  SESSION_FILE,
  BROWSER_DATA_DIR,
  DEBUG_DIR,
  ensureDirs,
  logSession,
  checkSessionStatus,
  saveSession,
  isLoginPage,
  waitForManualLogin
} = require('./session_manager');

// ── Config ───────────────────────────────────────────────────────────
const VNC_PORT = process.env.VNC_PORT || 5900;
const NOVNC_PORT = process.env.NOVNC_PORT || 6080;
const DISPLAY_NUM = process.env.DISPLAY_NUM || '99';
const DISPLAY = `:${DISPLAY_NUM}`;
const LOGIN_TIMEOUT_MS = parseInt(process.env.LOGIN_TIMEOUT_MS) || 600000; // 10 phút

// ── CLI Args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isCheckOnly = args.includes('--check');
const isForceRenew = args.includes('--force');

// ── Helpers ──────────────────────────────────────────────────────────

function isXvfbAvailable() {
  try {
    execSync('which Xvfb', { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

function isVncAvailable() {
  try {
    execSync('which x11vnc', { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

function isNoVncAvailable() {
  try {
    // noVNC thường nằm ở /usr/share/novnc hoặc dùng websockify
    execSync('which websockify', { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

function isDisplayAvailable() {
  return !!process.env.DISPLAY;
}

/**
 * Kiểm tra xem Xvfb đã chạy trên display này chưa.
 */
function isXvfbRunning(displayNum) {
  try {
    const result = execSync(`ps aux | grep "Xvfb :${displayNum}" | grep -v grep`, { stdio: 'pipe' }).toString();
    return result.trim().length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Khởi động Xvfb nếu chưa chạy.
 */
function startXvfb(displayNum) {
  if (isXvfbRunning(displayNum)) {
    logSession('info', `Xvfb đã đang chạy trên :${displayNum}`);
    return null;
  }

  logSession('info', `Khởi động Xvfb trên :${displayNum}...`);
  const xvfb = spawn('Xvfb', [`:${displayNum}`, '-screen', '0', '1280x720x24'], {
    stdio: 'ignore',
    detached: true
  });
  xvfb.unref();

  // Đợi Xvfb sẵn sàng
  execSync('sleep 1');

  logSession('success', `Xvfb đã khởi động trên :${displayNum}`);
  return xvfb;
}

/**
 * Khởi động x11vnc để user có thể VNC vào xem/điều khiển browser.
 */
function startVnc(displayNum, port) {
  logSession('info', `Khởi động x11vnc trên port ${port}...`);

  try {
    // Kill x11vnc cũ nếu có
    execSync(`pkill -f "x11vnc.*:${displayNum}" || true`, { stdio: 'pipe' });
  } catch (_) { /* ignore */ }

  const vnc = spawn('x11vnc', [
    '-display', `:${displayNum}`,
    '-rfbport', String(port),
    '-nopw',
    '-forever',
    '-shared',
    '-noxdamage'
  ], {
    stdio: 'ignore',
    detached: true
  });
  vnc.unref();

  execSync('sleep 1');

  logSession('success', `x11vnc đã khởi động. Kết nối VNC: vnc://<server_ip>:${port}`);
  return vnc;
}

/**
 * Khởi động noVNC (websockify) để user dùng browser truy cập VNC.
 */
function startNoVnc(vncPort, webPort) {
  logSession('info', `Khởi động noVNC (websockify) trên port ${webPort}...`);

  try {
    execSync(`pkill -f "websockify.*${webPort}" || true`, { stdio: 'pipe' });
  } catch (_) { /* ignore */ }

  const novnc = spawn('websockify', [
    '--web', '/usr/share/novnc',
    String(webPort),
    `localhost:${vncPort}`
  ], {
    stdio: 'ignore',
    detached: true
  });
  novnc.unref();

  execSync('sleep 1');

  logSession('success', `noVNC đã khởi động. Truy cập: http://<server_ip>:${webPort}/vnc.html`);
  return novnc;
}

/**
 * Cleanup: tắt Xvfb, VNC nếu script đã start.
 */
function cleanup(processes) {
  for (const proc of processes) {
    if (proc && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch (_) { /* ignore */ }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  ensureDirs();

  // ─── Check Only Mode ──────────────────────────────────────────────
  if (isCheckOnly) {
    const status = checkSessionStatus();
    console.log('\n📋 Trạng thái Session Facebook:');
    console.log('─'.repeat(50));
    console.log(`  Status:  ${status.status}`);
    console.log(`  Detail:  ${status.detail}`);
    if (status.cUser) console.log(`  User ID: ${status.cUser}`);
    if (status.expiresAt) console.log(`  Hết hạn: ${status.expiresAt}`);
    console.log('─'.repeat(50));
    process.exit(status.status === 'valid' ? 0 : 1);
  }

  // ─── Check nếu session vẫn còn valid và không force ────────────────
  if (!isForceRenew) {
    const status = checkSessionStatus();
    if (status.status === 'valid') {
      console.log('\n✅ Session Facebook vẫn còn hợp lệ.');
      console.log(`  User ID: ${status.cUser}`);
      console.log(`  Hết hạn: ${status.expiresAt}`);
      console.log('\n💡 Dùng --force để bắt buộc login lại.');
      process.exit(0);
    }
    console.log(`\n⚠️  Session cần được renew: ${status.detail}`);
  } else {
    console.log('\n🔄 Force renew session...');
  }

  // ─── Xác định chế độ chạy ─────────────────────────────────────────
  const isLocal = process.env.ENV === 'local';
  const hasDisplay = isDisplayAvailable();
  const hasXvfb = isXvfbAvailable();
  const hasVnc = isVncAvailable();
  const hasNoVnc = isNoVncAvailable();

  let useHeadless = false;
  let displayEnv = process.env.DISPLAY;
  const startedProcesses = [];

  console.log('\n🔍 Kiểm tra môi trường:');
  console.log(`  ENV=${process.env.ENV || '(not set)'}`);
  console.log(`  DISPLAY=${displayEnv || '(not set)'}`);
  console.log(`  Xvfb:     ${hasXvfb ? '✅' : '❌'}`);
  console.log(`  x11vnc:   ${hasVnc ? '✅' : '❌'}`);
  console.log(`  noVNC:    ${hasNoVnc ? '✅' : '❌'}`);

  if (isLocal && hasDisplay) {
    // Local: dùng display hiện có (GUI desktop)
    logSession('info', 'Chế độ Local — mở Chromium trên display hiện có.');
    useHeadless = false;
  } else if (hasXvfb) {
    // Server: dùng Xvfb + VNC
    logSession('info', 'Chế độ Server — dùng Xvfb virtual display.');

    const xvfbProc = startXvfb(DISPLAY_NUM);
    if (xvfbProc) startedProcesses.push(xvfbProc);
    displayEnv = DISPLAY;
    process.env.DISPLAY = DISPLAY;
    useHeadless = false;

    if (hasVnc) {
      const vncProc = startVnc(DISPLAY_NUM, VNC_PORT);
      if (vncProc) startedProcesses.push(vncProc);
    }

    if (hasNoVnc) {
      startNoVnc(VNC_PORT, NOVNC_PORT);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('🖥️  HƯỚNG DẪN KẾT NỐI ĐỂ LOGIN FACEBOOK:');
    console.log('═'.repeat(60));
    if (hasVnc) {
      console.log(`  VNC Client:   vnc://<server_ip>:${VNC_PORT}`);
    }
    if (hasNoVnc) {
      console.log(`  Web Browser:  http://<server_ip>:${NOVNC_PORT}/vnc.html`);
    }
    console.log('═'.repeat(60));
    console.log('');
  } else if (hasDisplay) {
    // Có DISPLAY nhưng không có Xvfb (ví dụ: SSH -X)
    logSession('info', 'Dùng DISPLAY hiện có (SSH -X hoặc tương tự).');
    useHeadless = false;
  } else {
    // Không có gì: fallback headless — user sẽ không login được
    logSession('error', 'Không có display và không có Xvfb. Không thể mở browser để login.');
    console.log('\n❌ Không thể mở browser trên server!');
    console.log('📦 Cài đặt Xvfb và x11vnc:');
    console.log('   sudo apt-get install -y xvfb x11vnc');
    console.log('   (Tuỳ chọn) sudo apt-get install -y novnc websockify');
    console.log('\n💡 Hoặc chạy trên máy local: ENV=local node scripts/session_generator.js');
    process.exit(1);
  }

  // ─── Launch Browser ────────────────────────────────────────────────
  logSession('info', 'Khởi động Chromium...');

  let browser;
  try {
    browser = await chromium.launch({
      headless: useHeadless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  } catch (e) {
    logSession('error', 'Không thể khởi động Chromium: ' + e.message);
    cleanup(startedProcesses);
    process.exit(1);
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh'
  });

  const page = await context.newPage();

  // Anti-detection
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  try {
    // ─── Mở Facebook ──────────────────────────────────────────────────
    console.log('\n🚀 Đang mở Facebook...');
    await page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Chờ page load xong
    await page.waitForTimeout(3000);

    // Kiểm tra đã đăng nhập chưa
    const needLogin = await isLoginPage(page);

    if (!needLogin) {
      console.log('\n✅ Tài khoản đã đăng nhập sẵn!');
    } else {
      console.log('\n' + '═'.repeat(60));
      console.log('👉 HÀNH ĐỘNG CẦN THỰC HIỆN:');
      console.log('   1. Kết nối vào browser (VNC hoặc trực tiếp)');
      console.log('   2. Đăng nhập Facebook');
      console.log('   3. Giải CAPTCHA nếu có');
      console.log(`   4. Script sẽ tự phát hiện khi login thành công`);
      console.log(`   ⏳ Timeout: ${LOGIN_TIMEOUT_MS / 60000} phút`);
      console.log('═'.repeat(60));
      console.log('');

      const loginSuccess = await waitForManualLogin(page, LOGIN_TIMEOUT_MS);

      if (!loginSuccess) {
        logSession('error', 'Login thất bại — quá thời gian chờ.');
        console.log('\n❌ Quá thời gian chờ đăng nhập!');
        console.log('💡 Thử lại: node scripts/session_generator.js --force');
        await browser.close();
        cleanup(startedProcesses);
        process.exit(1);
      }
    }

    // ─── Lưu Session ──────────────────────────────────────────────────
    console.log('\n💾 Đang lưu session...');

    const saved = await saveSession(context);

    if (saved) {
      const status = checkSessionStatus();
      console.log('\n' + '═'.repeat(60));
      console.log('✅ SESSION ĐÃ ĐƯỢC LƯU THÀNH CÔNG!');
      console.log('═'.repeat(60));
      console.log(`  File:    ${SESSION_FILE}`);
      console.log(`  User:    ${status.cUser || 'N/A'}`);
      console.log(`  Hết hạn: ${status.expiresAt || 'N/A'}`);
      console.log('═'.repeat(60));
      console.log('\n📝 Session sẽ được tự động sử dụng bởi:');
      console.log('   - universal_scraper.js');
      console.log('   - universal_scraper_vision.js');
      console.log('\n💡 Kiểm tra session: node scripts/session_generator.js --check');
      console.log('💡 Renew session:    node scripts/session_generator.js --force');
    } else {
      logSession('error', 'Lưu session thất bại!');
      console.log('\n❌ Không thể lưu session!');
      console.log('📂 Kiểm tra quyền ghi tại: ' + SESSION_FILE);
    }

    // ─── Đồng bộ vào persistent browser profile ────────────────────────
    try {
      await syncSessionToPersistentProfile(context);
    } catch (e) {
      logSession('warn', 'Không thể đồng bộ session vào browser-data: ' + e.message);
    }

  } catch (e) {
    logSession('error', 'Lỗi không mong đợi: ' + e.message);
    console.error('\n❌ Lỗi:', e.message);
  } finally {
    await browser.close();
    cleanup(startedProcesses);
    process.exit(0);
  }
}

/**
 * Đồng bộ session cookies vào persistent browser profile (browser-data/).
 * Điều này đảm bảo facebook_discovery.js (dùng launchPersistentContext) cũng có session.
 */
async function syncSessionToPersistentProfile(sourceContext) {
  logSession('info', 'Đồng bộ session vào browser-data/ persistent profile...');

  try {
    const persistentContext = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    // Lấy cookies từ source context
    const cookies = await sourceContext.cookies();

    // Inject cookies vào persistent context
    if (cookies.length > 0) {
      await persistentContext.addCookies(cookies);
      logSession('success', `Đã đồng bộ ${cookies.length} cookies vào browser-data/`);
    }

    await persistentContext.close();
  } catch (e) {
    logSession('warn', 'Đồng bộ persistent profile thất bại: ' + e.message);
  }
}

// ─── Run ──────────────────────────────────────────────────────────────
main();