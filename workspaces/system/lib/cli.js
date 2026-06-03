#!/usr/bin/env node
/**
 * Job Queue CLI
 * 
 * Used by the orchestrator agent to create jobs, check status, and poll for completion.
 * 
 * Usage:
 *   node cli.js create <task_type> '<json_input>'
 *   node cli.js status <job_id>
 *   node cli.js poll <job_id> [--timeout <seconds>]
 *   node cli.js list [queue|running|completed|failed|stale]
 *   node cli.js run <job_id>          # Claim & execute a job (used internally by worker-run)
 *   node cli.js run-next              # Claim & execute the next queued job
 */

const jobManager = require('./job-manager');
const config = require('./config');
const { spawn } = require('child_process');
const path = require('path');

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function printError(message) {
  printJson({ status: 'error', error: message });
  process.exit(1);
}

// ─── Commands ───────────────────────────────────────────────────────

function cmdCreate(taskType, inputJsonStr) {
  if (!taskType) {
    printError('Missing task_type. Usage: cli.js create <task_type> \'<json_input>\'');
  }

  if (!config.TASK_REGISTRY[taskType]) {
    printError(`Unknown task_type: "${taskType}". Available: ${Object.keys(config.TASK_REGISTRY).join(', ')}`);
  }

  let input = {};
  if (inputJsonStr) {
    try {
      input = JSON.parse(inputJsonStr);
    } catch (err) {
      printError(`Invalid JSON input: ${err.message}`);
    }
  }

  const job = jobManager.createJob(taskType, input);
  printJson({
    status: 'ok',
    message: `Job created in queue`,
    job_id: job.job_id,
    task_type: job.task_type,
    timeout_seconds: job.timeout_seconds,
  });
}

function cmdStatus(jobId) {
  if (!jobId) {
    printError('Missing job_id. Usage: cli.js status <job_id>');
  }

  const job = jobManager.getJob(jobId);
  if (!job) {
    printError(`Job not found: ${jobId}`);
  }

  printJson(job);
}

function cmdPoll(jobId, timeoutSeconds) {
  if (!jobId) {
    printError('Missing job_id. Usage: cli.js poll <job_id> [--timeout <seconds>]');
  }

  const timeout = (timeoutSeconds || config.POLL_MAX_WAIT_MS / 1000) * 1000;
  const interval = config.POLL_INTERVAL_MS;
  const startTime = Date.now();

  const check = () => {
    const job = jobManager.getJob(jobId);

    if (!job) {
      printJson({ status: 'error', error: `Job not found: ${jobId}` });
      process.exit(1);
    }

    if (job.status === 'completed' || job.status === 'failed') {
      printJson(job);
      process.exit(job.status === 'completed' ? 0 : 1);
    }

    const elapsed = Date.now() - startTime;
    if (elapsed >= timeout) {
      printJson({
        ...job,
        poll_result: 'timeout',
        poll_message: `Polling timed out after ${Math.round(elapsed / 1000)}s. Job is still ${job.status}.`,
      });
      process.exit(2);
    }

    // Continue polling
    setTimeout(check, interval);
  };

  check();
}

function cmdList(statusFilter) {
  const validStatuses = ['queue', 'running', 'completed', 'failed', 'stale'];

  if (statusFilter && !validStatuses.includes(statusFilter)) {
    printError(`Invalid status: "${statusFilter}". Valid: ${validStatuses.join(', ')}`);
  }

  if (statusFilter) {
    const jobs = jobManager.listJobs(statusFilter);
    printJson({ status: statusFilter, count: jobs.length, jobs });
  } else {
    // List all
    const result = {};
    for (const s of validStatuses) {
      const jobs = jobManager.listJobs(s);
      result[s] = { count: jobs.length, jobs };
    }
    printJson(result);
  }
}

// ─── Dispatch (All-in-one, blocking) ────────────────────────────────

