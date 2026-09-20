import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { AdmitCard, Course, ExamSession, Job, Student, Subscription } from '../models.js';
import {
  AppError,
  asyncHandler,
  audit,
  downloadLimiter,
  requireAdmin,
  requireStudent,
  validate,
  verifyLimiter,
} from '../security.js';
import {
  REASON_TEXT,
  buildCardNo,
  checkEligibility,
  currentAssetNames,
  getCardPdf,
  getEligibilityMap,
  pregenerateForExamSessionLater,
  renderPreviewPdf,
  runBulkPdf,
  verifyAssets,
} from '../pdf.js';
import { totalSemesters, yearOf } from './master.js';

const router = Router();

router.param('id', (req, res, next, v) =>
  /^[a-f\d]{24}$/i.test(v) ? next() : next(new AppError(400, 'Invalid id.', 'INVALID_ID'))
);
router.param('cardId', (req, res, next, v) =>
  /^[a-f\d]{24}$/i.test(v) ? next() : next(new AppError(400, 'Invalid id.', 'INVALID_ID'))
);
router.param('jobId', (req, res, next, v) =>
  /^[a-f\d]{24}$/i.test(v) ? next() : next(new AppError(400, 'Invalid id.', 'INVALID_ID'))
);
router.param('token', (req, res, next, v) =>
  /^[a-f0-9]{32}$/.test(v) ? next() : next(new AppError(404, 'Admit card not found.', 'NOT_FOUND'))
);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id.');
const sessionSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}$/, 'Use the format 2025-26.')
  .refine((v) => (Number(v.slice(0, 4)) + 1) % 100 === Number(v.slice(5)), 'Session years must be consecutive, e.g. 2025-26.');
const clean = (min, max) =>
  z
    .string()
    .max(max * 2)
    .transform((v) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(min, 'Required.').max(max));

const DEFAULT_INSTRUCTIONS = [
  'Candidates must carry this admit card to the examination hall on every exam day.',
  'Candidates must report at the examination hall at least 15 minutes before the exam starts.',
  'Mobile phones, smart watches and other electronic devices are strictly prohibited in the examination hall.',
  'Use of unfair means or carrying study material into the examination hall is strictly prohibited.',
  'This admit card is valid only along with the college identity card.',
];

const timetableRow = z.object({
  date: z.coerce.date(),
  subject: clean(1, 150),
  time: clean(1, 60),
});

const examBody = z.object({
  session: sessionSchema,
  course: objectId,
  semester: z.coerce.number().int().min(1).max(20),
  examName: clean(2, 80).default('Internal Examination'),
  timetable: z.array(timetableRow).min(1, 'Add at least one timetable row.').max(12, 'Maximum 12 timetable rows.'),
  instructions: z.array(clean(1, 300)).max(10, 'Maximum 10 instructions.'),
});

/* ------------------------------ Helpers ------------------------------ */
const dateStr = (d) => new Date(d).toISOString().slice(0, 10);

const serializeExam = (e, cardCount = 0) => ({
  id: String(e._id),
  session: e.session,
  course: e.course?._id
    ? { id: String(e.course._id), shortName: e.course.shortName, name: e.course.name }
    : { id: String(e.course) },
  year: e.year,
  semester: e.semester,
  examName: e.examName,
  examCode: e.examCode,
  timetable: (e.timetable || []).map((r) => ({ date: dateStr(r.date), subject: r.subject, time: r.time })),
  instructions: e.instructions || [],
  status: e.status,
  version: e.version,
  publishedAt: e.publishedAt || null,
  everPublished: Boolean(e.publishedAt),
  cardCount,
  createdAt: e.createdAt,
});

async function loadCourse(courseId, semester) {
  const course = await Course.findById(courseId).lean();
  if (!course) throw new AppError(400, 'Selected course does not exist.', 'INVALID_COURSE');
  if (semester > totalSemesters(course)) {
    throw new AppError(400, `${course.shortName} has only ${totalSemesters(course)} semesters.`, 'INVALID_SEMESTER');
  }
  return course;
}

function assertTimetable(rows) {
  const seen = new Set();
  let previous = null;
  rows.forEach((r, i) => {
    const key = `${dateStr(r.date)}|${r.subject.toLowerCase()}`;
    if (seen.has(key)) throw new AppError(400, `Row ${i + 1}: this subject is already listed on the same date.`, 'INVALID_TIMETABLE');
    seen.add(key);
    if (previous && r.date.getTime() < previous.getTime()) {
      throw new AppError(400, `Row ${i + 1}: dates must be in ascending order.`, 'INVALID_TIMETABLE');
    }
    previous = r.date;
  });
}

