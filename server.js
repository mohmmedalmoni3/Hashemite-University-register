const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 10000);
const isProduction = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const MAX_BODY = 16 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const POOL_KEY = Symbol.for('ieee-day.registration.pg-pool');
// Reuse one small pool per Node isolate, including across serverless invocations.
const pool = DATABASE_URL ? (globalThis[POOL_KEY] ||= new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
  query_timeout: 12000,
  statement_timeout: 10000
})) : null;
const rateLimits = new Map();

const RETRYABLE_DB_CODES = new Set([
  '08000', '08001', '08003', '08006', '08007', '08P01', '57P01', '57P02', '57P03',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENETUNREACH'
]);

function isRetryableDatabaseError(error) {
  return RETRYABLE_DB_CODES.has(error.code) || String(error.code || '').startsWith('08');
}

async function queryWithRetry(text, values) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await pool.query(text, values); }
    catch (error) {
      if (!isRetryableDatabaseError(error) || attempt >= 2) throw error;
      // Neon may need a moment to wake a suspended compute on the first query.
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

if (pool) pool.on('error', error => console.error('Idle database client error', { code: error.code || 'unknown' }));

function json(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function sessionToken(expires) {
  const payload = Buffer.from(JSON.stringify({ exp: expires })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(req) {
  if (!SESSION_SECRET) return false;
  const token = cookies(req).hu_admin_session || '';
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

function cookie(value, maxAge) {
  return `hu_admin_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`;
}

function registrationDeviceCookie(value) {
  return `hu_registration_device=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isProduction ? '; Secure' : ''}`;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Render يضع التطبيق خلف Reverse Proxy: عنوان العميل الحقيقي في X-Forwarded-For
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, key, limit, windowMs) {
  const now = Date.now();
  const id = `${key}:${clientIp(req)}`;
  const state = rateLimits.get(id);
  if (!state || state.until <= now) { rateLimits.set(id, { count: 1, until: now + windowMs }); return false; }
  state.count += 1;
  return state.count > limit;
}

// تنظيف دوري للعدّادات المنتهية
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of rateLimits) if (state.until <= now) rateLimits.delete(id);
}, 10 * 60 * 1000).unref();

async function bodyJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw Object.assign(new Error('too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩۰-۹]/g, char => {
    const arabic = '٠١٢٣٤٥٦٧٨٩'.indexOf(char);
    return String(arabic < 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(char) : arabic);
  });
}

function normalizePhone(value) {
  let phone = normalizeDigits(value).replace(/[\s()-]/g, '');
  if (/^\+?962/.test(phone)) phone = `0${phone.replace(/^\+?962/, '')}`;
  return phone;
}

function cleanRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'request' };
  for (const key of ['fullName', 'phone', 'email', 'major', 'year']) {
    if (typeof input[key] !== 'string') return { error: key };
  }
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  const phone = normalizePhone(input.phone);
  const email = input.email.trim().toLowerCase();
  const major = input.major.trim();
  const year = input.year.trim();
  if (fullName.split(' ').length < 4 || fullName.length > 160) return { error: 'fullName' };
  if (!/^07[789]\d{7}$/.test(phone)) return { error: 'phone' };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'email' };
  if (!major || major.length > 120) return { error: 'major' };
  if (!year || year.length > 80) return { error: 'year' };
  if (input.consent !== true) return { error: 'consent' };
  return { value: { fullName, phone, email, major, year } };
}

