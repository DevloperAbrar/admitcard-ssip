import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { config } from './config.js';
import { Course, Job, Student } from './models.js';
import { AppError, audit } from './security.js';
import { totalSemesters, yearOf } from './routes/master.js';

const MAX_ROWS = 5000;
const MAX_ISSUES = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HEADER_MAP = {
  studentname: 'name',
  enrollmentno: 'enrollmentNo',
  email: 'email',
  rollno: 'rollNo',
  year: 'year',
  semester: 'semester',
  course: 'course',
};
const HEADER_LABELS = {
  studentname: 'Student Name',
  enrollmentno: 'Enrollment No.',
  email: 'Email',
  rollno: 'Roll No.',
  year: 'Year',
  semester: 'Semester',
  course: 'Course',
};

const normHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Removes control characters and leading = + - @ (spreadsheet formula injection).
export function cleanCell(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[\s=+\-@]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const hadFormulaChar = (raw) => /^[=+\-@]/.test(String(raw ?? '').trim());
const toInt = (v) => (/^\d{1,2}$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN);

export async function analyseCsv(buffer) {
  let headerRow = [];
  let records;
  try {
    records = parse(buffer, {
      columns: (header) => {
        headerRow = header.map(normHeader);
        return headerRow;
      },
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch {
    throw new AppError(400, 'Could not read the CSV file. Please use the sample file format.', 'INVALID_CSV');
  }

  const missing = Object.keys(HEADER_MAP).filter((k) => !headerRow.includes(k));
  if (missing.length) {
    throw new AppError(400, `Missing column(s): ${missing.map((k) => HEADER_LABELS[k]).join(', ')}.`, 'INVALID_CSV');
  }
  if (records.length === 0) throw new AppError(400, 'The file has no data rows.', 'INVALID_CSV');
  if (records.length > MAX_ROWS) {
    throw new AppError(400, `Too many rows (${records.length}). Maximum ${MAX_ROWS} per file.`, 'INVALID_CSV');
  }

  const courses = await Course.find({ isActive: true }).lean();
  const courseLookup = new Map();
  for (const c of courses) {
    courseLookup.set(c.shortName.toLowerCase(), c);
    courseLookup.set(c.name.toLowerCase(), c);
  }

  const rows = [];
  const seenEmail = new Map();
  const seenEnroll = new Map();

  records.forEach((rec, index) => {
    const rowNo = index + 2; // header is row 1
    const messages = [];
    const raw = {};
    for (const [key, field] of Object.entries(HEADER_MAP)) raw[field] = rec[key];

    if (Object.values(raw).some((v) => hadFormulaChar(v))) {
      messages.push('Leading =, +, - or @ characters were removed.');
    }

    const name = cleanCell(raw.name);
    const enrollmentNo = cleanCell(raw.enrollmentNo);
    const rollNo = cleanCell(raw.rollNo);
    const email = cleanCell(raw.email).toLowerCase();
    const courseText = cleanCell(raw.course);
    const year = toInt(cleanCell(raw.year));
    const semester = toInt(cleanCell(raw.semester));
    const errors = [];

    if (name.length < 2 || name.length > 120) errors.push('Student Name must be 2 to 120 characters.');
    if (!enrollmentNo || enrollmentNo.length > 40) errors.push('Enrollment No. is required (max 40 characters).');
    if (!rollNo || rollNo.length > 40) errors.push('Roll No. is required (max 40 characters).');
    if (!EMAIL_RE.test(email) || email.length > 200) errors.push('Email is not valid.');

    const course = courseLookup.get(courseText.toLowerCase());
    if (!course) {
      errors.push(`Course "${courseText}" does not match the Course master.`);
    } else if (Number.isNaN(year) || Number.isNaN(semester) || year < 1 || semester < 1) {
      errors.push('Year and Semester must be numbers.');
    } else if (semester > totalSemesters(course)) {
      errors.push(`${course.shortName} has only ${totalSemesters(course)} semesters.`);
    } else if (yearOf(course, semester) !== year) {
      errors.push(`Semester ${semester} belongs to Year ${yearOf(course, semester)}, not Year ${year}.`);
    }

    if (email && seenEmail.has(email)) errors.push(`Duplicate email in file (also row ${seenEmail.get(email)}).`);
    else if (email) seenEmail.set(email, rowNo);
    if (enrollmentNo && seenEnroll.has(enrollmentNo)) {
      errors.push(`Duplicate Enrollment No. in file (also row ${seenEnroll.get(enrollmentNo)}).`);
    } else if (enrollmentNo) seenEnroll.set(enrollmentNo, rowNo);

    rows.push({
      row: rowNo,
      name,
      enrollmentNo,
      rollNo,
      email,
      courseName: courseText,
      courseId: course ? course._id : null,
      courseShort: course ? course.shortName : courseText,
      year,
      semester,
      status: errors.length ? 'error' : 'valid',
      messages: [...errors, ...messages],
      existingId: null,
    });
  });

  // Compare with students already in the database.
  const candidates = rows.filter((r) => r.status === 'valid');
  const emails = candidates.map((r) => r.email);
  const enrolls = candidates.map((r) => r.enrollmentNo);
  const existing = candidates.length
    ? await Student.find({
        isDeleted: false,
        $or: [{ email: { $in: emails } }, { enrollmentNo: { $in: enrolls } }],
      })
        .select('email enrollmentNo')
        .lean()
    : [];
  const byEmail = new Map(existing.map((s) => [s.email, s]));
  const byEnroll = new Map(existing.map((s) => [s.enrollmentNo, s]));

  for (const r of candidates) {
    const a = byEmail.get(r.email);
    const b = byEnroll.get(r.enrollmentNo);
    if (a && b && String(a._id) !== String(b._id)) {
      r.status = 'error';
      r.messages.unshift('Email and Enrollment No. belong to two different existing students.');
    } else if (a || b) {
      r.status = 'duplicate';
      r.existingId = String((a || b)._id);
      r.messages.unshift('Student already exists.');
    }
  }

  const summary = {
    total: rows.length,
    valid: rows.filter((r) => r.status === 'valid').length,
    duplicate: rows.filter((r) => r.status === 'duplicate').length,
    error: rows.filter((r) => r.status === 'error').length,
  };
  return { rows, summary };
}

export async function runCsvImport(jobId) {
  const job = await Job.findById(jobId);
  if (!job) return;
  const filePath = job.params?.file;
  const mode = job.params?.duplicateMode === 'update' ? 'update' : 'skip';

  try {
    await Job.updateOne({ _id: jobId }, { $set: { status: 'running' } });
    const buffer = await fs.promises.readFile(filePath);
    const { rows } = await analyseCsv(buffer); // always re-validated on the server
    await Job.updateOne({ _id: jobId }, { $set: { 'progress.total': rows.length, 'progress.done': 0 } });

    const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const issues = [];
    const pushIssue = (row, ref, reason) => {
      if (issues.length < MAX_ISSUES) issues.push({ row, ref: String(ref || ''), reason });
    };

    let done = 0;
    for (const r of rows) {
      const ref = r.email || r.enrollmentNo;
      try {
        if (r.status === 'error') {
          summary.failed += 1;
          pushIssue(r.row, ref, r.messages.join(' '));
        } else if (r.status === 'duplicate') {
          if (mode === 'update') {
            const res = await Student.updateOne(
              { _id: r.existingId, isDeleted: false },
              {
                $set: {
                  name: r.name,
                  enrollmentNo: r.enrollmentNo,
                  rollNo: r.rollNo,
                  email: r.email,
                  course: r.courseId,
                  year: r.year,
                  semester: r.semester,
                },
              },
              { runValidators: true }
            );
            if (res.matchedCount) summary.updated += 1;
            else {
              summary.failed += 1;
              pushIssue(r.row, ref, 'Existing student no longer available.');
            }
          } else {
            summary.skipped += 1;
            pushIssue(r.row, ref, 'Skipped: student already exists.');
          }
        } else {
          await Student.create({
            name: r.name,
            enrollmentNo: r.enrollmentNo,
            rollNo: r.rollNo,
            email: r.email,
            course: r.courseId,
            year: r.year,
            semester: r.semester,
          });
          summary.created += 1;
        }
      } catch (err) {
        summary.failed += 1;
        pushIssue(r.row, ref, err?.code === 11000 ? 'Duplicate email or enrollment number.' : err.message);
      }
      done += 1;
      if (done % 25 === 0) await Job.updateOne({ _id: jobId }, { $set: { 'progress.done': done } });
    }

    await Job.updateOne(
      { _id: jobId },
      { $set: { status: 'completed', 'progress.done': done, summary, issues } }
    );
    await audit(null, 'CSV_IMPORT', {
      actor: job.createdBy,
      actorType: 'admin',
      entity: 'Job',
      entityId: jobId,
      details: { ...summary, mode },
    });
  } catch (err) {
    console.error('[jobs] CSV import failed:', err);
    await Job.updateOne(
      { _id: jobId },
      { $set: { status: 'failed', error: err instanceof AppError ? err.message : 'Import failed unexpectedly.' } }
    );
  } finally {
    if (filePath) await fs.promises.rm(filePath, { force: true }).catch(() => {});
  }
}

async function cleanupTempFiles() {
  try {
    const dir = config.paths.csvTemp;
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const name of await fs.promises.readdir(dir)) {
      const full = path.join(dir, name);
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.promises.rm(full, { force: true });
    }
  } catch (err) {
    console.error('[jobs] temp cleanup failed:', err.message);
  }
}

export async function startJobs() {
  await Job.updateMany(
    { status: { $in: ['queued', 'running'] } },
    { $set: { status: 'failed', error: 'Server restarted while the job was running.' } }
  );
  await cleanupTempFiles();
  setInterval(cleanupTempFiles, 30 * 60 * 1000).unref();
}