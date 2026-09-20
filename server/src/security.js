import crypto from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AuditLog, LoginLock, RefreshToken } from './models.js';

const ISSUER = 'college-portal';

/* ------------------------------ Errors ------------------------------ */
export class AppError extends Error {
  constructor(status, message, code = 'ERROR', extra = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Resource not found.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'SERVER_ERROR';
  let message = 'Something went wrong. Please try again.';
  let extra = {};

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    extra = err.extra;
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    const errors = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    const first = errors[0];
    message = first ? (first.field ? `${first.field}: ${first.message}` : first.message) : 'Invalid input.';
    extra = { errors };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Invalid request body.';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request is too large.';
  } else if (err?.name === 'ValidationError' && err.errors) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = Object.values(err.errors)[0]?.message || 'Invalid input.';
  } else if (err?.name === 'CastError') {
    status = 400;
    code = 'INVALID_VALUE';
    message = 'Invalid value provided.';
  } else if (err?.code === 11000) {
    status = 409;
    code = 'DUPLICATE';
    message = 'A record with the same unique value already exists.';
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  res.status(status).json({ success: false, code, message, ...extra });
}

/* ------------------------------ Base middleware ------------------------------ */
export const helmetMw = helmet({ crossOriginResourcePolicy: { policy: 'same-site' } });

export const corsMw = cors({
  origin(origin, callback) {
    callback(null, !origin || origin === config.clientUrl);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600,
});

export const sanitizeMw = mongoSanitize({ replaceWith: '_' });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function originGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.originalUrl.startsWith('/api/payments/webhook')) return next();
  const origin = req.get('origin');
  if (origin && origin !== config.clientUrl) {
    return next(new AppError(403, 'Request blocked.', 'BAD_ORIGIN'));
  }
  return next();
}

/* ------------------------------ Rate limits ------------------------------ */
const limitHandler = (message) => (req, res) =>
  res.status(429).json({ success: false, code: 'RATE_LIMITED', message });

export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) =>
    req.originalUrl.startsWith('/api/auth/admin/login') ||
    req.originalUrl.startsWith('/api/payments/webhook') ||
    req.originalUrl.startsWith('/api/health'),
  handler: limitHandler('Too many requests. Please try again in a few minutes.'),
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler('Too many login attempts from this network. Please try again later.'),
});

export const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many downloads. Please try again in a few minutes.'),
});

export const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: limitHandler('Too many verification requests. Please try again later.'),
});

/* ------------------------------ Cookies and tokens ------------------------------ */
export const COOKIES = { access: 'cp_access', refresh: 'cp_refresh' };
const REFRESH_PATH = '/api/auth';
const REUSE_GRACE_MS = 30 * 1000;

const baseCookie = { httpOnly: true, secure: config.isProd, sameSite: 'lax' };

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(COOKIES.access, accessToken, {
    ...baseCookie,
    path: '/',
    maxAge: config.jwt.accessTtlSec * 1000,
  });
  res.cookie(COOKIES.refresh, refreshToken, {
    ...baseCookie,
    path: REFRESH_PATH,
    maxAge: config.jwt.refreshTtlSec * 1000,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(COOKIES.access, { ...baseCookie, path: '/' });
  res.clearCookie(COOKIES.refresh, { ...baseCookie, path: REFRESH_PATH });
}

export async function issueSession(req, res, { sub, role, email }) {
  const jti = crypto.randomBytes(24).toString('hex');
  const accessToken = jwt.sign({ role, email }, config.jwt.accessSecret, {
    algorithm: 'HS256',
    subject: String(sub),
    issuer: ISSUER,
    expiresIn: config.jwt.accessTtlSec,
  });
  const refreshToken = jwt.sign({ role, email }, config.jwt.refreshSecret, {
    algorithm: 'HS256',
    subject: String(sub),
    issuer: ISSUER,
    expiresIn: config.jwt.refreshTtlSec,
    jwtid: jti,
  });

  await RefreshToken.create({
    jti,
    subject: String(sub),
    role,
    expiresAt: new Date(Date.now() + config.jwt.refreshTtlSec * 1000),
    ip: req.ip,
    userAgent: (req.get('user-agent') || '').slice(0, 250),
  });

  setAuthCookies(res, accessToken, refreshToken);
}

function readRefreshPayload(req) {
  const token = req.cookies?.[COOKIES.refresh];
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwt.refreshSecret, { algorithms: ['HS256'], issuer: ISSUER });
  } catch {
    return null;
  }
}

// Rotates the refresh token. A short reuse grace avoids logging users out when
// two browser tabs refresh at the same moment.
export async function consumeRefreshToken(req) {
  const payload = readRefreshPayload(req);
  if (!payload?.jti) return null;

  const now = new Date();
  let doc = await RefreshToken.findOneAndUpdate(
    { jti: payload.jti, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now } }
  );
  if (!doc) {
    doc = await RefreshToken.findOne({
      jti: payload.jti,
      expiresAt: { $gt: now },
      revokedAt: { $gte: new Date(now.getTime() - REUSE_GRACE_MS) },
    });
    if (!doc) return null;
  }
  return { sub: payload.sub, role: payload.role, email: payload.email, jti: payload.jti };
}

