/**
 * Job Manager - Core library
 * 
 * Provides atomic, file-based job lifecycle management:
 * createJob → claimJob → updateHeartbeat → completeJob / failJob
 * Plus: acquireLock, releaseLock, markStale, getJob, listJobs
 * 
 * All writes are atomic (write tmp → rename). All moves are atomic (fs.renameSync).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// ─── Helpers ────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function generateJobId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}-${rand}`;
}

function now() {
  return new Date().toISOString();
}

/**
 * Atomic write: write to a temp file then rename.
 * Guarantees readers never see a partial file.
 */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read and parse a JSON file. Returns null if file doesn't exist or is invalid.
 */
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Atomic move: rename file from one directory to another.
 * Only works on the same filesystem (which it is — all under workspaces/).
 */
function atomicMove(srcPath, destDir) {
  ensureDir(destDir);
  const filename = path.basename(srcPath);
  const destPath = path.join(destDir, filename);
  fs.renameSync(srcPath, destPath);
  return destPath;
}

// ─── Lock Management ────────────────────────────────────────────────

/**
 * Acquire a named lock. Returns true if acquired, false if already held.
 * Lock files contain a timestamp for TTL-based expiry.
 */
function acquireLock(lockName) {
  ensureDir(config.LOCKS_DIR);
  const lockPath = path.join(config.LOCKS_DIR, `${lockName}.lock`);

  // Check if lock exists and is still valid
  if (fs.existsSync(lockPath)) {
    const lockData = readJson(lockPath);
    if (lockData && lockData.acquired_at) {
      const age = Date.now() - new Date(lockData.acquired_at).getTime();
      if (age < config.LOCK_TTL_MS) {
        return false; // Lock is still held
      }
      // Lock expired — remove it
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  // Try to acquire by atomic write
  try {
    // Use O_EXCL flag to ensure atomicity
    const fd = fs.openSync(lockPath, 'wx');
    const lockData = JSON.stringify({
      acquired_at: now(),
      pid: process.pid,
      lock_name: lockName,
    });
    fs.writeSync(fd, lockData);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      return false; // Someone else got it first
    }
    throw err;
  }
}

/**
 * Release a named lock.
 */
function releaseLock(lockName) {
  const lockPath = path.join(config.LOCKS_DIR, `${lockName}.lock`);
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

// ─── Job Lifecycle ──────────────────────────────────────────────────

/**
 * Create a new job and place it in the queue.
 * @param {string} taskType - One of the keys in TASK_REGISTRY
 * @param {object} input - Task-specific input (params array, etc.)
 * @returns {object} The created job object
 */
function createJob(taskType, input = {}) {
  const jobId = generateJobId();
  const timeoutSeconds = config.TASK_TIMEOUTS[taskType] || config.TASK_TIMEOUTS.default;

  const job = {
    job_id: jobId,
    task_type: taskType,
    status: 'queued',
    owner_agent: '',
    created_at: now(),
    started_at: '',
    finished_at: '',
    heartbeat_at: '',
    attempt: 0,
    max_attempts: config.MAX_ATTEMPTS,
    timeout_seconds: timeoutSeconds,
    priority: input.priority || 'normal',
    input: input,
    output_path: '',
    error: '',
  };

  const filePath = path.join(config.QUEUE_DIR, `${jobId}.json`);
  atomicWriteJson(filePath, job);
  return job;
}

/**
 * Claim the next available job from the queue (or a specific job by ID).
 * Uses atomic rename as the claim mechanism — only one process can succeed.
 * @param {string} agentName - Name of the agent claiming
 * @param {string} [jobId] - Optional specific job ID to claim
 * @returns {object|null} The claimed job, or null if nothing available
 */
function claimJob(agentName, jobId = null) {
  const lockName = `claim_${agentName}`;
  if (!acquireLock(lockName)) {
    return null; // Another claim in progress
  }

  try {
    let targetFile = null;

    if (jobId) {
      // Claim specific job
      const filePath = path.join(config.QUEUE_DIR, `${jobId}.json`);
      if (fs.existsSync(filePath)) {
        targetFile = filePath;
      }
    } else {
      // Claim oldest job in queue
      const files = fs.readdirSync(config.QUEUE_DIR)
        .filter(f => f.endsWith('.json'))
        .sort(); // Alphabetical ≈ chronological (job IDs start with timestamp)

      if (files.length > 0) {
        targetFile = path.join(config.QUEUE_DIR, files[0]);
      }
    }

    if (!targetFile) return null;

    // Atomic move to running
    const newPath = atomicMove(targetFile, config.RUNNING_DIR);

    // Update job metadata
    const job = readJson(newPath);
    if (!job) return null;

    job.status = 'running';
    job.owner_agent = agentName;
    job.started_at = now();
    job.heartbeat_at = now();
    job.attempt += 1;

    atomicWriteJson(newPath, job);
    return job;
  } finally {
    releaseLock(lockName);
  }
}

/**
 * Update heartbeat timestamp for a running job.
 * @param {string} jobId
 * @returns {boolean} Success
 */
function updateHeartbeat(jobId) {
  const filePath = path.join(config.RUNNING_DIR, `${jobId}.json`);
  const job = readJson(filePath);
  if (!job) return false;

  job.heartbeat_at = now();
  atomicWriteJson(filePath, job);
  return true;
}

/**
 * Mark a job as completed. Moves from running → completed.
 * @param {string} jobId
 * @param {string} outputPath - Path to the result file
 * @returns {object|null} The completed job
 */
function completeJob(jobId, outputPath = '') {
  const filePath = path.join(config.RUNNING_DIR, `${jobId}.json`);
  const job = readJson(filePath);
  if (!job) return null;

  job.status = 'completed';
  job.finished_at = now();
  job.output_path = outputPath;

  atomicWriteJson(filePath, job);
  atomicMove(filePath, config.COMPLETED_DIR);

  return job;
}

/**
 * Mark a job as failed. Moves from running → failed.
 * @param {string} jobId
 * @param {string} errorMessage
 * @returns {object|null} The failed job
 */
function failJob(jobId, errorMessage = '') {
  const filePath = path.join(config.RUNNING_DIR, `${jobId}.json`);
  const job = readJson(filePath);
  if (!job) return null;

  job.status = 'failed';
  job.finished_at = now();
  job.error = errorMessage;

  atomicWriteJson(filePath, job);
  atomicMove(filePath, config.FAILED_DIR);

  return job;
}

/**
 * Mark a running job as stale. If retries remain, moves back to queue.
 * Otherwise moves to failed.
 * @param {string} jobId
 * @returns {object|null} The updated job
 */
function markStale(jobId) {
  const filePath = path.join(config.RUNNING_DIR, `${jobId}.json`);
  const job = readJson(filePath);
  if (!job) return null;

  if (job.attempt < job.max_attempts) {
    // Retry: move back to queue
    job.status = 'queued';
    job.owner_agent = '';
    job.started_at = '';
    job.heartbeat_at = '';
    job.error = `Stale after attempt ${job.attempt} (heartbeat timeout)`;

    atomicWriteJson(filePath, job);
    atomicMove(filePath, config.QUEUE_DIR);
  } else {
    // Max retries exceeded: move to failed
    job.status = 'failed';
    job.finished_at = now();
    job.error = `Max attempts (${job.max_attempts}) exceeded. Last: heartbeat timeout.`;

    atomicWriteJson(filePath, job);
    atomicMove(filePath, config.FAILED_DIR);
  }

  return job;
}

// ─── Query ──────────────────────────────────────────────────────────

/**
 * Get a job by ID. Searches all status directories.
 * @param {string} jobId
 * @returns {object|null}
 */
function getJob(jobId) {
  const filename = `${jobId}.json`;
  const dirs = [
    config.QUEUE_DIR,
    config.RUNNING_DIR,
    config.COMPLETED_DIR,
    config.FAILED_DIR,
    config.STALE_DIR,
  ];

  for (const dir of dirs) {
    const filePath = path.join(dir, filename);
    const job = readJson(filePath);
    if (job) return job;
  }

  return null;
}

/**
 * List all jobs in a given status directory.
 * @param {'queue'|'running'|'completed'|'failed'|'stale'} status
 * @returns {object[]}
 */
function listJobs(status) {
  const dirMap = {
    queue: config.QUEUE_DIR,
    running: config.RUNNING_DIR,
    completed: config.COMPLETED_DIR,
    failed: config.FAILED_DIR,
    stale: config.STALE_DIR,
  };

  const dir = dirMap[status];
  if (!dir) return [];

  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => readJson(path.join(dir, f)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  createJob,
  claimJob,
  updateHeartbeat,
  completeJob,
  failJob,
  markStale,
  acquireLock,
  releaseLock,
  getJob,
  listJobs,
  // Utilities exposed for testing
  atomicWriteJson,
  readJson,
  generateJobId,
};
