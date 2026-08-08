// Static file server + a small AI chat proxy for local testing.
// Binds to 127.0.0.1 only (not exposed on the network) so it's for internal/dev use.
//
// Usage:
//   node server.js            # serves on http://127.0.0.1:8080
//   PORT=3000 node server.js  # custom port
//
// The chat widget (POST /api/chat) needs an Anthropic API key. Set it either as
// a real environment variable, or in a local ".env" file (not committed) as:
//   ANTHROPIC_API_KEY=sk-ant-...

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const PORT = process.env.PORT || 8080;

// ---- Tiny .env loader (no dependency) -------------------------------------
// Only fills in vars that aren't already set in the real environment.
(function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve and guard against path traversal outside ROOT.
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      // Dev server: always re-fetch the latest file instead of caching stale edits.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ---- AI chat proxy ----------------------------------------------------------
// The browser never sees the API key — it only talks to this server, which
// holds the key and forwards a streamed response from Claude.

const SYSTEM_PROMPT =
  'You are a friendly, concise assistant embedded on "متجر الدراجات" ' +
  '(a used-bicycle marketplace website). Help visitors with things like: how ' +
  'to list a bike for sale, how to browse/filter listings, how the size guide ' +
  'works, how messaging a seller works, and general questions about buying or ' +
  'selling a used bike safely. Reply in the same language the visitor writes ' +
  'in (Arabic or English). Keep answers short — a few sentences unless the ' +
  'visitor clearly wants more detail. If asked something unrelated to the ' +
  'site or bikes, answer briefly if you can, but steer back to how you can ' +
  'help with the marketplace.';

const MAX_MESSAGES = 20;       // cap conversation length sent per request
const MAX_MESSAGE_CHARS = 4000; // cap each message's length
const MAX_TOKENS = 1024;

// Very small per-IP rate limiter — enough to stop accidental runaway loops
// during local testing. Not a substitute for real abuse protection if this
// ever moves off localhost.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitHits = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateLimitHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateLimitHits.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX_REQUESTS;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  if (messages.length > MAX_MESSAGES) {
    return `too many messages (max ${MAX_MESSAGES})`;
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      return 'each message needs role "user" or "assistant"';
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      return 'each message needs non-empty string content';
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return `message content too long (max ${MAX_MESSAGE_CHARS} chars)`;
    }
  }
  if (messages[messages.length - 1].role !== 'user') {
    return 'the last message must be from the user';
  }
  return null;
}

async function handleChat(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests — please slow down.' }));
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Server is missing ANTHROPIC_API_KEY. Set it as an env var or in a local .env file.',
    }));
    return;
  }

  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 200_000) { // guard against absurd payloads before JSON.parse
      tooBig = true;
      req.destroy();
    }
  });

  req.on('end', async () => {
    if (tooBig) return; // connection already destroyed

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const validationError = validateMessages(parsed.messages);
    if (validationError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validationError }));
      return;
    }

    // Loaded lazily so the static file server still works with zero
    // dependencies installed if the chat feature is never used.
    let Anthropic;
    try {
      Anthropic = require('@anthropic-ai/sdk');
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Run "npm install" first (missing @anthropic-ai/sdk).' }));
      return;
    }

    const client = new Anthropic();

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    try {
      const stream = client.messages.stream({
        model: 'claude-opus-5',
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'medium' },
        messages: parsed.messages.map((m) => ({ role: m.role, content: m.content })),
      });

      stream.on('text', (delta) => res.write(delta));
      const finalMessage = await stream.finalMessage();

      if (finalMessage.stop_reason === 'refusal') {
        res.write('\n\n[The assistant declined to answer that one — try rephrasing.]');
      }
      res.end();
    } catch (err) {
      console.error('Chat API error:', err);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream chat request failed.' }));
      } else {
        res.end('\n\n[Something went wrong — please try again.]');
      }
    }
  });
}

// ---- Router -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST' && urlPath === '/api/chat') {
    handleChat(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT}`);
  console.log(`  ➜  http://${HOST}:${PORT}/`);
  console.log(
    process.env.ANTHROPIC_API_KEY
      ? '  ✓ ANTHROPIC_API_KEY is set — chat widget is live.'
      : '  ⚠ ANTHROPIC_API_KEY is not set — chat widget will return an error until it is.'
  );
  console.log('Press Ctrl+C to stop.');
});
