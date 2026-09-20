import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  DataTable,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  cn,
  SESSION_RE,
  saveBlob,
  useDebounce,
  useToast,
} from '../../components/ui.jsx';

const INITIAL_FILTERS = { q: '', course: '', year: '', semester: '', status: '', session: '', subscriptionStatus: '' };
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

/* ------------------------------ Add / edit form ------------------------------ */
function StudentForm({ open, student, courses, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', enrollmentNo: '', rollNo: '', email: '', course: '', semester: '1' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    if (student) {
      setForm({
        name: student.name,
        enrollmentNo: student.enrollmentNo,
        rollNo: student.rollNo,
        email: student.email,
        course: student.course?.id || '',
        semester: String(student.semester),
      });
    } else {
      setForm({ name: '', enrollmentNo: '', rollNo: '', email: '', course: courses.find((c) => c.isActive)?.id || '', semester: '1' });
    }
  }, [open, student, courses]);

  const course = courses.find((c) => c.id === form.course);
  const year = course && form.semester ? Math.ceil(Number(form.semester) / course.semestersPerYear) : '';
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim() || !form.enrollmentNo.trim() || !form.rollNo.trim() || !form.email.trim() || !form.course) {
      return setError('Please fill in all fields.');
    }
    const body = {
      name: form.name,
      enrollmentNo: form.enrollmentNo,
      rollNo: form.rollNo,
      email: form.email,
      course: form.course,
      year,
      semester: Number(form.semester),
    };
    setSaving(true);
    try {
      if (student) await api.students.update(student.id, body);
      else await api.students.create(body);
      toast.success(student ? 'Student updated.' : 'Student added.');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title={student ? 'Edit student' : 'Add student'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="student-form" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form id="student-form" onSubmit={submit} noValidate className="space-y-3">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</div>}
        <Field label="Student name" htmlFor="s-name">
          <Input id="s-name" value={form.name} onChange={set('name')} maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Enrollment No." htmlFor="s-enr">
            <Input id="s-enr" value={form.enrollmentNo} onChange={set('enrollmentNo')} maxLength={40} />
          </Field>
          <Field label="Roll No." htmlFor="s-roll">
            <Input id="s-roll" value={form.rollNo} onChange={set('rollNo')} maxLength={40} />
          </Field>
        </div>
        <Field label="Email (Google account)" htmlFor="s-email">
          <Input id="s-email" type="email" value={form.email} onChange={set('email')} maxLength={200} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Course" htmlFor="s-course">
            <Select id="s-course" value={form.course} onChange={set('course')}>
              <option value="">Select</option>
              {courses.filter((c) => c.isActive || c.id === form.course).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.shortName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Semester" htmlFor="s-sem">
            <Select id="s-sem" value={form.semester} onChange={set('semester')}>
              {range(course?.totalSemesters || 8).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Year (auto)" htmlFor="s-year">
            <Input id="s-year" value={year} disabled readOnly />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ CSV import ------------------------------ */
function ImportModal({ open, onClose, onDone }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [step, setStep] = useState('upload'); // upload | preview | running | done
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [mode, setMode] = useState('skip');
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);

  useEffect(() => {
    if (open) {
      setStep('upload');
      setPreview(null);
      setMode('skip');
      setJobId(null);
      setJob(null);
      setBusy(false);
    }
  }, [open]);

  // Poll the background job until it finishes.
  useEffect(() => {
    if (step !== 'running' || !jobId) return undefined;
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const res = await api.students.importJob(jobId);
        if (!alive) return;
        setJob(res.job);
        if (res.job.status === 'completed' || res.job.status === 'failed') {
          setStep('done');
          if (res.job.status === 'completed') onDone();
          return;
        }
      } catch (err) {
        if (!alive) return;
        toast.error(err.message);
      }
      timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [step, jobId, toast, onDone]);

  const downloadSample = async () => {
    try {
      saveBlob(await api.students.sampleCsv(), 'students-sample.csv');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) return toast.error('Please choose a .csv file.');
    if (file.size > 2 * 1024 * 1024) return toast.error('File is too large. Maximum size is 2 MB.');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.students.importPreview(fd);
      setPreview(res);
      setStep('preview');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await api.students.importConfirm({ token: preview.token, duplicateMode: mode });
      setJobId(res.jobId);
      setStep('running');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadErrors = async () => {
    try {
      saveBlob(await api.students.importErrors(jobId), 'import-report.csv');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const s = preview?.summary;
  const canConfirm = s && (s.valid > 0 || (mode === 'update' && s.duplicate > 0));
  const rowColor = { valid: 'green', duplicate: 'yellow', error: 'red' };

  return (
    <Modal
      open={open}
      onClose={busy || step === 'running' ? undefined : onClose}
      title="Import students from CSV"
      size="lg"
      footer={
        step === 'preview' ? (
          <>
            <Button variant="secondary" onClick={() => setStep('upload')} disabled={busy}>
              Choose another file
            </Button>
            <Button onClick={confirm} loading={busy} disabled={!canConfirm}>
              Confirm import
            </Button>
          </>
        ) : step === 'done' ? (
          <Button onClick={onClose}>Close</Button>
        ) : null
      }
    >
      {step === 'upload' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Columns: Student Name, Enrollment No., Email, Roll No., Year, Semester, Course. Maximum 5000 rows and 2 MB per file.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={downloadSample}>
              Download sample CSV
            </Button>
            <Button onClick={() => fileRef.current?.click()} loading={busy}>
              Upload CSV
            </Button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={upload} />
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge color="gray">Total: {s.total}</Badge>
            <Badge color="green">Valid: {s.valid}</Badge>
            <Badge color="yellow">Already exist: {s.duplicate}</Badge>
            <Badge color="red">Errors: {s.error}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="font-medium text-slate-700">If a student already exists:</span>
            {[
              ['skip', 'Skip'],
              ['update', 'Update'],
            ].map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input type="radio" name="dup" checked={mode === value} onChange={() => setMode(value)} />
                {label}
              </label>
            ))}
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                <tr>
                  {['Row', 'Name', 'Enrollment', 'Email', 'Sem', 'Status', 'Notes'].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {preview.rows.map((r) => (
                  <tr key={r.row}>
                    <td className="px-3 py-1.5">{r.row}</td>
                    <td className="px-3 py-1.5">{r.name}</td>
                    <td className="px-3 py-1.5">{r.enrollmentNo}</td>
                    <td className="px-3 py-1.5">{r.email}</td>
                    <td className="px-3 py-1.5">{r.semester ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <Badge color={rowColor[r.status]}>{r.status}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-slate-600">{r.messages.join(' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.truncated && <p className="text-xs text-slate-500">Showing the first 300 rows (errors first). All rows are re-checked on import.</p>}
        </div>
      )}

      {step === 'running' && (
        <div className="space-y-3 py-4 text-center">
          <p className="text-sm text-slate-700">Import is running in the background...</p>
          {job?.progress?.total > 0 && (
            <>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-indigo-600 transition-all"
                  style={{ width: `${Math.round((job.progress.done / job.progress.total) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-slate-500">
                {job.progress.done} of {job.progress.total} rows
              </p>
            </>
          )}
        </div>
      )}

      {step === 'done' && job && (
        <div className="space-y-3">
          {job.status === 'failed' ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{job.error || 'Import failed.'}</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge color="green">Created: {job.summary.created}</Badge>
                <Badge color="blue">Updated: {job.summary.updated}</Badge>
                <Badge color="yellow">Skipped: {job.summary.skipped}</Badge>
                <Badge color="red">Failed: {job.summary.failed}</Badge>
              </div>
              {job.issueCount > 0 && (
                <Button variant="secondary" onClick={downloadErrors}>
                  Download error / skipped report
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------ Promote ------------------------------ */
function PromoteModal({ open, courses, onClose, onDone }) {
  const toast = useToast();
  const [course, setCourse] = useState('');
  const [semester, setSemester] = useState('');
  const [graduate, setGraduate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) {
      setCourse(courses.find((c) => c.isActive)?.id || '');
      setSemester('');
      setGraduate(false);
      setConfirming(false);
    }
  }, [open, courses]);

  const selected = courses.find((c) => c.id === course);

  const run = async () => {
    setBusy(true);
    try {
      const body = { course, graduateFinal: graduate };
      if (semester) body.semester = Number(semester);
      const res = await api.students.promote(body);
      toast.success(`${res.promoted} promoted, ${res.graduated} marked inactive (graduated).`);
      onDone();
    } catch (err) {
      toast.error(err.message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={onClose}
        title="Promote students"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={!course}>
              Continue
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Moves active students to the next semester (year updates automatically). Use it at the end of a session.</p>
          <Field label="Course" htmlFor="p-course">
            <Select id="p-course" value={course} onChange={(e) => setCourse(e.target.value)}>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.shortName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Only this semester" htmlFor="p-sem" hint="Leave empty to promote every semester of the course.">
            <Select id="p-sem" value={semester} onChange={(e) => setSemester(e.target.value)}>
              <option value="">All semesters</option>
              {range(selected?.totalSemesters || 8).map((n) => (
                <option key={n} value={n}>
                  Semester {n}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={graduate} onChange={(e) => setGraduate(e.target.checked)} />
            Mark final-semester students as inactive (graduated)
          </label>
        </div>
      </Modal>
      <ConfirmModal
        open={open && confirming}
        title="Promote students?"
        message="This changes the semester of many students at once and cannot be undone automatically. Continue?"
        confirmLabel="Yes, promote"
        loading={busy}
        onConfirm={run}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/* ------------------------------ Page ------------------------------ */
export default function Students() {
  const toast = useToast();
  const [courses, setCourses] = useState([]);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [formStudent, setFormStudent] = useState(undefined); // undefined = closed, null = new
  const [confirm, setConfirm] = useState(null); // { type, student }
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const debouncedQ = useDebounce(filters.q);
  const sessionOk = SESSION_RE.test(filters.session);
  const query = useMemo(
    () => ({
      q: debouncedQ,
      course: filters.course,
      year: filters.year,
      semester: filters.semester,
      status: filters.status,
      session: sessionOk ? filters.session : '',
      subscriptionStatus: sessionOk ? filters.subscriptionStatus : '',
    }),
    [debouncedQ, filters, sessionOk]
  );

  useEffect(() => {
    api.master
      .courses()
      .then((res) => setCourses(res.items))
      .catch((err) => toast.error(err.message));
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.students.list({ ...query, page, limit: 20 }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [query, page, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const setFilter = (key) => (e) => {
    const value = e.target.value;
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const selectedCourse = courses.find((c) => c.id === filters.course);
  const maxYears = selectedCourse?.years || Math.max(4, ...courses.map((c) => c.years));
  const maxSems = selectedCourse?.totalSemesters || Math.max(8, ...courses.map((c) => c.totalSemesters));

  const exportExcel = async () => {
    setExporting(true);
    try {
      const { q, course, year, semester, status, session, subscriptionStatus } = query;
      saveBlob(await api.students.exportXlsx({ q, course, year, semester, status, session, subscriptionStatus }), 'students.xlsx');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setExporting(false);
    }
  };

  const runConfirm = async () => {
    setConfirmBusy(true);
    try {
      const { type, student } = confirm;
      if (type === 'delete') await api.students.remove(student.id);
      else await api.students.setStatus(student.id, type === 'deactivate' ? 'inactive' : 'active');
      toast.success('Done.');
      setConfirm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setConfirmBusy(false);
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Student',
      render: (s) => (
        <div>
          <p className="font-medium text-slate-900">{s.name}</p>
          <p className="text-xs text-slate-500">{s.email}</p>
        </div>
      ),
    },
    { key: 'enrollmentNo', header: 'Enrollment' },
    { key: 'rollNo', header: 'Roll No.' },
    { key: 'course', header: 'Course', render: (s) => `${s.course?.shortName || '—'} · Y${s.year} / S${s.semester}` },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    ...(sessionOk
      ? [{ key: 'sub', header: `Subscription ${filters.session}`, render: (s) => <StatusBadge status={s.subscriptionStatus} /> }]
      : []),
    {
      key: 'actions',
      header: 'Actions',
      render: (s) => (
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" className="px-2 py-1" onClick={() => setFormStudent(s)}>
            Edit
          </Button>
          <Button
            variant="ghost"
            className="px-2 py-1"
            onClick={() => setConfirm({ type: s.status === 'active' ? 'deactivate' : 'activate', student: s })}
          >
            {s.status === 'active' ? 'Deactivate' : 'Activate'}
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-red-600" onClick={() => setConfirm({ type: 'delete', student: s })}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const confirmText = {
    deactivate: ['Deactivate student?', 'The student will not be able to log in or download admit cards.', 'Deactivate', false],
    activate: ['Activate student?', 'The student will be able to log in again.', 'Activate', false],
    delete: ['Delete student?', 'The student is removed from lists (soft delete). Payment history is kept.', 'Delete', true],
  };
  const ct = confirm ? confirmText[confirm.type] : null;

  return (
    <>
      <PageHeader title="Students" description="Add, import, filter and export students.">
        <Button variant="secondary" onClick={() => setPromoteOpen(true)}>
          Promote
        </Button>
        <Button variant="secondary" onClick={exportExcel} loading={exporting}>
          Export Excel
        </Button>
        <Button variant="secondary" onClick={() => setImportOpen(true)}>
          Import CSV
        </Button>
        <Button onClick={() => setFormStudent(null)}>Add student</Button>
      </PageHeader>

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input placeholder="Search name, email, enrollment, roll no." value={filters.q} onChange={setFilter('q')} />
          <Select value={filters.course} onChange={setFilter('course')}>
            <option value="">All courses</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.shortName}
              </option>
            ))}
          </Select>
          <Select value={filters.year} onChange={setFilter('year')}>
            <option value="">All years</option>
            {range(maxYears).map((n) => (
              <option key={n} value={n}>
                Year {n}
              </option>
            ))}
          </Select>
          <Select value={filters.semester} onChange={setFilter('semester')}>
            <option value="">All semesters</option>
            {range(maxSems).map((n) => (
              <option key={n} value={n}>
                Semester {n}
              </option>
            ))}
          </Select>
          <Select value={filters.status} onChange={setFilter('status')}>
            <option value="">Active + inactive</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
          <Input placeholder="Session e.g. 2025-26" value={filters.session} onChange={setFilter('session')} maxLength={7} />
          <Select value={filters.subscriptionStatus} onChange={setFilter('subscriptionStatus')} disabled={!sessionOk}>
            <option value="">Any subscription</option>
            {['paid', 'unpaid', 'pending', 'failed', 'refunded', 'waived'].map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => { setFilters(INITIAL_FILTERS); setPage(1); }}>
            Reset filters
          </Button>
        </div>
        <p className={cn('mt-2 text-xs text-slate-500', sessionOk && 'hidden')}>Enter a valid session (2025-26) to filter by subscription status.</p>
      </Card>

      <DataTable columns={columns} rows={data.items} loading={loading} empty="No students found." />
      <Pagination page={data.page || page} pages={data.pages} total={data.total} onChange={setPage} />

      <StudentForm
        open={formStudent !== undefined}
        student={formStudent}
        courses={courses}
        onClose={() => setFormStudent(undefined)}
        onSaved={() => {
          setFormStudent(undefined);
          load();
        }}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} />
      <PromoteModal
        open={promoteOpen}
        courses={courses}
        onClose={() => setPromoteOpen(false)}
        onDone={() => {
          setPromoteOpen(false);
          load();
        }}
      />
      <ConfirmModal
        open={Boolean(confirm)}
        title={ct?.[0]}
        message={ct ? `${ct[1]} (${confirm.student.name})` : ''}
        confirmLabel={ct?.[2]}
        danger={ct?.[3]}
        loading={confirmBusy}
        onConfirm={runConfirm}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}