import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import otplib from 'otplib';
import { z } from 'zod';
import { config } from '../config.js';
import {
  AppError,
  asyncHandler,
  audit,
  authenticate,
  clearAuthCookies,
  clearLoginFailures,
  consumeRefreshToken,
  getLockStatus,
  issueSession,
  loginLimiter,
  loginLockKey,
  registerFailedLogin,
  revokeRefreshToken,
  validate,
} from '../security.js';

const { authenticator } = otplib;
authenticator.options = { window: 1 };

const router = Router();

const emailSchema = z.string().trim().toLowerCase().email().max(200);

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code.')
    .optional(),
});

const lockStatusSchema = z.object({ email: emailSchema });

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function respondLocked(res, lock) {
  res.set('Retry-After', String(lock.retryAfterSec));
  return res.status(429).json({
    success: false,
    code: 'LOGIN_LOCKED',
    message: 'Too many failed attempts. Please wait before trying again.',
    retryAfterSec: lock.retryAfterSec,
    lockedUntil: lock.lockedUntil,
  });
}

router.post(
  '/admin/login',
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password, otp } = req.body;
    const key = loginLockKey(req.ip, email);

    const lock = await getLockStatus(key);
    if (lock.locked) return respondLocked(res, lock);

    const fail = async (message) => {
      const result = await registerFailedLogin(key);
      await audit(req, result.locked ? 'LOGIN_LOCKED' : 'LOGIN_FAILED', {
        actor: email,
        actorType: 'admin',
        details: { attemptsLeft: result.attemptsLeft },
      });
      if (result.locked) return respondLocked(res, result);
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message,
        attemptsLeft: result.attemptsLeft,
      });
    };

    // Always run bcrypt so response time does not reveal whether the email matched.
    const emailOk = safeEqual(email, config.admin.email);
    const passwordOk = await bcrypt.compare(password, config.admin.passwordHash);
    if (!emailOk || !passwordOk) return fail('Invalid email or password.');

    if (config.admin.twoFaSecret) {
      if (!otp) return res.json({ success: true, otpRequired: true });
      if (!authenticator.check(otp, config.admin.twoFaSecret)) {
        return fail('Invalid authentication code.');
      }
    }

    await clearLoginFailures(key);
    await issueSession(req, res, { sub: 'admin', role: 'admin', email: config.admin.email });
    await audit(req, 'LOGIN', { actor: config.admin.email, actorType: 'admin' });

    return res.json({ success: true, user: { role: 'admin', email: config.admin.email } });
  })
);

router.get(
  '/admin/lock-status',
  validate({ query: lockStatusSchema }),
  asyncHandler(async (req, res) => {
    const lock = await getLockStatus(loginLockKey(req.ip, req.query.email));
    res.json({ success: true, locked: lock.locked, retryAfterSec: lock.retryAfterSec || 0 });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const session = await consumeRefreshToken(req);
    const valid = session && session.role === 'admin' && session.email === config.admin.email;
    if (!valid) {
      clearAuthCookies(res);
      throw new AppError(401, 'Session expired. Please log in again.', 'SESSION_EXPIRED');
    }
    await issueSession(req, res, { sub: session.sub, role: session.role, email: session.email });
    res.json({ success: true, user: { role: session.role, email: session.email } });
  })
);

router.get('/me', authenticate, (req, res, next) => {
  if (req.auth.role !== 'admin' || req.auth.email !== config.admin.email) {
    return next(new AppError(401, 'Session is no longer valid.', 'UNAUTHENTICATED'));
  }
  return res.json({ success: true, user: { role: 'admin', email: req.auth.email } });
});

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await revokeRefreshToken(req);
    clearAuthCookies(res);
    res.json({ success: true });
  })
);

export default router;