function baseExamCode(name) {
  const n = name.toLowerCase();
  const digits = (name.match(/\d+/) || [''])[0];
  let base;
  if (n.includes('internal')) base = 'INT';
  else if (n.includes('mid')) base = 'MID';
  else if (n.includes('end')) base = 'END';
  else base = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'EXM';
  return `${base}${digits}`.slice(0, 10);
}

// Card numbers must never collide, so two exams of the same semester get different codes.
async function uniqueExamCode(b, courseId) {
  const base = baseExamCode(b.examName);
  let code = base;
  let n = 2;
  while (await ExamSession.exists({ session: b.session, course: courseId, semester: b.semester, examCode: code })) {
    code = `${base}${n}`;
    n += 1;
  }
  return code;
}

const dupExam = () =>
  new AppError(409, 'An exam session with the same session, course, semester and examination name already exists.', 'DUPLICATE');

async function createMissingCards(exam) {
  const courseId = exam.course._id || exam.course;
  const students = await Student.find({ course: courseId, semester: exam.semester, isDeleted: false, status: 'active' })
    .select('_id')
    .lean();
  const existing = await AdmitCard.find({ examSession: exam._id }).select('student').lean();
  const have = new Set(existing.map((c) => String(c.student)));
  const missing = students.filter((s) => !have.has(String(s._id)));
  if (!missing.length) return 0;

  const course = exam.course._id ? exam.course : await Course.findById(courseId).lean();
  const updated = await ExamSession.findOneAndUpdate(
    { _id: exam._id },
    { $inc: { cardCounter: missing.length } },
    { new: true }
  )
    .select('cardCounter')
    .lean();
  const start = updated.cardCounter - missing.length;

  const docs = missing.map((s, i) => ({
    student: s._id,
    examSession: exam._id,
    cardNo: buildCardNo(exam, course, start + i + 1),
    qrToken: crypto.randomBytes(16).toString('hex'),
  }));
  try {
    await AdmitCard.insertMany(docs, { ordered: false });
  } catch (err) {
    // A parallel request may have inserted some of the same cards. Anything else is a real error.
    if (!(err?.code === 11000 || err?.name === 'MongoBulkWriteError')) throw err;
  }
  return docs.length;
}

async function loadBundle(cardId) {
  const card = await AdmitCard.findById(cardId).lean();
  if (!card) return null;
  const [student, exam] = await Promise.all([
    Student.findById(card.student).lean(),
    ExamSession.findById(card.examSession).populate('course', 'name shortName').lean(),
  ]);
  if (!student || !exam) return null;
  return { card, student, exam };
}

async function loadActiveStudent(id) {
  const student = await Student.findById(id).lean();
  if (!student || student.isDeleted) throw new AppError(401, 'Account not found.', 'UNAUTHENTICATED');
  if (student.status !== 'active') throw new AppError(403, 'Account disabled.', 'ACCOUNT_DISABLED');
  return student;
}

function sendPdf(res, buffer, filename, mode) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${mode === 'download' ? 'attachment' : 'inline'}; filename="${filename}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buffer);
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
const pdfQuery = z.object({ mode: z.enum(['preview', 'download']).default('preview') });

/* ------------------------------ Admin: defaults ------------------------------ */
router.get(
  '/defaults',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { names, missing } = verifyAssets();
    res.json({
      success: true,
      collegeName: config.college.name,
      examNames: ['Internal Examination', 'Mid Sem Examination', 'End Sem Examination'],
      instructions: DEFAULT_INSTRUCTIONS,
      assets: names,
      missingAssets: missing,
    });
  })
);

/* ------------------------------ Admin: exam sessions ------------------------------ */
const listQuery = z.object({
  session: sessionSchema.optional(),
  course: objectId.optional(),
  semester: z.coerce.number().int().min(1).max(20).optional(),
  status: z.enum(['draft', 'published']).optional(),
});

