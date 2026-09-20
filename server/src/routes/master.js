import { Router } from 'express';
import { z } from 'zod';
import { AuditLog, Course, ExamSession, Payment, Plan, Student } from '../models.js';
import { AppError, asyncHandler, audit, requireAdmin, validate } from '../security.js';

const router = Router();
router.use(requireAdmin);

router.param('id', (req, res, next, value) => {
  if (!/^[a-f\d]{24}$/i.test(value)) return next(new AppError(400, 'Invalid id.', 'INVALID_ID'));
  return next();
});

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id.');
const sessionSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}$/, 'Use the format 2025-26.')
  .refine((v) => (Number(v.slice(0, 4)) + 1) % 100 === Number(v.slice(5)), 'Session years must be consecutive, e.g. 2025-26.');

export const totalSemesters = (course) => course.years * course.semestersPerYear;
export const yearOf = (course, semester) => Math.ceil(semester / course.semestersPerYear);

export async function seedDefaultCourse() {
  if ((await Course.estimatedDocumentCount()) === 0) {
    await Course.create({ name: 'Bachelor of Pharmacy', shortName: 'B.Pharm', years: 4, semestersPerYear: 2 });
    console.log('[seed] Default course B.Pharm (4 years, 8 semesters) created');
  }
}

const serializeCourse = (c, studentCount = 0, planCount = 0) => ({
  id: String(c._id),
  name: c.name,
  shortName: c.shortName,
  years: c.years,
  semestersPerYear: c.semestersPerYear,
  totalSemesters: c.years * c.semestersPerYear,
  isActive: c.isActive,
  studentCount,
  planCount,
});

const serializePlan = (p, paymentCount = 0) => ({
  id: String(p._id),
  name: p.name,
  amount: p.amount,
  course: p.course ? { id: String(p.course._id), name: p.course.name, shortName: p.course.shortName } : null,
  year: p.year,
  semester: p.semester,
  session: p.session,
  status: p.status,
  paymentCount,
  createdAt: p.createdAt,
});

/* ------------------------------ Courses ------------------------------ */
const courseBody = z.object({
  name: z.string().trim().min(2).max(120),
  shortName: z.string().trim().min(1).max(30),
  years: z.coerce.number().int().min(1).max(8),
  semestersPerYear: z.coerce.number().int().min(1).max(4),
  isActive: z.boolean().optional(),
});

const courseInUse = async (id) => {
  const [s, p, e] = await Promise.all([
    Student.exists({ course: id }),
    Plan.exists({ course: id }),
    ExamSession.exists({ course: id }),
  ]);
  return Boolean(s || p || e);
};

const shortNameTaken = (shortName, excludeId) => {
  const filter = { shortName };
  if (excludeId) filter._id = { $ne: excludeId };
  return Course.findOne(filter).collation({ locale: 'en', strength: 2 }).lean();
};

router.get(
  '/courses',
  asyncHandler(async (req, res) => {
    const [courses, studentCounts, planCounts] = await Promise.all([
      Course.find().sort({ shortName: 1 }).lean(),
      Student.aggregate([{ $match: { isDeleted: false } }, { $group: { _id: '$course', n: { $sum: 1 } } }]),
      Plan.aggregate([{ $group: { _id: '$course', n: { $sum: 1 } } }]),
    ]);
    const sc = new Map(studentCounts.map((x) => [String(x._id), x.n]));
    const pc = new Map(planCounts.map((x) => [String(x._id), x.n]));
    res.json({
      success: true,
      items: courses.map((c) => serializeCourse(c, sc.get(String(c._id)) || 0, pc.get(String(c._id)) || 0)),
    });
  })
);

router.post(
  '/courses',
  validate({ body: courseBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (await shortNameTaken(b.shortName)) throw new AppError(409, 'A course with this short name already exists.', 'DUPLICATE');
    const course = await Course.create({
      name: b.name,
      shortName: b.shortName,
      years: b.years,
      semestersPerYear: b.semestersPerYear,
      isActive: b.isActive ?? true,
    });
    await audit(req, 'COURSE_CREATE', { entity: 'Course', entityId: course._id, details: { shortName: course.shortName } });
    res.status(201).json({ success: true, item: serializeCourse(course) });
  })
);

router.put(
  '/courses/:id',
  validate({ body: courseBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const course = await Course.findById(req.params.id);
    if (!course) throw new AppError(404, 'Course not found.', 'NOT_FOUND');
    if (await shortNameTaken(b.shortName, course._id)) {
      throw new AppError(409, 'A course with this short name already exists.', 'DUPLICATE');
    }
    const structureChanged = course.years !== b.years || course.semestersPerYear !== b.semestersPerYear;
    if (structureChanged && (await courseInUse(course._id))) {
      throw new AppError(409, 'Years/semesters cannot be changed because students, plans or exams already use this course.', 'COURSE_IN_USE');
    }
    course.name = b.name;
    course.shortName = b.shortName;
    course.years = b.years;
    course.semestersPerYear = b.semestersPerYear;
    if (typeof b.isActive === 'boolean') course.isActive = b.isActive;
    await course.save();
    await audit(req, 'COURSE_UPDATE', { entity: 'Course', entityId: course._id, details: { shortName: course.shortName } });
    res.json({ success: true, item: serializeCourse(course) });
  })
);

router.delete(
  '/courses/:id',
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.params.id);
    if (!course) throw new AppError(404, 'Course not found.', 'NOT_FOUND');
    if (await courseInUse(course._id)) {
      throw new AppError(409, 'This course is in use. Deactivate it instead of deleting.', 'COURSE_IN_USE');
    }
    await course.deleteOne();
    await audit(req, 'COURSE_DELETE', { entity: 'Course', entityId: course._id, details: { shortName: course.shortName } });
    res.json({ success: true });
  })
);

