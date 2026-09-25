// Static file server + a small AI chat proxy.
//
// HOST defaults to 0.0.0.0 (all interfaces) so this runs as-is on hosting
// platforms (Render/Railway/Fly/etc.) that proxy traffic into the container's
// exposed port. Set HOST=127.0.0.1 to go back to localhost-only for local dev.
//
// Usage:
//   node server.js               # serves on http://0.0.0.0:8080
//   PORT=3000 node server.js     # custom port (most hosts set this for you)
//   HOST=127.0.0.1 node server.js  # localhost-only, e.g. for local-only testing
//
// The chat widget (POST /api/chat) needs an Anthropic API key. Set it either as
// a real environment variable, or in a local ".env" file (not committed) as:
//   ANTHROPIC_API_KEY=sk-ant-...
//
// DATA_DIR controls where products/rides/clubs/users/sessions.json live.
// Defaults to this project folder (fine for local dev), but on a host with
// an ephemeral filesystem — e.g. Render's free/non-disk plans — that folder
// gets wiped on every deploy/restart, silently resetting every account and
// listing back to the demo seed data. Set DATA_DIR to a mounted persistent
// disk's path (e.g. Render's Disks feature, mounted at /var/data) in
// production so the data actually survives deploys.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Last-resort safety net: a bug in one request handler should cost that one
// request, not the whole site (async handlers are called without a catch, so
// an unexpected throw there is an unhandled rejection, which by default
// kills the process). Log it loudly and keep serving.
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const ROOT = __dirname;
let DATA_DIR = process.env.DATA_DIR || ROOT;
// Harmless when DATA_DIR already exists (the default ROOT case); makes sure
// a freshly-mounted, empty disk doesn't fail the first write.
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  // DATA_DIR points somewhere this process can't create — almost always
  // "the persistent disk isn't attached (or is mounted at a different
  // path)". Crashing here would take the whole site down on deploy, so
  // fall back to the project folder instead — but shout about it, because
  // that folder is wiped on every deploy and users' data won't survive.
  console.error('='.repeat(72));
  console.error(`DATA_DIR "${DATA_DIR}" is not usable (${e.code || e.message}).`);
  console.error('Is the persistent disk attached, with its Mount Path equal to DATA_DIR?');
  console.error(`Falling back to ${ROOT} — data will NOT survive a redeploy until this is fixed.`);
  console.error('='.repeat(72));
  DATA_DIR = ROOT;
}
const HOST = process.env.HOST || '0.0.0.0';
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

// decodeURIComponent throws on a malformed escape like "/%" — and an
// exception thrown inside the request handler used to take the whole
// process down. Any bad URL is just "not found".
function safeDecodeUrlPath(url) {
  try {
    return decodeURIComponent(String(url || '').split('?')[0]);
  } catch {
    return null;
  }
}

// Only these files are ever served as static content. The site is one page
// (index.html) whose images come from elsewhere, so there's nothing else
// the browser needs from this folder — and the old "serve anything under
// the project folder" behaviour exposed server.js, package.json, and (if
// DATA_DIR ever fell back to the project folder) users.json and
// sessions.json, i.e. every password hash and every login token.
const PUBLIC_FILES = new Set(['/index.html', '/manifest.json']);

