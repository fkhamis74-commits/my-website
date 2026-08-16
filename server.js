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

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
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

const USERS_FILE = path.join(ROOT, 'users.json');
const SESSIONS_FILE = path.join(ROOT, 'sessions.json');
const AUTH_MAX_BODY_BYTES = 20_000; // plain text fields only
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Same default admin the client used to seed into localStorage (id: 1,
// admin@bikestore.com / admin123) — kept so anyone who already knew those
// demo credentials still gets in after this migration. Change the password
// after first login.
function seedDefaultUsers() {
  return [
    {
      id: 1,
      name: 'Admin',
      email: 'admin@bikestore.com',
      phone: '',
      passwordHash: hashPassword('admin123'),
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
async function handleForgotPassword(req, res) {
  let body;
  try {
    body = await readJsonBody(req, AUTH_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const email = String(body.email || '').trim().toLowerCase();
  const user = loadUsersFromDisk().find((u) => u.email === email);
  sendJson(res, 200, user ? { found: true, name: user.name } : { found: false });
}

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
  const email = String(body.email || '').trim().toLowerCase();
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 4) {
    sendJson(res, 400, { error: 'Password must be at least 4 characters.' });
    return;
  }
  const users = loadUsersFromDisk();
  const idx = users.findIndex((u) => u.email === email);
  if (idx === -1) { sendJson(res, 404, { error: 'Email not registered.' }); return; }
  users[idx].passwordHash = hashPassword(newPassword);
  saveUsersToDisk(users);
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

const PRODUCTS_FILE = path.join(ROOT, 'products.json');
const PRODUCT_MAX_BODY_BYTES = 8_000_000; // generous — product images are base64-encoded

// Same starting inventory the app used to seed into localStorage, so a fresh
// deployment (or a deleted products.json) shows the same demo listings.
const DEMO_PRODUCTS = [
  {
    id: 10001,
    name: 'Cervelo R5 Disc',
    type: 'road',
    price: 14500,
    originalPrice: 22000,
    size: '54 cm (M)',
    condition: 'ممتازة (مفحوصة)',
    groupset: 'Shimano Ultegra Di2',
    frameMaterial: 'Carbon',
    location: 'دبي - الإمارات',
    locationEn: 'Dubai - UAE',
    sellerName: 'فهد عبدالله',
    sellerNameEn: 'Fahad Abdullah',
    sellerPhone: '+971500000001',
    sellerEmail: 'seller1@example.com',
    sellerRating: '4.9 ★',
    image: 'https://images.unsplash.com/photo-1485965120184-e220f721d03e?auto=format&fit=crop&w=600&q=80',
    notes: 'دراجة طريق احترافية بحالة ممتازة، الصيانة دورية مع غيارات إلكترونية Di2، لم تتعرض لأي حوادث.',
    notesEn: 'High-performance road bike in excellent condition. Regularly serviced with electronic Di2 shifting and no crash history.',
    createdAt: '2026-07-30T10:00:00.000Z',
    favorites: 0,
    sellerId: 9000,
    availability: 'available',
    status: 'approved',
  },
  {
    id: 10002,
    name: 'Scott Spark RC Team',
    type: 'mountain',
    price: 9800,
    originalPrice: 15000,
    size: 'L',
    condition: 'جيدة جداً',
    groupset: 'SRAM GX Eagle',
    frameMaterial: 'Carbon',
    location: 'أبوظبي - الإمارات',
    locationEn: 'Abu Dhabi - UAE',
    sellerName: 'علي المنصوري',
    sellerNameEn: 'Ali Al Mansoori',
    sellerPhone: '+971500000002',
    sellerEmail: 'seller2@example.com',
    sellerRating: '4.8 ★',
    image: 'https://images.unsplash.com/photo-1532298229144-0ec0c57515c7?auto=format&fit=crop&w=600&q=80',
    notes: 'دراجة جبلية بامتياز مع نظام تعليق مزدوج كامل ومناسبة للمسارات الجبلية والوعرة.',
    notesEn: 'Top-tier mountain bike with full dual suspension, ideal for rough and technical trails.',
    createdAt: '2026-07-31T10:00:00.000Z',
    favorites: 0,
    sellerId: 9001,
    availability: 'available',
    status: 'approved',
  },
  {
    id: 10003,
    name: 'Specialized Sirrus X 4.0',
    type: 'hybrid',
    price: 3200,
    originalPrice: 4800,
    size: 'M',
    condition: 'ممتازة',
    groupset: 'Shimano Deore',
    frameMaterial: 'Aluminum',
    location: 'الشارقة - الإمارات',
    locationEn: 'Sharjah - UAE',
    sellerName: 'أحمد الحمادي',
    sellerNameEn: 'Ahmed Al Hammadi',
    sellerPhone: '+971500000003',
    sellerEmail: 'seller3@example.com',
    sellerRating: '4.7 ★',
    image: 'https://images.unsplash.com/photo-1507035895480-2b3156c31fc8?auto=format&fit=crop&w=600&q=80',
    notes: 'دراجة هجين خفيفة ومريحة جداً للتنقل اليومي والتمارين الرياضية داخل المدينة.',
    notesEn: 'Light and comfortable hybrid bike, perfect for city commuting and everyday fitness rides.',
    createdAt: '2026-08-01T10:00:00.000Z',
    favorites: 0,
    sellerId: 9002,
    availability: 'reserved',
    status: 'approved',
  },
];

function loadProductsFromDisk() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(DEMO_PRODUCTS, null, 2));
    return DEMO_PRODUCTS;
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

const RIDES_FILE = path.join(ROOT, 'rides.json');
const RIDE_MAX_BODY_BYTES = 200_000; // plain text/number fields only, no images

// Neutral example rides for a fresh deployment — organizerId values (8000s)
// are demo-only and never collide with a real registered user's id (assigned
// via Date.now() at signup), so these never show as "mine" for an actual
// visitor, same as DEMO_PRODUCTS' sellerId convention above.
const DEMO_RIDES = [
  {
    id: 1,
    title: 'طلعة صباحية - مضمار جميرا',
    track: 'مضمار جميرا للدراجات',
    location: 'دبي - جميرا',
    startPoint: 'بوابة 2 - المضمار',
    date: '2026-08-15',
    time: '06:00',
    distance: 25,
    difficulty: 'medium',
    speed: '25-28 كم/س',
    bikeType: 'road',
    gender: 'mixed',
    level: 'intermediate',
    maxParticipants: 8,
    notes: 'الرجاء الالتزام بوقت الانطلاق وارتداء الخوذة.',
    organizerId: 8000,
    organizerName: 'سلطان الكعبي',
    createdAt: '2026-08-01T10:00:00.000Z',
    participants: [
      { userId: 8000, name: 'سلطان الكعبي' },
      { userId: null, name: 'محمد راشد' },
      { userId: null, name: 'خالد العلي' },
    ],
    pendingRequests: [],
  },
  {
    id: 2,
    title: 'طلعة جبلية - مسار الحجر',
    track: 'مسار الحجر الجبلي',
    location: 'رأس الخيمة',
    startPoint: 'مدخل المسار الرئيسي',
    date: '2026-08-20',
    time: '05:30',
    distance: 40,
    difficulty: 'hard',
    speed: '18-22 كم/س',
    bikeType: 'mtb',
    gender: 'male',
    level: 'advanced',
    maxParticipants: 6,
    notes: 'مسار جبلي وعر، يفضل وجود خبرة سابقة.',
    organizerId: 8001,
    organizerName: 'عبدالله سعيد',
    createdAt: '2026-08-02T10:00:00.000Z',
    participants: [
      { userId: 8001, name: 'عبدالله سعيد' },
    ],
    pendingRequests: [
      { id: 101, userId: null, name: 'ياسر فهد', note: 'دراجة MTB، مستوى متقدم، أرغب بالانضمام.' },
      { id: 102, userId: null, name: 'نواف حمد', note: 'شاركت في طلعات جبلية سابقة.' },
    ],
  },
  {
    id: 3,
    title: 'طلعة مسائية خفيفة - كورنيش أبوظبي',
    track: 'كورنيش أبوظبي',
    location: 'أبوظبي',
    startPoint: 'قرب مرسى أبوظبي',
    date: '2026-08-12',
    time: '17:30',
    distance: 15,
    difficulty: 'easy',
    speed: '18-20 كم/س',
    bikeType: 'any',
    gender: 'mixed',
    level: 'beginner',
    maxParticipants: 12,
    notes: '',
    organizerId: 8002,
    organizerName: 'مريم النعيمي',
    createdAt: '2026-08-03T10:00:00.000Z',
    participants: [
      { userId: 8002, name: 'مريم النعيمي' },
      { userId: null, name: 'سارة أحمد' },
    ],
    pendingRequests: [],
  },
];

function loadRidesFromDisk() {
  if (!fs.existsSync(RIDES_FILE)) {
    fs.writeFileSync(RIDES_FILE, JSON.stringify(DEMO_RIDES, null, 2));
    return DEMO_RIDES;
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

const CLUBS_FILE = path.join(ROOT, 'clubs.json');
const CLUB_MAX_BODY_BYTES = 50_000; // plain text fields only

const DEMO_CLUBS = [
  {
    id: 1,
    name: 'مجموعة القدرة الصباحية (Al Qudra Riders)',
    locationBadge: 'دبي - مسار القدرة',
    level: 'متوسط / محترف',
    description: 'تمارين أسبوعية منتظمة صباح كل سبت وأحد. متوسط السرعة بين 32 إلى 36 كم/ساعة.',
    schedule: 'السبت والأحد',
    whatsappLink: 'https://chat.whatsapp.com/',
    ownerId: 8100,
    ownerName: 'مجتمع القدرة',
    createdAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 2,
    name: 'مجتمع الحديريات للدراجات (Hudayriyat Social)',
    locationBadge: 'أبوظبي - جزيرة الحديريات',
    level: 'جميع المستويات',
    description: 'جولات مسائية خفيفة ومناسبة للمبتدئين والمتوسطين للاستمتاع بركوب الدراجة والتعارف.',
    schedule: 'الثلاثاء والخميس',
    whatsappLink: 'https://chat.whatsapp.com/',
    ownerId: 8101,
    ownerName: 'مجتمع الحديريات',
    createdAt: '2026-08-02T10:00:00.000Z',
  },
];

function loadClubsFromDisk() {
  if (!fs.existsSync(CLUBS_FILE)) {
    fs.writeFileSync(CLUBS_FILE, JSON.stringify(DEMO_CLUBS, null, 2));
    return DEMO_CLUBS;
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

// ---- Router -----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST' && urlPath === '/api/chat') {
    handleChat(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/auth/register') { handleRegister(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/login') { handleLogin(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/guest') { handleGuestLogin(req, res); return; }
  if (req.method === 'POST' && urlPath === '/api/auth/logout') { handleLogout(req, res); return; }
  if (req.method === 'GET' && urlPath === '/api/auth/me') { handleMe(req, res); return; }
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
