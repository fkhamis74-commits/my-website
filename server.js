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
  'height to suggest a frame size:\n' +
  '  165–172 cm -> size 50–52 (S)\n' +
  '  173–180 cm -> size 54 (M)\n' +
  '  181–188 cm -> size 56 (L)\n' +
  '  189+ cm   -> size 58+ (XL)\n' +
  'Once you know (or can estimate) a budget, size, or preferred brand, call ' +
  'the search_bikes tool to check the real, currently-available inventory — ' +
  'never invent or assume a listing exists without calling it first. If ' +
  'nothing matches, call search_bikes again with looser criteria (e.g. drop ' +
  'the brand, or raise maxPrice) and explain what differs about the closest ' +
  'option you found (price, size, condition, etc.).';

// Tool the model can call to check real, current inventory instead of
// guessing — see searchBikes() below for what actually runs.
const TOOLS = [
  {
    name: 'search_bikes',
    description: 'البحث في قاعدة بيانات الدراجات المعروضة بناءً على الميزانية والمقاس المناسب للطول.',
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
      },
    },
  },
];

// Only ever searches approved + available listings — reserved/sold/pending
// items are never surfaced to the assistant, so it can't recommend them.
function searchBikes(input) {
  const { maxPrice, size, brand } = input || {};
  return loadProductsFromDisk()
    .filter((p) => p.status === 'approved' && p.availability === 'available')
    .filter((p) => typeof maxPrice !== 'number' || p.price <= maxPrice)
    .filter((p) => !size || String(p.size).toLowerCase().includes(String(size).toLowerCase()))
    .filter((p) => !brand || String(p.name).toLowerCase().includes(String(brand).toLowerCase()))
    .map((p) => ({
      name: p.name,
      type: p.type,
      price: p.price,
      size: p.size,
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
  let body;
  try {
    body = await readJsonBody(req, PRODUCT_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const products = loadProductsFromDisk();
  // Server assigns id/createdAt — never trust a client-supplied id, it could
  // collide with an existing listing.
  const newProduct = { ...body, id: Date.now(), createdAt: new Date().toISOString() };
  products.push(newProduct);
  saveProductsToDisk(products);
  sendJson(res, 201, newProduct);
}

async function handleUpdateProduct(req, res, id) {
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
  // Partial merge (PATCH semantics) — callers send only the fields changing
  // (availability, moderation status, favorites count, ...).
  products[idx] = { ...products[idx], ...body, id: products[idx].id };
  saveProductsToDisk(products);
  sendJson(res, 200, products[idx]);
}

async function handleDeleteProduct(req, res, id) {
  const products = loadProductsFromDisk();
  const idx = products.findIndex((p) => String(p.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Product not found' });
    return;
  }
  products.splice(idx, 1);
  saveProductsToDisk(products);
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
