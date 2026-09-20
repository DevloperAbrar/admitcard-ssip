import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { Button, Field, Input, useAuth } from '../components/ui.jsx';

const APP_NAME = import.meta.env.VITE_APP_NAME || 'College Portal';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const pad = (n) => String(n).padStart(2, '0');
function formatCountdown(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function Login() {
  const { user, setUser } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpRequired, setOtpRequired] = useState(false);
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
    if (otpRequired && !/^\d{6}$/.test(otp.trim())) return setError('Enter the 6-digit authentication code.');

    setSubmitting(true);
    try {
      const body = { email: normEmail, password };
      if (otpRequired) body.otp = otp.trim();
      const res = await api.auth.adminLogin(body);
      if (res.otpRequired) {
        setOtpRequired(true);
        return;
      }
      setUser(res.user);
    } catch (err) {
      if (err.code === 'LOGIN_LOCKED') {
        startLock(normEmail, err.data?.retryAfterSec || 900);
      } else if (err.code === 'INVALID_CREDENTIALS') {
        const left = err.data?.attemptsLeft;
        setError(
          typeof left === 'number' ? `${err.message} ${left} attempt(s) left before this login is locked.` : err.message
        );
        if (otpRequired) setOtp('');
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

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-slate-900">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-slate-500">Admin login</p>
        </div>

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
                setOtpRequired(false);
                setOtp('');
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
                  setOtpRequired(false);
                  setOtp('');
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

          {otpRequired && (
            <Field label="Authentication code" htmlFor="otp" hint="Open Google Authenticator and enter the 6-digit code.">
              <Input
                id="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                disabled={submitting}
                autoFocus
              />
            </Field>
          )}

          <Button type="submit" className="w-full" loading={submitting} disabled={locked}>
            {otpRequired ? 'Verify and log in' : 'Log in'}
          </Button>
        </form>
      </div>
    </div>
  );
}