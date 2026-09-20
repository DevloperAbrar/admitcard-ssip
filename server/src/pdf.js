import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';
import { PDFDocument } from 'pdf-lib';
import { config } from './config.js';
import { AdmitCard, ExamSession, Job, Payment, Student, Subscription } from './models.js';
import { AppError, audit } from './security.js';
import { admitCardPage, receiptPage, wrapHtml } from './templates.js';

const TEMPLATE_VERSION = 'v1';
const CHUNK_SIZE = 100;
const RECYCLE_AFTER = 300;
const MAX_QUEUE = 400;
const CONCURRENCY = Math.min(3, Math.max(1, Number.parseInt(process.env.PDF_CONCURRENCY, 10) || 2));

/* ------------------------------ Assets and fonts ------------------------------ */
const ASSET_CANDIDATES = {
  logo: ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp', 'logo.svg'],
  principalSign: ['principal-sign.png', 'principal-sign.jpg', 'principal-sign.jpeg', 'principal-sign.webp'],
  inchargeSign: ['incharge-sign.png', 'incharge-sign.jpg', 'incharge-sign.jpeg', 'incharge-sign.webp'],
  seal: ['seal.png', 'seal.jpg', 'seal.jpeg', 'seal.webp'],
};

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// File names of the assets that exist right now (stored on the exam session when it is published).
export function currentAssetNames() {
  const out = {};
  for (const [key, list] of Object.entries(ASSET_CANDIDATES)) {
    const found = list.find((name) => fs.existsSync(path.join(config.paths.branding, name)));
    if (found) out[key] = found;
  }
  return out;
}

