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
  let body;
  try {
    body = await readJsonBody(req, RIDE_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const rides = loadRidesFromDisk();
  // Server assigns id/createdAt, same reasoning as products — never trust a
  // client-supplied id.
  const newRide = { ...body, id: Date.now(), createdAt: new Date().toISOString() };
  rides.push(newRide);
  saveRidesToDisk(rides);
  sendJson(res, 201, newRide);
}

async function handleUpdateRide(req, res, id) {
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
  // Partial merge (PATCH semantics) — the client computes the next
  // participants/pendingRequests array (join/leave/accept/reject all just
  // send the updated array) and this merges it in, same pattern as
  // handleUpdateProduct.
  rides[idx] = { ...rides[idx], ...body, id: rides[idx].id };
  saveRidesToDisk(rides);
  sendJson(res, 200, rides[idx]);
}

async function handleDeleteRide(req, res, id) {
  const rides = loadRidesFromDisk();
  const idx = rides.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Ride not found' });
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
  let body;
  try {
    body = await readJsonBody(req, CLUB_MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, e.status || 400, { error: e.message });
    return;
  }
  const clubs = loadClubsFromDisk();
  const newClub = { ...body, id: Date.now(), createdAt: new Date().toISOString() };
  clubs.push(newClub);
  saveClubsToDisk(clubs);
  sendJson(res, 201, newClub);
}

async function handleUpdateClub(req, res, id) {
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
  clubs[idx] = { ...clubs[idx], ...body, id: clubs[idx].id };
  saveClubsToDisk(clubs);
  sendJson(res, 200, clubs[idx]);
}

async function handleDeleteClub(req, res, id) {
  const clubs = loadClubsFromDisk();
  const idx = clubs.findIndex((c) => String(c.id) === String(id));
  if (idx === -1) {
    sendJson(res, 404, { error: 'Club not found' });
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
