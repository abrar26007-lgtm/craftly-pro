const express = require('express');
const path = require('path');
const JSZip = require('jszip');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const jobs = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pad(n, len = 3) {
  return String(n).padStart(len, '0');
}

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ─── Core: Call Anthropic API with full retry + backoff ─────────────────────

async function callAnthropic(apiKey, model, prompt, maxRetries = 8) {
  let backoffMs = 35000; // Start 35s (slightly above Anthropic's usual reset)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (networkErr) {
      if (attempt === maxRetries) throw new Error(`Network error: ${networkErr.message}`);
      await sleep(5000);
      continue;
    }

    // Rate limit
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const retryAfterHeader = res.headers.get('retry-after');
      const waitMs = retryAfterHeader
        ? parseInt(retryAfterHeader) * 1000 + 2000
        : backoffMs + Math.floor(Math.random() * 5000); // jitter

      backoffMs = Math.min(backoffMs * 2, 300000); // cap at 5 min

      if (attempt < maxRetries) {
        const waitSec = Math.round(waitMs / 1000);
        throw { retry: true, wait: waitMs, msg: `Rate limited. Waiting ${waitSec}s... (attempt ${attempt}/${maxRetries})` };
      }
      throw new Error(`Rate limit hit after ${maxRetries} attempts: ${JSON.stringify(body).slice(0, 200)}`);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  }

  throw new Error('Max retries exceeded');
}

// ─── Worker: generate single batch with retry loop ──────────────────────────

async function generateBatch(apiKey, model, prompt, idx, total, job, maxRetries = 8) {
  let backoffMs = 35000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const text = await callAnthropic(apiKey, model, prompt);

      // Try to extract JSON from response
      let parsed;
      try {
        const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/) ||
                          text.match(/(\{[\s\S]*\})/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[1] : text);
      } catch {
        // Not JSON — wrap raw text
        parsed = {
          batch_index: idx,
          content: text,
          generated_at: new Date().toISOString(),
        };
      }

      return JSON.stringify(parsed, null, 2);

    } catch (err) {
      if (err.retry) {
        job.retried++;
        job.log(`⏳ [${pad(idx)}/${total}] ${err.msg}`);
        await sleep(err.wait);
        backoffMs = Math.min(backoffMs * 2, 300000);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed after ${maxRetries} retries`);
}

// ─── Job runner ──────────────────────────────────────────────────────────────

async function runJob(jobId) {
  const job = jobs.get(jobId);
  const { apiKey, model, prompt, total, concurrency } = job;

  job.status = 'running';
  job.startedAt = Date.now();
  job.log(`🚀 Starting generation: ${total} batches, ${concurrency} concurrent`);

  const queue = Array.from({ length: total }, (_, i) => i + 1);
  const files = [];

  async function worker(workerId) {
    while (true) {
      const idx = queue.shift();
      if (idx === undefined) break;

      job.log(`▶ [${pad(idx)}/${total}] Worker-${workerId} started`);

      try {
        const content = await generateBatch(apiKey, model, prompt, idx, total, job);
        files.push({ name: `batch_${pad(idx)}.json`, content });
        job.done++;
        job.log(`✅ [${pad(idx)}/${total}] Done`);
      } catch (err) {
        job.failed++;
        job.failedIndices.push(idx);
        job.log(`❌ [${pad(idx)}/${total}] Failed: ${err.message.slice(0, 120)}`);
      }

      // Mandatory inter-request delay to avoid hammering the API
      const delayMs = 1500 + Math.random() * 1000;
      await sleep(delayMs);
    }
  }

  // Stagger worker starts to avoid burst
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) {
    await sleep(i * 1200); // 1.2s between each worker start
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);

  // Build ZIP
  job.log(`📦 Building ZIP with ${files.length} files...`);
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.name, f.content);
  }
  job.zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  job.status = 'done';
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  job.log(`🎉 Complete in ${elapsed}s — ${job.done} done, ${job.failed} failed, ${job.retried} retries.`);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Start job (JSON body)
app.post('/api/start', (req, res) => {
  const { apiKey, model, prompt, total, concurrency } = req.body;

  if (!apiKey?.trim()) return res.status(400).json({ error: 'API key required' });
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt required' });
  if (!total || isNaN(parseInt(total)) || parseInt(total) < 1)
    return res.status(400).json({ error: 'Invalid batch count' });

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const logEntries = [];

  const job = {
    status: 'starting',
    done: 0,
    failed: 0,
    retried: 0,
    total: parseInt(total),
    concurrency: Math.min(Math.max(parseInt(concurrency) || 2, 1), 5),
    apiKey,
    model: model || 'claude-sonnet-4-20250514',
    prompt,
    logs: logEntries,
    failedIndices: [],
    zipBuffer: null,
    startedAt: null,
    log(msg) {
      logEntries.push(`[${ts()}] ${msg}`);
      if (logEntries.length > 500) logEntries.splice(0, logEntries.length - 500);
    },
  };

  jobs.set(jobId, job);
  res.json({ jobId });

  runJob(jobId).catch(err => {
    job.status = 'error';
    job.log(`💥 Fatal: ${err.message}`);
  });
});

// Upload prompt file
app.post('/api/upload-prompt', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const text = req.file.buffer.toString('utf-8');
  res.json({ prompt: text, filename: req.file.originalname });
});

// Poll status
app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const processed = job.done + job.failed;
  const progress = job.total > 0 ? Math.round((processed / job.total) * 100) : 0;

  let batchesPerMin = null;
  if (job.startedAt && processed > 0) {
    const elapsedMin = (Date.now() - job.startedAt) / 60000;
    batchesPerMin = (processed / elapsedMin).toFixed(1);
  }

  res.json({
    status: job.status,
    done: job.done,
    failed: job.failed,
    retried: job.retried,
    total: job.total,
    progress,
    batchesPerMin,
    logs: job.logs.slice(-50),
    failedIndices: job.failedIndices,
    hasZip: !!job.zipBuffer,
  });
});

// Download ZIP
app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.zipBuffer) return res.status(404).json({ error: 'ZIP not ready' });

  const filename = `craftly_batches_${new Date().toISOString().slice(0, 10)}_${req.params.id}.zip`;
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': job.zipBuffer.length,
  });
  res.send(job.zipBuffer);
});

// Clean up old jobs (> 2 hours)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.startedAt && job.startedAt < cutoff) {
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000);

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Craftly Production Dashboard`);
  console.log(`   http://localhost:${PORT}\n`);
});