router.get(
  '/sessions',
  requireAdmin,
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const filter = {};
    for (const key of ['session', 'course', 'semester', 'status']) {
      if (req.query[key] !== undefined) filter[key] = req.query[key];
    }
    const [items, counts] = await Promise.all([
      ExamSession.find(filter).populate('course', 'name shortName').sort({ session: -1, semester: 1, createdAt: -1 }).limit(300).lean(),
      AdmitCard.aggregate([{ $group: { _id: '$examSession', n: { $sum: 1 } } }]),
    ]);
    const cc = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json({ success: true, items: items.map((e) => serializeExam(e, cc.get(String(e._id)) || 0)) });
  })
);

router.get(
  '/sessions/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const exam = await ExamSession.findById(req.params.id).populate('course', 'name shortName').lean();
    if (!exam) throw new AppError(404, 'Exam session not found.', 'NOT_FOUND');
    const cardCount = await AdmitCard.countDocuments({ examSession: exam._id });
    res.json({ success: true, item: serializeExam(exam, cardCount) });
  })
);

router.post(
  '/sessions',
  requireAdmin,
  validate({ body: examBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const course = await loadCourse(b.course, b.semester);
    assertTimetable(b.timetable);
    const examCode = await uniqueExamCode(b, course._id);

    let exam;
    try {
      exam = await ExamSession.create({
        session: b.session,
        course: course._id,
        year: yearOf(course, b.semester),
        semester: b.semester,
        examName: b.examName,
        examCode,
        timetable: b.timetable,
        instructions: b.instructions,
        status: 'draft',
        assetsUsed: currentAssetNames(),
      });
    } catch (err) {
      if (err?.code === 11000) throw dupExam();
      throw err;
    }
    await audit(req, 'EXAM_CREATE', {
      entity: 'ExamSession',
      entityId: exam._id,
      details: { session: exam.session, semester: exam.semester, examName: exam.examName },
    });
    await exam.populate('course', 'name shortName');
    res.status(201).json({ success: true, item: serializeExam(exam.toObject()) });
  })
);

router.put(
  '/sessions/:id',
  requireAdmin,
  validate({ body: examBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const exam = await ExamSession.findById(req.params.id);
    if (!exam) throw new AppError(404, 'Exam session not found.', 'NOT_FOUND');
    assertTimetable(b.timetable);

    if (exam.publishedAt) {
      // Cards already exist: identity of the exam is locked, only timetable and instructions change.
      const locked =
        b.session !== exam.session ||
        b.course !== String(exam.course) ||
        b.semester !== exam.semester ||
        b.examName !== exam.examName;
      if (locked) {
        throw new AppError(409, 'Session, course, semester and examination name cannot be changed after publishing.', 'EXAM_LOCKED');
      }
      exam.timetable = b.timetable;
      exam.instructions = b.instructions;
      exam.version += 1;
      await exam.save();
      await AdmitCard.updateMany({ examSession: exam._id }, { $inc: { version: 1 } });
      await audit(req, 'EXAM_EDIT_PUBLISHED', { entity: 'ExamSession', entityId: exam._id, details: { version: exam.version } });
      if (exam.status === 'published') pregenerateForExamSessionLater(exam._id);
    } else {
      const course = await loadCourse(b.course, b.semester);
      exam.session = b.session;
      exam.course = course._id;
      exam.year = yearOf(course, b.semester);
      exam.semester = b.semester;
      exam.examName = b.examName;
      exam.timetable = b.timetable;
      exam.instructions = b.instructions;
      exam.examCode = await uniqueExamCode({ ...b, examName: b.examName }, course._id).then(async (code) => {
        // keep the existing code if it is still free for this scope
        const clash = await ExamSession.exists({
          _id: { $ne: exam._id },
          session: b.session,
          course: course._id,
          semester: b.semester,
          examCode: exam.examCode,
        });
        return clash ? code : exam.examCode;
      });
      try {
        await exam.save();
      } catch (err) {
        if (err?.code === 11000) throw dupExam();
        throw err;
      }
      await audit(req, 'EXAM_UPDATE', { entity: 'ExamSession', entityId: exam._id });
    }
    await exam.populate('course', 'name shortName');
    const cardCount = await AdmitCard.countDocuments({ examSession: exam._id });
    res.json({ success: true, item: serializeExam(exam.toObject(), cardCount) });
  })
);

router.delete(
  '/sessions/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const exam = await ExamSession.findById(req.params.id);
    if (!exam) throw new AppError(404, 'Exam session not found.', 'NOT_FOUND');
    if (exam.status !== 'draft' || (await AdmitCard.exists({ examSession: exam._id }))) {
      throw new AppError(409, 'Only a draft with no issued cards can be deleted. Unpublish it instead.', 'EXAM_IN_USE');
    }
    await exam.deleteOne();
    await audit(req, 'EXAM_DELETE', { entity: 'ExamSession', entityId: exam._id });
    res.json({ success: true });
  })
);

