import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { Button, Card, FullPageLoader, PageHeader, formatINR, useAuth, useToast } from '../../components/ui.jsx';

const APP_NAME = import.meta.env.VITE_APP_NAME || 'College Portal';

function loadRazorpay() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error('Could not load the payment window. Please check your internet connection.'));
    document.body.appendChild(script);
    return undefined;
  });
}

const MESSAGE_STYLES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warn: 'border-yellow-200 bg-yellow-50 text-yellow-800',
  info: 'border-blue-200 bg-blue-50 text-blue-800',
};

export default function Pay() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { type, text }
  const [waiting, setWaiting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api.payments.myPlan();
      setState({ loading: false, data, error: '' });
      return data;
    } catch (err) {
      setState({ loading: false, data: null, error: err.message });
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Already paid or waived: nothing to pay here.
  useEffect(() => {
    if (state.data?.subscription) navigate('/student', { replace: true });
  }, [state.data, navigate]);

  // After a payment that could not be confirmed instantly, keep checking for up to 2 minutes.
  useEffect(() => {
    if (!waiting) return undefined;
    let tries = 0;
    const id = setInterval(async () => {
      tries += 1;
      const data = await refresh();
      if (data?.subscription || tries >= 24) {
        clearInterval(id);
        setWaiting(false);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [waiting, refresh]);

  const plan = state.data?.plan;
  const latest = state.data?.latestPayment;
  const verifying = waiting || latest?.status === 'pending';

  const pay = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await loadRazorpay();
      const res = await api.payments.createOrder();
      const { order, student } = res;

      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.id,
        name: APP_NAME,
        description: plan?.name || 'Semester fees',
        prefill: { name: student.name, email: student.email },
        theme: { color: '#4f46e5' },
        handler: async (response) => {
          try {
            await api.payments.verify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            toast.success('Payment successful.');
            await refresh();
          } catch {
            // Money may have been deducted; the webhook or reconcile job will confirm it.
            setMessage({ type: 'warn', text: 'Verifying payment, please do not pay again.' });
            setWaiting(true);
          } finally {
            setBusy(false);
          }
        },
        modal: {
          ondismiss: () => setBusy(false),
        },
      });
      checkout.on('payment.failed', (r) => {
        setMessage({ type: 'error', text: r?.error?.description || 'Payment failed. Please try again.' });
        setBusy(false);
      });
      checkout.open();
    } catch (err) {
      if (err.code === 'ALREADY_PAID') {
        await refresh();
      } else {
        setMessage({ type: 'error', text: err.message });
      }
      setBusy(false);
    }
  };

  if (state.loading) return <FullPageLoader />;

  return (
    <>
      <PageHeader title="Complete your payment" description="Pay the semester fee to unlock your portal and admit cards." />

      {state.error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{state.error}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="mb-3 text-sm font-semibold text-slate-900">Your profile</p>
          <dl className="divide-y divide-slate-100 text-sm">
            {[
              ['Name', user?.name],
              ['Email', user?.email],
              ['Enrollment No.', user?.enrollmentNo],
              ['Roll No.', user?.rollNo],
              ['Course', user?.course?.shortName],
              ['Year / Semester', user ? `Year ${user.year} / Semester ${user.semester}` : ''],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 py-2">
                <dt className="text-slate-500">{label}</dt>
                <dd className="text-right font-medium text-slate-900">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <p className="mb-3 text-sm font-semibold text-slate-900">Fee details</p>
          {plan ? (
            <>
              <p className="text-sm text-slate-600">{plan.name}</p>
              <p className="mt-1 text-3xl font-bold text-slate-900">{formatINR(plan.amount)}</p>
              <p className="mt-1 text-xs text-slate-500">
                Session {plan.session} · Semester {plan.semester}
              </p>

              {verifying && (
                <div className={`mt-4 rounded-lg border p-3 text-sm ${MESSAGE_STYLES.warn}`}>Verifying payment, please do not pay again.</div>
              )}
              {!verifying && latest?.status === 'failed' && !message && (
                <div className={`mt-4 rounded-lg border p-3 text-sm ${MESSAGE_STYLES.error}`}>
                  Your last payment did not go through{latest.failureReason ? `: ${latest.failureReason}` : '.'} You can try again.
                </div>
              )}
              {message && <div className={`mt-4 rounded-lg border p-3 text-sm ${MESSAGE_STYLES[message.type]}`}>{message.text}</div>}

              <Button className="mt-4 w-full" onClick={pay} loading={busy} disabled={verifying}>
                {latest?.status === 'failed' || message?.type === 'error' ? 'Retry payment' : `Pay ${formatINR(plan.amount)}`}
              </Button>
              <p className="mt-2 text-center text-xs text-slate-500">Secure payment by Razorpay. The amount is fixed by the college.</p>
            </>
          ) : (
            <p className="text-sm text-slate-600">No fee plan is available for your course and semester yet. Please contact the college admin.</p>
          )}
        </Card>
      </div>
    </>
  );
}