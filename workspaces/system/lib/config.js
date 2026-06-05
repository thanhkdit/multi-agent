/**
 * Job Queue System - Configuration
 * Central configuration for the job queue, heartbeat, and watchdog system.
 */

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SYSTEM_ROOT = path.resolve(__dirname, '..');

module.exports = {
  PROJECT_ROOT,
  SYSTEM_ROOT,

  // Job directories
  QUEUE_DIR: path.join(SYSTEM_ROOT, 'jobs', 'queue'),
  RUNNING_DIR: path.join(SYSTEM_ROOT, 'jobs', 'running'),
  COMPLETED_DIR: path.join(SYSTEM_ROOT, 'jobs', 'completed'),
  FAILED_DIR: path.join(SYSTEM_ROOT, 'jobs', 'failed'),
  STALE_DIR: path.join(SYSTEM_ROOT, 'jobs', 'stale'),
  LOCKS_DIR: path.join(SYSTEM_ROOT, 'jobs', 'locks'),

  // Other system directories
  LOGS_DIR: path.join(SYSTEM_ROOT, 'logs'),
  STATE_DIR: path.join(SYSTEM_ROOT, 'state'),
  RESULT_DIR: path.join(PROJECT_ROOT, 'workspaces', 'shared', 'result'),
  JOBS_RESULT_DIR: path.join(PROJECT_ROOT, 'workspaces', 'shared', 'result', '_jobs'),

  // Timeout per task type (seconds)
  TASK_TIMEOUTS: {
    facebook_feed: 600,
    facebook_ads_library: 600,
    facebook_session: 60,
    tiktok_analytic: 180,
    video_transcript: 300,
    default: 600,
  },

  // Heartbeat
  HEARTBEAT_INTERVAL_MS: 10_000,   // Worker updates heartbeat every 10s
  HEARTBEAT_TIMEOUT_MS: 60_000,    // If no heartbeat for 60s → stale

  // Lock
  LOCK_TTL_MS: 30_000,             // Lock expires after 30s

  // Retry
  MAX_ATTEMPTS: 3,

  // Polling
  POLL_INTERVAL_MS: 5_000,         // Check job status every 5s
  POLL_MAX_WAIT_MS: 660_000,       // Max 11 minutes polling

  // Task registry: maps task_type → script execution info
  TASK_REGISTRY: {
    facebook_feed: {
      script: 'scripts/facebook/facebook_feed.js',
      cwd: path.join(PROJECT_ROOT, 'workspaces', 'agent-scraper'),
      buildArgs: (params) => ['node', 'scripts/facebook/facebook_feed.js', ...params],
    },
    facebook_ads_library: {
      script: 'scripts/facebook/facebook_ads_library.js',
      cwd: path.join(PROJECT_ROOT, 'workspaces', 'agent-scraper'),
      buildArgs: (params) => ['node', 'scripts/facebook/facebook_ads_library.js', ...params],
    },
    tiktok_analytic: {
      script: 'scripts/tiktok/analytic.js',
      cwd: path.join(PROJECT_ROOT, 'workspaces', 'agent-scraper'),
      buildArgs: (params) => ['node', 'scripts/tiktok/analytic.js', ...params],
    },
    video_transcript: {
      script: 'scripts/video_transcript.py',
      cwd: path.join(PROJECT_ROOT, 'workspaces', 'agent-scraper'),
      buildArgs: (params) => ['python3', 'scripts/video_transcript.py', ...params],
    },
    facebook_session: {
      script: 'scripts/facebook/session_generator.js',
      cwd: path.join(PROJECT_ROOT, 'workspaces', 'agent-scraper'),
      buildArgs: (params) => ['node', 'scripts/facebook/session_generator.js', ...params],
    },
  },
};
