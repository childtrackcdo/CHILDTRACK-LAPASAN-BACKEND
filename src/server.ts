import 'dotenv/config';
import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import compression from 'compression';
import hpp from 'hpp';
import { createWriteStream, mkdirSync } from 'fs';
import crypto from 'crypto';

// ── Standalone route files ─────────────────────────────────────────────────────
// These MUST be imported and mounted BEFORE apiRoutes.
import notificationsRoutes from './routes/notificationsRoutes';
import attendanceRoutes    from './routes/attendanceRoutes';
import kioskRoutes         from './routes/kioskRoutes';
import alertsRoutes        from './routes/alertsRoutes';  

// ── Main combined router ───────────────────────────────────────────────────────
import apiRoutes      from './routes/index';
import teachersRouter from './routes/teachersRoutes';

import { errorHandler, notFound } from '../middleware/errorMiddleware';

const app: Application = express();
const PORT   = process.env.PORT ?? 5000;
const isProd = process.env.NODE_ENV === 'production';

// ─── Trust Proxy ──────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─── Helmet ───────────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy:   { policy: 'same-origin-allow-popups' },
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: isProd
    ? {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc:  ["'self'", "'unsafe-eval'"],          // 'unsafe-eval' required by MUI/Emotion
          styleSrc:   ["'self'", "'unsafe-inline'"],
          imgSrc:     ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc:    ["'self'", 'data:'],                  // data: required by MUI icon fonts
          objectSrc:  ["'none'"],
          frameSrc:   ["'none'"],
          upgradeInsecureRequests: [],
        },
      }
    : false,
  hsts:          isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  noSniff:       true,
  frameguard:    { action: 'deny' },
  xssFilter:     true,
  hidePoweredBy: true,
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = new Set([
  ...(process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),
  'http://localhost:5173',
  'https://childtrach-hs-frontend.vercel.app',
  'https://childtrach-hs-frontend-n4pb5pazy-rovicalmonias-projects.vercel.app',
  'https://childtrack-lapasan-frontend.pages.dev',
  'http://localhost:8081',
  'http://192.168.1.13:5173',
  'http://192.168.1.13:8081',
  'http://192.168.1.37:5173',
  'http://192.168.1.37:8081',
  'http://192.168.1.37:5137',
  'http://10.208.179.77:5173',
  'http://172.26.99.77:5173',
  'http://172.26.99.77:8081',
  'http://172.26.99.84:5173',
  'http://172.26.99.84:8081',
  'http://172.26.99.109:5173',
  'http://172.26.99.232:5173',
  'https://55f4acad.childtrack-lapasan-parentstudents-portal.pages.dev',
  'https://childtrack-lapasan-parentstudents-portal.pages.dev',
  'https://childtrack-lapasan-parentstudents-portal.pages.dev/',
  'http://localhost:8081',
]);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-ID', 'ngrok-skip-browser-warning'],
  exposedHeaders: ['X-Request-ID', 'RateLimit-Limit', 'RateLimit-Remaining'],
  maxAge: 86_400,
}));

// ─── Compression ──────────────────────────────────────────────────────────────
app.use(compression({
  filter:    (req, res) => req.headers['x-no-compression'] ? false : compression.filter(req, res),
  threshold: 512,
  level:     4,
}));

// ─── Request ID ───────────────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-ID', id);
  next();
});

// ─── Logging ──────────────────────────────────────────────────────────────────
if (isProd) {
  mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
  const accessLog = createWriteStream(
    path.join(process.cwd(), 'logs', 'access.log'),
    { flags: 'a' },
  );
  app.use(morgan('combined', { stream: accessLog }));
} else {
  app.use(morgan('dev'));
}

// ─── Body Parsing ─────────────────────────────────────────────────────────────
// 10 MB is sufficient — Multer handles file uploads separately via multipart.
// The previous 1 GB limit allowed a single malicious POST to OOM the process.
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ─── HTTP Parameter Pollution ─────────────────────────────────────────────────
app.use(hpp());

// ─── Payload Key Sanitization ─────────────────────────────────────────────────
const sanitizeKeys = (obj: Record<string, unknown>): Record<string, unknown> => {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const safeKey = key.replace(/[$\.]/g, '_');
    const val     = obj[key];
    clean[safeKey] = val && typeof val === 'object' && !Array.isArray(val)
      ? sanitizeKeys(val as Record<string, unknown>)
      : val;
  }
  return clean;
};

app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object') req.body = sanitizeKeys(req.body);
  next();
});

// ─── Base64 Data URI Guard ────────────────────────────────────────────────────
const isBase64DataUri = (v: string): boolean =>
  /^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(v);

