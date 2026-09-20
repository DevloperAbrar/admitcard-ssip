import crypto from 'node:crypto';
import { Router } from 'express';
import Razorpay from 'razorpay';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { config } from '../config.js';
import { Counter, Payment, Plan, Student, Subscription, WebhookEvent } from '../models.js';
import {
  AppError,
  asyncHandler,
  audit,
  authenticate,
  downloadLimiter,
  requireAdmin,
  requireStudent,
  validate,
} from '../security.js';
import { pregenerateForStudentLater, renderReceiptPdf } from '../pdf.js';

const router = Router();

router.param('id', (req, res, next, value) => {
  if (!/^[a-f\d]{24}$/i.test(value)) return next(new AppError(400, 'Invalid id.', 'INVALID_ID'));
  return next();
});

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id.');
const sessionSchema = z.string().trim().regex(/^\d{4}-\d{2}$/, 'Use the format 2025-26.');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LIST_LIMIT = 4000;
const ORDER_REUSE_MS = 30 * 60 * 1000;

/* ------------------------------ Razorpay client ------------------------------ */
let razorpayClient = null;
function getRazorpay() {
  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new AppError(500, 'Payment gateway is not configured yet.', 'RAZORPAY_NOT_CONFIGURED');
  }
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
  }
  return razorpayClient;
}

async function nextReceiptNo() {
  const seq = await Counter.next('receipt');
  return `RCPT-${String(seq).padStart(6, '0')}`;
}

