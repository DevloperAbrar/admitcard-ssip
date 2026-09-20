import { useCallback, useEffect, useState } from 'react';
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
  Select,
  SESSION_RE,
  StatusBadge,
  cn,
  currentSession,
  formatINR,
  useToast,
} from '../../components/ui.jsx';

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

/* ------------------------------ Course modal ------------------------------ */
function CourseForm({ open, course, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', shortName: '', years: '4', semestersPerYear: '2', isActive: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setForm(
      course
        ? {
            name: course.name,
            shortName: course.shortName,
            years: String(course.years),
            semestersPerYear: String(course.semestersPerYear),
            isActive: course.isActive,
          }
        : { name: '', shortName: '', years: '4', semestersPerYear: '2', isActive: true }
    );
  }, [open, course]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.name.trim().length < 2 || !form.shortName.trim()) return setError('Enter the course name and short name.');
    const body = {
      name: form.name,
      shortName: form.shortName,
      years: Number(form.years),
      semestersPerYear: Number(form.semestersPerYear),
      isActive: form.isActive,
    };
    setSaving(true);
    try {
      if (course) await api.master.updateCourse(course.id, body);
      else await api.master.createCourse(body);
      toast.success('Course saved.');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const inUse = course && (course.studentCount > 0 || course.planCount > 0);

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title={course ? 'Edit course' : 'Add course'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="course-form" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form id="course-form" onSubmit={submit} noValidate className="space-y-3">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</div>}
        <Field label="Course name" htmlFor="c-name">
          <Input id="c-name" value={form.name} onChange={set('name')} maxLength={120} placeholder="Bachelor of Pharmacy" />
        </Field>
        <Field label="Short name" htmlFor="c-short">
          <Input id="c-short" value={form.shortName} onChange={set('shortName')} maxLength={30} placeholder="B.Pharm" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Years" htmlFor="c-years">
            <Select id="c-years" value={form.years} onChange={set('years')} disabled={inUse}>
              {range(8).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Semesters per year" htmlFor="c-spy">
            <Select id="c-spy" value={form.semestersPerYear} onChange={set('semestersPerYear')} disabled={inUse}>
              {range(4).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {inUse && <p className="text-xs text-slate-500">Years and semesters are locked because students or plans already use this course.</p>}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
          Active (available for new students)
        </label>
      </form>
    </Modal>
  );
}

/* ------------------------------ Plan modal ------------------------------ */
function PlanForm({ open, plan, courses, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', amount: '', course: '', semester: '1', session: currentSession(), status: 'active' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setForm(
      plan
        ? {
            name: plan.name,
            amount: String(plan.amount),
            course: plan.course?.id || '',
            semester: String(plan.semester),
            session: plan.session,
            status: plan.status,
          }
        : {
            name: '',
            amount: '',
            course: courses.find((c) => c.isActive)?.id || '',
            semester: '1',
            session: currentSession(),
            status: 'active',
          }
    );
  }, [open, plan, courses]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const course = courses.find((c) => c.id === form.course);
  const year = course ? Math.ceil(Number(form.semester) / course.semestersPerYear) : '';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.name.trim().length < 2) return setError('Enter a plan name.');
    if (!/^\d+$/.test(form.amount) || Number(form.amount) < 1) return setError('Amount must be a whole number of rupees (1 or more).');
    if (!SESSION_RE.test(form.session)) return setError('Session must look like 2025-26.');
    if (!form.course) return setError('Select a course.');
    const body = {
      name: form.name,
      amount: Number(form.amount),
      course: form.course,
      semester: Number(form.semester),
      session: form.session,
      status: form.status,
    };
    setSaving(true);
    try {
      if (plan) await api.master.updatePlan(plan.id, body);
      else await api.master.createPlan(body);
      toast.success('Plan saved. New amount applies to future payments only.');
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const locked = plan && plan.paymentCount > 0;

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title={plan ? 'Edit plan' : 'Add plan'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="plan-form" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form id="plan-form" onSubmit={submit} noValidate className="space-y-3">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</div>}
        <Field label="Plan name" htmlFor="pl-name">
          <Input id="pl-name" value={form.name} onChange={set('name')} maxLength={120} placeholder="Semester 5 fees" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹)" htmlFor="pl-amt" hint="Whole rupees">
            <Input id="pl-amt" inputMode="numeric" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value.replace(/\D/g, '') }))} />
          </Field>
          <Field label="Session" htmlFor="pl-session">
            <Input id="pl-session" value={form.session} onChange={set('session')} maxLength={7} disabled={locked} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Course" htmlFor="pl-course">
            <Select id="pl-course" value={form.course} onChange={set('course')} disabled={locked}>
              <option value="">Select</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.shortName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Semester" htmlFor="pl-sem">
            <Select id="pl-sem" value={form.semester} onChange={set('semester')} disabled={locked}>
              {range(course?.totalSemesters || 8).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Year (auto)" htmlFor="pl-year">
            <Input id="pl-year" value={year} disabled readOnly />
          </Field>
        </div>
        <Field label="Status" htmlFor="pl-status">
          <Select id="pl-status" value={form.status} onChange={set('status')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </Field>
        {locked && <p className="text-xs text-slate-500">Course, session and semester are locked because payments exist for this plan.</p>}
      </form>
    </Modal>
  );
}

