import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { config } from '../config.js';
import { Course, Job, Payment, Student, Subscription } from '../models.js';
import { AppError, asyncHandler, audit, requireAdmin, validate } from '../security.js';
import { analyseCsv, cleanCell, runCsvImport } from '../jobs.js';
import { totalSemesters, yearOf } from './master.js';

const router = Router();
router.use(requireAdmin);

router.param('id', (req, res, next, value) => {
  if (!/^[a-f\d]{24}$/i.test(value)) return next(new AppError(400, 'Invalid id.', 'INVALID_ID'));
  return next();
});

const EXPORT_LIMIT = 20000;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id.');
const sessionSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}$/, 'Use the format 2025-26.')
  .refine((v) => (Number(v.slice(0, 4)) + 1) % 100 === Number(v.slice(5)), 'Session years must be consecutive.');
const text = (min, max) =>
  z.string().max(max * 3).transform(cleanCell).pipe(z.string().min(min, 'Required.').max(max));

const filterQuery = z.object({
  q: z.string().trim().max(100).optional(),
  course: objectId.optional(),
  year: z.coerce.number().int().min(1).max(10).optional(),
  semester: z.coerce.number().int().min(1).max(20).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  session: sessionSchema.optional(),
  subscriptionStatus: z.enum(['paid', 'unpaid', 'pending', 'failed', 'refunded', 'waived']).optional(),
});
const listQuery = filterQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['name', 'enrollmentNo', 'rollNo', 'createdAt']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

const studentBody = z.object({
  name: text(2, 120),
  enrollmentNo: text(1, 40),
  rollNo: text(1, 40),
  email: z.string().trim().toLowerCase().email().max(200),
  course: objectId,
  year: z.coerce.number().int().min(1).max(10),
  semester: z.coerce.number().int().min(1).max(20),
});

