import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import {
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
    SESSION_RE,
    Spinner,
    StatusBadge,
    currentSession,
    formatDateTime,
    formatINR,
    saveBlob,
    useDebounce,
    useToast,
} from '../../components/ui.jsx';

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

function SummaryCard({ label, value }) {
    return (
        <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
        </Card>
    );
}

/* ------------------------------ Offline payment ------------------------------ */
function ManualModal({ row, session, onClose, onDone }) {
    const toast = useToast();
    const [plan, setPlan] = useState(undefined); // undefined = loading, null = none
    const [method, setMethod] = useState('cash');
    const [reference, setReference] = useState('');
    const [notes, setNotes] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!row) return;
        setPlan(undefined);
        setMethod('cash');
        setReference('');
        setNotes('');
        setError('');
        api.master
            .plans({ course: row.course.id, session, semester: row.semester, status: 'active' })
            .then((res) => setPlan(res.items[0] || null))
            .catch((err) => {
                setPlan(null);
                setError(err.message);
            });
    }, [row, session]);

    const submit = async () => {
        setError('');
        if (!reference.trim()) return setError('Enter the receipt / reference number.');
        setSaving(true);
        try {
            await api.payments.manual({ student: row.studentId, plan: plan.id, method, reference, notes: notes || undefined });
            toast.success('Offline payment recorded.');
            onDone();
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            open={Boolean(row)}
            onClose={saving ? undefined : onClose}
            title="Record offline payment"
            footer={
                <>
                    <Button variant="secondary" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={submit} loading={saving} disabled={!plan}>
                        Record payment
                    </Button>
                </>
            }
        >
            {row && (
                <div className="space-y-3">
                    <p className="text-sm text-slate-700">
                        {row.name} ({row.enrollmentNo}) · Semester {row.semester}
                    </p>
                    {plan === undefined && (
                        <div className="text-indigo-600">
                            <Spinner />
                        </div>
                    )}
                    {plan === null && (
                        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-2 text-sm text-yellow-800">
                            No active plan exists for this course, semester and session. Create one in Plans & Courses first.
                        </div>
                    )}
                    {plan && (
                        <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            {plan.name} · <span className="font-semibold">{formatINR(plan.amount)}</span> (from plan, cannot be edited)
                        </div>
                    )}
                    {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</div>}
                    <Field label="Method" htmlFor="m-method">
                        <Select id="m-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                            <option value="cash">Cash</option>
                            <option value="dd">Demand Draft</option>
                            <option value="upi">UPI</option>
                            <option value="other">Other</option>
                        </Select>
                    </Field>
                    <Field label="Reference (receipt no. / DD no. / UPI ref)" htmlFor="m-ref">
                        <Input id="m-ref" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
                    </Field>
                    <Field label="Notes (optional)" htmlFor="m-notes">
                        <Input id="m-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
                    </Field>
                </div>
            )}
        </Modal>
    );
}

