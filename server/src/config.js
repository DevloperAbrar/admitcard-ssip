import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const env = process.env;

function fail(message) {
  console.error(`[config] ${message}`);
  process.exit(1);
}

const REQUIRED = [
  'MONGO_URI',
  'CLIENT_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD_HASH',
];

const missing = REQUIRED.filter((key) => !env[key] || !env[key].trim());
if (missing.length) fail(`Missing required environment variables: ${missing.join(', ')}`);

if (env.JWT_ACCESS_SECRET.length < 32 || env.JWT_REFRESH_SECRET.length < 32) {
  fail('JWT secrets must be at least 32 characters long.');
}
if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
  fail('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different.');
}
if (!/^\$2[aby]\$\d{2}\$.{53}$/.test(env.ADMIN_PASSWORD_HASH)) {
  fail("ADMIN_PASSWORD_HASH is not a valid bcrypt hash. Keep it inside single quotes in .env.");
}

const toPositiveInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const isProd = env.NODE_ENV === 'production';
const assets = path.join(ROOT, 'assets');
const storage = path.join(ROOT, 'storage');

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  trustProxy: isProd,
  port: toPositiveInt(env.PORT, 5000),
  clientUrl: env.CLIENT_URL.trim().replace(/\/+$/, ''),
  mongoUri: env.MONGO_URI.trim(),

  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtlSec: 15 * 60,
    refreshTtlSec: 7 * 24 * 60 * 60,
  },

  admin: {
    email: env.ADMIN_EMAIL.trim().toLowerCase(),
    passwordHash: env.ADMIN_PASSWORD_HASH,
    twoFaSecret: (env.ADMIN_2FA_SECRET || '').trim(),
  },

  google: { clientId: (env.GOOGLE_CLIENT_ID || '').trim() },

  razorpay: {
    keyId: (env.RAZORPAY_KEY_ID || '').trim(),
    keySecret: (env.RAZORPAY_KEY_SECRET || '').trim(),
    webhookSecret: (env.RAZORPAY_WEBHOOK_SECRET || '').trim(),
  },

  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: toPositiveInt(env.API_RATE_LIMIT_MAX, 100),
  },

  college: {
    name: (env.COLLEGE_NAME || 'Your College Name').trim(),
    code: (env.COLLEGE_CODE || 'COL').trim().toUpperCase(),
    accentColor: /^#[0-9a-f]{6}$/i.test((env.COLLEGE_COLOR || '').trim()) ? env.COLLEGE_COLOR.trim() : '#1e3a8a',
    principalName: (env.PRINCIPAL_NAME || '').trim(),
    inchargeName: (env.EXAM_INCHARGE_NAME || '').trim(),
    courseTitles: {
      'B.PHARM': 'BACHELOR OF PHARMACY (B.PHARM.)',
    },
  },

  paths: {
    root: ROOT,
    assets,
    branding: path.join(assets, 'branding'),
    fonts: path.join(assets, 'fonts'),
    storage,
    pdfCache: path.join(storage, 'pdf-cache'),
    csvTemp: path.join(storage, 'csv-temp'),
    exports: path.join(storage, 'exports'),
  },
};