/* ------------------------------ Helpers ------------------------------ */
// Session-wide subscription status per (student, semester). A subscription wins over payments.
async function sessionStatusPairs(session) {
  const [subs, pays] = await Promise.all([
    Subscription.find({ session }).select('student semester status').lean(),
    Payment.find({ session, status: { $in: ['created', 'pending', 'failed'] } })
      .select('student semester status createdAt')
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  const map = new Map();
  for (const p of pays) {
    map.set(`${p.student}:${p.semester}`, {
      student: p.student,
      semester: p.semester,
      status: p.status === 'failed' ? 'failed' : 'pending',
    });
  }
  for (const s of subs) {
    map.set(`${s.student}:${s.semester}`, { student: s.student, semester: s.semester, status: s.status });
  }
  return map;
}

async function buildFilter(q) {
  const filter = { isDeleted: false };
  if (q.course) filter.course = q.course;
  if (q.year) filter.year = q.year;
  if (q.semester) filter.semester = q.semester;
  if (q.status) filter.status = q.status;
  const and = [];

  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    and.push({ $or: [{ name: rx }, { email: rx }, { enrollmentNo: rx }, { rollNo: rx }] });
  }

  if (q.subscriptionStatus) {
    if (!q.session) {
      throw new AppError(400, 'Select a session to filter by subscription status.', 'SESSION_REQUIRED');
    }
    const entries = [...(await sessionStatusPairs(q.session)).values()];
    const pair = (e) => ({ _id: e.student, semester: e.semester });
    if (q.subscriptionStatus === 'unpaid') {
      if (entries.length) and.push({ $nor: entries.map(pair) });
    } else {
      const matching = entries.filter((e) => e.status === q.subscriptionStatus).map(pair);
      and.push(matching.length ? { $or: matching } : { _id: { $in: [] } });
    }
  }

  if (and.length) filter.$and = and;
  return filter;
}

const serialize = (s, statusMap) => ({
  id: String(s._id),
  name: s.name,
  enrollmentNo: s.enrollmentNo,
  rollNo: s.rollNo,
  email: s.email,
  course: s.course ? { id: String(s.course._id), shortName: s.course.shortName, name: s.course.name } : null,
  year: s.year,
  semester: s.semester,
  status: s.status,
  subscriptionStatus: statusMap ? statusMap.get(`${s._id}:${s.semester}`)?.status ?? 'unpaid' : null,
  createdAt: s.createdAt,
});

async function assertAcademic(courseId, year, semester, { requireActive }) {
  const course = await Course.findById(courseId).lean();
  if (!course || (requireActive && !course.isActive)) {
    throw new AppError(400, 'Selected course is not available.', 'INVALID_COURSE');
  }
  if (semester > totalSemesters(course)) {
    throw new AppError(400, `${course.shortName} has only ${totalSemesters(course)} semesters.`, 'INVALID_SEMESTER');
  }
  if (yearOf(course, semester) !== year) {
    throw new AppError(400, `Semester ${semester} belongs to Year ${yearOf(course, semester)}, not Year ${year}.`, 'YEAR_SEMESTER_MISMATCH');
  }
  return course;
}

async function assertUnique({ email, enrollmentNo }, excludeId) {
  const filter = { isDeleted: false, $or: [{ email }, { enrollmentNo }] };
  if (excludeId) filter._id = { $ne: excludeId };
  const found = await Student.findOne(filter).select('email enrollmentNo').lean();
  if (!found) return;
  if (found.email === email) throw new AppError(409, 'A student with this email already exists.', 'DUPLICATE_EMAIL');
  throw new AppError(409, 'A student with this enrollment number already exists.', 'DUPLICATE_ENROLLMENT');
}

const csvEscape = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/* ------------------------------ CSV upload ------------------------------ */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.csvTemp),
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}.csv`),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.csv$/i.test(file.originalname)) return cb(null, true);
    return cb(new AppError(400, 'Only .csv files are allowed.', 'INVALID_FILE'));
  },
});

function uploadCsv(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(413, 'File is too large. Maximum size is 2 MB.', 'FILE_TOO_LARGE'));
    }
    if (err instanceof AppError) return next(err);
    return next(new AppError(400, 'Invalid file upload.', 'UPLOAD_ERROR'));
  });
}

/* ------------------------------ Static routes (before /:id) ------------------------------ */
router.get(
  '/export',
  validate({ query: filterQuery }),
  asyncHandler(async (req, res) => {
    const filter = await buildFilter(req.query);
    const total = await Student.countDocuments(filter);
    if (total > EXPORT_LIMIT) {
      throw new AppError(400, `Too many students to export (${total}). Apply filters (maximum ${EXPORT_LIMIT}).`, 'EXPORT_TOO_LARGE');
    }
    const students = await Student.find(filter)
      .populate('course', 'shortName')
      .sort({ name: 1 })
      .collation({ locale: 'en', strength: 2 })
      .lean();
    const statusMap = req.query.session ? await sessionStatusPairs(req.query.session) : null;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Students');
    ws.columns = [
      { header: 'Student Name', key: 'name', width: 28 },
      { header: 'Enrollment No.', key: 'enrollmentNo', width: 18 },
      { header: 'Roll No.', key: 'rollNo', width: 12 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Course', key: 'course', width: 14 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Semester', key: 'semester', width: 10 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Subscription', key: 'subscription', width: 14 },
    ];
    const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v);
    for (const s of students) {
      ws.addRow({
        name: safe(s.name),
        enrollmentNo: safe(s.enrollmentNo),
        rollNo: safe(s.rollNo),
        email: safe(s.email),
        course: s.course?.shortName || '',
        year: s.year,
        semester: s.semester,
        status: s.status,
        subscription: statusMap ? statusMap.get(`${s._id}:${s.semester}`)?.status ?? 'unpaid' : '',
      });
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = await wb.xlsx.writeBuffer();
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="students.xlsx"',
    });
    res.end(Buffer.from(buffer));
  })
);

router.get(
  '/sample-csv',
  asyncHandler(async (req, res) => {
    const course = await Course.findOne({ isActive: true }).sort({ createdAt: 1 }).lean();
    const short = course?.shortName || 'B.Pharm';
    const csv =
      [
        'Student Name,Enrollment No.,Email,Roll No.,Year,Semester,Course',
        `Rahul Sharma,EN2025001,rahul.sharma@example.com,101,1,1,"${short}"`,
        `Priya Verma,EN2025002,priya.verma@example.com,102,1,2,"${short}"`,
      ].join('\r\n') + '\r\n';
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="students-sample.csv"',
    });
    res.send(csv);
  })
);

router.post(
  '/import/preview',
  uploadCsv,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, 'Please choose a CSV file.', 'NO_FILE');
    const token = path.basename(req.file.filename, '.csv');
    try {
      const buffer = await fs.promises.readFile(req.file.path);
      const { rows, summary } = await analyseCsv(buffer);
      const order = { error: 0, duplicate: 1, valid: 2 };
      const preview = [...rows]
        .sort((a, b) => order[a.status] - order[b.status] || a.row - b.row)
        .slice(0, 300)
        .map((r) => ({
          row: r.row,
          name: r.name,
          enrollmentNo: r.enrollmentNo,
          rollNo: r.rollNo,
          email: r.email,
          course: r.courseShort,
          year: Number.isNaN(r.year) ? null : r.year,
          semester: Number.isNaN(r.semester) ? null : r.semester,
          status: r.status,
          messages: r.messages,
        }));
      res.json({ success: true, token, summary, rows: preview, truncated: rows.length > preview.length });
    } catch (err) {
      await fs.promises.rm(req.file.path, { force: true }).catch(() => {});
      throw err;
    }
  })
);

router.post(
  '/import/confirm',
  validate({
    body: z.object({
      token: z.string().regex(/^[a-f0-9]{32}$/, 'Invalid upload token.'),
      duplicateMode: z.enum(['skip', 'update']),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { token, duplicateMode } = req.body;
    const source = path.join(config.paths.csvTemp, `${token}.csv`);
    const claimed = path.join(config.paths.csvTemp, `${token}.claimed`);

    // Atomic claim: only one confirm request can rename the file.
    try {
      await fs.promises.rename(source, claimed);
    } catch {
      const existing = await Job.findOne({ type: 'csvImport', 'params.token': token }).select('_id').lean();
      if (existing) return res.json({ success: true, jobId: String(existing._id) });
      throw new AppError(404, 'This upload has expired. Please upload the file again.', 'UPLOAD_EXPIRED');
    }

    const job = await Job.create({
      type: 'csvImport',
      status: 'queued',
      params: { token, file: claimed, duplicateMode },
      createdBy: req.auth.email,
    });
    setImmediate(() => {
      runCsvImport(job._id).catch((err) => console.error('[jobs] runCsvImport crashed:', err));
    });
    return res.status(202).json({ success: true, jobId: String(job._id) });
  })
);

router.get(
  '/import/jobs/:id',
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, type: 'csvImport' }).lean();
    if (!job) throw new AppError(404, 'Import job not found.', 'NOT_FOUND');
    res.json({
      success: true,
      job: {
        id: String(job._id),
        status: job.status,
        progress: job.progress,
        summary: job.summary || null,
        error: job.error || null,
        issueCount: job.issues?.length || 0,
      },
    });
  })
);

router.get(
  '/import/jobs/:id/errors',
  asyncHandler(async (req, res) => {
    const job = await Job.findOne({ _id: req.params.id, type: 'csvImport' }).lean();
    if (!job) throw new AppError(404, 'Import job not found.', 'NOT_FOUND');
    const lines = ['Row,Reference,Reason'];
    for (const i of job.issues || []) lines.push([i.row, csvEscape(i.ref), csvEscape(i.reason)].join(','));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="import-report.csv"',
    });
    res.send(`${lines.join('\r\n')}\r\n`);
  })
);

router.post(
  '/promote',
  validate({
    body: z.object({
      course: objectId,
      semester: z.coerce.number().int().min(1).max(20).optional(),
      graduateFinal: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { course: courseId, semester, graduateFinal } = req.body;
    const course = await Course.findById(courseId).lean();
    if (!course) throw new AppError(404, 'Course not found.', 'NOT_FOUND');
    const total = totalSemesters(course);
    if (semester && semester > total) {
      throw new AppError(400, `${course.shortName} has only ${total} semesters.`, 'INVALID_SEMESTER');
    }

    const base = { course: course._id, isDeleted: false, status: 'active' };
    let promoted = 0;
    let graduated = 0;

    const promotable = semester ? (semester < total ? { semester } : null) : { semester: { $lt: total } };
    if (promotable) {
      const result = await Student.updateMany(
        { ...base, ...promotable },
        [
          {
            $set: {
              semester: { $add: ['$semester', 1] },
              year: { $ceil: { $divide: [{ $add: ['$semester', 1] }, course.semestersPerYear] } },
              updatedAt: new Date(),
            },
          },
        ],
        { updatePipeline: true }
      );
      promoted = result.modifiedCount;
    }

    if (graduateFinal && (!semester || semester === total)) {
      const result = await Student.updateMany(
        { ...base, semester: total },
        { $set: { status: 'inactive' } }
      );
      graduated = result.modifiedCount;
    }

    await audit(req, 'STUDENT_PROMOTE', {
      entity: 'Course',
      entityId: course._id,
      details: { course: course.shortName, fromSemester: semester || 'all', promoted, graduated },
    });
    res.json({ success: true, promoted, graduated });
  })
);

/* ------------------------------ List and CRUD ------------------------------ */
router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const filter = await buildFilter(q);
    const sort = { [q.sortBy]: q.order === 'asc' ? 1 : -1, _id: 1 };
    const [items, total] = await Promise.all([
      Student.find(filter)
        .populate('course', 'name shortName')
        .sort(sort)
        .collation({ locale: 'en', strength: 2 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      Student.countDocuments(filter),
    ]);
    const statusMap = q.session ? await sessionStatusPairs(q.session) : null;
    res.json({
      success: true,
      items: items.map((s) => serialize(s, statusMap)),
      total,
      page: q.page,
      pages: Math.max(1, Math.ceil(total / q.limit)),
    });
  })
);

router.post(
  '/',
  validate({ body: studentBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    await assertAcademic(b.course, b.year, b.semester, { requireActive: true });
    await assertUnique(b);
    const student = await Student.create(b);
    await audit(req, 'STUDENT_CREATE', {
      entity: 'Student',
      entityId: student._id,
      details: { email: student.email, enrollmentNo: student.enrollmentNo },
    });
    await student.populate('course', 'name shortName');
    res.status(201).json({ success: true, item: serialize(student, null) });
  })
);

router.put(
  '/:id',
  validate({ body: studentBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const student = await Student.findOne({ _id: req.params.id, isDeleted: false });
    if (!student) throw new AppError(404, 'Student not found.', 'NOT_FOUND');

    const courseChanged = String(student.course) !== b.course;
    await assertAcademic(b.course, b.year, b.semester, { requireActive: courseChanged });
    await assertUnique(b, student._id);

    Object.assign(student, b);
    await student.save();
    await audit(req, 'STUDENT_UPDATE', {
      entity: 'Student',
      entityId: student._id,
      details: { email: student.email, semester: student.semester },
    });
    await student.populate('course', 'name shortName');
    res.json({ success: true, item: serialize(student, null) });
  })
);

router.patch(
  '/:id/status',
  validate({ body: z.object({ status: z.enum(['active', 'inactive']) }) }),
  asyncHandler(async (req, res) => {
    const student = await Student.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { $set: { status: req.body.status } },
      { new: true }
    ).populate('course', 'name shortName');
    if (!student) throw new AppError(404, 'Student not found.', 'NOT_FOUND');
    await audit(req, req.body.status === 'active' ? 'STUDENT_ACTIVATE' : 'STUDENT_DEACTIVATE', {
      entity: 'Student',
      entityId: student._id,
      details: { email: student.email },
    });
    res.json({ success: true, item: serialize(student, null) });
  })
);

// Soft delete only: payment history and issued cards stay intact.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const student = await Student.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date(), status: 'inactive' } },
      { new: true }
    );
    if (!student) throw new AppError(404, 'Student not found.', 'NOT_FOUND');
    await audit(req, 'STUDENT_DELETE', {
      entity: 'Student',
      entityId: student._id,
      details: { email: student.email, enrollmentNo: student.enrollmentNo },
    });
    res.json({ success: true });
  })
);

export default router;