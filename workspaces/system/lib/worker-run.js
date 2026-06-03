#!/usr/bin/env node
/**
 * Worker Runner
 * 
 * Claims a job from the queue and executes its script with periodic heartbeat updates.
 * Captures stdout/stderr, writes result to shared/result/_jobs/, and completes/fails the job.
 * 
 * Usage:
 *   node worker-run.js                 # Claim and run the next queued job
 *   node worker-run.js <job_id>        # Claim and run a specific job
 *   node worker-run.js --agent <name>  # Specify agent name (default: "worker")
 * 
 * The worker:
 *  1. Claims job (atomic move queue → running)
 *  2. Starts heartbeat timer (updates every 10s)
 *  3. Spawns the script as a child process
 *  4. Captures stdout/stderr
 *  5. On success: saves result, moves job to completed
 *  6. On failure: moves job to failed
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const jobManager = require('./job-manager');
const config = require('./config');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseArgs() {
  const args = process.argv.slice(2);
  let jobId = null;
  let agentName = 'worker';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) {
      agentName = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--')) {
      jobId = args[i];
    }
  }

  return { jobId, agentName };
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [worker] ${msg}`;
  console.error(line); // stderr for logs, stdout reserved for result

  // Also append to log file
  try {
    ensureDir(config.LOGS_DIR);
    fs.appendFileSync(
      path.join(config.LOGS_DIR, 'worker.log'),
      line + '\n'
    );
  } catch {}
}

async function runJob(job) {
  const taskDef = config.TASK_REGISTRY[job.task_type];
  if (!taskDef) {
    throw new Error(`Unknown task_type: ${job.task_type}`);
  }

  const params = job.input.params || [];
  const cmdArgs = taskDef.buildArgs(params);
  const cmd = cmdArgs[0];
  const spawnArgs = cmdArgs.slice(1);

  log(`Executing: ${cmd} ${spawnArgs.join(' ')}`);
  log(`CWD: ${taskDef.cwd}`);

  // Start heartbeat interval
  const heartbeatTimer = setInterval(() => {
    try {
      const updated = jobManager.updateHeartbeat(job.job_id);
      if (updated) {
        log(`Heartbeat updated for ${job.job_id}`);
      }
    } catch (err) {
      log(`Heartbeat error: ${err.message}`);
    }
  }, config.HEARTBEAT_INTERVAL_MS);

  return new Promise((resolve, reject) => {
    const timeoutMs = (job.timeout_seconds || config.TASK_TIMEOUTS.default) * 1000;
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(cmd, spawnArgs, {
      cwd: taskDef.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Timeout kill
    const killTimer = setTimeout(() => {
      killed = true;
      log(`Timeout (${job.timeout_seconds}s) reached, killing process`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      clearInterval(heartbeatTimer);

      if (killed) {
        reject(new Error(`Process killed: timeout after ${job.timeout_seconds}s`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}. stderr: ${stderr.slice(-500)}`));
        return;
      }

      resolve({ stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      clearInterval(heartbeatTimer);
      reject(new Error(`Spawn error: ${err.message}`));
    });
  });
}

async function main() {
  const { jobId, agentName } = parseArgs();

  // Claim job
  log(`Claiming job... (jobId=${jobId || 'next'}, agent=${agentName})`);
  const job = jobManager.claimJob(agentName, jobId);

  if (!job) {
    const msg = jobId
      ? `Job ${jobId} not found in queue or already claimed`
      : 'No jobs in queue';
    console.log(JSON.stringify({ status: 'no_job', message: msg }));
    process.exit(0);
  }

  log(`Claimed job ${job.job_id} (type=${job.task_type}, attempt=${job.attempt}/${job.max_attempts})`);

  try {
    const result = await runJob(job);

    // Save output to shared/result/_jobs/
    ensureDir(config.JOBS_RESULT_DIR);
    const outputFilename = `${job.task_type}_${job.job_id}.json`;
    const outputPath = path.join(config.JOBS_RESULT_DIR, outputFilename);

    // Try to parse stdout as JSON, save raw if not
    let outputData;
    try {
      outputData = JSON.parse(result.stdout);
    } catch {
      outputData = { raw_output: result.stdout, stderr: result.stderr };
    }

    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');

    // Use absolute path so any agent can read it regardless of CWD
    const absoluteOutputPath = outputPath;

    // Mark job completed
    const completedJob = jobManager.completeJob(job.job_id, absoluteOutputPath);

    log(`Job ${job.job_id} completed. Output: ${absoluteOutputPath}`);
    console.log(JSON.stringify({
      status: 'completed',
      job_id: job.job_id,
      task_type: job.task_type,
      output_path: absoluteOutputPath,
    }));

  } catch (err) {
    log(`Job ${job.job_id} failed: ${err.message}`);

    // Mark job failed
    jobManager.failJob(job.job_id, err.message);

    console.log(JSON.stringify({
      status: 'failed',
      job_id: job.job_id,
      task_type: job.task_type,
      error: err.message,
    }));
    process.exit(1);
  }
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  console.log(JSON.stringify({ status: 'error', error: err.message }));
  process.exit(1);
});
