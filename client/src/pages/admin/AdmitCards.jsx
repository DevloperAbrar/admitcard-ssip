import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  DataTable,
  Input,
  PageHeader,
  Pagination,
  Select,
  SESSION_RE,
  StatusBadge,
  formatDateTime,
  saveBlob,
  useDebounce,
  usePdfViewer,
  useToast,
} from '../../components/ui.jsx';

export default function AdmitCards() {
  const { id } = useParams();
  return id ? <Cohort id={id} /> : <SessionList />;
}

/* ------------------------------ Exam session list ------------------------------ */
function SessionList() {
  const toast = useToast();
  const navigate = useNavigate();
  const [courses, setCourses] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ session: '', course: '', status: '' });
  const [confirm, setConfirm] = useState(null); // { type, exam }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.master
      .courses()
      .then((res) => setCourses(res.items))
      .catch((err) => toast.error(err.message));
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { course: f.course, status: f.status, session: SESSION_RE.test(f.session) ? f.session : '' };
      setItems((await api.admitCards.sessions(params)).items);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [f, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const runConfirm = async () => {
    setBusy(true);
    try {
      const { type, exam } = confirm;
      if (type === 'publish') {
        const res = await api.admitCards.publish(exam.id);
        toast.success(`Published. ${res.cardsCreated} card(s) created.`);
      } else if (type === 'unpublish') {
        await api.admitCards.unpublish(exam.id);
        toast.success('Unpublished. Students can no longer see these cards.');
      } else {
        await api.admitCards.deleteSession(exam.id);
        toast.success('Deleted.');
      }
      setConfirm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    { key: 'examName', header: 'Examination', render: (e) => <span className="font-medium text-slate-900">{e.examName}</span> },
    { key: 'session', header: 'Session' },
    { key: 'course', header: 'Course', render: (e) => `${e.course.shortName || ''} · Y${e.year} / S${e.semester}` },
    { key: 'rows', header: 'Subjects', render: (e) => e.timetable.length },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} /> },
    { key: 'version', header: 'Version', render: (e) => `v${e.version}` },
    { key: 'cards', header: 'Cards', render: (e) => e.cardCount },
    {
      key: 'actions',
      header: 'Actions',
      render: (e) => (
        <div className="flex flex-wrap gap-1">
          <Link to={`/admin/admit-cards/${e.id}`}>
            <Button variant="ghost" className="px-2 py-1">
              Open
            </Button>
          </Link>
          <Link to={`/admin/admit-cards/${e.id}/edit`}>
            <Button variant="ghost" className="px-2 py-1">
              Edit
            </Button>
          </Link>
          {e.status === 'draft' ? (
            <Button variant="ghost" className="px-2 py-1" onClick={() => setConfirm({ type: 'publish', exam: e })}>
              Publish
            </Button>
          ) : (
            <Button variant="ghost" className="px-2 py-1" onClick={() => setConfirm({ type: 'unpublish', exam: e })}>
              Unpublish
            </Button>
          )}
          {e.status === 'draft' && e.cardCount === 0 && (
            <Button variant="ghost" className="px-2 py-1 text-red-600" onClick={() => setConfirm({ type: 'delete', exam: e })}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  const text = {
    publish: ['Publish exam session?', 'A card is created for every active student of this course and semester, and students can see it right away.', 'Publish', false],
    unpublish: ['Unpublish exam session?', 'Students will immediately lose access to these admit cards.', 'Unpublish', true],
    delete: ['Delete draft?', 'This draft will be permanently removed.', 'Delete', true],
  };
  const t = confirm ? text[confirm.type] : null;

  return (
    <>
      <PageHeader title="Admit Cards" description="Exam sessions, publishing and downloads.">
        <Button onClick={() => navigate('/admin/admit-cards/new')}>Create exam session</Button>
      </PageHeader>

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input placeholder="Session e.g. 2025-26" maxLength={7} value={f.session} onChange={(e) => setF((x) => ({ ...x, session: e.target.value }))} />
          <Select value={f.course} onChange={(e) => setF((x) => ({ ...x, course: e.target.value }))}>
            <option value="">All courses</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.shortName}
              </option>
            ))}
          </Select>
          <Select value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value }))}>
            <option value="">Draft + published</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </Select>
        </div>
      </Card>

      <DataTable columns={columns} rows={items} loading={loading} empty="No exam sessions yet." />

      <ConfirmModal
        open={Boolean(confirm)}
        title={t?.[0]}
        message={t ? `${t[1]} (${confirm.exam.examName}, Semester ${confirm.exam.semester}, ${confirm.exam.session})` : ''}
        confirmLabel={t?.[2]}
        danger={t?.[3]}
        loading={busy}
        onConfirm={runConfirm}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