export async function revokeRefreshToken(req) {
  const payload = readRefreshPayload(req);
  if (!payload?.jti) return;
  await RefreshToken.updateOne(
    { jti: payload.jti, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

export async function revokeAllSessions(subject) {
  await RefreshToken.updateMany(
    { subject: String(subject), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

/* ------------------------------ Auth middleware ------------------------------ */
export function authenticate(req, res, next) {
  const token = req.cookies?.[COOKIES.access];
  if (!token) {
    return next(new AppError(401, 'Please log in to continue.', 'UNAUTHENTICATED'));
  }
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
    });
    req.auth = { id: payload.sub, role: payload.role, email: payload.email };
    return next();
  } catch (err) {
    const expired = err?.name === 'TokenExpiredError';
    return next(
      new AppError(
        401,
        expired ? 'Session expired. Please log in again.' : 'Invalid session.',
        expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED'
      )
    );
  }
}

export const requireRole = (role) => (req, res, next) => {
  if (req.auth?.role !== role) {
    return next(new AppError(403, 'You do not have permission to do this.', 'FORBIDDEN'));
  }
  if (role === 'admin' && req.auth.email !== config.admin.email) {
    return next(new AppError(401, 'Session is no longer valid.', 'UNAUTHENTICATED'));
  }
  return next();
};

export const requireAdmin = [authenticate, requireRole('admin')];
export const requireStudent = [authenticate, requireRole('student')];

/* ------------------------------ Login lock ------------------------------ */
const LOCK = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  levelsMin: [15, 30, 60, 1440],
  memoryMs: 24 * 60 * 60 * 1000,
};

export const loginLockKey = (ip, email) =>
  crypto.createHash('sha256').update(`${ip}|${email}`).digest('hex');

export async function getLockStatus(key) {
  const doc = await LoginLock.findOne({ key }).lean();
  const now = Date.now();
  if (doc?.lockedUntil && new Date(doc.lockedUntil).getTime() > now) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((new Date(doc.lockedUntil).getTime() - now) / 1000),
      lockedUntil: doc.lockedUntil,
    };
  }
  return { locked: false };
}

async function incrementAttempts(key, now) {
  const run = () =>
    LoginLock.findOneAndUpdate(
      { key },
      {
        $inc: { attempts: 1 },
        $set: { lastFailureAt: now, expireAt: new Date(now.getTime() + LOCK.memoryMs) },
        $setOnInsert: { level: 0, lockedUntil: null },
      },
      { upsert: true, new: true }
    );
  try {
    return await run();
  } catch (err) {
    if (err?.code === 11000) return run();
    throw err;
  }
}

export async function registerFailedLogin(key) {
  const now = new Date();

  // Old attempt window expired (and no active lock): start counting again.
  await LoginLock.updateOne(
    {
      key,
      lastFailureAt: { $lt: new Date(now.getTime() - LOCK.windowMs) },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    { $set: { attempts: 0 } }
  );

  const doc = await incrementAttempts(key, now);

  if (doc.attempts >= LOCK.maxAttempts) {
    const minutes = LOCK.levelsMin[Math.min(doc.level, LOCK.levelsMin.length - 1)];
    const lockedUntil = new Date(now.getTime() + minutes * 60 * 1000);
    const locked = await LoginLock.findOneAndUpdate(
      { key, attempts: { $gte: LOCK.maxAttempts } },
      {
        $set: {
          attempts: 0,
          lockedUntil,
          expireAt: new Date(lockedUntil.getTime() + LOCK.memoryMs),
        },
        $inc: { level: 1 },
      },
      { new: true }
    );
    if (locked) {
      return { locked: true, retryAfterSec: minutes * 60, lockedUntil, attemptsLeft: 0 };
    }
    const status = await getLockStatus(key); // another parallel request already applied the lock
    return { ...status, attemptsLeft: 0 };
  }

  return { locked: false, attemptsLeft: LOCK.maxAttempts - doc.attempts };
}

export async function clearLoginFailures(key) {
  await LoginLock.deleteOne({ key });
}

/* ------------------------------ Validation and audit ------------------------------ */
export const validate =
  ({ body, query } = {}) =>
  (req, res, next) => {
    try {
      if (body) req.body = body.parse(req.body ?? {});
      if (query) req.query = query.parse(req.query ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };

export async function audit(req, action, options = {}) {
  const { details, actor, actorType, entity, entityId } = options;
  try {
    await AuditLog.create({
      action,
      actor: actor ?? req?.auth?.email ?? 'system',
      actorType: actorType ?? req?.auth?.role ?? 'system',
      ip: req?.ip,
      entity,
      entityId: entityId ? String(entityId) : undefined,
      details,
    });
  } catch (err) {
    console.error('[audit] failed to write log:', err.message);
  }
}