function serveStatic(req, res) {
  let urlPath = safeDecodeUrlPath(req.url);
  if (urlPath === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  if (!PUBLIC_FILES.has(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const filePath = path.join(ROOT, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
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
  'You are a friendly, concise assistant embedded on "Pedalex" ' +
  '(a used-bicycle marketplace website). Help visitors with things like: how ' +
  'to list a bike for sale, how to browse/filter listings, how messaging a ' +
  'seller works, and general questions about buying or selling a used bike ' +
  'safely. Reply in the same language the visitor writes in (Arabic or ' +
  'English). Keep answers short — a few sentences unless the visitor clearly ' +
  'wants more detail. If asked something unrelated to the site or bikes, ' +
  'answer briefly if you can, but steer back to how you can help with the ' +
  'marketplace.\n\n' +
  'You can also act as a bike-fitting assistant. If a visitor is looking to ' +
  'buy, ask for their budget and height if they haven\'t mentioned them. Use ' +
  'height to suggest a frame size — these are the site\'s canonical ' +
  'breakpoints, the same ones the Size Guide page and the inventory\'s own ' +
  'quick size filter use, so always match them exactly rather than rounding ' +
  'or improvising your own cutoffs:\n' +
  '  under 158 cm -> size XS\n' +
  '  158–167 cm   -> size S\n' +
  '  168–177 cm   -> size M\n' +
  '  178–187 cm   -> size L\n' +
  '  188–197 cm   -> size XL\n' +
  '  198+ cm      -> size XXL\n' +
  'Once you know (or can estimate) a budget, size, or preferred brand/frame ' +
  'material, call the search_bikes tool to check the real, ' +
  'currently-available inventory — never invent or assume a listing exists ' +
  'without calling it first. If nothing matches, call search_bikes again ' +
  'with looser criteria (e.g. drop the brand/material, or raise maxPrice) ' +
  'and explain what differs about the closest option you found (price, ' +
  'size, condition, etc.).';

// Tool the model can call to check real, current inventory instead of
// guessing — see searchBikes() below for what actually runs.
const TOOLS = [
  {
    name: 'search_bikes',
    description: 'البحث في قاعدة بيانات الدراجات المعروضة بناءً على الميزانية والمقاس وخامة الفريم المناسبة.',
    input_schema: {
      type: 'object',
      properties: {
        maxPrice: {
          type: 'number',
          description: 'الحد الأقصى للسعر بالدرهم الإماراتي',
        },
        size: {
          type: 'string',
          description: "مقاس الفريم المطلوب (مثال: '52', '54', '56')",
        },
        brand: {
          type: 'string',
          description: "الماركة أو البراند المفضل إن وجد (مثال: 'Cervelo', 'Seka', 'Trek')",
        },
        material: {
          type: 'string',
          description: "خامة الفريم إن حددها المستخدم — كربون (carbon) أو ألومنيوم (aluminum)",
        },
      },
    },
  },
];

// Only ever searches approved + available listings — reserved/sold/pending
// items are never surfaced to the assistant, so it can't recommend them.
function searchBikes(input) {
  const { maxPrice, size, brand, material } = input || {};
  // The model may pass the Arabic term itself (per the tool description
  // above) even though frameMaterial is stored in English — normalize both
  // common Arabic spellings to the English value they mean before matching.
  const materialNormalized = material
    ? String(material).toLowerCase().replace('كربون', 'carbon').replace('ألومنيوم', 'aluminum').replace('الومنيوم', 'aluminum')
    : '';
  return loadProductsFromDisk()
    .filter((p) => p.status === 'approved' && p.availability === 'available')
    .filter((p) => typeof maxPrice !== 'number' || p.price <= maxPrice)
    .filter((p) => !size || String(p.size).toLowerCase().includes(String(size).toLowerCase()))
    .filter((p) => !brand || String(p.name).toLowerCase().includes(String(brand).toLowerCase()))
    .filter((p) => !materialNormalized || String(p.frameMaterial || '').toLowerCase().includes(materialNormalized))
    .map((p) => ({
      name: p.name,
      type: p.type,
      price: p.price,
      size: p.size,
      frameMaterial: p.frameMaterial,
      condition: p.condition,
      frameMaterial: p.frameMaterial,
    }));
}

function executeTool(name, input) {
  if (name === 'search_bikes') return searchBikes(input);
  return { error: `Unknown tool: ${name}` };
}

const MAX_MESSAGES = 20;       // cap conversation length sent per request
const MAX_MESSAGE_CHARS = 4000; // cap each message's length
const MAX_TOKENS = 1024;
const MAX_TOOL_TURNS = 4; // guard against the model looping on tool calls forever

// Very small per-IP rate limiter — enough to stop accidental runaway loops
// during local testing. Not a substitute for real abuse protection if this
// ever moves off localhost.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitHits = new Map(); // ip -> [timestamps]

function isRateLimited(ip, hitsMap = rateLimitHits, max = RATE_LIMIT_MAX_REQUESTS) {
  const now = Date.now();
  const hits = (hitsMap.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  hitsMap.set(ip, hits);
  return hits.length > max;
}

// Separate, stricter bucket for login/register — a shared bucket with the
// chat widget would let heavy (legitimate) chat use crowd out someone's
// ability to log in, and vice versa.
const AUTH_RATE_LIMIT_MAX_REQUESTS = 10;
const authRateLimitHits = new Map();

// Its own bucket too, tighter still — this one sends a real email every
// successful call, unlike most other endpoints.
const CONTACT_RATE_LIMIT_MAX_REQUESTS = 5;
const contactRateLimitHits = new Map();

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
      const conversation = parsed.messages.map((m) => ({ role: m.role, content: m.content }));
      let finalMessage;

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const stream = client.messages.stream({
          model: 'claude-opus-5',
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          output_config: { effort: 'medium' },
          messages: conversation,
        });

        stream.on('text', (delta) => res.write(delta));
        finalMessage = await stream.finalMessage();

        if (finalMessage.stop_reason !== 'tool_use') break;

        // The model wants search_bikes run before it can finish answering —
        // execute it locally against the real inventory and feed the result
        // back so the next turn can use it.
        conversation.push({ role: 'assistant', content: finalMessage.content });
        const toolResults = finalMessage.content
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(executeTool(block.name, block.input)),
          }));
        conversation.push({ role: 'user', content: toolResults });
      }

      if (finalMessage.stop_reason === 'tool_use') {
        // Hit MAX_TOOL_TURNS still wanting to call a tool — bail out visibly
        // rather than silently ending with no reply text.
        res.write('\n\n[Still looking — try narrowing your budget or size.]');
      } else if (finalMessage.stop_reason === 'refusal') {
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

// ---- Users & sessions -----------------------------------------------------------
// Real, server-verified accounts. Previously "accounts" lived entirely in each
// visitor's own localStorage, which the server never checked — meaning
// anyone could grant themselves admin from their browser console, or call
// the products/rides/clubs endpoints directly (bypassing the UI's "only the
// owner sees a Delete button" checks) to edit or delete listings that
// weren't theirs. Every mutating request below now requires a valid session
// token, and ownership/admin checks happen here, not just in the UI.

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PASSWORD_RESETS_FILE = path.join(DATA_DIR, 'password-resets.json');
const AUTH_MAX_BODY_BYTES = 20_000; // plain text fields only
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// id: 1, isAdmin: true — the very first account, auto-created the first
// time users.json doesn't exist yet. See seedDefaultUsers() below for how
// its email/password are chosen.
// The seed admin account's credentials used to be the hardcoded literal
// "admin@bikestore.com" / "admin123" — fine for local dev, but this file is
// committed to a *public* repo, so a fixed, published password would let
// anyone who reads the source log in as admin on any deployment that hasn't
// overwritten it. Now: the email defaults to the real business address
// (pedalexbikes@gmail.com) and the password comes from ADMIN_SEED_PASSWORD
// (set this in Render's environment for the live deploy) — or, if that's
// unset, a random password printed to the server log *once*, on first
// boot, so a deploy started with no env vars set still isn't sitting on a
// public default. Override either with ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD.
// This only ever runs once (see loadUsersFromDisk): it seeds users.json the
// first time it doesn't exist, and never runs again once a real users.json
// is on disk.
function seedDefaultUsers() {
  const email = process.env.ADMIN_SEED_EMAIL || 'pedalexbikes@gmail.com';
  let password = process.env.ADMIN_SEED_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url'); // 12 random chars
    console.log('='.repeat(72));
    console.log(`No ADMIN_SEED_PASSWORD set — generated a one-time admin password.`);
    console.log(`  Admin email:    ${email}`);
    console.log(`  Admin password: ${password}`);
    console.log(`Log in once with this, then set ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD`);
    console.log(`as real environment variables so this isn't regenerated on next deploy.`);
    console.log('='.repeat(72));
  }
  return [
    {
      id: 1,
      name: 'Admin',
      email,
      phone: '',
      passwordHash: hashPassword(password),
      rating: 5,
      reviews: [],
      isAdmin: true,
      createdAt: new Date().toISOString(),
    },
  ];
}

// scrypt (built into Node — no extra dependency) with a random per-user salt.
// Stored as "salt:hash", both hex.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  // Lengths must match before timingSafeEqual (it throws otherwise) — a
  // mismatched length just means "wrong password".
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function loadUsersFromDisk() {
  if (!fs.existsSync(USERS_FILE)) {
    const seeded = seedDefaultUsers();
    fs.writeFileSync(USERS_FILE, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Error reading users.json, treating as empty:', e);
    return [];
  }
}

function saveUsersToDisk(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Never send passwordHash to the client.
function publicUser(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

// ---- Sessions ---------------------------------------------------------------
// token -> { userId, expiresAt } for real accounts, or
// token -> { guestUser, expiresAt } for guest sessions (never written to
// users.json — guests are disposable, but still need a stable identity for
// the lifetime of their session so ownership checks work the same way).
// Persisted to disk so a server restart/redeploy doesn't silently log
// everyone out; still just an in-memory Map as the source of truth at
// runtime.
let sessions = new Map();

function loadSessionsFromDisk() {
  if (!fs.existsSync(SESSIONS_FILE)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    return new Map((Array.isArray(parsed) ? parsed : []).filter(([, s]) => s.expiresAt > now));
  } catch (e) {
    console.error('Error reading sessions.json, starting with no sessions:', e);
    return new Map();
  }
}

function saveSessionsToDisk() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.entries()], null, 2));
}

sessions = loadSessionsFromDisk();

function createSession(data) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessionsToDisk();
  return token;
}

function deleteSession(token) {
  sessions.delete(token);
  saveSessionsToDisk();
}

// ---- Password reset tokens ---------------------------------------------------
// token -> { userId, expiresAt }. Same load/save/persist pattern as
// sessions above, but short-lived (RESET_TOKEN_TTL_MS) and single-use: a
// token is deleted the moment it's redeemed in handleResetPassword, and
// expired ones are dropped on load. This is the *only* proof of email
// ownership the reset flow accepts — see handleForgotPassword/
// handleResetPassword below.
let passwordResets = new Map();