/* ------------------------------ Page ------------------------------ */
export default function Plans() {
  const toast = useToast();
  const [tab, setTab] = useState('plans');
  const [courses, setCourses] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pf, setPf] = useState({ session: '', course: '', status: '' });
  const [courseForm, setCourseForm] = useState(undefined);
  const [planForm, setPlanForm] = useState(undefined);
  const [confirm, setConfirm] = useState(null); // { kind, item }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { course: pf.course, status: pf.status, session: SESSION_RE.test(pf.session) ? pf.session : '' };
      const [c, p] = await Promise.all([api.master.courses(), api.master.plans(params)]);
      setCourses(c.items);
      setPlans(p.items);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [pf, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async () => {
    setBusy(true);
    try {
      if (confirm.kind === 'course') await api.master.deleteCourse(confirm.item.id);
      else await api.master.deletePlan(confirm.item.id);
      toast.success('Deleted.');
      setConfirm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const courseColumns = [
    { key: 'shortName', header: 'Short name', render: (c) => <span className="font-medium text-slate-900">{c.shortName}</span> },
    { key: 'name', header: 'Name' },
    { key: 'years', header: 'Years' },
    { key: 'semesters', header: 'Semesters', render: (c) => c.totalSemesters },
    { key: 'students', header: 'Students', render: (c) => c.studentCount },
    { key: 'plans', header: 'Plans', render: (c) => c.planCount },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.isActive ? 'active' : 'inactive'} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <div className="flex gap-1">
          <Button variant="ghost" className="px-2 py-1" onClick={() => setCourseForm(c)}>
            Edit
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-red-600" onClick={() => setConfirm({ kind: 'course', item: c })}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const planColumns = [
    { key: 'name', header: 'Plan', render: (p) => <span className="font-medium text-slate-900">{p.name}</span> },
    { key: 'course', header: 'Course', render: (p) => p.course?.shortName || '—' },
    { key: 'ys', header: 'Year / Sem', render: (p) => `Y${p.year} / S${p.semester}` },
    { key: 'session', header: 'Session' },
    { key: 'amount', header: 'Amount', render: (p) => formatINR(p.amount) },
    { key: 'payments', header: 'Payments', render: (p) => p.paymentCount },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (p) => (
        <div className="flex gap-1">
          <Button variant="ghost" className="px-2 py-1" onClick={() => setPlanForm(p)}>
            Edit
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-red-600" onClick={() => setConfirm({ kind: 'plan', item: p })}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Plans & Courses" description="The fee amount is always read from here on the server.">
        {tab === 'plans' ? (
          <Button onClick={() => setPlanForm(null)}>Add plan</Button>
        ) : (
          <Button onClick={() => setCourseForm(null)}>Add course</Button>
        )}
      </PageHeader>

      <div className="mb-4 inline-flex gap-1 rounded-lg bg-slate-200 p-1 text-sm font-medium">
        {[
          ['plans', 'Plans'],
          ['courses', 'Courses'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn('rounded-md px-4 py-1.5 transition', tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'plans' ? (
        <>
          <Card className="mb-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Input placeholder="Session e.g. 2025-26" value={pf.session} maxLength={7} onChange={(e) => setPf((f) => ({ ...f, session: e.target.value }))} />
              <Select value={pf.course} onChange={(e) => setPf((f) => ({ ...f, course: e.target.value }))}>
                <option value="">All courses</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.shortName}
                  </option>
                ))}
              </Select>
              <Select value={pf.status} onChange={(e) => setPf((f) => ({ ...f, status: e.target.value }))}>
                <option value="">Any status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </Select>
            </div>
          </Card>
          <DataTable columns={planColumns} rows={plans} loading={loading} empty="No plans yet. Add one so students can pay." />
        </>
      ) : (
        <DataTable columns={courseColumns} rows={courses} loading={loading} empty="No courses." />
      )}

      <p className="mt-3 text-xs text-slate-500">
        <Badge color="blue">Note</Badge> Changing a plan affects future payments only. Every payment keeps its own amount snapshot.
      </p>

      <CourseForm
        open={courseForm !== undefined}
        course={courseForm}
        onClose={() => setCourseForm(undefined)}
        onSaved={() => {
          setCourseForm(undefined);
          load();
        }}
      />
      <PlanForm
        open={planForm !== undefined}
        plan={planForm}
        courses={courses}
        onClose={() => setPlanForm(undefined)}
        onSaved={() => {
          setPlanForm(undefined);
          load();
        }}
      />
      <ConfirmModal
        open={Boolean(confirm)}
        title={`Delete ${confirm?.kind || ''}?`}
        message={confirm ? `Delete "${confirm.item.name}"? This works only if nothing uses it. Otherwise deactivate it.` : ''}
        confirmLabel="Delete"
        danger
        loading={busy}
        onConfirm={remove}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}