function listFonts() {
  try {
    return fs
      .readdirSync(config.paths.fonts)
      .filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

export function verifyAssets() {
  const names = currentAssetNames();
  const missing = [];
  if (!names.logo) missing.push('assets/branding/logo.png');
  if (!names.principalSign) missing.push('assets/branding/principal-sign.png');
  if (!names.inchargeSign) missing.push('assets/branding/incharge-sign.png');
  if (!listFonts().length) missing.push('a .ttf/.otf/.woff2 font in assets/fonts');
  return { names, missing };
}

const uriCache = new Map();
async function assetUri(name) {
  if (!name) return null;
  if (uriCache.has(name)) return uriCache.get(name);
  try {
    const safe = path.basename(name);
    const buf = await fs.promises.readFile(path.join(config.paths.branding, safe));
    const uri = `data:${MIME[path.extname(safe).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`;
    uriCache.set(name, uri);
    return uri;
  } catch {
    return null;
  }
}

export async function resolveAssets(assetsUsed) {
  const current = currentAssetNames();
  const out = {};
  for (const key of Object.keys(ASSET_CANDIDATES)) {
    out[key] = (await assetUri(assetsUsed?.[key])) || (await assetUri(current[key]));
  }
  return out;
}

function assetStamp(assetsUsed) {
  const current = currentAssetNames();
  return Object.keys(ASSET_CANDIDATES).map((key) => {
    const name = assetsUsed?.[key] || current[key];
    if (!name) return null;
    try {
      const st = fs.statSync(path.join(config.paths.branding, path.basename(name)));
      return `${name}:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      return `${name}:missing`;
    }
  });
}

let fontCssCache = null;
export function fontCss() {
  if (fontCssCache !== null) return fontCssCache;
  const files = listFonts();
  if (!files.length) {
    fontCssCache = '';
    return fontCssCache;
  }
  const isItalic = (f) => /italic|oblique/i.test(f);
  const isBold = (f) => /bold|black|heavy/i.test(f) && !isItalic(f);
  const plain = (f) => !isBold(f) && !isItalic(f);
  const regular = files.find((f) => plain(f) && /regular|normal/i.test(f)) || files.find(plain) || files[0];
  const bold = files.find(isBold);

  const face = (file, weight) => {
    const ext = path.extname(file).toLowerCase();
    const format = { '.ttf': 'truetype', '.otf': 'opentype', '.woff': 'woff', '.woff2': 'woff2' }[ext];
    const b64 = fs.readFileSync(path.join(config.paths.fonts, file)).toString('base64');
    return `@font-face{font-family:'PortalFont';font-weight:${weight};font-style:normal;src:url(data:font/${ext.slice(1)};base64,${b64}) format('${format}');}`;
  };
  fontCssCache = face(regular, 400) + (bold ? face(bold, 700) : '');
  return fontCssCache;
}

/* ------------------------------ Chromium and queue ------------------------------ */
let browser = null;
let launching = null;
let renders = 0;
let inFlight = 0;

async function getBrowser() {
  if (browser && browser.connected !== false) return browser;
  if (!launching) {
    launching = puppeteer
      .launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
      })
      .then((b) => {
        browser = b;
        renders = 0;
        b.on('disconnected', () => {
          if (browser === b) browser = null;
        });
        return b;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

async function resetBrowser() {
  const b = browser;
  browser = null;
  renders = 0;
  if (!b) return;
  try {
    await Promise.race([b.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  } catch {
    /* ignore */
  }
  try {
    b.process()?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

function maybeRecycle() {
  if (renders >= RECYCLE_AFTER && inFlight === 0 && browser) {
    const b = browser;
    browser = null;
    renders = 0;
    b.close().catch(() => {});
  }
}

const waiting = [];
let active = 0;

function pump() {
  while (active < CONCURRENCY && waiting.length) {
    const { task, resolve, reject } = waiting.shift();
    active += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function enqueue(task) {
  if (waiting.length >= MAX_QUEUE) {
    return Promise.reject(new AppError(503, 'The server is busy generating documents. Please try again in a minute.', 'PDF_BUSY'));
  }
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('PDF render timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function renderOnce(html, timeoutMs) {
  const b = await getBrowser();
  inFlight += 1;
  let page;
  try {
    page = await b.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url === 'about:blank') req.continue();
      else req.abort();
    });
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: timeoutMs });
    return Buffer.from(pdf);
  } finally {
    if (page) await page.close().catch(() => {});
    inFlight -= 1;
    renders += 1;
    maybeRecycle();
  }
}

export function renderPdf(html, { timeoutMs = 30000 } = {}) {
  return enqueue(async () => {
    try {
      return await withTimeout(renderOnce(html, timeoutMs), timeoutMs + 5000);
    } catch (firstError) {
      console.error('[pdf] render failed, retrying once:', firstError.message);
      await resetBrowser();
      try {
        return await withTimeout(renderOnce(html, timeoutMs), timeoutMs + 5000);
      } catch (err) {
        console.error('[pdf] render failed again:', err.message);
        throw new AppError(500, 'Could not generate the PDF right now. Please try again.', 'PDF_FAILED');
      }
    }
  });
}

/* ------------------------------ Eligibility (single source of truth) ------------------------------ */
export const REASON_TEXT = {
  NOT_PUBLISHED: 'This exam is not published.',
  INACTIVE: 'Student account is not active.',
  UNPAID: 'Subscription is unpaid.',
  REFUNDED: 'Subscription was refunded.',
};

export async function getEligibilityMap(exam, students) {
  const ids = students.map((s) => s._id);
  const subs = ids.length
    ? await Subscription.find({ session: exam.session, semester: exam.semester, student: { $in: ids } })
        .select('student status')
        .lean()
    : [];
  const byStudent = new Map(subs.map((s) => [String(s.student), s.status]));
  const out = new Map();
  for (const s of students) {
    const subscriptionStatus = byStudent.get(String(s._id)) || 'unpaid';
    let reason = null;
    if (exam.status !== 'published') reason = 'NOT_PUBLISHED';
    else if (s.isDeleted || s.status !== 'active') reason = 'INACTIVE';
    else if (subscriptionStatus === 'refunded') reason = 'REFUNDED';
    else if (!['paid', 'waived'].includes(subscriptionStatus)) reason = 'UNPAID';
    out.set(String(s._id), { eligible: !reason, reason, subscriptionStatus });
  }
  return out;
}

export async function checkEligibility(exam, student) {
  return (await getEligibilityMap(exam, [student])).get(String(student._id));
}

/* ------------------------------ Card number ------------------------------ */
export function courseCode(shortName) {
  const parts = String(shortName || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length <= 1) return (parts[0] || 'CRS').slice(0, 4).toUpperCase();
  return parts.map((p) => p[0]).join('').toUpperCase();
}

export function buildCardNo(exam, course, seq) {
  return `${config.college.code}/${exam.session}/${exam.examCode || 'INT'}/${courseCode(course.shortName)}-S${exam.semester}/${String(seq).padStart(4, '0')}`;
}

/* ------------------------------ Admit card PDF (with disk cache) ------------------------------ */
async function buildCardData({ card, student, exam, sample = false }) {
  const verifyUrl = `${config.clientUrl}/verify/${card.qrToken}`;
  const qrRaw = await QRCode.toString(verifyUrl, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  const qrSvg = qrRaw.replace(/<\?xml[^>]*\?>/g, '').trim();
  const course = exam.course;
  return {
    sample,
    collegeName: config.college.name,
    courseTitle: config.college.courseTitles[String(course.shortName).toUpperCase()] || String(course.name).toUpperCase(),
    examTitle: `${exam.examName} – Admit Card`.toUpperCase(),
    session: exam.session,
    cardNo: card.cardNo,
    qrSvg,
    student: { name: student.name, enrollmentNo: student.enrollmentNo, rollNo: student.rollNo },
    year: exam.year,
    semester: exam.semester,
    examName: exam.examName,
    courseShort: course.shortName,
    timetable: exam.timetable,
    instructions: exam.instructions || [],
    generatedOn: new Date(),
    inchargeName: config.college.inchargeName,
    principalName: config.college.principalName,
  };
}

function cardHash({ card, student, exam }) {
  const payload = JSON.stringify([
    TEMPLATE_VERSION,
    String(card._id),
    card.version,
    card.cardNo,
    card.qrToken,
    student.name,
    student.enrollmentNo,
    student.rollNo,
    exam.version,
    exam.examName,
    exam.session,
    exam.year,
    exam.semester,
    exam.course?.shortName,
    exam.course?.name,
    (exam.timetable || []).map((r) => [new Date(r.date).toISOString(), r.subject, r.time]),
    exam.instructions,
    assetStamp(exam.assetsUsed),
    config.college.name,
    config.college.inchargeName,
    config.college.principalName,
    config.college.accentColor,
    config.clientUrl,
  ]);
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

async function writeAtomic(file, buffer) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, buffer);
  await fs.promises.rename(tmp, file);
}

async function pruneOld(prefix, keepFile) {
  try {
    for (const name of await fs.promises.readdir(config.paths.pdfCache)) {
      const full = path.join(config.paths.pdfCache, name);
      if (name.startsWith(`${prefix}-`) && full !== keepFile && name.endsWith('.pdf')) {
        await fs.promises.rm(full, { force: true });
      }
    }
  } catch {
    /* cache cleanup is best effort */
  }
}

const inflight = new Map();

// card, student and exam are lean documents; exam.course must be populated (name, shortName).
export async function getCardPdf({ card, student, exam }) {
  const file = path.join(config.paths.pdfCache, `${card._id}-${cardHash({ card, student, exam })}.pdf`);
  try {
    return await fs.promises.readFile(file);
  } catch {
    /* cache miss */
  }
  if (inflight.has(file)) return inflight.get(file);

  const job = (async () => {
    const assets = await resolveAssets(exam.assetsUsed);
    const data = await buildCardData({ card, student, exam });
    const pdf = await renderPdf(wrapHtml(admitCardPage(data), { assets, fontCss: fontCss() }));
    await writeAtomic(file, pdf);
    pruneOld(String(card._id), file);
    return pdf;
  })().finally(() => inflight.delete(file));

  inflight.set(file, job);
  return job;
}

// Sample student, nothing saved. Used by the exam session builder.
export async function renderPreviewPdf(exam) {
  const full = { ...exam, assetsUsed: currentAssetNames(), version: 1 };
  const card = { qrToken: 'preview', cardNo: buildCardNo(full, full.course, 1) };
  const student = { name: 'Sample Student', enrollmentNo: 'EN2025001', rollNo: '101' };
  const assets = await resolveAssets(full.assetsUsed);
  const data = await buildCardData({ card, student, exam: full, sample: true });
  return renderPdf(wrapHtml(admitCardPage(data), { assets, fontCss: fontCss() }));
}

/* ------------------------------ Receipt PDF ------------------------------ */
const METHOD_LABELS = { razorpay: 'Online (Razorpay)', cash: 'Cash', dd: 'Demand Draft', upi: 'UPI', other: 'Other' };

export async function renderReceiptPdf(paymentId) {
  const payment = await Payment.findById(paymentId)
    .populate({ path: 'student', populate: { path: 'course', select: 'name shortName' } })
    .lean();
  if (!payment || !payment.student) throw new AppError(404, 'Receipt not found.', 'NOT_FOUND');

  const stamp = crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        TEMPLATE_VERSION,
        payment.status,
        payment.amount,
        payment.receiptNo,
        payment.paidAt,
        payment.refundedAt,
        payment.refundAmount,
        payment.student.name,
        payment.student.enrollmentNo,
        payment.student.rollNo,
        config.college.name,
        assetStamp(null),
      ])
    )
    .digest('hex')
    .slice(0, 16);
  const file = path.join(config.paths.pdfCache, `receipt-${payment._id}-${stamp}.pdf`);
  try {
    return await fs.promises.readFile(file);
  } catch {
    /* cache miss */
  }

  const course = payment.student.course || {};
  const method = METHOD_LABELS[payment.method] || 'Other';
  const html = wrapHtml(
    receiptPage({
      collegeName: config.college.name,
      courseName: config.college.courseTitles[String(course.shortName || '').toUpperCase()] || String(course.name || '').toUpperCase(),
      courseShort: course.shortName || '',
      receiptNo: payment.receiptNo,
      paidAt: payment.paidAt || payment.createdAt,
      student: payment.student,
      semester: payment.semester,
      session: payment.session,
      description: `Semester ${payment.semester} fees - Academic Session ${payment.session}`,
      amount: payment.amount,
      method: payment.gatewayMethod ? `${method} - ${payment.gatewayMethod}` : method,
      reference: payment.razorpayPaymentId || payment.reference || '-',
      orderId: payment.razorpayOrderId,
      status: payment.status,
      refundAmount: payment.refundAmount,
      refundedAt: payment.refundedAt,
      generatedOn: new Date(),
    }),
    { assets: await resolveAssets(null), fontCss: fontCss() }
  );
  const pdf = await renderPdf(html);
  await writeAtomic(file, pdf);
  pruneOld(`receipt-${payment._id}`, file);
  return pdf;
}

/* ------------------------------ Pre-generation (background) ------------------------------ */
async function runPool(items, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      try {
        await worker(item);
      } catch (err) {
        console.error('[pdf] pre-generation failed:', err.message);
      }
    }
  });
  await Promise.all(runners);
}

export async function pregenerateForExamSession(examSessionId) {
  const exam = await ExamSession.findById(examSessionId).populate('course', 'name shortName').lean();
  if (!exam || exam.status !== 'published') return;
  const cards = await AdmitCard.find({ examSession: exam._id, status: 'issued' }).lean();
  const students = await Student.find({ _id: { $in: cards.map((c) => c.student) } }).lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const eligibility = await getEligibilityMap(exam, students);
  const todo = cards.filter((c) => eligibility.get(String(c.student))?.eligible && byId.has(String(c.student)));
  await runPool(todo, (card) => getCardPdf({ card, student: byId.get(String(card.student)), exam }));
}

export async function pregenerateForStudent(studentId) {
  const student = await Student.findById(studentId).lean();
  if (!student || student.isDeleted || student.status !== 'active') return;
  const exams = await ExamSession.find({ course: student.course, semester: student.semester, status: 'published' })
    .populate('course', 'name shortName')
    .lean();
  for (const exam of exams) {
    const card = await AdmitCard.findOne({ student: student._id, examSession: exam._id, status: 'issued' }).lean();
    if (!card) continue;
    const el = await checkEligibility(exam, student);
    if (el.eligible) await getCardPdf({ card, student, exam });
  }
}

export function runInBackground(label, fn) {
  setImmediate(() => {
    fn().catch((err) => console.error(`[pdf] ${label} failed:`, err.message));
  });
}

export const pregenerateForStudentLater = (studentId) =>
  runInBackground('student pre-generation', () => pregenerateForStudent(studentId));
export const pregenerateForExamSessionLater = (examSessionId) =>
  runInBackground('exam pre-generation', () => pregenerateForExamSession(examSessionId));

/* ------------------------------ Bulk PDF job ------------------------------ */
export async function runBulkPdf(jobId) {
  const job = await Job.findById(jobId);
  if (!job) return;

  const fail = (message, issues = []) =>
    Job.updateOne({ _id: jobId }, { $set: { status: 'failed', error: message, issues } });

  try {
    await Job.updateOne({ _id: jobId }, { $set: { status: 'running' } });
    const exam = await ExamSession.findById(job.params?.examSessionId).populate('course', 'name shortName').lean();
    if (!exam) return await fail('Exam session not found.');
    if (exam.status !== 'published') return await fail('Exam session is not published.');

    const students = await Student.find({ course: exam.course._id, semester: exam.semester, isDeleted: false }).lean();
    const cards = await AdmitCard.find({ examSession: exam._id }).lean();
    const cardByStudent = new Map(cards.map((c) => [String(c.student), c]));
    const eligibility = await getEligibilityMap(exam, students);
    const collator = new Intl.Collator('en', { numeric: true });
    students.sort((a, b) => collator.compare(a.rollNo, b.rollNo));

    const eligible = [];
    const issues = [];
    students.forEach((student, index) => {
      const card = cardByStudent.get(String(student._id));
      const el = eligibility.get(String(student._id));
      let reason = null;
      if (!card) reason = 'No card issued (use Sync new students).';
      else if (card.status !== 'issued') reason = 'Card revoked.';
      else if (!el.eligible) reason = REASON_TEXT[el.reason] || el.reason;
      if (reason) issues.push({ row: index + 1, ref: `${student.name} (${student.enrollmentNo})`, reason });
      else eligible.push({ card, student });
    });

    if (!eligible.length) return await fail('No eligible students. Every student is unpaid, inactive or has no card.', issues.slice(0, 5000));
    await Job.updateOne({ _id: jobId }, { $set: { 'progress.total': eligible.length, 'progress.done': 0 } });

    const assets = await resolveAssets(exam.assetsUsed);
    const css = fontCss();
    const merged = await PDFDocument.create();
    let done = 0;

    for (let i = 0; i < eligible.length; i += CHUNK_SIZE) {
      const slice = eligible.slice(i, i + CHUNK_SIZE);
      const pages = await Promise.all(
        slice.map(async ({ card, student }) => admitCardPage(await buildCardData({ card, student, exam })))
      );
      const buffer = await renderPdf(wrapHtml(pages.join(''), { assets, fontCss: css }), { timeoutMs: 180000 });
      const part = await PDFDocument.load(buffer);
      const copied = await merged.copyPages(part, part.getPageIndices());
      copied.forEach((p) => merged.addPage(p));
      done += slice.length;
      await Job.updateOne({ _id: jobId }, { $set: { 'progress.done': done } });
    }

    const friendly = `admit-cards_${exam.session}_${String(exam.course.shortName).replace(/[^A-Za-z0-9]+/g, '')}_sem${exam.semester}.pdf`;
    const file = path.join(config.paths.exports, `bulk-${jobId}.pdf`);
    await fs.promises.writeFile(file, await merged.save());

    await AdmitCard.updateMany(
      { _id: { $in: eligible.map((e) => e.card._id) } },
      { $inc: { downloadCount: 1 }, $set: { lastDownloadedAt: new Date() } }
    );
    await Job.updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'completed',
          resultFile: file,
          resultFileName: friendly,
          summary: { totalStudents: students.length, included: eligible.length, skipped: issues.length },
          issues: issues.slice(0, 5000),
        },
      }
    );
    await audit(null, 'BULK_DOWNLOAD', {
      actor: job.createdBy,
      actorType: 'admin',
      entity: 'ExamSession',
      entityId: exam._id,
      details: { included: eligible.length, skipped: issues.length },
    });
  } catch (err) {
    console.error('[pdf] bulk job failed:', err);
    await Job.updateOne(
      { _id: jobId },
      { $set: { status: 'failed', error: err instanceof AppError ? err.message : 'Bulk PDF generation failed.' } }
    );
  }
}

/* ------------------------------ Startup / shutdown ------------------------------ */
async function cleanupFiles() {
  const rules = [
    [config.paths.exports, 24 * 60 * 60 * 1000],
    [config.paths.pdfCache, 60 * 24 * 60 * 60 * 1000],
  ];
  for (const [dir, maxAge] of rules) {
    try {
      const cutoff = Date.now() - maxAge;
      for (const name of await fs.promises.readdir(dir)) {
        const full = path.join(dir, name);
        const st = await fs.promises.stat(full).catch(() => null);
        if (st?.isFile() && st.mtimeMs < cutoff) await fs.promises.rm(full, { force: true });
      }
    } catch (err) {
      console.error('[pdf] cleanup failed:', err.message);
    }
  }
}

export async function startPdfEngine() {
  const { missing } = verifyAssets();
  if (missing.length) {
    const message = `[pdf] Missing required files: ${missing.join(', ')}`;
    if (config.isProd) {
      console.error(message);
      process.exit(1);
    }
    console.warn(`${message} (allowed in development, add them before going live)`);
  }

  try {
    await getBrowser();
    console.log('[pdf] Chromium ready');
  } catch (err) {
    if (config.isProd) {
      console.error('[pdf] Chromium failed to start:', err.message);
      process.exit(1);
    }
    console.warn('[pdf] Chromium could not start. PDF features will fail until it works:', err.message);
  }

  cleanupFiles();
  setInterval(cleanupFiles, 60 * 60 * 1000).unref();
}

export async function stopPdfEngine() {
  await resetBrowser();
}