import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { config } from '../config.js';
import { Student } from '../models.js';
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

const router = Router();
const googleClient = config.google.clientId ? new OAuth2Client(config.google.clientId) : null;

const emailSchema = z.string().trim().toLowerCase().email().max(200);

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const lockStatusSchema = z.object({ email: emailSchema });
const googleSchema = z.object({ credential: z.string().min(20).max(4096) });

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

// Returns the student profile for the session, or null if the account no longer qualifies.
async function studentUser(id) {
  const s = await Student.findById(id).populate('course', 'name shortName').lean();
  if (!s || s.isDeleted || s.status !== 'active') return null;
  return {
    role: 'student',
    id: String(s._id),
    email: s.email,
    name: s.name,
    enrollmentNo: s.enrollmentNo,
    rollNo: s.rollNo,
    course: s.course ? { id: String(s.course._id), name: s.course.name, shortName: s.course.shortName } : null,
    year: s.year,
    semester: s.semester,
  };
}

/* ------------------------------ Admin login ------------------------------ */
router.post(
  '/admin/login',
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
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

/* ------------------------------ Student email login ------------------------------ */
const studentLoginSchema = z.object({
  email: emailSchema,
});

router.post(
  '/student/login',
  loginLimiter,
  validate({ body: studentLoginSchema }),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const key = loginLockKey(req.ip, email);

    const lock = await getLockStatus(key);
    if (lock.locked) return respondLocked(res, lock);

    const student = await Student.findOne({ email, isDeleted: false });
    if (!student) {
      const result = await registerFailedLogin(key);
      await audit(req, 'STUDENT_LOGIN_UNREGISTERED', { actor: email, actorType: 'student' });
      if (result.locked) return respondLocked(res, result);
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'No account found with this email. Contact the admin.',
        attemptsLeft: result.attemptsLeft,
      });
    }
    if (student.status !== 'active') {
      return res.status(403).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'Your account is disabled. Contact admin.' });
    }

    await clearLoginFailures(key);
    await Student.updateOne({ _id: student._id }, { $set: { lastLoginAt: new Date() } });
    await issueSession(req, res, { sub: String(student._id), role: 'student', email });
    await audit(req, 'STUDENT_LOGIN', { actor: email, actorType: 'student', entity: 'Student', entityId: student._id });

    res.json({ success: true, user: await studentUser(student._id) });
  })
);

/* ------------------------------ Student Google login ------------------------------ */
router.post(
  '/student/google',
  loginLimiter,
  validate({ body: googleSchema }),
  asyncHandler(async (req, res) => {
    if (!googleClient) {
      throw new AppError(500, 'Google login is not configured yet.', 'GOOGLE_NOT_CONFIGURED');
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: req.body.credential,
        audience: config.google.clientId,
      });
      payload = ticket.getPayload();
    } catch {
      throw new AppError(401, 'Google sign-in failed. Please try again.', 'GOOGLE_INVALID');
    }

    const email = String(payload?.email || '').trim().toLowerCase();
    if (!email || !payload.email_verified) {
      throw new AppError(401, 'Your Google email is not verified.', 'GOOGLE_INVALID');
    }

    const student = await Student.findOne({ email, isDeleted: false });
    if (!student) {
      await audit(req, 'STUDENT_LOGIN_UNREGISTERED', { actor: email, actorType: 'student' });
      throw new AppError(403, 'Your email is not registered. Contact admin.', 'NOT_REGISTERED');
    }
    if (student.status !== 'active') {
      throw new AppError(403, 'Account disabled.', 'ACCOUNT_DISABLED');
    }

    await Student.updateOne({ _id: student._id }, { $set: { lastLoginAt: new Date() } });
    await issueSession(req, res, { sub: String(student._id), role: 'student', email });
    await audit(req, 'STUDENT_LOGIN', {
      actor: email,
      actorType: 'student',
      entity: 'Student',
      entityId: student._id,
    });

    res.json({ success: true, user: await studentUser(student._id) });
  })
);

/* ------------------------------ Session ------------------------------ */
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const session = await consumeRefreshToken(req);
    let user = null;
    if (session?.role === 'admin' && session.email === config.admin.email) {
      user = { role: 'admin', email: session.email };
    } else if (session?.role === 'student') {
      user = await studentUser(session.sub);
    }
    if (!user) {
      clearAuthCookies(res);
      throw new AppError(401, 'Session expired. Please log in again.', 'SESSION_EXPIRED');
    }
    await issueSession(req, res, { sub: session.sub, role: session.role, email: session.email });
    res.json({ success: true, user });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    if (req.auth.role === 'admin') {
      if (req.auth.email !== config.admin.email) {
        throw new AppError(401, 'Session is no longer valid.', 'UNAUTHENTICATED');
      }
      return res.json({ success: true, user: { role: 'admin', email: req.auth.email } });
    }
    const user = await studentUser(req.auth.id);
    if (!user) throw new AppError(401, 'Session is no longer valid.', 'UNAUTHENTICATED');
    return res.json({ success: true, user });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await revokeRefreshToken(req);
    clearAuthCookies(res);
    res.json({ success: true });
  })
);

export default router;