function loadPasswordResetsFromDisk() {
  if (!fs.existsSync(PASSWORD_RESETS_FILE)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(PASSWORD_RESETS_FILE, 'utf8'));
    const now = Date.now();
    return new Map((Array.isArray(parsed) ? parsed : []).filter(([, r]) => r.expiresAt > now));
  } catch (e) {
    console.error('Error reading password-resets.json, starting with none:', e);
    return new Map();
  }
}

function savePasswordResetsToDisk() {
  fs.writeFileSync(PASSWORD_RESETS_FILE, JSON.stringify([...passwordResets.entries()], null, 2));
}

passwordResets = loadPasswordResetsFromDisk();

function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  passwordResets.set(token, { userId, expiresAt: Date.now() + RESET_TOKEN_TTL_MS });
  savePasswordResetsToDisk();
  return token;
}

// Returns the userId for a still-valid token, or null — and always deletes
// the token either way, so a single link can only ever be used once (an
// expired one is cleaned up here rather than left for the next load).
function consumePasswordResetToken(token) {
  const record = passwordResets.get(token);
  if (!record) return null;
  passwordResets.delete(token);
  savePasswordResetsToDisk();
  if (record.expiresAt <= Date.now()) return null;
  return record.userId;
}

// ---- Transactional email (Resend) --------------------------------------------
// Plain HTTPS call, no SDK — same "no extra dependency" approach as the rest
// of this file. Set RESEND_API_KEY (and optionally RESEND_FROM /
// APP_PUBLIC_URL) as real environment variables in production. Without a
// key, this logs instead of sending — see the warning in
// handleForgotPassword when that happens.
const https = require('https');

// Resend's free tier can only send "from" a domain you've verified with
// them by DNS — a plain Gmail address (or any address on a domain you
// don't own) can never be a valid "from" there, only onboarding@resend.dev
// (their shared sandbox sender) until a real domain is verified. So a
// reply the user sends still lands in the actual business inbox by making
// that the reply_to instead — set REPLY_TO_EMAIL if pedalexbikes@gmail.com
// isn't the right address.
function sendEmail({ to, subject, html, replyTo }) {
  return new Promise((resolve, reject) => {
    const from = process.env.RESEND_FROM || 'Pedalex <onboarding@resend.dev>';
    const resolvedReplyTo = replyTo || process.env.REPLY_TO_EMAIL || 'pedalexbikes@gmail.com';
    const payload = JSON.stringify({ from, to, subject, html, reply_to: resolvedReplyTo });
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`Resend API ${res.statusCode}: ${body}`));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Minimal HTML-escaping for text dropped into an email body — server.js has
// no other HTML-templating helper (the client's escapeHtml() only runs in
// the browser), and this one's only job is stopping visitor-typed text from
// breaking out of the surrounding markup.
function escapeHtmlForEmail(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildResetEmailHtml(name, resetUrl) {
  const safeName = escapeHtmlForEmail(name);
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color:#0F172A;">Pedalex</h2>
      <p>Hi ${safeName || 'there'},</p>
      <p>We received a request to reset your Pedalex password. Click the button below to choose a new one — this link works once and expires in 30 minutes.</p>
      <p style="text-align:center; margin: 32px 0;">
        <a href="${resetUrl}" style="background:#2563EB; color:#fff; padding:14px 28px; border-radius:999px; text-decoration:none; font-weight:bold;">Reset Password</a>
      </p>
      <p style="color:#64748B; font-size:13px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
      <p style="color:#94A3B8; font-size:12px;">${resetUrl}</p>
    </div>`;
}

function buildContactEmailHtml(name, email, message) {
  return `
    <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color:#0F172A;">New message from the Pedalex website</h2>
      <p><strong>From:</strong> ${escapeHtmlForEmail(name)} (${escapeHtmlForEmail(email)})</p>
      <p style="white-space: pre-wrap; background:#F8FAFC; border:1px solid #E2E8F0; border-radius:12px; padding:16px;">${escapeHtmlForEmail(message)}</p>
      <p style="color:#94A3B8; font-size:12px;">Reply to this email to answer ${escapeHtmlForEmail(name)} directly — Reply-To is already set to their address.</p>
    </div>`;
}

const CONTACT_MAX_BODY_BYTES = 20_000; // plain text fields only

// The "Contact Us" form (About page) — forwards straight to the business
// inbox (CONTACT_TO_EMAIL, defaulting to pedalexbikes@gmail.com) with
// Reply-To set to the visitor's own address, so answering them is just
// hitting Reply. No account/auth needed — anyone can reach out.
async function handleContact(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip, contactRateLimitHits, CONTACT_RATE_LIMIT_MAX_REQUESTS)) {
    sendJson(res, 429, { error: 'Too many messages — please slow down.' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, CONTACT_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const name = String(body.name || '').trim().slice(0, 200);
  const email = String(body.email || '').trim().slice(0, 200);
  const message = String(body.message || '').trim().slice(0, 5000);
  if (!name || !email || !message) {
    sendJson(res, 400, { error: 'Name, email, and message are all required.' });
    return;
  }
  const to = process.env.CONTACT_TO_EMAIL || 'pedalexbikes@gmail.com';
  if (!process.env.RESEND_API_KEY) {
    // Don't tell the visitor "sent" when nothing was — that silently loses
    // their message. Log it (so it's recoverable from the server log) and
    // report the failure instead.
    console.warn(`RESEND_API_KEY not set — contact message from ${name} <${email}> NOT emailed. Message: ${message}`);
    sendJson(res, 503, { error: 'Email is not configured on the server yet.' });
    return;
  }
  try {
    await sendEmail({
      to,
      subject: `Pedalex contact form: ${name}`,
      html: buildContactEmailHtml(name, email, message),
      replyTo: email,
    });
  } catch (e) {
    console.error('Failed to send contact email:', e);
    // Provider's own explanation (e.g. "you can only send testing emails to
    // your own address") — safe to show, and it's the difference between
    // guessing and knowing why delivery failed.
    let reason = '';
    try { reason = JSON.parse(String(e.message).replace(/^Resend API \d+: /, '')).message || ''; } catch {}
    sendJson(res, 502, {
      error: 'Could not send your message right now — please try again shortly.',
      reason: String(reason).slice(0, 300),
    });
    return;
  }
  sendJson(res, 200, { ok: true });
}

// ---- WhatsApp Business Cloud API: listings sent in as a chat message --------
// A seller messages the business WhatsApp number describing a bike (+ maybe
// a photo); this turns that into a normal Pedalex listing — same AI
// moderation as the website's own "sell your bike" form, same admin queue
// when it isn't confidently clean. Needs three things set as real Render
// environment variables once the Meta app exists: WHATSAPP_ACCESS_TOKEN,
// WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_VERIFY_TOKEN (any string you pick —
// it's just a shared secret Meta echoes back to prove the webhook config
// request is really from you). Until those are set, the webhook endpoints
// exist but quietly do nothing.
const WHATSAPP_API_VERSION = 'v21.0';

function whatsAppConfigured() {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function graphApiGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

function graphApiGetBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

// Downloads a photo the seller attached and returns it as a data: URI, the
// same format the website's own upload form stores images in.
async function fetchWhatsAppImage(mediaId) {
  if (!mediaId) return null;
  try {
    const meta = await graphApiGetJson(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`);
    if (!meta?.url) return null;
    const buf = await graphApiGetBuffer(meta.url);
    return `data:${meta.mime_type || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.error('Failed to fetch WhatsApp media:', e);
    return null;
  }
}

function sendWhatsAppMessage(to, text) {
  return new Promise((resolve, reject) => {
    if (!whatsAppConfigured()) { resolve(); return; }
    const payload = JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`WhatsApp send ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Reads a seller's free-text WhatsApp message and pulls out a listing —
// or null if the message doesn't actually describe an item for sale (a
// greeting, a question, "is this still available", etc.), so the caller
// can ask for clarification instead of publishing nonsense.
async function parseWhatsAppListing(text) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return null;
  }
  const prompt = `A seller sent this WhatsApp message to list an item for sale on Pedalex, a bike/cycling-gear marketplace in the UAE:

"""
${text}
"""

If this message is NOT actually describing a specific item for sale (e.g. it's a greeting, a question, "is this available", unrelated chat), respond with exactly: {"notAListing": true}

Otherwise extract the listing and respond with ONLY this JSON, no other text:
{"name": "<short title>", "type": "road"|"mountain"|"hybrid"|"electric"|"accessory", "price": <number, AED — your best estimate if a currency/unit is implied, or 0 if truly not mentioned>, "size": "<size if mentioned, else empty string>", "condition": "<condition in Arabic if mentioned, else empty string>", "notes": "<any other details from the message, in the seller's own words>"}`;

  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const responseText = (res.content || []).find((b) => b.type === 'text')?.text || '';
    const match = responseText.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.notAListing || !parsed.name) return null;
    return parsed;
  } catch (e) {
    console.error('WhatsApp listing parse failed:', e);
    return null;
  }
}

