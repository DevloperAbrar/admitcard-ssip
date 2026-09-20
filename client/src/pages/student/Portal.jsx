import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Outlet } from 'react-router-dom';
import { api } from '../../api.js';
import {
  Badge,
  Button,
  Card,
  DataTable,
  FullPageLoader,
  PageHeader,
  Spinner,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatINR,
  saveBlob,
  useAuth,
  usePdfViewer,
  useToast,
} from '../../components/ui.jsx';

/* ------------------------------ Gate: unpaid students only see the Pay page ------------------------------ */
export function StudentGate() {
  const [state, setState] = useState({ loading: true, paid: false, error: '' });

  const check = useCallback(() => {
    setState({ loading: true, paid: false, error: '' });
    api.payments
      .myPlan()
      .then((res) => setState({ loading: false, paid: Boolean(res.subscription), error: '' }))
      .catch((err) => setState({ loading: false, paid: false, error: err.message }));
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  if (state.loading) return <FullPageLoader />;
  if (state.error) {
    return (
      <Card>
        <p className="text-sm text-red-700">{state.error}</p>
        <Button className="mt-3" variant="secondary" onClick={check}>
          Try again
        </Button>
      </Card>
    );
  }
  if (!state.paid) return <Navigate to="/student/pay" replace />;
  return <Outlet />;
}

/* ------------------------------ Dashboard ------------------------------ */
export function StudentDashboard() {
  const { user } = useAuth();
  const toast = useToast();
  const [plan, setPlan] = useState(null);
  const [cards, setCards] = useState(null);

  useEffect(() => {
    api.payments
      .myPlan()
      .then(setPlan)
      .catch((err) => toast.error(err.message));
    api.admitCards
      .my()
      .then((res) => setCards(res.items))
      .catch(() => setCards([]));
  }, [toast]);

  const ready = cards ? cards.filter((c) => c.eligible).length : null;

  return (
    <>
      <PageHeader title={`Welcome, ${user?.name || ''}`} description="Your student dashboard." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="mb-3 text-sm font-semibold text-slate-900">Profile</p>
          <dl className="divide-y divide-slate-100 text-sm">
            {[
              ['Enrollment No.', user?.enrollmentNo],
              ['Roll No.', user?.rollNo],
              ['Email', user?.email],
              ['Course', user?.course?.name],
              ['Year / Semester', user ? `Year ${user.year} / Semester ${user.semester}` : ''],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-2">
                <dt className="text-slate-500">{label}</dt>
                <dd className="text-right font-medium text-slate-900">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <div className="space-y-4">
          <Card>
            <p className="text-sm font-semibold text-slate-900">Subscription</p>
            {plan ? (
              <p className="mt-2 text-sm text-slate-700">
                Semester {plan.subscription?.semester} · Session {plan.subscription?.session}{' '}
                <StatusBadge status={plan.subscription?.status} />
              </p>
            ) : (
              <div className="mt-2 text-indigo-600">
                <Spinner />
              </div>
            )}
            <Link to="/student/subscription" className="mt-2 inline-block text-sm text-indigo-600">
              View receipts →
            </Link>
          </Card>

          <Card>
            <p className="text-sm font-semibold text-slate-900">Admit cards</p>
            <p className="mt-2 text-sm text-slate-700">
              {cards === null ? 'Loading...' : ready > 0 ? `${ready} admit card(s) ready to download.` : 'No admit card is published for you yet.'}
            </p>
            <Link to="/student/admit-cards" className="mt-2 inline-block text-sm text-indigo-600">
              Open admit cards →
            </Link>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ------------------------------ Subscription & receipts ------------------------------ */
export function StudentSubscription() {
  const toast = useToast();
  const viewer = usePdfViewer();
  const [data, setData] = useState(null);

  useEffect(() => {
    api.payments
      .myPayments()
      .then(setData)
      .catch((err) => toast.error(err.message));
  }, [toast]);

  const download = async (p) => {
    try {
      saveBlob(await api.payments.receipt(p.id, 'download'), `receipt-${p.receiptNo}.pdf`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const subColumns = [
    { key: 'session', header: 'Session' },
    { key: 'semester', header: 'Semester' },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'note', header: 'Note', render: (s) => s.waivedReason || '—' },
  ];

  const payColumns = [
    { key: 'date', header: 'Date', render: (p) => formatDateTime(p.paidAt || p.createdAt) },
    { key: 'session', header: 'Session / Sem', render: (p) => `${p.session} · S${p.semester}` },
    { key: 'amount', header: 'Amount', render: (p) => formatINR(p.amount) },
    { key: 'method', header: 'Method', render: (p) => p.method },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'receipt', header: 'Receipt', render: (p) => p.receiptNo || '—' },
    {
      key: 'actions',
      header: 'Actions',
      render: (p) =>
        p.receiptNo && ['paid', 'refunded'].includes(p.status) ? (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              className="px-2 py-1"
              onClick={() => viewer.open(() => api.payments.receipt(p.id, 'preview'), `Receipt ${p.receiptNo}`, () => download(p))}
            >
              View
            </Button>
            <Button variant="ghost" className="px-2 py-1" onClick={() => download(p)}>
              Download
            </Button>
          </div>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <>
      <PageHeader title="Subscription & Receipts" description="Your fee status and payment receipts." />
      <p className="mb-2 text-sm font-semibold text-slate-900">Subscriptions</p>
      <DataTable columns={subColumns} rows={data?.subscriptions || []} loading={!data} empty="No subscriptions yet." />
      <p className="mb-2 mt-6 text-sm font-semibold text-slate-900">Payments</p>
      <DataTable columns={payColumns} rows={data?.payments || []} loading={!data} empty="No payments yet." />
      {viewer.modal}
    </>
  );
}

/* ------------------------------ Admit cards ------------------------------ */
export function StudentAdmitCards() {
  const toast = useToast();
  const viewer = usePdfViewer();
  const [items, setItems] = useState(null);

  const load = useCallback(() => {
    api.admitCards
      .my()
      .then((res) => setItems(res.items))
      .catch((err) => {
        toast.error(err.message);
        setItems([]);
      });
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const download = async (c) => {
    try {
      saveBlob(await api.admitCards.myPdf(c.cardId, 'download'), `admit-card-${c.examName.replace(/\s+/g, '-')}.pdf`);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <>
      <PageHeader title="Admit Card" description="Published admit cards for your course and semester." />

      {items === null && (
        <div className="flex justify-center py-10 text-indigo-600">
          <Spinner className="h-8 w-8" />
        </div>
      )}

      {items && items.length === 0 && (
        <Card>
          <p className="text-sm text-slate-600">No admit card has been published for you yet. Please check again later.</p>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {(items || []).map((c) => (
          <Card key={c.cardId}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-slate-900">{c.examName}</p>
                <p className="text-xs text-slate-500">
                  Session {c.session} · Semester {c.semester}
                </p>
              </div>
              {c.updated && <Badge color="blue">Updated</Badge>}
            </div>
            <p className="mt-2 font-mono text-xs text-slate-600">{c.cardNo}</p>
            <p className="mt-1 text-xs text-slate-500">Published {formatDate(c.publishedAt)}</p>

            {c.eligible ? (
              <div className="mt-4 flex gap-2">
                <Button variant="secondary" onClick={() => viewer.open(() => api.admitCards.myPdf(c.cardId, 'preview'), `${c.examName} - Admit Card`, () => download(c))}>
                  Preview
                </Button>
                <Button onClick={() => download(c)}>Download</Button>
              </div>
            ) : (
              <p className="mt-4 rounded-lg bg-red-50 p-2 text-sm text-red-700">Blocked: {c.reason}</p>
            )}
          </Card>
        ))}
      </div>
      {viewer.modal}
    </>
  );
}