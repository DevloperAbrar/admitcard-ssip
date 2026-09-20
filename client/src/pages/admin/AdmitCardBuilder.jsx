import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import {
  Button,
  Card,
  ConfirmModal,
  Field,
  FullPageLoader,
  Input,
  Modal,
  PageHeader,
  SESSION_RE,
  Select,
  currentSession,
  usePdfViewer,
  useToast,
} from '../../components/ui.jsx';

const MAX_ROWS = 12;
const MAX_INSTRUCTIONS = 10;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const emptyRow = () => ({ date: '', subject: '', time: '' });

const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return dt.toISOString().slice(0, 10);
};

// Accepts 2025-11-12, 12/11/2025, 12-11-2025, 12.11.2025 and "12 Nov 2025".
function parseDateCell(text) {
  const s = String(text).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (m) {
    const mi = MONTHS.findIndex((x) => m[2].toLowerCase().startsWith(x));
    if (mi >= 0) return iso(+m[3], mi + 1, +m[1]);
  }
  return '';
}

function checkTimetable(rows) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const today = new Date().toISOString().slice(0, 10);
  let prev = '';
  rows.forEach((r, i) => {
    const n = i + 1;
    if (!r.date) errors.push(`Row ${n}: choose a valid date.`);
    if (!r.subject.trim()) errors.push(`Row ${n}: enter the subject.`);
    if (!r.time.trim()) errors.push(`Row ${n}: enter the time.`);
    if (r.date) {
      const key = `${r.date}|${r.subject.trim().toLowerCase()}`;
      if (r.subject.trim() && seen.has(key)) errors.push(`Row ${n}: this subject is already listed on the same date.`);
      seen.add(key);
      if (prev && r.date < prev) errors.push(`Row ${n}: dates must be in ascending order.`);
      prev = r.date;
      if (r.date < today) warnings.push(`Row ${n}: the date is in the past.`);
    }
  });
  return { errors, warnings };
}