// A single shared, unguessable-password account that owns every listing
// submitted via WhatsApp — not something anyone signs in as, just a stable
// sellerId so these listings behave like any other (owner-only edit/delete,
// visible to the admin as a distinct source), while sellerName/sellerPhone
// on the listing itself show the real sender for the "contact seller" button.
function getOrCreateWhatsAppBotUser() {
  const users = loadUsersFromDisk();
  let bot = users.find((u) => u.email === 'whatsapp-bot@pedalex.internal');
  if (bot) return bot;
  bot = {
    id: 999999999999,
    name: 'WhatsApp',
    email: 'whatsapp-bot@pedalex.internal',
    phone: '',
    passwordHash: hashPassword(crypto.randomBytes(24).toString('hex')),
    rating: 5,
    reviews: [],
    isAdmin: false,
    createdAt: new Date().toISOString(),
  };
  users.push(bot);
  saveUsersToDisk(users);
  return bot;
}

// Meta's one-time handshake when you save the webhook URL in the app
// dashboard: echo back hub.challenge only if hub.verify_token matches what
// you configured, proving the request really came from you setting it up.
function handleWhatsAppVerify(req, res) {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (token && params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === token) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(params.get('hub.challenge') || '');
  } else {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
  }
}

// Every inbound message (and every delivery-status update, which this
// ignores) arrives here. Meta expects a fast 200 regardless of outcome —
// it retries on anything else — so this acknowledges immediately and keeps
// working in the background rather than making Meta wait on the AI calls.
async function handleWhatsAppMessage(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 5_000_000);
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');

  if (!whatsAppConfigured()) return;

  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return; // a status update (delivered/read), not a new message
    const from = message.from;
    const senderName = value?.contacts?.[0]?.profile?.name || '';

    let text = '';
    let imageMediaId = null;
    if (message.type === 'text') {
      text = message.text?.body || '';
    } else if (message.type === 'image') {
      text = message.image?.caption || '';
      imageMediaId = message.image?.id || null;
    } else {
      await sendWhatsAppMessage(from, 'مرحباً 👋 أرسل لي وصف الدراجة (النوع، الحالة، السعر) — ويفضّل مع صورة — وبنشرها لك على Pedalex.');
      return;
    }

    if (!text.trim()) {
      await sendWhatsAppMessage(from, 'أرسل وصف مختصر للدراجة (النوع، الحالة، السعر) مع الصورة.');
      return;
    }

    const parsed = await parseWhatsAppListing(text);
    if (!parsed) {
      await sendWhatsAppMessage(from, 'ما قدرت أفهم تفاصيل الإعلان 🙏 جرّب تكتب: نوع الدراجة، الحالة، السعر، والمقاس إن وجد.');
      return;
    }

    const image = imageMediaId ? await fetchWhatsAppImage(imageMediaId) : null;
    const bot = getOrCreateWhatsAppBotUser();
    const products = loadProductsFromDisk();
    const newProduct = {
      name: parsed.name,
      type: parsed.type || 'accessory',
      price: parsed.price || 0,
      size: parsed.size || '',
      condition: parsed.condition || '',
      notes: parsed.notes || '',
      image: image || '',
      sellerName: senderName || 'بائع واتساب',
      sellerPhone: `+${from}`,
      id: Date.now(),
      createdAt: new Date().toISOString(),
      sellerId: bot.id,
      status: 'pending',
      source: 'whatsapp',
    };

    const moderation = await moderateProductListing(newProduct);
    newProduct.aiDecision = moderation.decision;
    newProduct.aiReason = moderation.reason;
    if (moderation.decision === 'approve') {
      newProduct.status = 'approved';
    } else {
      newProduct.adminNotes = moderation.reason;
    }

    products.push(newProduct);
    saveProductsToDisk(products);

    const appUrl = process.env.APP_PUBLIC_URL || 'https://pedalexbikes.com';
    await sendWhatsAppMessage(
      from,
      newProduct.status === 'approved'
        ? `تم نشر إعلانك على Pedalex ✅\n${appUrl}`
        : 'استلمنا إعلانك وبنراجعه بسرعة قبل النشر، بنعلمك أول ما يتم قبوله ✅'
    );
  } catch (e) {
    console.error('WhatsApp webhook processing failed:', e);
  }
}

// Resolves the "Authorization: Bearer <token>" header to the real,
// server-known user (re-read from disk so a just-revoked admin flag is
// always current) or the guest identity — or null if missing/invalid/expired.
function getAuthUser(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  const token = match[1];
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    deleteSession(token);
    return null;
  }
  if (session.guestUser) return session.guestUser;
  const user = loadUsersFromDisk().find((u) => u.id === session.userId);
  return user ? publicUser(user) : null;
}

function sendUnauthorized(res) {
  sendJson(res, 401, { error: 'Sign in required.' });
}