// Marks a payment as paid and activates/updates the matching subscription.
// Safe to call twice for the same payment (checkout success + webhook race) -
// this is what makes the webhook a reliable source of truth.
export async function activatePaidPayment({ payment, razorpayPaymentId, gatewayMethod, actor }) {
  if (payment.status === 'paid') return payment;

  payment.status = 'paid';
  if (razorpayPaymentId) payment.razorpayPaymentId = razorpayPaymentId;
  if (gatewayMethod) payment.gatewayMethod = gatewayMethod;
  payment.paidAt = payment.paidAt || new Date();
  payment.receiptNo = payment.receiptNo || (await nextReceiptNo());
  payment.needsAttention = false;
  payment.attentionReason = undefined;

  try {
    await payment.save();
  } catch (err) {
    if (err?.code === 11000) {
      // Another process (checkout callback + webhook firing together) already saved this
      // payment id first. Treat it as already handled rather than erroring out.
      const fresh = await Payment.findById(payment._id);
      return fresh;
    }
    throw err;
  }

  await Subscription.findOneAndUpdate(
    { student: payment.student, session: payment.session, semester: payment.semester },
    {
      $set: { plan: payment.plan, status: 'paid', payment: payment._id },
      $unset: { waivedReason: '', waivedBy: '' },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  await audit(null, 'PAYMENT_CAPTURED', {
    actor: actor || 'system',
    actorType: 'system',
    entity: 'Payment',
    entityId: payment._id,
    details: { amount: payment.amount, receiptNo: payment.receiptNo, session: payment.session, semester: payment.semester },
  });

  pregenerateForStudentLater(payment.student);

  return payment;
}

export { getRazorpay };

/* ------------------------------ Student: create order ------------------------------ */
router.post(
  '/order',
  requireStudent,
  asyncHandler(async (req, res) => {
    const student = await Student.findById(req.auth.id).lean();
    if (!student || student.isDeleted) throw new AppError(401, 'Account not found.', 'UNAUTHENTICATED');
    if (student.status !== 'active') {
      throw new AppError(403, 'Your account has been disabled. Please contact admin.', 'ACCOUNT_DISABLED');
    }

    const plan = await Plan.findOne({ course: student.course, semester: student.semester, status: 'active' })
      .sort({ session: -1 })
      .lean();
    if (!plan) {
      throw new AppError(404, 'No fee plan is available for your course and semester yet. Please contact admin.', 'NO_PLAN');
    }

    const activeSub = await Subscription.findOne({
      student: student._id,
      session: plan.session,
      semester: plan.semester,
      status: { $in: ['paid', 'waived'] },
    }).lean();
    if (activeSub) throw new AppError(409, 'You already have an active subscription for this semester.', 'ALREADY_PAID');

    const existingPayment = await Payment.findOne({
      student: student._id,
      plan: plan._id,
      status: { $in: ['created', 'pending'] },
    }).sort({ createdAt: -1 });

    if (existingPayment && Date.now() - existingPayment.createdAt.getTime() < ORDER_REUSE_MS) {
      return res.json({
        success: true,
        order: {
          id: existingPayment.razorpayOrderId,
          amount: Math.round(existingPayment.amount * 100),
          currency: existingPayment.currency,
          keyId: config.razorpay.keyId,
        },
        student: { name: student.name, email: student.email },
      });
    }

    const razorpay = getRazorpay();
    let order;
    try {
      order = await razorpay.orders.create({
        amount: plan.amount * 100,
        currency: 'INR',
        receipt: `pay_${String(student._id).slice(-8)}_${Date.now()}`,
        notes: {
          studentId: String(student._id),
          planId: String(plan._id),
          session: plan.session,
          semester: String(plan.semester),
        },
      });
    } catch (err) {
      throw new AppError(502, 'Could not start the payment right now. Please try again.', 'RAZORPAY_ERROR');
    }

    if (existingPayment) {
      existingPayment.status = 'failed';
      existingPayment.failureReason = 'Superseded by a new payment attempt.';
      await existingPayment.save();
    }

    await Payment.create({
      student: student._id,
      plan: plan._id,
      session: plan.session,
      semester: plan.semester,
      amount: plan.amount,
      currency: 'INR',
      status: 'created',
      method: 'razorpay',
      razorpayOrderId: order.id,
    });

    res.json({
      success: true,
      order: { id: order.id, amount: order.amount, currency: order.currency, keyId: config.razorpay.keyId },
      student: { name: student.name, email: student.email },
    });
  })
);

/* ------------------------------ Student: verify payment ------------------------------ */
const verifyBody = z.object({
  razorpay_order_id: z.string().trim().min(1).max(100),
  razorpay_payment_id: z.string().trim().min(1).max(100),
  razorpay_signature: z.string().trim().min(1).max(200),
});

router.post(
  '/verify',
  requireStudent,
  validate({ body: verifyBody }),
  asyncHandler(async (req, res) => {
    const orderId = req.body.razorpay_order_id;
    const paymentId = req.body.razorpay_payment_id;
    const signature = req.body.razorpay_signature;

    const payment = await Payment.findOne({ razorpayOrderId: orderId, student: req.auth.id });
    if (!payment) throw new AppError(404, 'Payment record not found.', 'NOT_FOUND');
    if (payment.status === 'paid') return res.json({ success: true, alreadyPaid: true });
    if (!['created', 'pending'].includes(payment.status)) {
      throw new AppError(409, 'This payment can no longer be verified.', 'INVALID_STATE');
    }

    const expected = crypto
      .createHmac('sha256', config.razorpay.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    const valid =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));

    if (!valid) {
      payment.status = 'failed';
      payment.failureReason = 'Signature verification failed.';
      await payment.save();
      await audit(req, 'PAYMENT_SIGNATURE_INVALID', { entity: 'Payment', entityId: payment._id, actorType: 'student' });
      throw new AppError(400, 'Payment verification failed.', 'INVALID_SIGNATURE');
    }

    await activatePaidPayment({ payment, razorpayPaymentId: paymentId, actor: req.auth.email || 'student' });
    await audit(req, 'PAYMENT_VERIFIED', { entity: 'Payment', entityId: payment._id, actorType: 'student' });
    res.json({ success: true });
  })
);

/* ------------------------------ Student: my subscriptions/payments ------------------------------ */
router.get(
  '/my',
  requireStudent,
  asyncHandler(async (req, res) => {
    const [subscriptions, payments] = await Promise.all([
      Subscription.find({ student: req.auth.id }).sort({ session: -1, semester: -1 }).lean(),
      Payment.find({ student: req.auth.id }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    res.json({
      success: true,
      subscriptions: subscriptions.map((s) => ({
        id: String(s._id),
        session: s.session,
        semester: s.semester,
        status: s.status,
        waivedReason: s.waivedReason || null,
      })),
      payments: payments.map((p) => ({
        id: String(p._id),
        session: p.session,
        semester: p.semester,
        amount: p.amount,
        status: p.status,
        method: p.method,
        receiptNo: p.receiptNo || null,
        paidAt: p.paidAt || null,
        createdAt: p.createdAt,
        failureReason: p.status === 'failed' ? p.failureReason : null,
      })),
    });
  })
);

/* ------------------------------ Admin: subscriptions list + summary ------------------------------ */
const subsQuery = z.object({
  session: sessionSchema,
  course: objectId.optional(),
  year: z.coerce.number().int().min(1).max(10).optional(),
  semester: z.coerce.number().int().min(1).max(20).optional(),
  status: z.enum(['paid', 'waived', 'refunded', 'unpaid', 'pending', 'failed']).optional(),
  method: z.enum(['razorpay', 'cash', 'dd', 'upi', 'other']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().max(100).optional(),
});
const subsListQuery = subsQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Joins Student + Subscription + Payment + Plan in memory (dataset is small: a college's
// worth of students for one session, capped by LIST_LIMIT) rather than a heavy aggregation.
async function computeSubscriptionRows(q) {
  const studentFilter = { isDeleted: false };
  if (q.course) studentFilter.course = q.course;
  if (q.year) studentFilter.year = q.year;
  if (q.semester) studentFilter.semester = q.semester;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    studentFilter.$or = [{ name: rx }, { email: rx }, { enrollmentNo: rx }, { rollNo: rx }];
  }

  const totalMatching = await Student.countDocuments(studentFilter);
  if (totalMatching > LIST_LIMIT) {
    throw new AppError(
      400,
      `Too many students match (${totalMatching}). Narrow by course or semester (maximum ${LIST_LIMIT}).`,
      'TOO_MANY'
    );
  }

  const students = await Student.find(studentFilter)
    .populate('course', 'name shortName')
    .sort({ name: 1 })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  const studentIds = students.map((s) => s._id);

  const [subs, payments, plans] = await Promise.all([
    Subscription.find({ student: { $in: studentIds }, session: q.session })
      .populate('payment', 'amount method paidAt receiptNo')
      .lean(),
    Payment.find({ student: { $in: studentIds }, session: q.session, status: { $in: ['created', 'pending', 'failed'] } })
      .sort({ createdAt: -1 })
      .lean(),
    Plan.find({ session: q.session, status: 'active' }).lean(),
  ]);

  const subByStudent = new Map(subs.map((s) => [String(s.student), s]));
  const payByStudent = new Map();
  for (const p of payments) {
    const key = String(p.student);
    if (!payByStudent.has(key)) payByStudent.set(key, p); // sorted desc above, so first = latest
  }
  const planByCourseSemester = new Map(plans.map((p) => [`${p.course}:${p.semester}`, p]));

  const rows = students.map((s) => {
    const sub = subByStudent.get(String(s._id));
    const pay = payByStudent.get(String(s._id));
    const plan = planByCourseSemester.get(`${s.course?._id}:${s.semester}`);

    let status = 'unpaid';
    let amount = plan ? plan.amount : null;
    let method = null;
    let paidAt = null;
    let receiptNo = null;
    let paymentId = null;
    let failureReason = null;

    if (sub) {
      status = sub.status;
      if (sub.payment) {
        amount = sub.payment.amount;
        method = sub.payment.method;
        paidAt = sub.payment.paidAt;
        receiptNo = sub.payment.receiptNo;
        paymentId = String(sub.payment._id);
      }
    } else if (pay) {
      status = pay.status === 'failed' ? 'failed' : 'pending';
      amount = pay.amount;
      method = pay.method;
      paymentId = String(pay._id);
      failureReason = pay.status === 'failed' ? pay.failureReason : null;
    }

    return {
      studentId: String(s._id),
      name: s.name,
      enrollmentNo: s.enrollmentNo,
      rollNo: s.rollNo,
      email: s.email,
      course: s.course ? { id: String(s.course._id), shortName: s.course.shortName } : null,
      year: s.year,
      semester: s.semester,
      status,
      amount,
      method,
      paidAt,
      receiptNo,
      paymentId,
      failureReason,
    };
  });

  return rows;
}

function filterRows(rows, q) {
  let out = rows;
  if (q.method) out = out.filter((r) => r.method === q.method);
  if (q.from || q.to) {
    out = out.filter((r) => {
      if (!r.paidAt) return false;
      const t = new Date(r.paidAt).getTime();
      if (q.from && t < q.from.getTime()) return false;
      if (q.to && t > q.to.getTime() + 24 * 60 * 60 * 1000 - 1) return false;
      return true;
    });
  }
  if (q.status) out = out.filter((r) => r.status === q.status);
  return out;
}

function summarize(rows) {
  return {
    totalStudents: rows.length,
    paid: rows.filter((r) => r.status === 'paid').length,
    waived: rows.filter((r) => r.status === 'waived').length,
    unpaid: rows.filter((r) => r.status === 'unpaid').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    refunded: rows.filter((r) => r.status === 'refunded').length,
    totalCollected: rows.filter((r) => r.status === 'paid').reduce((sum, r) => sum + (r.amount || 0), 0),
    totalRemaining: rows
      .filter((r) => ['unpaid', 'pending', 'failed'].includes(r.status))
      .reduce((sum, r) => sum + (r.amount || 0), 0),
  };
}

router.get(
  '/subscriptions',
  requireAdmin,
  validate({ query: subsListQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const allRows = await computeSubscriptionRows(q);
    const summary = summarize(allRows);
    const filtered = filterRows(allRows, q);

    const total = filtered.length;
    const start = (q.page - 1) * q.limit;
    const items = filtered.slice(start, start + q.limit);

    res.json({ success: true, items, summary, total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
  })
);

router.get(
  '/subscriptions/needs-attention',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const items = await Payment.find({ needsAttention: true })
      .populate('student', 'name email enrollmentNo')
      .populate('plan', 'name amount')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({
      success: true,
      items: items.map((p) => ({
        id: String(p._id),
        student: p.student
          ? { id: String(p.student._id), name: p.student.name, email: p.student.email, enrollmentNo: p.student.enrollmentNo }
          : null,
        amount: p.amount,
        status: p.status,
        attentionReason: p.attentionReason,
        razorpayOrderId: p.razorpayOrderId,
        reconcileAttempts: p.reconcileAttempts,
        createdAt: p.createdAt,
      })),
    });
  })
);

router.get(
  '/subscriptions/export',
  requireAdmin,
  downloadLimiter,
  validate({ query: subsQuery }),
  asyncHandler(async (req, res) => {
    const rows = filterRows(await computeSubscriptionRows(req.query), req.query);

    const cols = [
      { header: 'Student Name', key: 'name', width: 28 },
      { header: 'Enrollment No.', key: 'enrollmentNo', width: 18 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Course', key: 'course', width: 14 },
      { header: 'Semester', key: 'semester', width: 10 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Amount', key: 'amount', width: 12 },
      { header: 'Method', key: 'method', width: 10 },
      { header: 'Receipt No.', key: 'receiptNo', width: 16 },
      { header: 'Paid At', key: 'paidAt', width: 20 },
    ];
    const safe = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v);
    const toRow = (r) => ({
      name: safe(r.name),
      enrollmentNo: safe(r.enrollmentNo),
      email: safe(r.email),
      course: r.course?.shortName || '',
      semester: r.semester,
      status: r.status,
      amount: r.amount ?? '',
      method: r.method || '',
      receiptNo: r.receiptNo || '',
      paidAt: r.paidAt ? new Date(r.paidAt).toLocaleString('en-IN') : '',
    });

    const wb = new ExcelJS.Workbook();
    const wsAll = wb.addWorksheet('Payments');
    wsAll.columns = cols;
    rows.forEach((r) => wsAll.addRow(toRow(r)));

    const wsUnpaid = wb.addWorksheet('Unpaid');
    wsUnpaid.columns = cols;
    rows.filter((r) => ['unpaid', 'pending', 'failed'].includes(r.status)).forEach((r) => wsUnpaid.addRow(toRow(r)));

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="subscriptions-${req.query.session}.xlsx"`,
    });
    await wb.xlsx.write(res);
    res.end();
    await audit(req, 'SUBSCRIPTIONS_EXPORT', { details: { session: req.query.session, count: rows.length } });
  })
);

/* ------------------------------ Admin: manual (offline) payment ------------------------------ */
const manualBody = z.object({
  student: objectId,
  plan: objectId,
  method: z.enum(['cash', 'dd', 'upi', 'other']),
  reference: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).optional(),
});

router.post(
  '/manual',
  requireAdmin,
  validate({ body: manualBody }),
  asyncHandler(async (req, res) => {
    const [student, plan] = await Promise.all([
      Student.findOne({ _id: req.body.student, isDeleted: false }).lean(),
      Plan.findById(req.body.plan).lean(),
    ]);
    if (!student) throw new AppError(404, 'Student not found.', 'NOT_FOUND');
    if (!plan) throw new AppError(404, 'Plan not found.', 'NOT_FOUND');
    if (String(plan.course) !== String(student.course) || plan.semester !== student.semester) {
      throw new AppError(400, "This plan does not match the student's course and semester.", 'PLAN_MISMATCH');
    }

    const existing = await Subscription.findOne({
      student: student._id,
      session: plan.session,
      semester: plan.semester,
      status: { $in: ['paid', 'waived'] },
    }).lean();
    if (existing) throw new AppError(409, 'This student already has an active subscription for this semester.', 'ALREADY_PAID');

    const receiptNo = await nextReceiptNo();
    const payment = await Payment.create({
      student: student._id,
      plan: plan._id,
      session: plan.session,
      semester: plan.semester,
      amount: plan.amount,
      currency: 'INR',
      status: 'paid',
      method: req.body.method,
      reference: req.body.reference,
      receiptNo,
      paidAt: new Date(),
      recordedBy: req.auth.email,
      notes: req.body.notes,
    });
    await Subscription.findOneAndUpdate(
      { student: student._id, session: plan.session, semester: plan.semester },
      { $set: { plan: plan._id, status: 'paid', payment: payment._id }, $unset: { waivedReason: '', waivedBy: '' } },
      { upsert: true, setDefaultsOnInsert: true }
    );

    await audit(req, 'PAYMENT_MANUAL', {
      entity: 'Payment',
      entityId: payment._id,
      details: { student: String(student._id), method: req.body.method, amount: plan.amount, reference: req.body.reference },
    });
    res.status(201).json({ success: true, item: { id: String(payment._id), receiptNo } });
  })
);

/* ------------------------------ Admin: fee waiver ------------------------------ */
const waiveBody = z.object({
  student: objectId,
  session: sessionSchema,
  semester: z.coerce.number().int().min(1).max(20),
  reason: z.string().trim().min(2).max(300),
});

router.post(
  '/waive',
  requireAdmin,
  validate({ body: waiveBody }),
  asyncHandler(async (req, res) => {
    const student = await Student.findOne({ _id: req.body.student, isDeleted: false }).lean();
    if (!student) throw new AppError(404, 'Student not found.', 'NOT_FOUND');

    const existing = await Subscription.findOne({
      student: student._id,
      session: req.body.session,
      semester: req.body.semester,
      status: { $in: ['paid', 'waived'] },
    }).lean();
    if (existing) throw new AppError(409, 'This student already has an active subscription for this semester.', 'ALREADY_PAID');

    await Subscription.findOneAndUpdate(
      { student: student._id, session: req.body.session, semester: req.body.semester },
      {
        $set: { status: 'waived', waivedReason: req.body.reason, waivedBy: req.auth.email },
        $unset: { payment: '' },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );

    await audit(req, 'PAYMENT_WAIVE', {
      entity: 'Student',
      entityId: student._id,
      details: { session: req.body.session, semester: req.body.semester, reason: req.body.reason },
    });
    res.json({ success: true });
  })
);

/* ------------------------------ Admin: refund ------------------------------ */
const refundBody = z.object({
  amount: z.coerce.number().int().min(1).optional(),
  reason: z.string().trim().min(2).max(300),
});

router.post(
  '/:id/refund',
  requireAdmin,
  validate({ body: refundBody }),
  asyncHandler(async (req, res) => {
    const payment = await Payment.findById(req.params.id);
    if (!payment) throw new AppError(404, 'Payment not found.', 'NOT_FOUND');
    if (payment.status !== 'paid') throw new AppError(409, 'Only a paid payment can be refunded.', 'INVALID_STATE');

    const amount = req.body.amount ?? payment.amount;
    if (amount > payment.amount) throw new AppError(400, 'Refund amount cannot exceed the paid amount.', 'INVALID_AMOUNT');

    if (payment.method === 'razorpay') {
      const razorpay = getRazorpay();
      let refund;
      try {
        refund = await razorpay.payments.refund(payment.razorpayPaymentId, {
          amount: amount * 100,
          speed: 'normal',
          notes: { reason: req.body.reason },
        });
      } catch (err) {
        throw new AppError(502, 'Refund could not be processed at the gateway. Please try again.', 'RAZORPAY_ERROR');
      }
      payment.refundId = refund.id;
    }

    payment.status = 'refunded';
    payment.refundAmount = amount;
    payment.refundReason = req.body.reason;
    payment.refundedAt = new Date();
    await payment.save();

    await Subscription.updateOne(
      { student: payment.student, session: payment.session, semester: payment.semester },
      { $set: { status: 'refunded' } }
    );

    // Note: once admit cards exist (build step 4), revoking any issued card for this
    // student + session here will be added alongside that route.
    await audit(req, 'PAYMENT_REFUND', {
      entity: 'Payment',
      entityId: payment._id,
      details: { amount, reason: req.body.reason },
    });
    res.json({ success: true });
  })
);

/* ------------------------------ Razorpay webhook (public, signature-checked) ------------------------------ */
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const signature = req.get('x-razorpay-signature');
    if (!signature || !req.rawBody || !config.razorpay.webhookSecret) {
      return res.status(400).json({ success: false, message: 'Invalid webhook request.' });
    }

    const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(req.rawBody).digest('hex');
    const valid =
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!valid) return res.status(400).json({ success: false, message: 'Invalid signature.' });

    let payload;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid payload.' });
    }

    const eventId = req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(req.rawBody).digest('hex');
    try {
      await WebhookEvent.create({ eventId, event: payload.event });
    } catch (err) {
      if (err?.code === 11000) return res.json({ success: true, duplicate: true });
      throw err;
    }

    try {
      const event = payload.event;
      if (event === 'payment.captured' || event === 'order.paid') {
        const paymentEntity = payload.payload?.payment?.entity;
        if (paymentEntity?.order_id) {
          const payment = await Payment.findOne({ razorpayOrderId: paymentEntity.order_id });
          if (payment && payment.status !== 'paid') {
            await activatePaidPayment({
              payment,
              razorpayPaymentId: paymentEntity.id,
              gatewayMethod: paymentEntity.method,
              actor: 'razorpay-webhook',
            });
          }
        }
      } else if (event === 'payment.failed') {
        const paymentEntity = payload.payload?.payment?.entity;
        if (paymentEntity?.order_id) {
          await Payment.updateOne(
            { razorpayOrderId: paymentEntity.order_id, status: { $in: ['created', 'pending'] } },
            {
              $set: {
                status: 'failed',
                failureReason: paymentEntity.error_description || 'Payment failed at the gateway.',
              },
            }
          );
        }
      } else if (event === 'refund.processed') {
        const refundEntity = payload.payload?.refund?.entity;
        if (refundEntity?.payment_id) {
          const payment = await Payment.findOne({ razorpayPaymentId: refundEntity.payment_id });
          if (payment && payment.status !== 'refunded') {
            payment.status = 'refunded';
            payment.refundId = refundEntity.id;
            payment.refundAmount = (refundEntity.amount || 0) / 100;
            payment.refundedAt = new Date();
            await payment.save();
            await Subscription.updateOne(
              { student: payment.student, session: payment.session, semester: payment.semester },
              { $set: { status: 'refunded' } }
            );
          }
        }
      }
      await WebhookEvent.updateOne({ eventId }, { $set: { processed: true, processedAt: new Date() } });
    } catch (err) {
      console.error('[webhook] processing failed:', err);
      // Razorpay retries failed webhooks automatically; the event record above prevents
      // duplicate side effects once this is investigated and re-delivered.
    }

    res.json({ success: true });
  })
);

/* ------------------------------ Student: plan + access status for the Pay page ------------------------------ */
router.get(
  '/my-plan',
  requireStudent,
  asyncHandler(async (req, res) => {
    const student = await Student.findById(req.auth.id).populate('course', 'name shortName').lean();
    if (!student || student.isDeleted) throw new AppError(401, 'Account not found.', 'UNAUTHENTICATED');
    if (student.status !== 'active') {
      throw new AppError(403, 'Your account has been disabled. Please contact admin.', 'ACCOUNT_DISABLED');
    }

    const [plan, subscription] = await Promise.all([
      Plan.findOne({ course: student.course._id, semester: student.semester, status: 'active' })
        .sort({ session: -1 })
        .lean(),
      Subscription.findOne({ student: student._id, semester: student.semester, status: { $in: ['paid', 'waived'] } })
        .sort({ session: -1 })
        .lean(),
    ]);

    let latestPayment = null;
    if (plan && !subscription) {
      const p = await Payment.findOne({ student: student._id, plan: plan._id }).sort({ createdAt: -1 }).lean();
      if (p && ['pending', 'failed'].includes(p.status)) {
        latestPayment = { status: p.status, failureReason: p.status === 'failed' ? p.failureReason || null : null };
      }
    }

    res.json({
      success: true,
      plan: plan ? { id: String(plan._id), name: plan.name, amount: plan.amount, session: plan.session, semester: plan.semester } : null,
      subscription: subscription
        ? { status: subscription.status, session: subscription.session, semester: subscription.semester }
        : null,
      latestPayment,
    });
  })
);

/* ------------------------------ Receipt PDF (student: own only, admin: any) ------------------------------ */
router.get(
  '/:id/receipt',
  authenticate,
  downloadLimiter,
  asyncHandler(async (req, res) => {
    const payment = await Payment.findById(req.params.id).select('student status receiptNo').lean();
    if (!payment) throw new AppError(404, 'Receipt not found.', 'NOT_FOUND');

    if (req.auth.role === 'student') {
      if (String(payment.student) !== String(req.auth.id)) throw new AppError(404, 'Receipt not found.', 'NOT_FOUND');
    } else if (req.auth.role !== 'admin' || req.auth.email !== config.admin.email) {
      throw new AppError(403, 'You do not have permission to do this.', 'FORBIDDEN');
    }
    if (!payment.receiptNo || !['paid', 'refunded'].includes(payment.status)) {
      throw new AppError(409, 'A receipt is available only for completed payments.', 'INVALID_STATE');
    }

    const pdf = await renderReceiptPdf(payment._id);
    const disposition = req.query.mode === 'preview' ? 'inline' : 'attachment';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="receipt-${payment.receiptNo}.pdf"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'private, no-store',
    });
    res.end(pdf);
  })
);

export default router;