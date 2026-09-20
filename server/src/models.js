import mongoose from 'mongoose';

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const timestamps = { timestamps: true };

/* ------------------------------ Course ------------------------------ */
const courseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    shortName: { type: String, required: true, trim: true, maxlength: 30 },
    years: { type: Number, required: true, min: 1, max: 8, default: 4 },
    semestersPerYear: { type: Number, required: true, min: 1, max: 4, default: 2 },
    isActive: { type: Boolean, default: true },
  },
  timestamps
);
courseSchema.index({ shortName: 1 }, { unique: true });
courseSchema.virtual('totalSemesters').get(function totalSemesters() {
  return this.years * this.semestersPerYear;
});

/* ------------------------------ Student ------------------------------ */
const studentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    enrollmentNo: { type: String, required: true, trim: true, maxlength: 40 },
    rollNo: { type: String, required: true, trim: true, maxlength: 40 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    course: { type: ObjectId, ref: 'Course', required: true },
    year: { type: Number, required: true, min: 1, max: 10 },
    semester: { type: Number, required: true, min: 1, max: 20 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    lastLoginAt: { type: Date },
  },
  timestamps
);
studentSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
studentSchema.index(
  { enrollmentNo: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
studentSchema.index({ course: 1, year: 1, semester: 1, isDeleted: 1, status: 1 });
studentSchema.index({ name: 1 });

/* ------------------------------ Plan ------------------------------ */
// amount is stored in whole rupees. Convert to paise only when creating a Razorpay order.
const planSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 1, max: 10000000, validate: Number.isInteger },
    course: { type: ObjectId, ref: 'Course', required: true },
    year: { type: Number, required: true, min: 1, max: 10 },
    semester: { type: Number, required: true, min: 1, max: 20 },
    session: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  timestamps
);
planSchema.index(
  { course: 1, session: 1, semester: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

/* ------------------------------ Payment ------------------------------ */
const paymentSchema = new Schema(
  {
    student: { type: ObjectId, ref: 'Student', required: true },
    plan: { type: ObjectId, ref: 'Plan', required: true },
    session: { type: String, required: true },
    semester: { type: Number, required: true },
    amount: { type: Number, required: true, min: 0 }, // snapshot in rupees
    currency: { type: String, default: 'INR' },
    status: {
      type: String,
      enum: ['created', 'pending', 'paid', 'failed', 'refunded'],
      default: 'created',
    },
    method: { type: String, enum: ['razorpay', 'cash', 'dd', 'upi', 'other'], default: 'razorpay' },
    gatewayMethod: { type: String }, // card / upi / netbanking (from Razorpay)
    razorpayOrderId: { type: String },
    razorpayPaymentId: { type: String },
    reference: { type: String, trim: true, maxlength: 100 }, // offline payment reference
    receiptNo: { type: String },
    paidAt: { type: Date },
    failureReason: { type: String, maxlength: 300 },
    refundId: { type: String },
    refundAmount: { type: Number },
    refundReason: { type: String, maxlength: 300 },
    refundedAt: { type: Date },
    needsAttention: { type: Boolean, default: false },
    attentionReason: { type: String, maxlength: 300 },
    reconcileAttempts: { type: Number, default: 0 },
    lastReconciledAt: { type: Date },
    recordedBy: { type: String },
    notes: { type: String, maxlength: 500 },
  },
  timestamps
);
paymentSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string' } } }
);
paymentSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } }
);
paymentSchema.index(
  { receiptNo: 1 },
  { unique: true, partialFilterExpression: { receiptNo: { $type: 'string' } } }
);
paymentSchema.index({ student: 1, session: 1, semester: 1, status: 1 });
paymentSchema.index({ status: 1, createdAt: 1 });
paymentSchema.index({ needsAttention: 1 });

/* ------------------------------ Subscription ------------------------------ */
const subscriptionSchema = new Schema(
  {
    student: { type: ObjectId, ref: 'Student', required: true },
    plan: { type: ObjectId, ref: 'Plan' },
    session: { type: String, required: true },
    semester: { type: Number, required: true },
    status: { type: String, enum: ['paid', 'waived', 'refunded'], required: true },
    payment: { type: ObjectId, ref: 'Payment' },
    waivedReason: { type: String, maxlength: 300 },
    waivedBy: { type: String },
  },
  timestamps
);
subscriptionSchema.index({ student: 1, session: 1, semester: 1 }, { unique: true });
subscriptionSchema.index({ session: 1, semester: 1, status: 1 });

/* ------------------------------ WebhookEvent ------------------------------ */
const webhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true },
    event: { type: String },
    processed: { type: Boolean, default: false },
    processedAt: { type: Date },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
  },
  { versionKey: false }
);
webhookEventSchema.index({ eventId: 1 }, { unique: true });

