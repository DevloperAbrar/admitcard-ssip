import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import './index.css';
import {
  AdminLayout,
  AuthProvider,
  Card,
  FullPageLoader,
  PageHeader,
  StudentLayout,
  ToastProvider,
  useAuth,
} from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Verify from './pages/Verify.jsx';
import Students from './pages/admin/Students.jsx';
import Subscriptions from './pages/admin/Subscriptions.jsx';
import Plans from './pages/admin/Plans.jsx';
import AdmitCards from './pages/admin/AdmitCards.jsx';
import AdmitCardBuilder from './pages/admin/AdmitCardBuilder.jsx';
import AuditLogs from './pages/admin/AuditLogs.jsx';
import Pay from './pages/student/Pay.jsx';
import { StudentAdmitCards, StudentDashboard, StudentGate, StudentSubscription } from './pages/student/Portal.jsx';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const homeFor = (role) => (role === 'admin' ? '/admin' : '/student');

function RequireRole({ role }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  return <Outlet />;
}

const QUICK_LINKS = [
  { to: '/admin/students', title: 'Students', text: 'Add, import (CSV), filter and export students.' },
  { to: '/admin/plans', title: 'Plans & Courses', text: 'Manage courses and fee plans.' },
  { to: '/admin/subscriptions', title: 'Subscriptions', text: 'Payments, refunds, offline entries and waivers.' },
  { to: '/admin/admit-cards', title: 'Admit Cards', text: 'Create exam sessions, publish and download cards.' },
  { to: '/admin/audit-logs', title: 'Audit Logs', text: 'Review every important action.' },
];

function AdminHome() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader title="Admin Panel" description={`Logged in as ${user?.email}`} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {QUICK_LINKS.map((l) => (
          <Link key={l.to} to={l.to}>
            <Card className="h-full transition hover:border-indigo-300 hover:shadow">
              <p className="font-medium text-slate-900">{l.title}</p>
              <p className="mt-1 text-sm text-slate-500">{l.text}</p>
            </Card>
          </Link>
        ))}
      </div>
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
      <Route path="/verify/:token" element={<Verify />} />

      <Route path="/admin" element={<RequireRole role="admin" />}>
        <Route element={<AdminLayout />}>
          <Route index element={<AdminHome />} />
          <Route path="students" element={<Students />} />
          <Route path="subscriptions" element={<Subscriptions />} />
          <Route path="plans" element={<Plans />} />
          <Route path="admit-cards" element={<AdmitCards />} />
          <Route path="admit-cards/new" element={<AdmitCardBuilder />} />
          <Route path="admit-cards/:id/edit" element={<AdmitCardBuilder />} />
          <Route path="admit-cards/:id" element={<AdmitCards />} />
          <Route path="audit-logs" element={<AuditLogs />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>

      <Route path="/student" element={<RequireRole role="student" />}>
        <Route element={<StudentLayout />}>
          <Route path="pay" element={<Pay />} />
          <Route element={<StudentGate />}>
            <Route index element={<StudentDashboard />} />
            <Route path="subscription" element={<StudentSubscription />} />
            <Route path="admit-cards" element={<StudentAdmitCards />} />
          </Route>
          <Route path="*" element={<Navigate to="/student" replace />} />
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const tree = (
  <BrowserRouter>
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  </BrowserRouter>
);

createRoot(document.getElementById('root')).render(
  <StrictMode>{GOOGLE_CLIENT_ID ? <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>{tree}</GoogleOAuthProvider> : tree}</StrictMode>
);