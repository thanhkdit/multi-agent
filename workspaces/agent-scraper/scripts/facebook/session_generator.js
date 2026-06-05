#!/usr/bin/env node

/**
 * session_generator.js
 *
 * Script quản lý session Facebook — 3 chế độ hoạt động:
 *
 * 1. --check    : Kiểm tra trạng thái session, trả JSON, thoát ngay.
 * 2. --force    : Launcher — spawn daemon nền, đợi VNC sẵn sàng, trả JSON có link.
 * 3. --daemon   : (Internal) Mở browser, start VNC, đợi login, lưu session.
 *
 * Cách chạy:
 *   node scripts/facebook/session_generator.js --check    # Kiểm tra session
 *   node scripts/facebook/session_generator.js --force    # Tạo session mới (trả link VNC ngay)
 *   node scripts/facebook/session_generator.js            # Renew nếu hết hạn (trả link VNC ngay)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const fs = require('fs');
const { spawn } = require('child_process');

const {
  checkSessionStatus,
  startRemoteLoginSession,
  ensureDirs,
  readDaemonStatus,
  isDaemonAlive,
  cleanupDaemonFiles,
  DAEMON_PID_FILE, DAEMON_STATUS_FILE,
  WORKSPACE_ROOT, SESSION_DIR, DEBUG_DIR,
} = require('./session_manager');

const args = process.argv.slice(2);
const isCheckOnly = args.includes('--check');
const isForce = args.includes('--force');
const isDaemon = args.includes('--daemon');

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function output(data) {
  console.log(JSON.stringify(data));
}

// ── Mode 1: --check ─────────────────────────────────────────────────

function handleCheck() {
  const status = checkSessionStatus();
  output(status);
  process.exit(0);
}

// ── Mode 2: Launcher (default / --force) ────────────────────────────
//    Spawn daemon nền → đợi status file → trả link VNC → exit 0

async function handleLaunch() {
  ensureDirs();

  // Nếu không force, kiểm tra session trước
  if (!isForce) {
    const status = checkSessionStatus();
    if (status.status === 'valid') {
      output({
        action: 'none',
        message: 'Session vẫn còn hạn, không cần login lại.',
        session: status
      });
      process.exit(0);
    }
  }

  // Kiểm tra daemon đang chạy chưa
  if (isDaemonAlive()) {
    const existing = readDaemonStatus(DAEMON_STATUS_FILE);
    if (existing && existing.vnc_url) {
      output({
        action: 'login_required',
        message: 'Browser đã mở sẵn. Hãy truy cập link bên dưới để đăng nhập.',
        vnc_url: existing.vnc_url,
        timeout_minutes: 10,
        note: 'Sau khi đăng nhập xong, session sẽ được lưu tự động.'
      });
      process.exit(0);
    }
  }

  // Dọn file daemon cũ
  cleanupDaemonFiles();

  // Spawn daemon process (detached, chạy nền)
  const daemonArgs = ['--force', '--daemon'];
  const logFile = path.join(DEBUG_DIR, 'session_daemon.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const outFd = fs.openSync(logFile, 'a');
  const errFd = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [__filename, ...daemonArgs], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env },
    stdio: ['ignore', outFd, errFd],
    detached: true,
  });
  child.unref();

  // Poll status file (tối đa 30 giây)
  const maxWait = 30000;
  const pollInterval = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    await sleep(pollInterval);

    const status = readDaemonStatus(DAEMON_STATUS_FILE);
    if (!status) continue;

    if (status.state === 'waiting_login' && status.vnc_url) {
      output({
        action: 'login_required',
        message: 'Browser đã mở. Hãy truy cập link bên dưới để đăng nhập Facebook.',
        vnc_url: status.vnc_url,
        timeout_minutes: 10,
        note: 'Sau khi đăng nhập xong, session sẽ được lưu tự động.'
      });
      process.exit(0);
    }

    if (status.state === 'already_logged_in') {
      output({
        action: 'none',
        message: status.message || 'Đã đăng nhập sẵn trong persistent profile.',
        session: status.session || {}
      });
      process.exit(0);
    }

    if (status.state === 'error') {
      output({
        action: 'error',
        message: status.message || 'Daemon gặp lỗi.'
      });
      process.exit(1);
    }
  }

  // Timeout chờ daemon
  output({
    action: 'error',
    message: 'Timeout: Không thể khởi động browser trong 30 giây.'
  });
  process.exit(1);
}

// ── Mode 3: --daemon (internal, spawned by launcher) ────────────────
//    Mở browser, start VNC, đợi login, lưu session, cleanup

async function handleDaemon() {
  ensureDirs();

  // Ghi PID file (singleton lock)
  fs.writeFileSync(DAEMON_PID_FILE, JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString()
  }));

  try {
    const result = await startRemoteLoginSession({
      force: isForce,
      statusFilePath: DAEMON_STATUS_FILE
    });

    if (result.success) {
      console.error('✅ Session daemon hoàn tất.');
    } else {
      console.error('❌ Session daemon thất bại.');
    }
  } catch (err) {
    console.error('❌ Daemon error:', err.message);
    // Ghi lỗi vào status file
    try {
      fs.writeFileSync(DAEMON_STATUS_FILE, JSON.stringify({
        state: 'error',
        message: err.message
      }));
    } catch {}
  } finally {
    // Cleanup PID file
    try { fs.unlinkSync(DAEMON_PID_FILE); } catch {}
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  if (isCheckOnly) {
    return handleCheck();
  }
  if (isDaemon) {
    return handleDaemon();
  }
  return handleLaunch();
}

main().catch(err => {
  output({ action: 'error', message: err.message });
  process.exit(1);
});