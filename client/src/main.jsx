import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import './index.css';
import {
  AdminLayout,
  AuthProvider,
  Card,
  FullPageLoader,
  PageHeader,
  ToastProvider,
  useAuth,
} from './components/ui.jsx';
import Login from './pages/Login.jsx';

const homeFor = (role) => (role === 'admin' ? '/admin' : '/student');

function RequireRole({ role }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  return <Outlet />;
}

function AdminHome() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="Admin Panel" description="Login, session and security are working." />
      <Card>
        <p className="text-sm text-slate-700">
          Logged in as <span className="font-medium">{user?.email}</span>.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Students, plans, payments and admit cards will be enabled in the next build steps.
        </p>
      </Card>
    </>
  );
}

function ComingSoon() {
  return (
    <>
      <PageHeader title="Not built yet" />
      <Card>
        <p className="text-sm text-slate-600">This section will be added in a later build step.</p>
      </Card>
    </>
  );
}

function NotFound() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-slate-500">Page not found.</p>
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route path="/admin" element={<RequireRole role="admin" />}>
        <Route element={<AdminLayout />}>
          <Route index element={<AdminHome />} />
          <Route path="*" element={<ComingSoon />} />
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>
);