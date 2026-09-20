import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { cn, useAuth } from '../components/ui.jsx';
import collegeBg from '../assets/college-bg.jpg';

const APP_NAME = import.meta.env.VITE_APP_NAME || 'Shri Sahaj Institute of Pharmacy';
const SHORT_NAME = import.meta.env.VITE_SHORT_NAME || 'SSIP Khargone';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad = (n) => String(n).padStart(2, '0');
function countdown(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${pad(m)}:${pad(s)}`;
}

/* ── Shared input style ── */
const inputCls =
  'w-full rounded-lg border border-white/20 bg-white/10 px-4 py-3 text-sm text-white placeholder-white/40 outline-none backdrop-blur-sm transition focus:border-amber-400 focus:bg-white/15 focus:ring-2 focus:ring-amber-400/30 disabled:opacity-50';

/* ── Student Panel ── */
function StudentPanel({ onUser }) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [lock, setLock] = useState(null);
  const [now, setNow] = useState(Date.now());

  const norm = email.trim().toLowerCase();
  const remaining = lock?.email === norm ? Math.max(0, Math.ceil((lock.until - now) / 1000)) : 0;
  const locked = remaining > 0;

  useEffect(() => {
    if (!lock) return;
    const id = setInterval(() => {
      const t = Date.now(); setNow(t);
      if (t >= lock.until) setLock(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lock]);

  const submit = async (e) => {
    e.preventDefault();
    if (locked || submitting) return;
    setError('');
    if (!EMAIL_RE.test(norm)) return setError('Enter a valid email address.');
    setSubmitting(true);
    try {
      const res = await api.auth.studentLogin(norm);
      onUser(res.user);
    } catch (err) {
      if (err.code === 'LOGIN_LOCKED') {
        const t = Date.now(); setNow(t);
        setLock({ email: norm, until: t + (err.data?.retryAfterSec || 900) * 1000 });
      } else setError(err.message);
    } finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {locked && (
        <div className="rounded-lg border border-red-400/40 bg-red-900/30 p-3 text-center text-sm text-red-200">
          Too many attempts. Try again in <span className="font-mono font-bold">{countdown(remaining)}</span>
        </div>
      )}
      {!locked && error && (
        <div className="rounded-lg border border-red-400/40 bg-red-900/30 px-4 py-3 text-sm text-red-200">{error}</div>
      )}
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-widest text-white/60">
          College Email Address
        </label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting || locked}
          placeholder="you@ssipkhargone.ac.in"
          className={inputCls}
        />
      </div>
      <button
        type="submit"
        disabled={submitting || locked}
        className="w-full rounded-lg bg-amber-500 px-4 py-3 text-sm font-bold text-white shadow-lg transition hover:bg-amber-400 active:scale-[.98] disabled:opacity-60"
      >
        {submitting ? 'Signing in…' : 'Sign In to Portal'}
      </button>
      <p className="text-center text-xs text-white/40">
        Use your registered college email address
      </p>
    </form>
  );
}

/* ── Admin Panel ── */
function AdminPanel({ onUser }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [lock, setLock] = useState(null);
  const [now, setNow] = useState(Date.now());

  const norm = email.trim().toLowerCase();
  const remaining = lock?.email === norm ? Math.max(0, Math.ceil((lock.until - now) / 1000)) : 0;
  const locked = remaining > 0;

  useEffect(() => {
    if (!lock) return;
    const id = setInterval(() => {
      const t = Date.now(); setNow(t);
      if (t >= lock.until) setLock(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lock]);

  const checkLock = async () => {
    if (!EMAIL_RE.test(norm) || lock?.email === norm) return;
    try {
      const r = await api.auth.lockStatus(norm);
      if (r.locked) { const t = Date.now(); setNow(t); setLock({ email: norm, until: t + r.retryAfterSec * 1000 }); }
    } catch { /* non-blocking */ }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (locked || submitting) return;
    setError('');
    if (!EMAIL_RE.test(norm)) return setError('Enter a valid email address.');
    if (!password) return setError('Enter your password.');
    setSubmitting(true);
    try {
      const res = await api.auth.adminLogin({ email: norm, password });
      onUser(res.user);
    } catch (err) {
      if (err.code === 'LOGIN_LOCKED') {
        const t = Date.now(); setNow(t);
        setLock({ email: norm, until: t + (err.data?.retryAfterSec || 900) * 1000 });
      } else {
        const left = err.data?.attemptsLeft;
        setError(typeof left === 'number' ? `${err.message} ${left} attempt(s) left.` : err.message);
      }
    } finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {locked && (
        <div className="rounded-lg border border-red-400/40 bg-red-900/30 p-3 text-center text-sm text-red-200">
          Too many attempts. Try again in <span className="font-mono font-bold">{countdown(remaining)}</span>
        </div>
      )}
      {!locked && error && (
        <div className="rounded-lg border border-red-400/40 bg-red-900/30 px-4 py-3 text-sm text-red-200">{error}</div>
      )}
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-widest text-white/60">Email</label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={checkLock}
          disabled={submitting || locked}
          placeholder="admin@ssipkhargone.ac.in"
          className={inputCls}
        />
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-widest text-white/60">Password</label>
        <div className="relative">
          <input
            type={showPass ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting || locked}
            className={cn(inputCls, 'pr-16')}
          />
          <button
            type="button"
            onClick={() => setShowPass(v => !v)}
            className="absolute inset-y-0 right-0 px-4 text-xs font-semibold text-white/50 hover:text-amber-400"
          >
            {showPass ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <button
        type="submit"
        disabled={submitting || locked}
        className="w-full rounded-lg bg-amber-500 px-4 py-3 text-sm font-bold text-white shadow-lg transition hover:bg-amber-400 active:scale-[.98] disabled:opacity-60"
      >
        {submitting ? 'Signing in…' : 'Sign In as Admin'}
      </button>
    </form>
  );
}

/* ── Main Login Page ── */
export default function Login() {
  const { user, setUser } = useAuth();
  const location = useLocation();
  const [tab, setTab] = useState('student');

  if (user?.role === 'admin') {
    const from = location.state?.from;
    return <Navigate to={typeof from === 'string' && from.startsWith('/admin') ? from : '/admin'} replace />;
  }
  if (user?.role === 'student') return <Navigate to="/student" replace />;

  return (
    <div className="relative flex min-h-screen items-stretch">

      {/* ── Background image with dark overlay ── */}
      <div className="absolute inset-0 z-0">
        <img
          src={collegeBg}
          alt=""
          className="h-full w-full object-cover object-center"
        />
        {/* dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/70 to-black/50" />
        {/* subtle green tint at bottom matching college colors */}
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-green-950/60 to-transparent" />
      </div>

      {/* ── Left side — College info ── */}
      <div className="relative z-10 hidden flex-col justify-between p-12 lg:flex lg:w-1/2">
        {/* Logo placeholder + name */}
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/20 backdrop-blur-sm border border-amber-400/30">
              <svg className="h-6 w-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 3.74-3.342" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">PCI & RGPV Approved</p>
            </div>
          </div>
        </div>

        {/* Main heading */}
        <div className="space-y-6">
          <div>
            <h1 className="text-4xl font-bold leading-tight text-white">
              Shri Sahaj Institute<br />
              <span className="text-amber-400">of Pharmacy</span>
            </h1>
            <p className="mt-2 text-lg font-medium text-white/60">Khargone, Madhya Pradesh</p>
          </div>

          <p className="max-w-sm text-sm leading-relaxed text-white/50">
            Student admit card & fee management portal. Access your exam hall tickets, payment receipts and semester information.
          </p>

          {/* Stats */}
          <div className="flex gap-8">
            {[
              { num: '1000+', label: 'Students' },
              { num: '7+', label: 'Years' },
              { num: '50+', label: 'Faculty' },
            ].map(({ num, label }) => (
              <div key={label}>
                <p className="text-2xl font-bold text-amber-400">{num}</p>
                <p className="text-xs text-white/50">{label}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-white/30">
          © {new Date().getFullYear()} Shri Sahaj Institute of Pharmacy, Khargone
        </p>
      </div>

      {/* ── Right side — Login card ── */}
      <div className="relative z-10 flex w-full items-center justify-center p-6 lg:w-1/2">
        <div className="w-full max-w-md">

          {/* Card */}
          <div className="rounded-2xl border border-white/10 bg-white/10 p-8 shadow-2xl backdrop-blur-md">

            {/* Mobile header */}
            <div className="mb-6 lg:hidden">
              <h1 className="text-xl font-bold text-white">{APP_NAME}</h1>
              <p className="text-sm text-white/50">{SHORT_NAME}</p>
            </div>

            {/* Desktop heading */}
            <div className="mb-6 hidden lg:block">
              <h2 className="text-xl font-bold text-white">Welcome back</h2>
              <p className="mt-1 text-sm text-white/50">Sign in to your portal account</p>
            </div>

            {/* Tabs */}
            <div className="mb-6 flex rounded-xl border border-white/10 bg-white/5 p-1">
              {[['student', '🎓 Student'], ['admin', '⚙️ Admin']].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={cn(
                    'flex-1 rounded-lg py-2.5 text-sm font-semibold transition',
                    tab === key
                      ? 'bg-amber-500 text-white shadow-sm'
                      : 'text-white/50 hover:text-white/80'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Panel */}
            {tab === 'student' ? <StudentPanel onUser={setUser} /> : <AdminPanel onUser={setUser} />}

            {/* Divider */}
            <div className="mt-6 border-t border-white/10 pt-4">
              <p className="text-center text-xs text-white/30">
                🔒 Secured portal · For queries contact college office
              </p>
            </div>
          </div>

          {/* Bottom badges */}
          <div className="mt-4 flex items-center justify-center gap-4">
            {['PCI Approved', 'RGPV Affiliated', 'MP Government'].map((b) => (
              <span key={b} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/40 backdrop-blur-sm">
                {b}
              </span>
            ))}
          </div>

          {/* Developer credit */}
          <div className="mt-5 text-center">
            <p className="text-xs text-white/25 mb-1">Designed & Developed by</p>
            <div className="flex items-center justify-center gap-2 flex-wrap">

              <a href="https://campussafar.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold text-amber-400/70 hover:text-amber-400 transition-colors duration-200"
              >
                CampusSafar Technologies Pvt. Ltd.
              </a>
              <span className="text-white/20 text-xs">·</span>

              <a href="https://i2s.campussafar.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-white/35 hover:text-white/60 transition-colors duration-200"
              >
                idea2software
              </a>
            </div>
          </div>

        </div>
      </div >
    </div >
  );
}