async function handleRegister(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip, authRateLimitHits, AUTH_RATE_LIMIT_MAX_REQUESTS)) {
    sendJson(res, 429, { error: 'Too many attempts — please slow down.' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const password = String(body.password || '');
  if (!name || !email || !phone || !password) {
    sendJson(res, 400, { error: 'Name, email, phone, and password are all required.' });
    return;
  }
  if (password.length < 4) {
    sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
    return;
  }
  const users = loadUsersFromDisk();
  if (users.find((u) => u.email === email)) {
    sendJson(res, 409, { error: 'Email already registered.' });
    return;
  }
  const newUser = {
    id: Date.now(),
    name,
    email,
    phone,
    passwordHash: hashPassword(password),
    rating: 5,
    reviews: [],
    isAdmin: false,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  saveUsersToDisk(users);
  const token = createSession({ userId: newUser.id });
  sendJson(res, 201, { token, user: publicUser(newUser) });
}

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip, authRateLimitHits, AUTH_RATE_LIMIT_MAX_REQUESTS)) {
    sendJson(res, 429, { error: 'Too many attempts — please slow down.' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const users = loadUsersFromDisk();
  const user = users.find((u) => u.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    sendJson(res, 401, { error: 'Invalid email or password.' });
    return;
  }
  const token = createSession({ userId: user.id });
  sendJson(res, 200, { token, user: publicUser(user) });
}

async function handleGuestLogin(req, res) {
  let body = {};
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch {
    // A body isn't required for guest login — an empty/invalid one just
    // means "use the default name".
  }
  const guestUser = {
    id: Date.now(),
    name: String(body.name || 'Guest').slice(0, 100),
    email: 'guest@example.com',
    phone: '',
    rating: 5,
    reviews: [],
    isAdmin: false,
    isGuest: true,
  };
  const token = createSession({ guestUser });
  sendJson(res, 201, { token, user: guestUser });
}

async function handleLogout(req, res) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (match) deleteSession(match[1]);
  res.writeHead(204);
  res.end();
}

async function handleMe(req, res) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  sendJson(res, 200, user);
}

// Self-service account deletion — required for app-store compliance (Apple
// Guideline 5.1.1(v): any app that lets someone create an account must also
// let them delete it in the app, not just by emailing support). Cascades to
// every listing/ride/club this account owns, same as the admin-only
// handleDeleteUser, plus its own sessions.
async function handleDeleteMe(req, res) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  if (user.isGuest) {
    // Nothing persisted to delete — just drop the session like logout.
    const header = req.headers['authorization'] || '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match) deleteSession(match[1]);
    res.writeHead(204);
    res.end();
    return;
  }

  const users = loadUsersFromDisk();
  const idx = users.findIndex((u) => u.id === user.id);
  if (idx === -1) { sendJson(res, 404, { error: 'Account not found.' }); return; }
  if (users[idx].isAdmin) {
    const remainingAdmins = users.filter((u) => u.isAdmin && u.id !== user.id).length;
    if (remainingAdmins === 0) {
      sendJson(res, 400, { error: 'You are the only remaining admin — grant admin to someone else before deleting this account.' });
      return;
    }
  }

  users.splice(idx, 1);
  saveUsersToDisk(users);

  // Drop every session for this account, not just the one making this
  // request — a deleted account shouldn't stay "logged in" anywhere else.
  for (const [token, session] of sessions.entries()) {
    if (session.userId === user.id) sessions.delete(token);
  }
  saveSessionsToDisk();

  const products = loadProductsFromDisk().filter((p) => String(p.sellerId) !== String(user.id));
  saveProductsToDisk(products);
  const rides = loadRidesFromDisk().filter((r) => String(r.organizerId) !== String(user.id));
  saveRidesToDisk(rides);
  const clubs = loadClubsFromDisk().filter((c) => String(c.ownerId) !== String(user.id));
  saveClubsToDisk(clubs);

  res.writeHead(204);
  res.end();
}

async function handleListUsers(req, res) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  if (!user.isAdmin) { sendJson(res, 403, { error: 'Admin access required.' }); return; }
  sendJson(res, 200, loadUsersFromDisk().map(publicUser));
}

async function handleUpdateUser(req, res, id) {
  const authUser = getAuthUser(req);
  if (!authUser) { sendUnauthorized(res); return; }
  if (!authUser.isAdmin) { sendJson(res, 403, { error: 'Admin access required.' }); return; }
  let body;
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const users = loadUsersFromDisk();
  const idx = users.findIndex((u) => String(u.id) === String(id));
  if (idx === -1) { sendJson(res, 404, { error: 'User not found' }); return; }

  // The only thing this endpoint is for — granting/revoking admin. Anything
  // else in the body (password, email, ...) is ignored rather than trusted.
  if (typeof body.isAdmin === 'boolean') {
    if (!body.isAdmin) {
      const remainingAdmins = users.filter((u) => u.isAdmin && String(u.id) !== String(id)).length;
      if (remainingAdmins === 0) {
        sendJson(res, 400, { error: 'Cannot remove admin access from the only remaining admin.' });
        return;
      }
    }
    users[idx].isAdmin = body.isAdmin;
    saveUsersToDisk(users);
  }
  sendJson(res, 200, publicUser(users[idx]));
}

async function handleDeleteUser(req, res, id) {
  const authUser = getAuthUser(req);
  if (!authUser) { sendUnauthorized(res); return; }
  if (!authUser.isAdmin) { sendJson(res, 403, { error: 'Admin access required.' }); return; }
  const users = loadUsersFromDisk();
  const idx = users.findIndex((u) => String(u.id) === String(id));
  if (idx === -1) { sendJson(res, 404, { error: 'User not found' }); return; }
  if (users[idx].isAdmin) {
    const remainingAdmins = users.filter((u) => u.isAdmin && String(u.id) !== String(id)).length;
    if (remainingAdmins === 0) {
      sendJson(res, 400, { error: 'Cannot delete the only remaining admin.' });
      return;
    }
  }
  users.splice(idx, 1);
  saveUsersToDisk(users);
  res.writeHead(204);
  res.end();
}

