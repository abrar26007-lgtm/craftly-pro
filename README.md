# 🚀 Craftly Production Dashboard

Batch `batch.json` generator powered by the Anthropic API.

---

## Requirements

- **Node.js 18+** (required for native `fetch`)
- An Anthropic API key

---

## Setup & Run (Local)

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open browser
http://localhost:3000
```

For auto-reload during development:
```bash
npm run dev
```

---

## Deploy on Railway / Render / Fly.io

### Railway (Recommended — free tier)
1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js
4. Done! Your app gets a public URL

### Render
1. Push to GitHub
2. Go to https://render.com → New Web Service
3. Connect repo, set:
   - Build command: `npm install`
   - Start command: `npm start`
4. Deploy

### Environment Variables (optional)
```
PORT=3000        # Default port (auto-set by most platforms)
```

---

## How to Use

1. Paste your **Anthropic API key** (sk-ant-...)
2. Select the **model** (Sonnet 4 recommended for speed/quality balance)
3. Set **total batches** (how many batch.json files to generate)
4. Keep **concurrency at 2** to avoid rate limits
5. **Upload a prompt.md** or paste your prompt directly
6. Click **Start Generation**
7. Watch live progress in the log
8. When done, click **Download ZIP** to get all batch.json files

---

## Rate Limit Protection

The server automatically handles HTTP 429 errors with:
- Exponential backoff (starts at 35s, doubles each retry, caps at 5 min)
- Random jitter to avoid thundering herd
- Up to 8 automatic retries per batch
- 1.5–2.5s mandatory delay between requests
- Worker start staggering (1.2s between each)

---

## File Output

Each generated file is saved as:
```
batch_001.json
batch_002.json
...
batch_500.json
```

If Claude returns valid JSON, it's saved as-is.
If Claude returns text, it's wrapped in:
```json
{
  "batch_index": 1,
  "content": "...",
  "generated_at": "2026-04-15T..."
}
```