export default function AdmitCardBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const viewer = usePdfViewer();

  const [loading, setLoading] = useState(true);
  const [courses, setCourses] = useState([]);
  const [defaults, setDefaults] = useState(null);
  const [examStatus, setExamStatus] = useState('draft');
  const [locked, setLocked] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [confirmPublish, setConfirmPublish] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [c, d, e] = await Promise.all([api.master.courses(), api.admitCards.defaults(), id ? api.admitCards.session(id) : null]);
        if (!alive) return;
        setCourses(c.items);
        setDefaults(d);
        if (e) {
          const x = e.item;
          setExamStatus(x.status);
          setLocked(x.everPublished);
          setForm({
            session: x.session,
            course: x.course.id,
            semester: String(x.semester),
            examName: x.examName,
            timetable: x.timetable.length ? x.timetable : [emptyRow()],
            instructions: x.instructions,
          });
        } else {
          setForm({
            session: currentSession(),
            course: c.items.find((k) => k.isActive)?.id || '',
            semester: '1',
            examName: d.examNames[0],
            timetable: [emptyRow()],
            instructions: d.instructions,
          });
        }
      } catch (err) {
        toast.error(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, toast]);

  const course = courses.find((c) => c.id === form?.course);
  const year = course && form ? Math.ceil(Number(form.semester) / course.semestersPerYear) : '';
  const tt = useMemo(() => (form ? checkTimetable(form.timetable) : { errors: [], warnings: [] }), [form]);

  if (loading || !form) return <FullPageLoader />;

  const patch = (changes) => setForm((f) => ({ ...f, ...changes }));
  const setRow = (index, changes) => patch({ timetable: form.timetable.map((r, i) => (i === index ? { ...r, ...changes } : r)) });
  const addRow = () => form.timetable.length < MAX_ROWS && patch({ timetable: [...form.timetable, emptyRow()] });
  const removeRow = (index) =>
    patch({ timetable: form.timetable.length > 1 ? form.timetable.filter((_, i) => i !== index) : [emptyRow()] });
  const moveRow = (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= form.timetable.length) return;
    const rows = [...form.timetable];
    [rows[index], rows[target]] = [rows[target], rows[index]];
    patch({ timetable: rows });
  };

  const setInstruction = (index, value) => patch({ instructions: form.instructions.map((t, i) => (i === index ? value : t)) });

  const applyPaste = () => {
    const parsed = [];
    for (const line of pasteText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let cells = line.split('\t').map((c) => c.trim());
      // A leading S.No column is ignored.
      if (cells.length >= 4 && /^\d+$/.test(cells[0])) cells = cells.slice(1);
      if (cells.length < 3) continue;
      parsed.push({ date: parseDateCell(cells[0]), subject: cells[1], time: cells[2] });
    }
    if (!parsed.length) return toast.error('No rows found. Paste 3 columns from Excel: Date, Subject, Time.');
    const base = form.timetable.length === 1 && !form.timetable[0].date && !form.timetable[0].subject ? [] : form.timetable;
    const merged = [...base, ...parsed];
    if (merged.length > MAX_ROWS) toast.info(`Only the first ${MAX_ROWS} rows are kept.`);
    patch({ timetable: merged.slice(0, MAX_ROWS) });
    setPasteOpen(false);
    setPasteText('');
  };

  const buildBody = () => ({
    session: form.session,
    course: form.course,
    semester: Number(form.semester),
    examName: form.examName.trim(),
    timetable: form.timetable.map((r) => ({ date: r.date, subject: r.subject.trim(), time: r.time.trim() })),
    instructions: form.instructions.map((t) => t.trim()).filter(Boolean),
  });

  // Returns an error message or '' when the form can be sent to the server.
  const validate = () => {
    if (!SESSION_RE.test(form.session)) return 'Academic session must look like 2025-26.';
    if (!form.course) return 'Select a course.';
    if (form.examName.trim().length < 2) return 'Enter the examination name.';
    if (tt.errors.length) return tt.errors[0];
    if (form.instructions.filter((t) => t.trim()).length > MAX_INSTRUCTIONS) return `Maximum ${MAX_INSTRUCTIONS} instructions.`;
    return '';
  };

  const persist = async () => {
    const body = buildBody();
    if (id) {
      await api.admitCards.updateSession(id, body);
      return id;
    }
    return (await api.admitCards.createSession(body)).item.id;
  };

  const preview = async () => {
    const problem = validate();
    if (problem) return toast.error(problem);
    setPreviewing(true);
    try {
      await viewer.open(() => api.admitCards.preview(buildBody()), 'Admit card preview (sample student)');
    } finally {
      setPreviewing(false);
    }
  };

  const saveDraft = async () => {
    const problem = validate();
    if (problem) return toast.error(problem);
    setSaving(true);
    try {
      const savedId = await persist();
      toast.success(locked ? 'Saved. Students will see an "Updated" badge.' : 'Draft saved.');
      navigate(`/admin/admit-cards/${savedId}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveAndPublish = async () => {
    setSaving(true);
    try {
      const savedId = await persist();
      const res = await api.admitCards.publish(savedId);
      toast.success(`Published. ${res.cardsCreated} card(s) created.`);
      navigate(`/admin/admit-cards/${savedId}`);
    } catch (err) {
      toast.error(err.message);
      setConfirmPublish(false);
    } finally {
      setSaving(false);
    }
  };

  const askPublish = () => {
    const problem = validate();
    if (problem) return toast.error(problem);
    setConfirmPublish(true);
  };

  return (
    <>
      <Link to={id ? `/admin/admit-cards/${id}` : '/admin/admit-cards'} className="mb-2 inline-block text-sm text-indigo-600">
        ← Back
      </Link>
      <PageHeader
        title={id ? 'Edit exam session' : 'Create exam session'}
        description="College name, logo, signatures and seal come from the server. Only the details below are needed."
      />

      {defaults?.missingAssets?.length > 0 && (
        <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          Missing on the server: {defaults.missingAssets.join(', ')}. The card will render without them.
        </div>
      )}
      {locked && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          Cards already exist for this exam. Only the timetable and instructions can change. Saving creates a new version and students see an
          "Updated" badge.
        </div>
      )}

      <div className="space-y-4">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Academic session" htmlFor="b-session">
              <Input id="b-session" value={form.session} maxLength={7} disabled={locked} onChange={(e) => patch({ session: e.target.value })} />
            </Field>
            <Field label="Course" htmlFor="b-course">
              <Select id="b-course" value={form.course} disabled={locked} onChange={(e) => patch({ course: e.target.value })}>
                <option value="">Select</option>
                {courses.filter((c) => c.isActive || c.id === form.course).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.shortName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Semester" htmlFor="b-sem">
              <Select id="b-sem" value={form.semester} disabled={locked} onChange={(e) => patch({ semester: e.target.value })}>
                {range(course?.totalSemesters || 8).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Year (auto)" htmlFor="b-year">
              <Input id="b-year" value={year} disabled readOnly />
            </Field>
            <Field label="Examination name" htmlFor="b-exam">
              <Input
                id="b-exam"
                list="exam-names"
                value={form.examName}
                maxLength={80}
                disabled={locked}
                onChange={(e) => patch({ examName: e.target.value })}
              />
              <datalist id="exam-names">
                {(defaults?.examNames || []).map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </Field>
          </div>
        </Card>

        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">Timetable ({form.timetable.length}/{MAX_ROWS})</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setPasteOpen(true)}>
                Paste from Excel
              </Button>
              <Button variant="secondary" onClick={addRow} disabled={form.timetable.length >= MAX_ROWS}>
                Add row
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            {form.timetable.map((r, i) => (
              <div key={i} className="grid grid-cols-[2rem_1fr] items-center gap-2 lg:grid-cols-[2rem_11rem_1fr_13rem_auto]">
                <span className="text-center text-sm font-medium text-slate-500">{i + 1}</span>
                <Input type="date" value={r.date} onChange={(e) => setRow(i, { date: e.target.value })} aria-label={`Date ${i + 1}`} />
                <Input placeholder="Subject" value={r.subject} maxLength={150} onChange={(e) => setRow(i, { subject: e.target.value })} aria-label={`Subject ${i + 1}`} />
                <Input placeholder="10:00 AM - 12:00 PM" value={r.time} maxLength={60} onChange={(e) => setRow(i, { time: e.target.value })} aria-label={`Time ${i + 1}`} />
                <div className="col-span-2 flex gap-1 lg:col-span-1">
                  <Button variant="ghost" className="px-2 py-1" onClick={() => moveRow(i, -1)} disabled={i === 0} aria-label="Move up">
                    ↑
                  </Button>
                  <Button variant="ghost" className="px-2 py-1" onClick={() => moveRow(i, 1)} disabled={i === form.timetable.length - 1} aria-label="Move down">
                    ↓
                  </Button>
                  <Button variant="ghost" className="px-2 py-1 text-red-600" onClick={() => removeRow(i)} aria-label="Remove row">
                    ✕
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {tt.errors.length > 0 && (
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-red-700">
              {tt.errors.slice(0, 6).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {tt.warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-yellow-700">
              {tt.warnings.slice(0, 4).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Instructions ({form.instructions.length}/{MAX_INSTRUCTIONS})</p>
            <Button
              variant="secondary"
              onClick={() => form.instructions.length < MAX_INSTRUCTIONS && patch({ instructions: [...form.instructions, ''] })}
              disabled={form.instructions.length >= MAX_INSTRUCTIONS}
            >
              Add instruction
            </Button>
          </div>
          <div className="space-y-2">
            {form.instructions.map((t, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="w-6 pt-2 text-center text-sm text-slate-500">{i + 1}</span>
                <textarea
                  rows={2}
                  maxLength={300}
                  value={t}
                  onChange={(e) => setInstruction(i, e.target.value)}
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
                <Button variant="ghost" className="px-2 py-1 text-red-600" onClick={() => patch({ instructions: form.instructions.filter((_, x) => x !== i) })} aria-label="Remove instruction">
                  ✕
                </Button>
              </div>
            ))}
            {form.instructions.length === 0 && <p className="text-sm text-slate-500">No instructions. The section is hidden on the card.</p>}
          </div>
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={preview} loading={previewing} disabled={saving}>
            Preview PDF
          </Button>
          <Button variant="secondary" onClick={saveDraft} loading={saving} disabled={previewing}>
            {locked ? 'Save changes' : 'Save as draft'}
          </Button>
          {examStatus !== 'published' && (
            <Button onClick={askPublish} disabled={saving || previewing}>
              Save & publish
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        title="Paste timetable from Excel"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyPaste}>Add rows</Button>
          </>
        }
      >
        <p className="mb-2 text-sm text-slate-600">Copy three columns in this order from Excel: Date, Subject, Time. An S.No column is ignored.</p>
        <textarea
          rows={8}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          className="block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          placeholder={'12/11/2025\tPharmaceutics\t10:00 AM - 12:00 PM'}
        />
      </Modal>

      <ConfirmModal
        open={confirmPublish}
        title="Save and publish?"
        message="A card is created for every active student of this course and semester, and they can see it right away."
        confirmLabel="Publish"
        loading={saving}
        onConfirm={saveAndPublish}
        onClose={() => setConfirmPublish(false)}
      />
      {viewer.modal}
    </>
  );
}