/* ------------------------------ Cohort view ------------------------------ */
function Cohort({ id }) {
  const toast = useToast();
  const viewer = usePdfViewer();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const dq = useDebounce(q);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.admitCards.cohort(id, { q: dq, status, page, limit: 50 }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [id, dq, status, page, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll the bulk PDF job while it runs.
  useEffect(() => {
    if (!jobId) return undefined;
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const res = await api.admitCards.bulkJob(jobId);
        if (!alive) return;
        setJob(res.job);
        if (res.job.status === 'completed' || res.job.status === 'failed') return;
      } catch (err) {
        if (!alive) return;
        toast.error(err.message);
      }
      timer = setTimeout(tick, 3000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [jobId, toast]);

  const exam = data?.exam;

  const runConfirm = async () => {
    setBusy(true);
    try {
      if (confirm === 'publish') {
        const res = await api.admitCards.publish(id);
        toast.success(`Published. ${res.cardsCreated} card(s) created.`);
      } else if (confirm === 'unpublish') {
        await api.admitCards.unpublish(id);
        toast.success('Unpublished.');
      } else {
        const res = await api.admitCards.sync(id);
        toast.success(`${res.cardsCreated} new card(s) created.`);
      }
      setConfirm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const startBulk = async () => {
    setStarting(true);
    setJob(null);
    setShowSkipped(false);
    try {
      const res = await api.admitCards.startBulk(id);
      setJobId(res.jobId);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setStarting(false);
    }
  };

  const downloadBulk = async () => {
    try {
      saveBlob(await api.admitCards.bulkDownload(jobId), 'admit-cards.pdf');
    } catch (err) {
      toast.error(err.message);
    }
  };

  const downloadOne = async (row) => {
    try {
      saveBlob(await api.admitCards.cardPdf(row.cardId, 'download'), `admit-card-${row.enrollmentNo}.pdf`);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const columns = [
    { key: 'name', header: 'Student', render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'enrollmentNo', header: 'Enrollment' },
    { key: 'rollNo', header: 'Roll No.' },
    { key: 'sub', header: 'Subscription', render: (r) => <StatusBadge status={r.subscriptionStatus} /> },
    {
      key: 'card',
      header: 'Card',
      render: (r) => (
        <div>
          <Badge color={r.cardStatus === 'ready' ? 'green' : 'red'}>{r.cardStatus === 'ready' ? 'Ready' : 'Blocked'}</Badge>
          {r.reason && <span className="block text-xs text-slate-500">{r.reason}</span>}
        </div>
      ),
    },
    { key: 'dl', header: 'Downloads', render: (r) => r.downloadCount },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            className="px-2 py-1"
            disabled={!r.cardId}
            onClick={() => viewer.open(() => api.admitCards.cardPdf(r.cardId, 'preview'), `Admit card - ${r.name}`)}
          >
            Preview
          </Button>
          <Button variant="ghost" className="px-2 py-1" disabled={r.cardStatus !== 'ready'} onClick={() => downloadOne(r)}>
            Download
          </Button>
        </div>
      ),
    },
  ];

  if (!data && !loading) {
    return (
      <>
        <PageHeader title="Exam session not found" />
        <Link to="/admin/admit-cards" className="text-sm text-indigo-600">
          ← Back to exam sessions
        </Link>
      </>
    );
  }

  const confirmText = {
    publish: ['Publish exam session?', 'Cards are created for every active student and become visible to students.', 'Publish', false],
    unpublish: ['Unpublish exam session?', 'Students will immediately lose access to these cards.', 'Unpublish', true],
    sync: ['Sync new students?', 'Creates cards for active students who were added after publishing.', 'Sync', false],
  };
  const ct = confirm ? confirmText[confirm] : null;
  const running = job && (job.status === 'queued' || job.status === 'running');

  return (
    <>
      <Link to="/admin/admit-cards" className="mb-2 inline-block text-sm text-indigo-600">
        ← All exam sessions
      </Link>
      <PageHeader
        title={exam ? `${exam.examName} · Semester ${exam.semester}` : 'Loading...'}
        description={exam ? `${exam.course.shortName} · Session ${exam.session} · Version ${exam.version}` : ''}
      >
        {exam && <StatusBadge status={exam.status} />}
        {exam && (
          <Link to={`/admin/admit-cards/${id}/edit`}>
            <Button variant="secondary">Edit</Button>
          </Link>
        )}
        {exam?.status === 'draft' && <Button onClick={() => setConfirm('publish')}>Publish</Button>}
        {exam?.status === 'published' && (
          <>
            <Button variant="secondary" onClick={() => setConfirm('sync')}>
              Sync new students
            </Button>
            <Button variant="secondary" onClick={startBulk} loading={starting} disabled={running}>
              Bulk download
            </Button>
            <Button variant="danger" onClick={() => setConfirm('unpublish')}>
              Unpublish
            </Button>
          </>
        )}
      </PageHeader>

      {job && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <p className="font-medium text-slate-900">
                Bulk download <StatusBadge status={job.status} />
              </p>
              {running && job.progress?.total > 0 && (
                <div className="mt-2 w-64">
                  <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full bg-indigo-600 transition-all" style={{ width: `${Math.round((job.progress.done / job.progress.total) * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {job.progress.done} of {job.progress.total} cards
                  </p>
                </div>
              )}
              {job.status === 'completed' && (
                <p className="mt-1 text-slate-600">
                  {job.summary.included} card(s) included, {job.summary.skipped} student(s) skipped.
                </p>
              )}
              {job.status === 'failed' && <p className="mt-1 text-red-700">{job.error}</p>}
            </div>
            <div className="flex gap-2">
              {job.skipped?.length > 0 && (
                <Button variant="secondary" onClick={() => setShowSkipped((v) => !v)}>
                  {showSkipped ? 'Hide' : 'Show'} skipped ({job.skipped.length})
                </Button>
              )}
              {job.status === 'completed' && job.hasFile && <Button onClick={downloadBulk}>Download PDF</Button>}
            </div>
          </div>
          {showSkipped && (
            <ul className="mt-3 max-h-56 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200 text-sm">
              {job.skipped.map((s, i) => (
                <li key={i} className="flex justify-between gap-4 px-3 py-1.5">
                  <span>{s.ref}</span>
                  <span className="text-slate-500">{s.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {data && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          {[
            ['Students', data.summary.total],
            ['Ready', data.summary.ready],
            ['Blocked', data.summary.blocked],
          ].map(([label, value]) => (
            <Card key={label} className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
            </Card>
          ))}
        </div>
      )}

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            placeholder="Search name, enrollment, roll no."
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Ready + blocked</option>
            <option value="ready">Ready</option>
            <option value="blocked">Blocked</option>
          </Select>
        </div>
      </Card>

      <DataTable columns={columns} rows={data?.items || []} rowKey="studentId" loading={loading} empty="No students in this cohort." />
      <Pagination page={data?.page || page} pages={data?.pages || 1} total={data?.total || 0} onChange={setPage} />
      <p className="mt-3 text-xs text-slate-500">Download and print work only for paid or waived students. Preview is always available to admin.</p>

      <ConfirmModal
        open={Boolean(confirm)}
        title={ct?.[0]}
        message={ct?.[1]}
        confirmLabel={ct?.[2]}
        danger={ct?.[3]}
        loading={busy}
        onConfirm={runConfirm}
        onClose={() => setConfirm(null)}
      />
      {viewer.modal}
    </>
  );
}