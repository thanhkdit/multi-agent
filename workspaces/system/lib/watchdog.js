#!/usr/bin/env node
/**
 * Watchdog
 * 
 * Scans running jobs for stale heartbeats and handles them:
 * - If heartbeat_at is older than HEARTBEAT_TIMEOUT_MS → job is stale
 * - If attempts remain → move back to queue for retry
 * - If max attempts reached → move to failed
 * 
 * Also cleans up expired lock files.
 * 
 * Usage:
 *   node watchdog.js               # Single scan
 *   node watchdog.js --daemon       # Run continuously (every 15s)
 *   node watchdog.js --interval 30  # Custom interval in seconds
 */

const fs = require('fs');
const path = require('path');
const jobManager = require('./job-manager');
const config = require('./config');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [watchdog] ${msg}`;
  console.log(line);

  try {
    ensureDir(config.LOGS_DIR);
    fs.appendFileSync(
      path.join(config.LOGS_DIR, 'watchdog.log'),
      line + '\n'
    );
  } catch {}
}

/**
 * Scan running jobs and mark stale ones.
 */
function scanStaleJobs() {
  let staleCount = 0;

  try {
    const files = fs.readdirSync(config.RUNNING_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const filePath = path.join(config.RUNNING_DIR, file);
      let job;

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        job = JSON.parse(raw);
      } catch {
        continue;
      }

      if (!job || !job.heartbeat_at) continue;

      const heartbeatAge = Date.now() - new Date(job.heartbeat_at).getTime();

      if (heartbeatAge > config.HEARTBEAT_TIMEOUT_MS) {
        log(`Stale job detected: ${job.job_id} (type=${job.task_type}, heartbeat age=${Math.round(heartbeatAge / 1000)}s, attempt=${job.attempt}/${job.max_attempts})`);

        try {
          jobManager.markStale(job.job_id);
          staleCount++;

          if (job.attempt < job.max_attempts) {
            log(`  → Moved back to queue for retry (attempt ${job.attempt + 1}/${job.max_attempts})`);
          } else {
            log(`  → Max attempts exceeded, moved to failed`);
          }
        } catch (err) {
          log(`  → Error marking stale: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log(`Error scanning: ${err.message}`);
  }

  return staleCount;
}

/**
 * Clean up expired lock files.
 */
function cleanExpiredLocks() {
  let cleaned = 0;

  try {
    const files = fs.readdirSync(config.LOCKS_DIR).filter(f => f.endsWith('.lock'));

    for (const file of files) {
      const filePath = path.join(config.LOCKS_DIR, file);

      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const lockData = JSON.parse(raw);
        const age = Date.now() - new Date(lockData.acquired_at).getTime();

        if (age > config.LOCK_TTL_MS) {
          fs.unlinkSync(filePath);
          cleaned++;
          log(`Cleaned expired lock: ${file} (age=${Math.round(age / 1000)}s)`);
        }
      } catch {
        // Corrupt lock file — remove it
        try {
          fs.unlinkSync(filePath);
          cleaned++;
        } catch {}
      }
    }
  } catch {}

  return cleaned;
}

/**
 * Run a single watchdog scan.
 */
function scan() {
  const stale = scanStaleJobs();
  const locks = cleanExpiredLocks();

  if (stale > 0 || locks > 0) {
    log(`Scan complete: ${stale} stale job(s) handled, ${locks} expired lock(s) cleaned`);
  }

  return { stale, locks };
}

// ─── Main ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isDaemon = args.includes('--daemon');
const intervalIdx = args.indexOf('--interval');
const intervalSec = intervalIdx !== -1 ? parseInt(args[intervalIdx + 1], 10) : 15;

if (isDaemon) {
  log(`Watchdog daemon started (interval=${intervalSec}s)`);

  // Run immediately, then on interval
  scan();
  setInterval(scan, intervalSec * 1000);
} else {
  // Single scan
  const result = scan();
  console.log(JSON.stringify({
    status: 'ok',
    stale_handled: result.stale,
    locks_cleaned: result.locks,
  }));
}