/* ------------------------------ Plans ------------------------------ */
const planBody = z.object({
  name: z.string().trim().min(2).max(120),
  amount: z.coerce.number().int().min(1).max(10000000),
  course: objectId,
  semester: z.coerce.number().int().min(1).max(20),
  session: sessionSchema,
  status: z.enum(['active', 'inactive']).default('active'),
});

const planQuery = z.object({
  course: objectId.optional(),
  session: sessionSchema.optional(),
  semester: z.coerce.number().int().min(1).max(20).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

async function loadCourseForPlan(courseId, semester) {
  const course = await Course.findById(courseId).lean();
  if (!course) throw new AppError(400, 'Selected course does not exist.', 'INVALID_COURSE');
  if (semester > totalSemesters(course)) {
    throw new AppError(400, `${course.shortName} has only ${totalSemesters(course)} semesters.`, 'INVALID_SEMESTER');
  }
  return course;
}

const duplicatePlanError = () =>
  new AppError(409, 'An active plan already exists for this course, session and semester.', 'DUPLICATE');

router.get(
  '/plans',
  validate({ query: planQuery }),
  asyncHandler(async (req, res) => {
    const filter = {};
    for (const key of ['course', 'session', 'semester', 'status']) {
      if (req.query[key] !== undefined) filter[key] = req.query[key];
    }
    const plans = await Plan.find(filter)
      .populate('course', 'name shortName')
      .sort({ session: -1, semester: 1, createdAt: -1 })
      .limit(500)
      .lean();
    const counts = await Payment.aggregate([
      { $match: { plan: { $in: plans.map((p) => p._id) } } },
      { $group: { _id: '$plan', n: { $sum: 1 } } },
    ]);
    const pc = new Map(counts.map((x) => [String(x._id), x.n]));
    res.json({ success: true, items: plans.map((p) => serializePlan(p, pc.get(String(p._id)) || 0)) });
  })
);

router.post(
  '/plans',
  validate({ body: planBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const course = await loadCourseForPlan(b.course, b.semester);
    let plan;
    try {
      plan = await Plan.create({
        name: b.name,
        amount: b.amount,
        course: course._id,
        year: yearOf(course, b.semester),
        semester: b.semester,
        session: b.session,
        status: b.status,
      });
    } catch (err) {
      if (err?.code === 11000) throw duplicatePlanError();
      throw err;
    }
    await audit(req, 'PLAN_CREATE', {
      entity: 'Plan',
      entityId: plan._id,
      details: { name: plan.name, amount: plan.amount, session: plan.session, semester: plan.semester },
    });
    await plan.populate('course', 'name shortName');
    res.status(201).json({ success: true, item: serializePlan(plan) });
  })
);

router.put(
  '/plans/:id',
  validate({ body: planBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const plan = await Plan.findById(req.params.id);
    if (!plan) throw new AppError(404, 'Plan not found.', 'NOT_FOUND');

    const course = await loadCourseForPlan(b.course, b.semester);
    const scopeChanged =
      String(plan.course) !== String(course._id) || plan.semester !== b.semester || plan.session !== b.session;
    if (scopeChanged && (await Payment.exists({ plan: plan._id }))) {
      throw new AppError(409, 'Payments already exist for this plan. Create a new plan instead of changing its course, session or semester.', 'PLAN_IN_USE');
    }

    const before = { amount: plan.amount, status: plan.status };
    plan.name = b.name;
    plan.amount = b.amount;
    plan.course = course._id;
    plan.year = yearOf(course, b.semester);
    plan.semester = b.semester;
    plan.session = b.session;
    plan.status = b.status;
    try {
      await plan.save();
    } catch (err) {
      if (err?.code === 11000) throw duplicatePlanError();
      throw err;
    }
    await audit(req, 'PLAN_UPDATE', {
      entity: 'Plan',
      entityId: plan._id,
      details: { before, after: { amount: plan.amount, status: plan.status } },
    });
    await plan.populate('course', 'name shortName');
    const paymentCount = await Payment.countDocuments({ plan: plan._id });
    res.json({ success: true, item: serializePlan(plan, paymentCount) });
  })
);

router.delete(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const plan = await Plan.findById(req.params.id);
    if (!plan) throw new AppError(404, 'Plan not found.', 'NOT_FOUND');
    if (await Payment.exists({ plan: plan._id })) {
      throw new AppError(409, 'Payments exist for this plan. Deactivate it instead of deleting.', 'PLAN_IN_USE');
    }
    await plan.deleteOne();
    await audit(req, 'PLAN_DELETE', { entity: 'Plan', entityId: plan._id, details: { name: plan.name } });
    res.json({ success: true });
  })
);

/* ------------------------------ Audit logs ------------------------------ */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().trim().max(50).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

router.get(
  '/audit-logs',
  validate({ query: auditQuery }),
  asyncHandler(async (req, res) => {
    const { page, limit, action, q, from, to } = req.query;
    const filter = {};
    if (action) filter.action = action;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ actor: rx }, { entityId: rx }, { action: rx }];
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    const [items, total, actions] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.distinct('action'),
    ]);
    res.json({
      success: true,
      items: items.map((l) => ({
        id: String(l._id),
        action: l.action,
        actor: l.actor,
        actorType: l.actorType,
        ip: l.ip,
        entity: l.entity,
        entityId: l.entityId,
        details: l.details,
        createdAt: l.createdAt,
      })),
      actions: actions.sort(),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  })
);

export default router;