// Step 1 of the in-app password reset (this app has no email service to
// actually deliver a reset link, so — same as before this migration —
// knowing the email address is the only "verification" there is). Only
// confirms whether an account exists; the response never includes anything
// sensitive.
// Always responds with the same generic message regardless of whether the
// email is registered — both to stop someone enumerating real accounts by
// email, and because the *only* thing that can actually change a password
// is a valid emailed token (see handleResetPassword). If it is registered,
// that token is generated here and mailed out; nothing about it is ever
// returned in this response.
async function handleForgotPassword(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip, authRateLimitHits, AUTH_RATE_LIMIT_MAX_REQUESTS)) {
    sendJson(res, 429, { error: 'Too many attempts — please slow down.' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  const user = loadUsersFromDisk().find((u) => u.email === email);
  if (user) {
    const token = createPasswordResetToken(user.id);
    const appUrl = process.env.APP_PUBLIC_URL || 'https://pedalexbikes.com';
    const resetUrl = `${appUrl}/?resetToken=${token}`;
    if (!process.env.RESEND_API_KEY) {
      // No email service configured — fail safe (no email sent, no token
      // leaked to the client) rather than falling back to the old
      // no-verification behavior. Logged so this is easy to notice locally.
      console.warn(`RESEND_API_KEY not set — password reset email NOT sent to ${email}. Reset URL (for local testing only): ${resetUrl}`);
    } else {
      try {
        await sendEmail({
          to: user.email,
          subject: 'Reset your Pedalex password',
          html: buildResetEmailHtml(user.name, resetUrl),
        });
      } catch (e) {
        console.error('Failed to send password reset email:', e);
      }
    }
  }
  sendJson(res, 200, { message: 'If that email is registered, a reset link has been sent.' });
}

// The token is the only proof of email ownership this accepts — see
// createPasswordResetToken/consumePasswordResetToken above. Single-use: a
// second attempt with the same link gets the same "invalid" response as a
// token that never existed.
async function handleResetPassword(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip, authRateLimitHits, AUTH_RATE_LIMIT_MAX_REQUESTS)) {
    sendJson(res, 429, { error: 'Too many attempts — please slow down.' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const token = String(body.token || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 4) {
    sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
    return;
  }
  const userId = token ? consumePasswordResetToken(token) : null;
  if (userId === null) {
    sendJson(res, 400, { error: 'This reset link is invalid or has expired.' });
    return;
  }
  const users = loadUsersFromDisk();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) { sendJson(res, 404, { error: 'Account not found.' }); return; }
  users[idx].passwordHash = hashPassword(newPassword);
  saveUsersToDisk(users);

  // A password reset is exactly when you want every *other* logged-in
  // session (e.g. an attacker's, if this was them getting locked out) to
  // stop working, not just leave them all valid.
  for (const [t, session] of sessions.entries()) {
    if (session.userId === userId) sessions.delete(t);
  }
  saveSessionsToDisk();

  sendJson(res, 200, { ok: true });
}

// Looks accounts up by phone (the login identifier is email, so it can't
// very well be recovered by asking for itself). Emails come back masked
// ("jo**@example.com") — this is still a limited-purpose recovery flow with
// no real proof of phone ownership, same trust level as before this
// migration, just no longer exposing the raw email or the full user list.
async function handleForgotUsername(req, res) {
  let body;
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const phone = String(body.phone || '').trim();
  const matches = loadUsersFromDisk().filter((u) => u.phone && u.phone === phone);
  const emails = matches.map((u) => maskEmail(u.email));
  sendJson(res, 200, { emails });
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return email || '';
  const visibleLen = Math.min(2, local.length);
  const visible = local.slice(0, visibleLen);
  return `${visible}${'*'.repeat(Math.max(1, local.length - visibleLen))}@${domain}`;
}

// ---- Products API -------------------------------------------------------------
// A flat JSON file acts as the shared "database" for product listings — good
// enough for a small marketplace demo, and simple to inspect/reset by hand.
// Users, messages, and moderation state still live in each browser's own
// localStorage; only product listings are shared across visitors here.

const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const PRODUCT_MAX_BODY_BYTES = 8_000_000; // generous — product images are base64-encoded

// A fresh deployment (or a deleted products.json) starts with no listings —
// only real ones from real users.
function loadProductsFromDisk() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    fs.writeFileSync(PRODUCTS_FILE, '[]');
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Error reading products.json, treating as empty:', e);
    return [];
  }
}

function saveProductsToDisk(products) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); return; }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleGetProducts(req, res) {
  sendJson(res, 200, loadProductsFromDisk());
}

// ---- AI moderation for new listings -----------------------------------------
// A new listing starts "pending" either way — this only decides whether it
// gets bumped straight to "approved" or left for a human in the admin queue.
// Deliberately conservative: anything the model isn't confident about, or
// any failure in this whole path (no API key, bad response, network error),
// falls back to "review" rather than "approve". Getting a false "review" on
// a fine listing just costs the admin one click later; a false "approve" on
// a bad one is live on the site until someone notices.
async function moderateProductListing(product) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { decision: 'review', reason: 'لم يتم إعداد المراجعة الذكية (لا يوجد مفتاح API).' };
  }
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    console.error('AI moderation: could not load @anthropic-ai/sdk:', e);
    return { decision: 'review', reason: 'المراجعة الذكية غير متاحة حالياً.' };
  }

  const summary = {
    name: product.name,
    type: product.type,
    price: product.price,
    size: product.size,
    condition: product.condition,
    frameMaterial: product.frameMaterial,
    notes: product.notes,
    hasPhoto: !!product.image,
  };

  const prompt = `You are a moderation assistant for Pedalex, a classifieds marketplace for bikes and cycling gear in the UAE. A seller just submitted this new listing:

${JSON.stringify(summary, null, 2)}

Decide "approve" only if ALL of these hold:
- It's clearly a real bike or cycling-related accessory (not an unrelated item, service, or spam).
- It has a real name/title and a sane, non-zero price for that kind of item.
- The notes/description contain no scam red flags: no request to pay or contact outside the platform via a suspicious link, no phone/email harvesting, no illegal or prohibited content, no hate speech.
- Nothing about the listing looks incomplete, contradictory, or exploitative (e.g. price wildly mismatched to the described item).

Otherwise decide "review" — and whenever you're genuinely unsure, choose "review" rather than guessing "approve".

Respond with ONLY a JSON object, no other text: {"decision": "approve" | "review", "reason": "<one short sentence in Arabic explaining the decision, for the marketplace admin>"}`;

  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (res.content || []).find((b) => b.type === 'text')?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { decision: 'review', reason: 'تعذّر فهم رد المراجعة الذكية.' };
    const parsed = JSON.parse(match[0]);
    if (parsed.decision !== 'approve' && parsed.decision !== 'review') {
      return { decision: 'review', reason: 'رد المراجعة الذكية غير صالح.' };
    }
    return { decision: parsed.decision, reason: String(parsed.reason || '').slice(0, 300) };
  } catch (e) {
    console.error('AI listing moderation failed:', e);
    return { decision: 'review', reason: 'حدث خطأ أثناء المراجعة الذكية.' };
  }
}