// Renders a real PDF with a sample student from the unsaved form data.
router.post(
  '/preview',
  requireAdmin,
  downloadLimiter,
  validate({ body: examBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const course = await loadCourse(b.course, b.semester);
    assertTimetable(b.timetable);
    const pdf = await renderPreviewPdf({
      session: b.session,
      course: { name: course.name, shortName: course.shortName },
      year: yearOf(course, b.semester),
      semester: b.semester,
      examName: b.examName,
      examCode: baseExamCode(b.examName),
      timetable: b.timetable,
      instructions: b.instructions,
    });
    sendPdf(res, pdf, 'admit-card-preview.pdf', 'preview');
  })
);

/* ------------------------------ Admin: publish / unpublish / sync ------------------------------ */
router.post(
  '/sessions/:id/publish',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const exam = await ExamSession.findById(req.params.id).populate('course', 'name shortName');
    if (!exam) throw new AppError(404, 'Exam session not found.', 'NOT_FOUND');
    if (exam.status === 'published') throw new AppError(409, 'This exam session is already published.', 'INVALID_STATE');

    const assets = currentAssetNames();
    if (config.isProd && (!assets.logo || !assets.principalSign || !assets.inchargeSign)) {
      throw new AppError(409, 'Logo or signature files are missing on the server.', 'ASSETS_MISSING');
    }
    exam.assetsUsed = assets;
    exam.status = 'published';
    exam.publishedAt = exam.publishedAt || new Date();
    await exam.save();

    const created = await createMissingCards(exam.toObject());
    await audit(req, 'EXAM_PUBLISH', {
      entity: 'ExamSession',
      entityId: exam._id,
      details: { session: exam.session, semester: exam.semester, cardsCreated: created },
    });
    pregenerateForExamSessionLater(exam._id);
    res.json({ success: true, cardsCreated: created });
  })
);

router.post(
  '/sessions/:id/unpublish',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const exam = await ExamSession.findOneAndUpdate(
      { _id: req.params.id, status: 'published' },
      { $set: { status: 'draft' } },
      { new: true }
    );
    if (!exam) throw new AppError(409, 'This exam session is not published.', 'INVALID_STATE');
    await audit(req, 'EXAM_UNPUBLISH', { entity: 'ExamSession', entityId: exam._id });
    res.json({ success: true });
  })
);

router.post(
  '/sessions/:id/sync',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const exam = await ExamSession.findById(req.params.id).populate('course', 'name shortName').lean();
    if (!exam) throw new AppError(404, 'Exam session not found.', 'NOT_FOUND');
    if (exam.status !== 'published') throw new AppError(409, 'Publish the exam session first.', 'INVALID_STATE');
    const created = await createMissingCards(exam);
    await audit(req, 'EXAM_SYNC', { entity: 'ExamSession', entityId: exam._id, details: { cardsCreated: created } });
    if (created) pregenerateForExamSessionLater(exam._id);
    res.json({ success: true, cardsCreated: created });
  })
);

