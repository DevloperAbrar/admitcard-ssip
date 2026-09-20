import {
    createContext,
    forwardRef,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
  } from 'react';
  import { createPortal } from 'react-dom';
  import { NavLink, Outlet, useNavigate } from 'react-router-dom';
  import { api } from '../api.js';
  
  const APP_NAME = import.meta.env.VITE_APP_NAME || 'College Portal';
  
  export const cn = (...classes) => classes.filter(Boolean).join(' ');
  
  /* ------------------------------ Toast ------------------------------ */
  const ToastContext = createContext(null);
  
  const TOAST_STYLES = {
    success: 'border-green-200 bg-green-50 text-green-800',
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-slate-200 bg-white text-slate-800',
  };
  
  export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    const counter = useRef(0);
  
    const remove = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);
    const push = useCallback(
      (type, message) => {
        counter.current += 1;
        const id = counter.current;
        setToasts((list) => [...list.slice(-3), { id, type, message }]);
        setTimeout(() => remove(id), 4500);
      },
      [remove]
    );
  
    const toast = useMemo(
      () => ({
        success: (m) => push('success', m),
        error: (m) => push('error', m),
        info: (m) => push('info', m),
      }),
      [push]
    );
  
    return (
      <ToastContext.Provider value={toast}>
        {children}
        <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={cn('pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg', TOAST_STYLES[t.type])}
            >
              {t.message}
            </div>
          ))}
        </div>
      </ToastContext.Provider>
    );
  }
  
  export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used inside ToastProvider');
    return ctx;
  }
  
  /* ------------------------------ Auth ------------------------------ */
  const AuthContext = createContext(null);
  
  export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
  
    useEffect(() => {
      let alive = true;
      api.auth
        .me()
        .then((res) => alive && setUser(res.user))
        .catch(() => alive && setUser(null))
        .finally(() => alive && setLoading(false));
  
      const onExpired = () => setUser(null);
      window.addEventListener('auth:expired', onExpired);
      return () => {
        alive = false;
        window.removeEventListener('auth:expired', onExpired);
      };
    }, []);
  
    const logout = useCallback(async () => {
      try {
        await api.auth.logout();
      } catch {
        /* cookies are cleared server-side; ignore network errors here */
      }
      setUser(null);
    }, []);
  
    const value = useMemo(() => ({ user, loading, setUser, logout }), [user, loading, logout]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
  }
  
  export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
    return ctx;
  }
  
  /* ------------------------------ Basic parts ------------------------------ */
  export function Spinner({ className = 'h-5 w-5' }) {
    return (
      <svg className={cn('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
      </svg>
    );
  }
  
  export function FullPageLoader() {
    return (
      <div className="flex h-full items-center justify-center text-indigo-600">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  
  const BUTTON_VARIANTS = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-500',
    secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500',
    ghost: 'text-slate-600 hover:bg-slate-100 focus-visible:ring-slate-400',
  };
  
  export function Button({ variant = 'primary', loading = false, disabled, className, children, type = 'button', ...rest }) {
    return (
      <button
        type={type}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
          BUTTON_VARIANTS[variant],
          className
        )}
        {...rest}
      >
        {loading && <Spinner className="h-4 w-4" />}
        {children}
      </button>
    );
  }
  
  export function Field({ label, htmlFor, error, hint, children }) {
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
            {label}
          </label>
        )}
        {children}
        {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  
  const inputClass =
    'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-slate-100';
  
  export const Input = forwardRef(function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(inputClass, className)} {...rest} />;
  });
  
  export const Select = forwardRef(function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(inputClass, className)} {...rest}>
        {children}
      </select>
    );
  });
  
  export function Card({ className, children }) {
    return <div className={cn('rounded-xl border border-slate-200 bg-white p-5 shadow-sm', className)}>{children}</div>;
  }
  
  const BADGE_STYLES = {
    green: 'bg-green-100 text-green-800',
    red: 'bg-red-100 text-red-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    blue: 'bg-blue-100 text-blue-800',
    gray: 'bg-slate-100 text-slate-700',
  };
  
  export function Badge({ color = 'gray', children }) {
    return (
      <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', BADGE_STYLES[color])}>
        {children}
      </span>
    );
  }
  
  export function PageHeader({ title, description, children }) {
    return (
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        {children && <div className="flex flex-wrap gap-2">{children}</div>}
      </div>
    );
  }
  
  export function Modal({ open, onClose, title, children, footer, size = 'md' }) {
    useEffect(() => {
      if (!open) return undefined;
      const onKey = (e) => e.key === 'Escape' && onClose?.();
      document.addEventListener('keydown', onKey);
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.removeEventListener('keydown', onKey);
        document.body.style.overflow = previous;
      };
    }, [open, onClose]);
  
    if (!open) return null;
    const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' }[size];
  
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} aria-hidden="true" />
        <div role="dialog" aria-modal="true" aria-label={title} className={cn('relative max-h-[90vh] w-full overflow-y-auto rounded-xl bg-white shadow-xl', width)}>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            <button type="button" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
              ✕
            </button>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</div>}
        </div>
      </div>,
      document.body
    );
  }
  
  /* ------------------------------ Layout ------------------------------ */
  const ADMIN_NAV = [
    { to: '/admin', label: 'Home', end: true },
    { to: '/admin/students', label: 'Students' },
    { to: '/admin/subscriptions', label: 'Subscriptions' },
    { to: '/admin/plans', label: 'Plans & Courses' },
    { to: '/admin/admit-cards', label: 'Admit Cards' },
    { to: '/admin/audit-logs', label: 'Audit Logs' },
  ];
  
  const STUDENT_NAV = [
    { to: '/student', label: 'Dashboard', end: true },
    { to: '/student/subscription', label: 'Subscription & Receipts' },
    { to: '/student/admit-cards', label: 'Admit Card' },
  ];
  
  function Shell({ subtitle, nav }) {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
  
    const onLogout = async () => {
      await logout();
      navigate('/login', { replace: true });
    };
  
    return (
      <div className="flex h-full">
        {open && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
  
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:static lg:translate-x-0',
            open ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          <div className="border-b border-slate-200 px-5 py-4">
            <p className="text-base font-semibold text-slate-900">{APP_NAME}</p>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto p-3">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'block rounded-lg px-3 py-2 text-sm font-medium transition',
                    isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>
  
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
            <button type="button" className="rounded p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
              ☰
            </button>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-sm text-slate-600 sm:inline">{user?.email}</span>
              <Button variant="secondary" onClick={onLogout}>
                Logout
              </Button>
            </div>
          </header>
          <main className="flex-1 overflow-y-auto p-4 sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    );
  }
  
  export const AdminLayout = () => <Shell subtitle="Admin Panel" nav={ADMIN_NAV} />;
  export const StudentLayout = () => <Shell subtitle="Student Portal" nav={STUDENT_NAV} />;