/**
 * dispatch: Create job → Run worker (as child process) → Return result.
 * Single blocking command. WARNING: This blocks for the entire duration
 * of the script (can be 5-10 minutes). May timeout in platforms with
 * exec timeouts. Prefer dispatch-bg + await-jobs for long-running tasks.
 *
 * Usage: node cli.js dispatch <task_type> '<json_input>'
 */
function cmdDispatch(taskType, inputJsonStr) {
  if (!taskType) {
    printError('Missing task_type. Usage: cli.js dispatch <task_type> \'{"params":[...]}\'');
  }

  if (!config.TASK_REGISTRY[taskType]) {
    printError(`Unknown task_type: "${taskType}". Available: ${Object.keys(config.TASK_REGISTRY).join(', ')}`);
  }

  let input = {};
  if (inputJsonStr) {
    try {
      input = JSON.parse(inputJsonStr);
    } catch (err) {
      printError(`Invalid JSON input: ${err.message}`);
    }
  }

  // 1. Create job
  const job = jobManager.createJob(taskType, input);
  console.error(`[dispatch] Job created: ${job.job_id} (type=${taskType})`);

  // 2. Run worker as child process (NOT background — stays attached)
  const workerPath = path.join(__dirname, 'worker-run.js');
  const child = spawn('node', [workerPath, job.job_id, '--agent', `worker_${job.job_id}`], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let workerStdout = '';
  let workerStderr = '';

  child.stdout.on('data', (data) => {
    workerStderr += data.toString(); // Worker's stdout is its result log
  });

  child.stderr.on('data', (data) => {
    workerStderr += data.toString();
    // Stream worker logs to stderr in real-time
    process.stderr.write(data);
  });

  child.on('close', (code) => {
    // 3. Read the final job state
    const finalJob = jobManager.getJob(job.job_id);

    if (!finalJob) {
      printJson({
        status: 'error',
        job_id: job.job_id,
        error: 'Job not found after worker completed',
        worker_exit_code: code,
      });
      process.exit(1);
      return;
    }

    // 4. Output the final job (includes output_path)
    printJson(finalJob);
    process.exit(finalJob.status === 'completed' ? 0 : 1);
  });

  child.on('error', (err) => {
    printJson({
      status: 'error',
      job_id: job.job_id,
      error: `Failed to start worker: ${err.message}`,
    });
    process.exit(1);
  });
}

// ─── Dispatch Background (Non-blocking) ─────────────────────────────

/**
 * dispatch-bg: Create job → Start worker in detached background → Return immediately.
 * Returns the job_id so the caller can poll for completion with await-jobs.
 *
 * Usage: node cli.js dispatch-bg <task_type> '<json_input>'
 */
function cmdDispatchBg(taskType, inputJsonStr) {
  if (!taskType) {
    printError('Missing task_type. Usage: cli.js dispatch-bg <task_type> \'{"params":[...]}\'');
  }

  if (!config.TASK_REGISTRY[taskType]) {
    printError(`Unknown task_type: "${taskType}". Available: ${Object.keys(config.TASK_REGISTRY).join(', ')}`);
  }

  let input = {};
  if (inputJsonStr) {
    try {
      input = JSON.parse(inputJsonStr);
    } catch (err) {
      printError(`Invalid JSON input: ${err.message}`);
    }
  }

  // 1. Create job
  const job = jobManager.createJob(taskType, input);

  // 2. Start worker DETACHED — process runs independently, cli.js exits immediately
  const workerPath = path.join(__dirname, 'worker-run.js');
  const logDir = config.LOGS_DIR;
  const fs = require('fs');
  fs.mkdirSync(logDir, { recursive: true });
  
  const stdoutLog = path.join(logDir, `worker_${job.job_id}.stdout.log`);
  const stderrLog = path.join(logDir, `worker_${job.job_id}.stderr.log`);
  const outFd = fs.openSync(stdoutLog, 'w');
  const errFd = fs.openSync(stderrLog, 'w');

  const child = spawn('node', [workerPath, job.job_id, '--agent', `worker_${job.job_id}`], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', outFd, errFd],
    detached: true,
  });

  child.unref();

  // 3. Return immediately with job_id
  printJson({
    status: 'dispatched',
    job_id: job.job_id,
    task_type: taskType,
    message: 'Job started in background. Use await-jobs to poll for completion.',
  });
}