/* ------------------------------ Admin: cohort view ------------------------------ */
const cohortQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ready', 'blocked']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  '/sessions/:id/cohort',
  requireAdmin,
  validate({ query: cohortQuery }),
  asyncHandler(async (req, res) => {
    const exam = await ExamSession.findById(req.params.id).populate('course', 'name shortName').lean();
    if (!exam) throw new AppError(404, 'Exam session not found.', 'NOT_FOUND');
    const { q, status, page, limit } = req.query;

    const filter = { course: exam.course._id, semester: exam.semester, isDeleted: false };
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ name: rx }, { enrollmentNo: rx }, { rollNo: rx }, { email: rx }];
    }
    const total = await Student.countDocuments(filter);
    if (total > 5000) throw new AppError(400, 'Too many students. Use the search box to narrow down.', 'TOO_MANY');

    const students = await Student.find(filter).sort({ name: 1 }).collation({ locale: 'en', strength: 2 }).lean();
    const cards = await AdmitCard.find({ examSession: exam._id, student: { $in: students.map((s) => s._id) } }).lean();
    const cardBy = new Map(cards.map((c) => [String(c.student), c]));
    const eligibility = await getEligibilityMap(exam, students);

    let rows = students.map((s) => {
      const card = cardBy.get(String(s._id));
      const el = eligibility.get(String(s._id));
      let cardStatus = 'ready';
      let reason = null;
      if (!card) {
        cardStatus = 'blocked';
        reason = exam.status === 'published' ? 'No card yet (use Sync new students).' : 'Exam not published.';
      } else if (card.status !== 'issued') {
        cardStatus = 'blocked';
        reason = 'Card revoked.';
      } else if (!el.eligible) {
        cardStatus = 'blocked';
        reason = REASON_TEXT[el.reason];
      }
      return {
        studentId: String(s._id),
        name: s.name,
        enrollmentNo: s.enrollmentNo,
        rollNo: s.rollNo,
        studentStatus: s.status,
        subscriptionStatus: el.subscriptionStatus,
        cardId: card ? String(card._id) : null,
        cardNo: card?.cardNo || null,
        cardStatus,
        reason,
        version: card?.version || null,
        downloadCount: card?.downloadCount || 0,
      };
    });

    const summary = {
      total: rows.length,
      ready: rows.filter((r) => r.cardStatus === 'ready').length,
      blocked: rows.filter((r) => r.cardStatus === 'blocked').length,
    };
    if (status) rows = rows.filter((r) => r.cardStatus === status);
    const start = (page - 1) * limit;

    res.json({
      success: true,
      exam: serializeExam(exam),
      summary,
      items: rows.slice(start, start + limit),
      total: rows.length,
      page,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
    });
  })
);

/* ------------------------------ Admin: single card PDF ------------------------------ */
router.get(
  '/cards/:cardId/pdf',
  requireAdmin,
  downloadLimiter,
  validate({ query: pdfQuery }),
  asyncHandler(async (req, res) => {
    const bundle = await loadBundle(req.params.cardId);
    if (!bundle) throw new AppError(404, 'Admit card not found.', 'NOT_FOUND');
    const { mode } = req.query;

    if (mode === 'download') {
      const el = await checkEligibility(bundle.exam, bundle.student);
      if (!el.eligible || bundle.card.status !== 'issued') {
        throw new AppError(403, `Download blocked: ${REASON_TEXT[el.reason] || 'card revoked.'}`, 'BLOCKED');
      }
    }
    const pdf = await getCardPdf(bundle);
    if (mode === 'download') {
      await AdmitCard.updateOne(
        { _id: bundle.card._id },
        { $inc: { downloadCount: 1 }, $set: { lastDownloadedAt: new Date() } }
      );
    }
    sendPdf(res, pdf, `admit-card-${safeName(bundle.student.enrollmentNo)}.pdf`, mode);
  })
);

/* ------------------------------ Admin: bulk download ------------------------------ */
router.post(
  '/sessions/:id/bulk',
  requireAdmin,
  downloadLimiter,
  asyncHandler(async (req, res) => {
    const exam = await ExamSession.findById(req.params.id).select('status').lean();
    if (!exam) throw new AppError(404, 'Exam session not found.', 'NOT_FOUND');
    if (exam.status !== 'published') throw new AppError(409, 'Publish the exam session first.', 'INVALID_STATE');
    if (await Job.exists({ type: 'bulkPdf', status: { $in: ['queued', 'running'] } })) {
      throw new AppError(409, 'Another bulk download is already running. Please wait for it to finish.', 'JOB_RUNNING');
    }
    const job = await Job.create({
      type: 'bulkPdf',
      status: 'queued',
      params: { examSessionId: String(exam._id) },
      createdBy: req.auth.email,
    });
    setImmediate(() => {
      runBulkPdf(job._id).catch((err) => console.error('[pdf] runBulkPdf crashed:', err));
    });
    res.status(202).json({ success: true, jobId: String(job._id) });
  })
);

router.get(
  '/bulk-jobs/:jobId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.jobId, type: 'bulkPdf' }).lean();
    if (!job) throw new AppError(404, 'Job not found.', 'NOT_FOUND');
    res.json({
      success: true,
      job: {
        id: String(job._id),
        status: job.status,
        progress: job.progress,
        summary: job.summary || null,
        error: job.error || null,
        skipped: (job.issues || []).slice(0, 1000).map((i) => ({ ref: i.ref, reason: i.reason })),
        hasFile: Boolean(job.resultFile),
      },
    });
  })
);