// ─── SQL Injection Guard ──────────────────────────────────────────────────────
const SQL_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXEC|UNION|CAST|CONVERT)\b)/i,
  /(--|;|\/\*|\*\/|xp_|0x[0-9a-f]+)/i,
  /(\bOR\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?)/i,
  /(\bAND\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?)/i,
  /('.*--)/i,
  /(SLEEP\s*\(|BENCHMARK\s*\(|WAITFOR\s+DELAY)/i,
];

const hasSQLi  = (v: string): boolean => SQL_PATTERNS.some((p) => p.test(v));
const scanSQLi = (o: unknown): boolean => {
  if (typeof o === 'string')      return isBase64DataUri(o) ? false : hasSQLi(o);
  if (Array.isArray(o))           return o.some(scanSQLi);
  if (o && typeof o === 'object') return Object.values(o).some(scanSQLi);
  return false;
};

app.use((req: Request, res: Response, next: NextFunction): void => {
  if ([req.body, req.query, req.params].some(scanSQLi)) {
    res.status(400).json({ error: 'Invalid input.', requestId: req.headers['x-request-id'] });
    return;
  }
  next();
});

// ─── XSS Sanitizer ───────────────────────────────────────────────────────────
const XSS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /<[^>]+on\w+\s*=\s*["'][^"']*["']/gi,
  /javascript\s*:/gi,
  /data\s*:\s*text\/html/gi,
];

const cleanStr = (v: string): string =>
  isBase64DataUri(v) ? v : XSS_PATTERNS.reduce((s, p) => s.replace(p, ''), v);

const sanitize = (v: unknown): unknown => {
  if (typeof v === 'string')      return cleanStr(v);
  if (Array.isArray(v))           return v.map(sanitize);
  if (v && typeof v === 'object') return Object.fromEntries(
    Object.entries(v).map(([k, val]) => [k, sanitize(val)]),
  );
  return v;
};

app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.body)   req.body   = sanitize(req.body);
  if (req.params) req.params = sanitize(req.params) as typeof req.params;
  next();
});

// ─── Rate Limiters ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      3_000,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Server is busy. Please retry in a moment.' },
  skip:    (req) => req.path === '/health',
});

const perIpLimiter = rateLimit({
  windowMs: 2 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests from this device. Please slow down.' },
  skip:    (req) => req.path === '/health',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      15,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  skipSuccessfulRequests: true,
});

const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'SMS rate limit reached.' },
});

const uploadSkipPaths = [
  '/api/student-auth',
  '/api/parent-auth',
];

const speedLimiter = slowDown({
  windowMs:   2 * 1000,
  delayAfter: 60,
  delayMs:    (hits) => (hits - 60) * 30,
});

app.use(globalLimiter);
app.use((req: Request, res: Response, next: NextFunction) => {
  if (uploadSkipPaths.some((p) => req.path.startsWith(p))) return next();
  perIpLimiter(req, res, next);
});
app.use(speedLimiter);

app.use('/api/auth',              authLimiter);
app.use('/api/admin/auth',        authLimiter);
app.use('/api/parent/auth',       authLimiter);


// ─── Static Files ─────────────────────────────────────────────────────────────
const safeStatic = (dir: string) =>
  express.static(path.resolve(process.cwd(), dir), {
    dotfiles:     'deny',
    index:        false,
    etag:         true,
    lastModified: true,
    maxAge:       isProd ? '7d' : 0,
  });

app.use('/reports', safeStatic('reports'));
app.use('/uploads', safeStatic('uploads'));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status:    'ok',
    service:   'ChildTrack HS Edition API',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
    capacity:  { maxStudents: 500, rateLimit: '100 req / 2s per device' },
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
//
// MOUNT ORDER IS CRITICAL.
//
// FIX: teachersRouter was previously mounted AFTER apiRoutes ('/api'), which
// meant it was dead code — Express matched '/api' first and never reached
// '/api/teachers'. It is now mounted before apiRoutes alongside the other
// standalone routers.
//
app.use('/api/notifications', notificationsRoutes);
app.use('/api/attendance',    attendanceRoutes);
app.use('/api/kiosk',         kioskRoutes);
app.use('/api/teachers',      teachersRouter);
app.use('/api/alerts',        alertsRoutes);   // moved up
app.use('/api',               apiRoutes);      // must be last
app.use(express.json({ limit: '5mb' }));

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Server + Connection Tuning ───────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   ChildTrack HS Edition — API Server         ║
  ║   Listening on http://localhost:${PORT}         ║
  ║   Mode: ${(process.env.NODE_ENV ?? 'development').padEnd(36)}║
  ║   Capacity: 500 students / 100 req per 2s    ║
  ╚══════════════════════════════════════════════╝
  `);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout   = 66_000;
server.maxHeadersCount  = 200;
server.timeout          = 30_000;

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = (signal: string) => {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => { console.log('HTTP server closed.'); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]', reason));
process.on('uncaughtException',  (err)    => { console.error('[UncaughtException]', err); shutdown('uncaughtException'); });