/* ------------------------------ ExamSession ------------------------------ */
const timetableRowSchema = new Schema(
  {
    date: { type: Date, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    time: { type: String, required: true, trim: true, maxlength: 60 },
  },
  { _id: false }
);

const examSessionSchema = new Schema(
  {
    session: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}$/ },
    course: { type: ObjectId, ref: 'Course', required: true },
    year: { type: Number, required: true },
    semester: { type: Number, required: true },
    examName: { type: String, required: true, trim: true, maxlength: 80, default: 'Internal Examination' },
    examCode: { type: String, trim: true, maxlength: 10, default: 'INT' },
    timetable: {
      type: [timetableRowSchema],
      validate: [(v) => v.length >= 1 && v.length <= 12, 'Timetable must have 1 to 12 rows.'],
    },
    instructions: {
      type: [{ type: String, trim: true, maxlength: 300 }],
      validate: [(v) => v.length <= 10, 'A maximum of 10 instructions is allowed.'],
    },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    version: { type: Number, default: 1 },
    cardCounter: { type: Number, default: 0 },
    assetsUsed: {
      logo: String,
      principalSign: String,
      inchargeSign: String,
      seal: String,
    },
    publishedAt: { type: Date },
  },
  timestamps
);
examSessionSchema.index({ session: 1, course: 1, semester: 1, examName: 1 }, { unique: true });
examSessionSchema.index({ course: 1, semester: 1, status: 1 });

/* ------------------------------ AdmitCard ------------------------------ */
const admitCardSchema = new Schema(
  {
    student: { type: ObjectId, ref: 'Student', required: true },
    examSession: { type: ObjectId, ref: 'ExamSession', required: true },
    cardNo: { type: String, required: true },
    qrToken: { type: String, required: true },
    status: { type: String, enum: ['issued', 'revoked'], default: 'issued' },
    revokedReason: { type: String, maxlength: 300 },
    version: { type: Number, default: 1 }, // bump to invalidate the PDF cache
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date },
  },
  timestamps
);
admitCardSchema.index({ student: 1, examSession: 1 }, { unique: true });
admitCardSchema.index({ cardNo: 1 }, { unique: true });
admitCardSchema.index({ qrToken: 1 }, { unique: true });
admitCardSchema.index({ examSession: 1, status: 1 });

/* ------------------------------ AuditLog ------------------------------ */
const auditLogSchema = new Schema(
  {
    action: { type: String, required: true },
    actor: { type: String, default: 'system' },
    actorType: { type: String, enum: ['admin', 'student', 'system'], default: 'system' },
    ip: { type: String },
    entity: { type: String },
    entityId: { type: String },
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

/* ------------------------------ LoginLock ------------------------------ */
const loginLockSchema = new Schema(
  {
    key: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    level: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastFailureAt: { type: Date },
    expireAt: { type: Date, required: true },
  },
  { versionKey: false }
);
loginLockSchema.index({ key: 1 }, { unique: true });
loginLockSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

/* ------------------------------ Job ------------------------------ */
const jobSchema = new Schema(
  {
    type: { type: String, enum: ['csvImport', 'bulkPdf'], required: true },
    status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
    progress: {
      total: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
    },
    params: { type: Schema.Types.Mixed },
    summary: { type: Schema.Types.Mixed },
    resultFile: { type: String },
    resultFileName: { type: String },
    issues: [{ _id: false, row: Number, ref: String, reason: String }],
    error: { type: String },
    createdBy: { type: String },
  },
  timestamps
);
jobSchema.index({ type: 1, createdAt: -1 });

/* ------------------------------ RefreshToken ------------------------------ */
const refreshTokenSchema = new Schema(
  {
    jti: { type: String, required: true },
    subject: { type: String, required: true },
    role: { type: String, enum: ['admin', 'student'], required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
refreshTokenSchema.index({ jti: 1 }, { unique: true });
refreshTokenSchema.index({ subject: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ------------------------------ Counter ------------------------------ */
const counterSchema = new Schema({
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ key: 1 }, { unique: true });
counterSchema.statics.next = async function next(key) {
  const doc = await this.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  return doc.seq;
};

export const Course = mongoose.model('Course', courseSchema);
export const Student = mongoose.model('Student', studentSchema);
export const Plan = mongoose.model('Plan', planSchema);
export const Payment = mongoose.model('Payment', paymentSchema);
export const Subscription = mongoose.model('Subscription', subscriptionSchema);
export const WebhookEvent = mongoose.model('WebhookEvent', webhookEventSchema);
export const ExamSession = mongoose.model('ExamSession', examSessionSchema);
export const AdmitCard = mongoose.model('AdmitCard', admitCardSchema);
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export const LoginLock = mongoose.model('LoginLock', loginLockSchema);
export const Job = mongoose.model('Job', jobSchema);
export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
export const Counter = mongoose.model('Counter', counterSchema);