router.get(
  '/bulk-jobs/:jobId/download',
  requireAdmin,
  downloadLimiter,
  asyncHandler(async (req, res, next) => {
    const job = await Job.findOne({ _id: req.params.jobId, type: 'bulkPdf', status: 'completed' }).lean();
    if (!job?.resultFile) throw new AppError(404, 'File not available.', 'NOT_FOUND');
    const resolved = path.resolve(job.resultFile);
    if (!resolved.startsWith(path.resolve(config.paths.exports) + path.sep)) {
      throw new AppError(404, 'File not available.', 'NOT_FOUND');
    }
    try {
      await fs.promises.access(resolved);
    } catch {
      throw new AppError(410, 'This file has expired. Please generate it again.', 'FILE_EXPIRED');
    }
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.download(resolved, job.resultFileName || 'admit-cards.pdf', (err) => {
      if (err && !res.headersSent) next(err);
    });
  })
);

/* ------------------------------ Student ------------------------------ */
router.get(
  '/my',
  requireStudent,
  asyncHandler(async (req, res) => {
    const student = await loadActiveStudent(req.auth.id);
    const exams = await ExamSession.find({ course: student.course, semester: student.semester, status: 'published' })
      .sort({ publishedAt: -1 })
      .lean();
    const cards = await AdmitCard.find({
      student: student._id,
      examSession: { $in: exams.map((e) => e._id) },
      status: 'issued',
    }).lean();
    const cardBy = new Map(cards.map((c) => [String(c.examSession), c]));

    const items = [];
    for (const exam of exams) {
      const card = cardBy.get(String(exam._id));
      if (!card) continue;
      const el = await checkEligibility(exam, student);
      items.push({
        cardId: String(card._id),
        cardNo: card.cardNo,
        examName: exam.examName,
        session: exam.session,
        semester: exam.semester,
        year: exam.year,
        eligible: el.eligible,
        reason: el.eligible ? null : REASON_TEXT[el.reason],
        updated: card.version > 1,
        publishedAt: exam.publishedAt,
      });
    }
    res.json({ success: true, items });
  })
);

// Eligibility is re-checked on the server for every request, preview and download alike.
router.get(
  '/my/:cardId/pdf',
  requireStudent,
  downloadLimiter,
  validate({ query: pdfQuery }),
  asyncHandler(async (req, res) => {
    const student = await loadActiveStudent(req.auth.id);
    const bundle = await loadBundle(req.params.cardId);
    if (!bundle || String(bundle.card.student) !== String(student._id)) {
      throw new AppError(404, 'Admit card not found.', 'NOT_FOUND');
    }
    const { card, exam } = bundle;
    if (card.status !== 'issued') throw new AppError(403, 'This admit card has been revoked.', 'BLOCKED');
    if (String(exam.course._id) !== String(student.course) || exam.semester !== student.semester) {
      throw new AppError(403, 'This admit card is not available for your current semester.', 'BLOCKED');
    }
    const el = await checkEligibility(exam, student);
    if (!el.eligible) throw new AppError(403, REASON_TEXT[el.reason], 'BLOCKED');

    const pdf = await getCardPdf({ card, student, exam });
    if (req.query.mode === 'download') {
      await AdmitCard.updateOne({ _id: card._id }, { $inc: { downloadCount: 1 }, $set: { lastDownloadedAt: new Date() } });
    }
    sendPdf(res, pdf, `admit-card-${safeName(student.enrollmentNo)}.pdf`, req.query.mode);
  })
);

/* ------------------------------ Public: QR verification ------------------------------ */
router.get(
  '/verify/:token',
  verifyLimiter,
  asyncHandler(async (req, res) => {
    const card = await AdmitCard.findOne({ qrToken: req.params.token }).lean();
    if (!card) throw new AppError(404, 'Admit card not found.', 'NOT_FOUND');
    const [student, exam] = await Promise.all([
      Student.findById(card.student).lean(),
      ExamSession.findById(card.examSession).populate('course', 'name shortName').lean(),
    ]);
    if (!student || !exam) throw new AppError(404, 'Admit card not found.', 'NOT_FOUND');

    const el = await checkEligibility(exam, student);
    const valid = card.status === 'issued' && el.eligible;
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      valid,
      status: valid ? 'Valid' : 'Revoked',
      card: {
        cardNo: card.cardNo,
        name: student.name,
        enrollmentNo: student.enrollmentNo,
        session: exam.session,
        semester: exam.semester,
        examName: exam.examName,
        course: exam.course.shortName,
      },
    });
  })
);

export default router;