/* ------------------------------ Waiver / refund (reason only) ------------------------------ */
function ReasonModal({ open, title, description, confirmLabel, danger, onClose, onSubmit }) {
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (open) {
            setReason('');
            setError('');
        }
    }, [open]);

    const submit = async () => {
        if (reason.trim().length < 2) return setError('Please enter a reason.');
        setSaving(true);
        setError('');
        try {
            await onSubmit(reason.trim());
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
            title={title}
            footer={
                <>
                    <Button variant="secondary" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variant={danger ? 'danger' : 'primary'} onClick={submit} loading={saving}>
                        {confirmLabel}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <p className="text-sm text-slate-600">{description}</p>
                {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800">{error}</div>}
                <Field label="Reason" htmlFor="reason">
                    <Input id="reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus />
                </Field>
            </div>
        </Modal>
    );
}

/* ------------------------------ Page ------------------------------ */
export default function Subscriptions() {
    const toast = useToast();
    const [courses, setCourses] = useState([]);
    const [filters, setFilters] = useState({
        session: currentSession(),
        course: '',
        semester: '',
        status: '',
        method: '',
        from: '',
        to: '',
        q: '',
    });
    const [page, setPage] = useState(1);
    const [data, setData] = useState({ items: [], summary: null, total: 0, pages: 1 });
    const [loading, setLoading] = useState(false);
    const [attention, setAttention] = useState(null); // null = hidden
    const [manualRow, setManualRow] = useState(null);
    const [waiveRow, setWaiveRow] = useState(null);
    const [refundRow, setRefundRow] = useState(null);
    const [exporting, setExporting] = useState(false);

    const debouncedQ = useDebounce(filters.q);
    const sessionOk = SESSION_RE.test(filters.session);
    const query = useMemo(
        () => ({ ...filters, q: debouncedQ }),
        [filters, debouncedQ]
    );

    useEffect(() => {
        api.master
            .courses()
            .then((res) => setCourses(res.items))
            .catch((err) => toast.error(err.message));
    }, [toast]);

    const load = useCallback(async () => {
        if (!SESSION_RE.test(query.session)) return;
        setLoading(true);
        try {
            setData(await api.payments.subscriptions({ ...query, page, limit: 50 }));
        } catch (err) {
            toast.error(err.message);
            setData((d) => ({ ...d, items: [], total: 0 }));
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
    const maxSems = selectedCourse?.totalSemesters || Math.max(8, ...courses.map((c) => c.totalSemesters));

    const toggleAttention = async () => {
        if (attention) return setAttention(null);
        try {
            setAttention((await api.payments.needsAttention()).items);
        } catch (err) {
            toast.error(err.message);
        }
    };

    const exportExcel = async () => {
        setExporting(true);
        try {
            const { page: _p, ...params } = query;
            saveBlob(await api.payments.exportSubscriptions(params), `subscriptions-${filters.session}.xlsx`);
        } catch (err) {
            toast.error(err.message);
        } finally {
            setExporting(false);
        }
    };

    const downloadReceipt = async (row) => {
        try {
            saveBlob(await api.payments.receipt(row.paymentId, 'download'), `receipt-${row.receiptNo}.pdf`);
        } catch (err) {
            toast.error(err.message);
        }
    };

    const reload = () => {
        setManualRow(null);
        setWaiveRow(null);
        setRefundRow(null);
        load();
    };

    const s = data.summary;

    const columns = [
        {
            key: 'name',
            header: 'Student',
            render: (r) => (
                <div>
                    <p className="font-medium text-slate-900">{r.name}</p>
                    <p className="text-xs text-slate-500">
                        {r.enrollmentNo} · {r.email}
                    </p>
                </div>
            ),
        },
        { key: 'sem', header: 'Sem', render: (r) => `${r.course?.shortName || ''} S${r.semester}` },
        { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        { key: 'amount', header: 'Amount', render: (r) => formatINR(r.amount) },
        { key: 'method', header: 'Method', render: (r) => r.method || '—' },
        { key: 'paidAt', header: 'Paid at', render: (r) => formatDateTime(r.paidAt) },
        { key: 'receiptNo', header: 'Receipt', render: (r) => r.receiptNo || '—' },
        {
            key: 'actions',
            header: 'Actions',
            render: (r) => (
                <div className="flex flex-wrap gap-1">
                    {r.paymentId && r.receiptNo && (
                        <Button variant="ghost" className="px-2 py-1" onClick={() => downloadReceipt(r)}>
                            Receipt
                        </Button>
                    )}
                    {r.status === 'paid' && r.paymentId && (
                        <Button variant="ghost" className="px-2 py-1 text-red-600" onClick={() => setRefundRow(r)}>
                            Refund
                        </Button>
                    )}
                    {r.course && ['unpaid', 'pending', 'failed', 'refunded'].includes(r.status) && (
                        <>
                            <Button variant="ghost" className="px-2 py-1" onClick={() => setManualRow(r)}>
                                Offline pay
                            </Button>
                            <Button variant="ghost" className="px-2 py-1" onClick={() => setWaiveRow(r)}>
                                Waive
                            </Button>
                        </>
                    )}
                </div>
            ),
        },
    ];

    return (
        <>
            <PageHeader title="Subscriptions" description="Payments, offline entries, waivers and refunds for one academic session.">
                <Button variant="secondary" onClick={toggleAttention}>
                    {attention ? 'Hide needs attention' : 'Needs attention'}
                </Button>
                <Button variant="secondary" onClick={exportExcel} loading={exporting} disabled={!sessionOk}>
                    Export Excel
                </Button>
            </PageHeader>

            {attention && (
                <Card className="mb-4">
                    <p className="mb-2 text-sm font-semibold text-slate-900">Payments that need attention</p>
                    {attention.length === 0 ? (
                        <p className="text-sm text-slate-500">Nothing needs attention right now.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full text-sm">
                                <thead className="text-left text-xs uppercase text-slate-500">
                                    <tr>
                                        <th className="py-2 pr-4">Student</th>
                                        <th className="py-2 pr-4">Amount</th>
                                        <th className="py-2 pr-4">Order ID</th>
                                        <th className="py-2 pr-4">Checks</th>
                                        <th className="py-2">Reason</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {attention.map((p) => (
                                        <tr key={p.id}>
                                            <td className="py-2 pr-4">
                                                {p.student?.name || '—'}
                                                <span className="block text-xs text-slate-500">{p.student?.enrollmentNo}</span>
                                            </td>
                                            <td className="py-2 pr-4">{formatINR(p.amount)}</td>
                                            <td className="py-2 pr-4 font-mono text-xs">{p.razorpayOrderId}</td>
                                            <td className="py-2 pr-4">{p.reconcileAttempts}</td>
                                            <td className="py-2 text-slate-600">{p.attentionReason}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>
            )}

            {s && (
                <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
                    <SummaryCard label="Students" value={s.totalStudents} />
                    <SummaryCard label="Paid" value={s.paid} />
                    <SummaryCard label="Waived" value={s.waived} />
                    <SummaryCard label="Unpaid" value={s.unpaid} />
                    <SummaryCard label="Pending" value={s.pending} />
                    <SummaryCard label="Refunded" value={s.refunded} />
                    <SummaryCard label="Collected" value={formatINR(s.totalCollected)} />
                    <SummaryCard label="Remaining" value={formatINR(s.totalRemaining)} />
                </div>
            )}

            <Card className="mb-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Session" htmlFor="f-session" error={!sessionOk ? 'Use the format 2025-26.' : ''}>
                        <Input id="f-session" value={filters.session} maxLength={7} onChange={setFilter('session')} />
                    </Field>
                    <Field label="Course" htmlFor="f-course">
                        <Select id="f-course" value={filters.course} onChange={setFilter('course')}>
                            <option value="">All courses</option>
                            {courses.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.shortName}
                                </option>
                            ))}
                        </Select>
                    </Field>
                    <Field label="Semester" htmlFor="f-sem">
                        <Select id="f-sem" value={filters.semester} onChange={setFilter('semester')}>
                            <option value="">All semesters</option>
                            {range(maxSems).map((n) => (
                                <option key={n} value={n}>
                                    Semester {n}
                                </option>
                            ))}
                        </Select>
                    </Field>
                    <Field label="Status" htmlFor="f-status">
                        <Select id="f-status" value={filters.status} onChange={setFilter('status')}>
                            <option value="">All statuses</option>
                            {['paid', 'unpaid', 'pending', 'failed', 'refunded', 'waived'].map((st) => (
                                <option key={st} value={st}>
                                    {st.charAt(0).toUpperCase() + st.slice(1)}
                                </option>
                            ))}
                        </Select>
                    </Field>
                    <Field label="Method" htmlFor="f-method">
                        <Select id="f-method" value={filters.method} onChange={setFilter('method')}>
                            <option value="">Any method</option>
                            <option value="razorpay">Razorpay</option>
                            <option value="cash">Cash</option>
                            <option value="dd">Demand Draft</option>
                            <option value="upi">UPI</option>
                            <option value="other">Other</option>
                        </Select>
                    </Field>
                    <Field label="Paid from" htmlFor="f-from">
                        <Input id="f-from" type="date" value={filters.from} onChange={setFilter('from')} />
                    </Field>
                    <Field label="Paid to" htmlFor="f-to">
                        <Input id="f-to" type="date" value={filters.to} onChange={setFilter('to')} />
                    </Field>
                    <Field label="Search" htmlFor="f-q">
                        <Input id="f-q" placeholder="Name, email, enrollment" value={filters.q} onChange={setFilter('q')} />
                    </Field>
                </div>
            </Card>

            <DataTable columns={columns} rows={data.items} rowKey="studentId" loading={loading} empty="No records for these filters." />
            <Pagination page={data.page || page} pages={data.pages} total={data.total} onChange={setPage} />

            <ManualModal row={manualRow} session={filters.session} onClose={() => setManualRow(null)} onDone={reload} />

            <ReasonModal
                open={Boolean(waiveRow)}
                title="Waive fee"
                description={waiveRow ? `${waiveRow.name}: the student will get full access for semester ${waiveRow.semester} without paying.` : ''}
                confirmLabel="Waive fee"
                onClose={() => setWaiveRow(null)}
                onSubmit={async (reason) => {
                    await api.payments.waive({ student: waiveRow.studentId, session: filters.session, semester: waiveRow.semester, reason });
                    toast.success('Fee waived.');
                    reload();
                }}
            />

            <ReasonModal
                open={Boolean(refundRow)}
                title="Refund payment"
                description={
                    refundRow
                        ? `${refundRow.name}: full refund of ${formatINR(refundRow.amount)}. The subscription becomes Refunded and the admit card is blocked immediately.`
                        : ''
                }
                confirmLabel="Refund"
                danger
                onClose={() => setRefundRow(null)}
                onSubmit={async (reason) => {
                    await api.payments.refund(refundRow.paymentId, { reason });
                    toast.success('Refund processed.');
                    reload();
                }}
            />
        </>
    );
}