async function initDatabase() {
  await queryWithRetry(`CREATE TABLE IF NOT EXISTS registrants (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    device_hash TEXT,
    major TEXT NOT NULL,
    study_year TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await queryWithRetry('ALTER TABLE registrants ADD COLUMN IF NOT EXISTS device_hash TEXT');
  await queryWithRetry('CREATE UNIQUE INDEX IF NOT EXISTS registrants_email_unique ON registrants (LOWER(email))');
  await queryWithRetry('CREATE UNIQUE INDEX IF NOT EXISTS registrants_device_hash_unique ON registrants (device_hash) WHERE device_hash IS NOT NULL');
}

function sendFile(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(ROOT, `.${decodeURIComponent(requested)}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) return false;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const extension = path.extname(filePath);
  const cacheControl = ['.html', '.css', '.js'].includes(extension) ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': cacheControl });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/healthz') {
    try { await queryWithRetry('SELECT 1'); return json(res, 200, { status: 'ok' }); }
    catch { return json(res, 503, { status: 'unavailable' }); }
  }
  if (url.pathname.startsWith('/api/')) {
    if (!pool) return json(res, 503, { error: 'server_not_configured', message: 'Database is not configured.' });
    if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'origin_rejected' });
    if (req.method === 'GET' && url.pathname === '/api/register/status') {
      const suppliedDeviceId = String(req.headers['x-registration-device'] || '');
      const validSuppliedDeviceId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedDeviceId) ? suppliedDeviceId.toLowerCase() : '';
      const deviceId = cookies(req).hu_registration_device || validSuppliedDeviceId;
      if (!deviceId) return json(res, 200, { registered: false });
      const deviceHash = crypto.createHash('sha256').update(deviceId).digest('hex');
      const result = await queryWithRetry('SELECT 1 FROM registrants WHERE device_hash = $1 LIMIT 1', [deviceHash]);
      return json(res, 200, { registered: result.rowCount > 0 });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/session') return json(res, 200, { authenticated: validSession(req) });
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (rateLimit(req, 'login', 10, 15 * 60 * 1000)) return json(res, 429, { error: 'rate_limited', message: 'محاولات كثيرة. حاول بعد قليل.' });
      const input = await bodyJson(req);
      const user = String(input.username || '');
      const pass = String(input.password || '');
      const userOk = Buffer.from(user).length === Buffer.from(ADMIN_USERNAME || '').length && crypto.timingSafeEqual(Buffer.from(user), Buffer.from(ADMIN_USERNAME || ''));
      const passOk = Buffer.from(pass).length === Buffer.from(ADMIN_PASSWORD || '').length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASSWORD || ''));
      if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET || !userOk || !passOk) return json(res, 401, { error: 'invalid_credentials', message: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
      return json(res, 200, { authenticated: true }, { 'Set-Cookie': cookie(sessionToken(Date.now() + SESSION_TTL), Math.floor(SESSION_TTL / 1000)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') return json(res, 200, { authenticated: false }, { 'Set-Cookie': cookie('', 0) });
    if (url.pathname.startsWith('/api/admin/') && !validSession(req)) return json(res, 401, { error: 'unauthorized', message: 'يرجى تسجيل الدخول للوصول إلى لوحة الإدارة.' });
    if (req.method === 'GET' && url.pathname === '/api/admin/registrants') {
      const result = await queryWithRetry('SELECT id, full_name AS "fullName", phone, email, major, study_year AS year, created_at AS "createdAt" FROM registrants ORDER BY created_at DESC LIMIT 10000');
      return json(res, 200, { registrants: result.rows });
    }
    if (req.method === 'POST' && url.pathname === '/api/register') {
      // حد مرتفع ليسمح بقاعة كاملة خلف عنوان IP مشترك.
      if (rateLimit(req, 'register', 1000, 60 * 60 * 1000)) return json(res, 429, { error: 'rate_limited', message: 'تم تجاوز عدد المحاولات. حاول لاحقاً.' });
      const input = await bodyJson(req);
      const cleaned = cleanRegistration(input);
      if (cleaned.error) return json(res, 400, { error: 'validation_error', field: cleaned.error, message: 'يرجى مراجعة البيانات المطلوبة.' });
      const { fullName, phone, email, major, year } = cleaned.value;
      const deviceCookie = cookies(req).hu_registration_device || '';
      const suppliedDeviceId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input.deviceId || '')) ? String(input.deviceId).toLowerCase() : '';
      const deviceId = deviceCookie || suppliedDeviceId || crypto.randomBytes(32).toString('base64url');
      const deviceHash = crypto.createHash('sha256').update(deviceId).digest('hex');
      try {
        const result = await queryWithRetry('INSERT INTO registrants (full_name, phone, email, device_hash, major, study_year) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at AS "createdAt"', [fullName, phone, email, deviceHash, major, year]);
        const headers = deviceCookie ? {} : { 'Set-Cookie': registrationDeviceCookie(deviceId) };
        return json(res, 201, { registered: true, id: result.rows[0].id, createdAt: result.rows[0].createdAt }, headers);
      } catch (error) {
        if (error.code === '23505') {
          const field = error.constraint === 'registrants_phone_key' ? 'phone' : error.constraint === 'registrants_device_hash_unique' ? 'device' : 'email';
          const message = field === 'phone' ? 'رقم الهاتف مسجّل مسبقاً.' : field === 'device' ? 'هذا الجهاز مسجّل مسبقاً، ولا يمكنه التسجيل مرة أخرى.' : 'البريد الإلكتروني مسجّل مسبقاً.';
          return json(res, 409, { error: 'duplicate', field, message });
        }
        throw error;
      }
    }
    return json(res, 404, { error: 'not_found' });
  }
  if (req.method === 'GET' && sendFile(res, url.pathname)) return;
  return json(res, 404, { error: 'not_found' });
}

async function start() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required.');
  let databaseHost = '';
  try { databaseHost = new URL(DATABASE_URL).hostname; } catch {}
  if (isProduction && !databaseHost.includes('-pooler')) throw new Error('Production DATABASE_URL must use the Neon pooled endpoint (-pooler).');
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are required.');
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  await initDatabase();
  const server = http.createServer((req, res) => handler(req, res).catch(error => {
    const status = error.status || (isRetryableDatabaseError(error) ? 503 : 500);
    if (!res.headersSent) json(res, status, {
      error: error.status === 413 ? 'request_too_large' : error.status === 400 ? 'invalid_request' : status === 503 ? 'database_unavailable' : 'server_error',
      message: error.status ? 'تعذّر قراءة الطلب.' : status === 503 ? 'الخدمة مشغولة مؤقتاً. حاول مجدداً بعد قليل.' : 'حدث خطأ غير متوقع.'
    });
    else res.destroy();
    // Never log request bodies, names, emails, phone numbers, or SQL values.
    console.error('Request failed', { path: urlPath(req.url), code: error.code || 'application_error', status });
  }));
  server.listen(PORT, '0.0.0.0', () => console.log(`Registration app listening on ${PORT}`));
  const close = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

function urlPath(requestUrl) {
  try { return new URL(requestUrl, 'http://localhost').pathname; } catch { return '/unknown'; }
}

start().catch(error => {
  console.error('Server startup failed', { code: error.code || 'configuration_error' });
  process.exit(1);
});
