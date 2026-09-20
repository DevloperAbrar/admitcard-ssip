import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import {
  Button,
  Card,
  DataTable,
  Input,
  PageHeader,
  Pagination,
  Select,
  formatDateTime,
  useDebounce,
  useToast,
} from '../../components/ui.jsx';

export default function AuditLogs() {
  const toast = useToast();
  const [f, setF] = useState({ action: '', q: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], actions: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const dq = useDebounce(f.q);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.master.auditLogs({ action: f.action, q: dq, from: f.from, to: f.to, page, limit: 25 }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [f.action, f.from, f.to, dq, page, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (e) => {
    const value = e.target.value;
    setF((x) => ({ ...x, [key]: value }));
    setPage(1);
  };

  const columns = [
    { key: 'time', header: 'Time', render: (l) => <span className="whitespace-nowrap">{formatDateTime(l.createdAt)}</span> },
    { key: 'action', header: 'Action', render: (l) => <span className="font-mono text-xs font-medium text-slate-900">{l.action}</span> },
    { key: 'actor', header: 'Actor', render: (l) => l.actor },
    { key: 'ip', header: 'IP', render: (l) => l.ip || '—' },
    { key: 'entity', header: 'Entity', render: (l) => (l.entity ? `${l.entity} ${l.entityId ? `· ${String(l.entityId).slice(-6)}` : ''}` : '—') },
    {
      key: 'details',
      header: 'Details',
      render: (l) =>
        l.details ? (
          <details className="max-w-xs">
            <summary className="cursor-pointer text-xs text-indigo-600">View</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">{JSON.stringify(l.details, null, 2)}</pre>
          </details>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <>
      <PageHeader title="Audit Logs" description="Logins, imports, edits, payments, publishing and downloads." />
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Select value={f.action} onChange={set('action')}>
            <option value="">All actions</option>
            {data.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Input placeholder="Search actor / id" value={f.q} onChange={set('q')} />
          <Input type="date" value={f.from} onChange={set('from')} aria-label="From date" />
          <Input type="date" value={f.to} onChange={set('to')} aria-label="To date" />
          <Button
            variant="secondary"
            onClick={() => {
              setF({ action: '', q: '', from: '', to: '' });
              setPage(1);
            }}
          >
            Reset
          </Button>
        </div>
      </Card>
      <DataTable columns={columns} rows={data.items} loading={loading} empty="No log entries." />
      <Pagination page={data.page || page} pages={data.pages} total={data.total} onChange={setPage} />
    </>
  );
}