async function handleCreateProduct(req, res) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  let body;
  try {
    body = await readJsonBody(req, PRODUCT_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const products = loadProductsFromDisk();
  // Server assigns id/createdAt — never trust a client-supplied id, it could
  // collide with an existing listing. sellerId/status are likewise always
  // set from the authenticated user/server, not the request body — otherwise
  // anyone could publish a listing already marked "approved" and owned by
  // someone else.
  const newProduct = {
    ...body,
    id: Date.now(),
    createdAt: new Date().toISOString(),
    sellerId: user.id,
    status: 'pending',
  };

  const moderation = await moderateProductListing(newProduct);
  newProduct.aiDecision = moderation.decision;
  newProduct.aiReason = moderation.reason;
  if (moderation.decision === 'approve') {
    newProduct.status = 'approved';
  } else {
    newProduct.adminNotes = moderation.reason;
  }

  products.push(newProduct);
  saveProductsToDisk(products);
  sendJson(res, 201, newProduct);
}

async function handleUpdateProduct(req, res, id) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  let body;
  try {
    body = await readJsonBody(req, PRODUCT_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const products = loadProductsFromDisk();
  const idx = products.findIndex((p) => String(p.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Product not found' });
    return;
  }
  const product = products[idx];
  const isOwner = String(product.sellerId) === String(user.id);

  // Special case: "favorite" clicks come from any visitor, not just the
  // owner — but only ever touch the favorites count, nothing else, and the
  // server computes the new value itself rather than trusting a
  // client-supplied number.
  const isFavoriteOnly = Object.keys(body).length === 1 && 'favorites' in body;
  if (isFavoriteOnly) {
    products[idx] = { ...product, favorites: (product.favorites || 0) + 1 };
    saveProductsToDisk(products);
    sendJson(res, 200, products[idx]);
    return;
  }

  if (!isOwner && !user.isAdmin) {
    sendJson(res, 403, { error: 'You can only edit your own listings.' });
    return;
  }

  // Moderation fields are admin-only — a seller PATCHing their own listing
  // can't self-approve or clear a rejection note this way.
  const nextBody = { ...body };
  if (!user.isAdmin) {
    delete nextBody.status;
    delete nextBody.adminNotes;
  }

  // Partial merge (PATCH semantics) — callers send only the fields changing
  // (availability, moderation status, ...). id/sellerId never change after
  // creation, regardless of who's asking.
  products[idx] = { ...product, ...nextBody, id: product.id, sellerId: product.sellerId };
  saveProductsToDisk(products);
  sendJson(res, 200, products[idx]);
}

async function handleDeleteProduct(req, res, id) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  const products = loadProductsFromDisk();
  const idx = products.findIndex((p) => String(p.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Product not found' });
    return;
  }
  if (String(products[idx].sellerId) !== String(user.id) && !user.isAdmin) {
    sendJson(res, 403, { error: 'You can only delete your own listings.' });
    return;
  }
  products.splice(idx, 1);
  saveProductsToDisk(products);
  res.writeHead(204);
  res.end();
}

// ---- Rides API ----------------------------------------------------------------
// Group bike rides: browse rides, create one, request to join, and (as the
// organizer) accept/reject requests. Needs the same server-shared storage as
// products — two different visitors must see and act on the same ride data
// (an organizer accepting a request only makes sense if both people are
// looking at the same record) — so it follows that file's exact pattern
// rather than living in localStorage like users/messages do.

const RIDES_FILE = path.join(DATA_DIR, 'rides.json');
const RIDE_MAX_BODY_BYTES = 200_000; // plain text/number fields only, no images

// A fresh deployment starts with no rides — only real ones from real users.
function loadRidesFromDisk() {
  if (!fs.existsSync(RIDES_FILE)) {
    fs.writeFileSync(RIDES_FILE, '[]');
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RIDES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Error reading rides.json, treating as empty:', e);
    return [];
  }
}

function saveRidesToDisk(rides) {
  fs.writeFileSync(RIDES_FILE, JSON.stringify(rides, null, 2));
}

async function handleGetRides(req, res) {
  sendJson(res, 200, loadRidesFromDisk());
}

async function handleCreateRide(req, res) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  let body;
  try {
    body = await readJsonBody(req, RIDE_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const rides = loadRidesFromDisk();
  // Server assigns id/createdAt, same reasoning as products — never trust a
  // client-supplied id. organizerId is likewise always the authenticated
  // user (whoever creates a ride is its organizer, by definition), and it
  // always starts with them as the sole participant and no requests yet —
  // otherwise a request body could forge fake pre-existing requests.
  const newRide = {
    ...body,
    id: Date.now(),
    createdAt: new Date().toISOString(),
    organizerId: user.id,
    organizerName: user.name,
    participants: [{ userId: user.id, name: user.name }],
    pendingRequests: [],
  };
  rides.push(newRide);
  saveRidesToDisk(rides);
  sendJson(res, 201, newRide);
}

// A non-organizer is only ever allowed to touch their own entry in
// `participants`/`pendingRequests` (join, leave, or cancel their own
// request) — never anyone else's, and never any other field. Returns true
// if `body` only makes changes of that shape relative to `ride`.
function isSelfServiceRideEdit(ride, body, userId) {
  const allowedKeys = ['participants', 'pendingRequests'];
  for (const key of Object.keys(body)) {
    if (!allowedKeys.includes(key)) return false;
  }
  for (const key of allowedKeys) {
    if (!(key in body)) continue;
    const before = ride[key] || [];
    const after = body[key] || [];
    if (!Array.isArray(after)) return false;
    const stringify = (arr) => new Set(arr.map((e) => JSON.stringify(e)));
    const beforeSet = stringify(before);
    const afterSet = stringify(after);
    const touched = [
      ...before.filter((e) => !afterSet.has(JSON.stringify(e))),
      ...after.filter((e) => !beforeSet.has(JSON.stringify(e))),
    ];
    for (const entry of touched) {
      if (String(entry.userId) !== String(userId)) return false;
    }
  }
  return true;
}

async function handleUpdateRide(req, res, id) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  let body;
  try {
    body = await readJsonBody(req, RIDE_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const rides = loadRidesFromDisk();
  const idx = rides.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Ride not found' });
    return;
  }
  const ride = rides[idx];
  const isOrganizer = String(ride.organizerId) === String(user.id);

  if (!isOrganizer && !user.isAdmin && !isSelfServiceRideEdit(ride, body, user.id)) {
    sendJson(res, 403, {
      error: 'You can only join, leave, or cancel your own request — only the organizer can change other details.',
    });
    return;
  }

  // Partial merge (PATCH semantics) — the client computes the next
  // participants/pendingRequests array (join/leave/accept/reject all just
  // send the updated array) and this merges it in. id/organizerId never
  // change after creation.
  rides[idx] = { ...ride, ...body, id: ride.id, organizerId: ride.organizerId };
  saveRidesToDisk(rides);
  sendJson(res, 200, rides[idx]);
}

async function handleDeleteRide(req, res, id) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  const rides = loadRidesFromDisk();
  const idx = rides.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Ride not found' });
    return;
  }
  if (String(rides[idx].organizerId) !== String(user.id) && !user.isAdmin) {
    sendJson(res, 403, { error: 'Only the organizer can delete this ride.' });
    return;
  }
  rides.splice(idx, 1);
  saveRidesToDisk(rides);
  res.writeHead(204);
  res.end();
}

// ---- Clubs API ----------------------------------------------------------------
// A directory of recurring WhatsApp cycling clubs/groups — distinct from
// Rides (which are single scheduled events with an accept/reject join flow).
// Clubs are just self-service directory entries: whoever adds one owns it
// and can remove it later, same ownership pattern as products' sellerId.

const CLUBS_FILE = path.join(DATA_DIR, 'clubs.json');
const CLUB_MAX_BODY_BYTES = 50_000; // plain text fields only

function loadClubsFromDisk() {
  if (!fs.existsSync(CLUBS_FILE)) {
    fs.writeFileSync(CLUBS_FILE, '[]');
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CLUBS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Error reading clubs.json, treating as empty:', e);
    return [];
  }
}

function saveClubsToDisk(clubs) {
  fs.writeFileSync(CLUBS_FILE, JSON.stringify(clubs, null, 2));
}

async function handleGetClubs(req, res) {
  sendJson(res, 200, loadClubsFromDisk());
}

async function handleCreateClub(req, res) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  let body;
  try {
    body = await readJsonBody(req, CLUB_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const clubs = loadClubsFromDisk();
  const newClub = {
    ...body,
    id: Date.now(),
    createdAt: new Date().toISOString(),
    ownerId: user.id,
    ownerName: user.name,
  };
  clubs.push(newClub);
  saveClubsToDisk(clubs);
  sendJson(res, 201, newClub);
}

async function handleUpdateClub(req, res, id) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  let body;
  try {
    body = await readJsonBody(req, CLUB_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const clubs = loadClubsFromDisk();
  const idx = clubs.findIndex((c) => String(c.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Club not found' });
    return;
  }
  if (String(clubs[idx].ownerId) !== String(user.id) && !user.isAdmin) {
    sendJson(res, 403, { error: 'You can only edit your own club.' });
    return;
  }
  clubs[idx] = { ...clubs[idx], ...body, id: clubs[idx].id, ownerId: clubs[idx].ownerId };
  saveClubsToDisk(clubs);
  sendJson(res, 200, clubs[idx]);
}

async function handleDeleteClub(req, res, id) {
  const user = getAuthUser(req);
  if (!user) { sendUnauthorized(res); return; }
  const clubs = loadClubsFromDisk();
  const idx = clubs.findIndex((c) => String(c.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Club not found' });
    return;
  }
  if (String(clubs[idx].ownerId) !== String(user.id) && !user.isAdmin) {
    sendJson(res, 403, { error: 'You can only delete your own club.' });
    return;
  }
  clubs.splice(idx, 1);
  saveClubsToDisk(clubs);
  res.writeHead(204);
  res.end();
}

// ---- Security headers ---------------------------------------------------------
// Wraps res.writeHead once per request so every response — from every
// handler above, present and future — gets these without having to touch
// each individual res.writeHead()/sendJson() call site. A handler can still
// override any of these by setting the same header itself.
function applySecurityHeaders(res) {
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, headersOrReason, maybeHeaders) => {
    const reasonGiven = typeof headersOrReason === 'string';
    const ownHeaders = (reasonGiven ? maybeHeaders : headersOrReason) || {};
    const merged = {
      // Stops browsers from "helpfully" guessing a different content type
      // than what's declared — the classic vector for a file upload/user
      // content endpoint to be reinterpreted as HTML/script.
      'X-Content-Type-Options': 'nosniff',
      // This site is never meant to be embedded in someone else's page —
      // blocks clickjacking (an invisible iframe of this site laid over
      // fake UI to trick clicks into e.g. deleting a listing).
      'X-Frame-Options': 'DENY',
      // Don't leak the full URL (which can contain a product id, a search
      // query, etc.) to third-party sites linked from this one.
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // Render already terminates HTTPS in front of this app; this tells
      // browsers to remember that and never fall back to plain HTTP for it.
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      // Nothing on this site uses the camera/mic/location — explicitly
      // turning them off means an XSS bug elsewhere can't abuse them either.
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
      // The native iOS/Android app loads this page from its own local
      // origin (capacitor://localhost) and calls this API cross-origin.
      // Without these, the browser inside the app silently blocks every
      // request — auth (Bearer tokens, not cookies) doesn't need this
      // locked to one origin, so '*' is safe here.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...ownHeaders,
    };
    return reasonGiven
      ? originalWriteHead(statusCode, headersOrReason, merged)
      : originalWriteHead(statusCode, merged);
  };
}

// ---- Router -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);
  const urlPath = safeDecodeUrlPath(req.url);
  if (urlPath === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  // Browsers send an OPTIONS preflight before the real cross-origin
  // request (e.g. every POST/PATCH/DELETE call the native app makes).
  // Answer it immediately with the CORS headers above and skip the router.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/chat') {
    handleChat(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/contact') { handleContact(req, res); return; }

  if (req.method === 'GET' && urlPath === '/webhook/whatsapp') { handleWhatsAppVerify(req, res); return; }
  if (req.method === 'POST' && urlPath === '/webhook/whatsapp') { handleWhatsAppMessage(req, res); return; }

  if (req.method === 'POST' && urlPath === '/api/auth/register') { handleRegister(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/login') { handleLogin(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/guest') { handleGuestLogin(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/logout') { handleLogout(req, res); return; }
  if (req.method === 'GET' && urlPath === '/api/auth/me') { handleMe(req, res); return; }
  if (req.method === 'DELETE' && urlPath === '/api/auth/me') { handleDeleteMe(req, res); return; }
  if (req.method === 'GET' && urlPath === '/api/auth/users') { handleListUsers(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/forgot-password') { handleForgotPassword(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/reset-password') { handleResetPassword(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/forgot-username') { handleForgotUsername(req, res); return; }

  const userMatch = urlPath.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (userMatch) {
    const id = userMatch[1];
    if (req.method === 'PATCH') { handleUpdateUser(req, res, id); return; }
    if (req.method === 'DELETE') { handleDeleteUser(req, res, id); return; }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  const productMatch = urlPath.match(/^\/api\/products(?:\/([^/]+))?$/);
  if (productMatch) {
    const id = productMatch[1];
    if (req.method === 'GET' && !id) { handleGetProducts(req, res); return; }
    if (req.method === 'POST' && !id) { handleCreateProduct(req, res); return; }
    if (req.method === 'PATCH' && id) { handleUpdateProduct(req, res, id); return; }
    if (req.method === 'DELETE' && id) { handleDeleteProduct(req, res, id); return; }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  const rideMatch = urlPath.match(/^\/api\/rides(?:\/([^/]+))?$/);
  if (rideMatch) {
    const id = rideMatch[1];
    if (req.method === 'GET' && !id) { handleGetRides(req, res); return; }
    if (req.method === 'POST' && !id) { handleCreateRide(req, res); return; }
    if (req.method === 'PATCH' && id) { handleUpdateRide(req, res, id); return; }
    if (req.method === 'DELETE' && id) { handleDeleteRide(req, res, id); return; }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  const clubMatch = urlPath.match(/^\/api\/clubs(?:\/([^/]+))?$/);
  if (clubMatch) {
    const id = clubMatch[1];
    if (req.method === 'GET' && !id) { handleGetClubs(req, res); return; }
    if (req.method === 'POST' && !id) { handleCreateClub(req, res); return; }
    if (req.method === 'PATCH' && id) { handleUpdateClub(req, res, id); return; }
    if (req.method === 'DELETE' && id) { handleDeleteClub(req, res, id); return; }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
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
  // 0.0.0.0 means "all interfaces" — not itself a browsable address, so print
  // localhost for local runs while still reporting the real bind host.
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`  ➜  http://${displayHost}:${PORT}/  (bound to ${HOST})`);
  console.log(
    process.env.ANTHROPIC_API_KEY
      ? '  ✓ ANTHROPIC_API_KEY is set — chat widget is live.'
      : '  ⚠ ANTHROPIC_API_KEY is not set — chat widget will return an error until it is.'
  );
  console.log('Press Ctrl+C to stop.');
});