// ─── Await Jobs (Multi-job polling with cycle timeout) ──────────────

/**
 * await-jobs: Poll multiple job IDs until all complete or cycle timeout.
 * Designed to fit within platform exec timeouts (default: 120s per cycle).
 * If not all jobs are done within the cycle, returns partial results so
 * the caller can invoke await-jobs again.
 *
 * Usage: node cli.js await-jobs <job_id_1> <job_id_2> ... [--timeout <seconds>]
 */
function cmdAwaitJobs(jobIds, timeoutSeconds) {
  if (!jobIds || jobIds.length === 0) {
    printError('Missing job IDs. Usage: cli.js await-jobs <job_id_1> <job_id_2> ... [--timeout <seconds>]');
  }

  const maxWait = (timeoutSeconds || 90) * 1000;
  const interval = config.POLL_INTERVAL_MS;
  const startTime = Date.now();

  const check = () => {
    const results = {};
    let allDone = true;
    let pendingIds = [];

    for (const id of jobIds) {
      const job = jobManager.getJob(id);
      if (!job) {
        results[id] = { status: 'error', error: `Job not found: ${id}` };
        continue;
      }
      results[id] = {
        status: job.status,
        task_type: job.task_type,
        job_id: job.job_id,
        output_path: job.output_path || '',
        error: job.error || '',
      };
      if (job.status !== 'completed' && job.status !== 'failed') {
        allDone = false;
        pendingIds.push(id);
      }
    }

    if (allDone) {
      printJson({
        poll_result: 'all_done',
        message: 'All jobs have completed.',
        jobs: results,
      });
      process.exit(0);
      return;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed >= maxWait) {
      printJson({
        poll_result: 'timeout',
        message: `Cycle timeout after ${Math.round(elapsed / 1000)}s. ${pendingIds.length} job(s) still running. Call await-jobs again with pending IDs.`,
        pending_job_ids: pendingIds,
        jobs: results,
      });
      process.exit(0); // exit 0 so platform doesn't treat it as an error
      return;
    }

    // Continue polling
    setTimeout(check, interval);
  };

  check();
}

// ─── Main ───────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

switch (command) {
  case 'create': {
    const [taskType, inputJson] = args;
    cmdCreate(taskType, inputJson);
    break;
  }

  case 'status': {
    const [jobId] = args;
    cmdStatus(jobId);
    break;
  }

  case 'poll': {
    let jobId = args[0];
    let timeout = null;
    const timeoutIdx = args.indexOf('--timeout');
    if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
      timeout = parseInt(args[timeoutIdx + 1], 10);
    }
    cmdPoll(jobId, timeout);
    break;
  }

  case 'list': {
    const [statusFilter] = args;
    cmdList(statusFilter);
    break;
  }

  case 'dispatch': {
    const [taskType, inputJson] = args;
    cmdDispatch(taskType, inputJson);
    break;
  }

  case 'dispatch-bg': {
    const [taskType, inputJson] = args;
    cmdDispatchBg(taskType, inputJson);
    break;
  }

  case 'await-jobs': {
    // Parse job IDs and optional --timeout
    const jobIds = [];
    let timeout = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--timeout' && args[i + 1]) {
        timeout = parseInt(args[i + 1], 10);
        i++;
      } else if (!args[i].startsWith('--')) {
        jobIds.push(args[i]);
      }
    }
    cmdAwaitJobs(jobIds, timeout);
    break;
  }

  default:
    printError(`Unknown command: "${command}". Available: create, status, poll, list, dispatch, dispatch-bg, await-jobs`);
}
