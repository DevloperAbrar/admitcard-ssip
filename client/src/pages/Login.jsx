import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google';
import { api } from '../api.js';
import { Button, Field, Input, cn, useAuth } from '../components/ui.jsx';

const APP_NAME = import.meta.env.VITE_APP_NAME || 'College Portal';
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad = (n) => String(n).padStart(2, '0');
function formatCountdown(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function StudentLogin({ onUser }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!GOOGLE_CLIENT_ID) {
    return <p className="text-sm text-red-600">Google login is not configured. Set VITE_GOOGLE_CLIENT_ID in client/.env.</p>;
  }

  const onSuccess = async (response) => {
    if (!response?.credential) return setError('Google sign-in failed. Please try again.');
    setBusy(true);
    setError('');
    try {
      const res = await api.auth.googleLogin(response.credential);
      onUser(res.user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}
      <p className="text-center text-sm text-slate-600">Sign in with the Google account registered with your college.</p>
      <div className={cn('flex justify-center', busy && 'pointer-events-none opacity-60')}>
        <GoogleLogin onSuccess={onSuccess} onError={() => setError('Google sign-in was cancelled or failed.')} />
      </div>
    </div>
  );
}

export default function Login() {
  const { user, setUser } = useAuth();
  const location = useLocation();

  const [tab, setTab] = useState('student');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [lock, setLock] = useState(null); // { email, until }
  const [now, setNow] = useState(Date.now());

  const normEmail = email.trim().toLowerCase();
  const remainingSec = lock && lock.email === normEmail ? Math.max(0, Math.ceil((lock.until - now) / 1000)) : 0;
  const locked = remainingSec > 0;

  useEffect(() => {
    if (!lock) return undefined;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lock.until) setLock(null);
    }, 1000);
    return () => clearInterval(id);
  }, [lock]);

  const startLock = (forEmail, seconds) => {
    const t = Date.now();
    setNow(t);
    setLock({ email: forEmail, until: t + seconds * 1000 });
  };

  const checkLock = async () => {
    if (!EMAIL_RE.test(normEmail) || (lock && lock.email === normEmail)) return;
    try {
      const res = await api.auth.lockStatus(normEmail);
      if (res.locked) startLock(normEmail, res.retryAfterSec);
    } catch {
      /* non-blocking: the login request itself will report a lock */
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (locked || submitting) return;
    setError('');

    if (!EMAIL_RE.test(normEmail)) return setError('Enter a valid email address.');
    if (!password) return setError('Enter your password.');

    setSubmitting(true);
    try {
      const res = await api.auth.adminLogin({ email: normEmail, password });
      setUser(res.user);
    } catch (err) {
      if (err.code === 'LOGIN_LOCKED') {
        startLock(normEmail, err.data?.retryAfterSec || 900);
      } else if (err.code === 'INVALID_CREDENTIALS') {
        const left = err.data?.attemptsLeft;
        setError(
          typeof left === 'number' ? `${err.message} ${left} attempt(s) left before this login is locked.` : err.message
        );
      } else {
        setError(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (user?.role === 'admin') {
    const from = location.state?.from;
    return <Navigate to={typeof from === 'string' && from.startsWith('/admin') ? from : '/admin'} replace />;
  }
  if (user?.role === 'student') return <Navigate to="/student" replace />;

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-slate-900">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to continue</p>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-200 p-1 text-sm font-medium">
          {[
            ['student', 'Student'],
            ['admin', 'Admin'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn('rounded-md py-1.5 transition', tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600')}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'student' ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <StudentLogin onUser={setUser} />
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            {locked && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center" role="alert">
                <p className="text-sm text-red-800">Too many failed attempts. Try again in</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-red-700">{formatCountdown(remainingSec)}</p>
              </div>
            )}

            {!locked && error && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
                {error}
              </div>
            )}

            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                onBlur={checkLock}
                disabled={submitting}
                placeholder="admin@example.com"
              />
            </Field>

            <Field label="Password" htmlFor="password">
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                  disabled={submitting}
                  className="pr-16"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-slate-500 hover:text-slate-700"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </Field>

            <Button type="submit" className="w-full" loading={submitting} disabled={locked}>
              Log in
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}