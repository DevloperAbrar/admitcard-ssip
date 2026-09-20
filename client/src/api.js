const BASE = '/api';

export class ApiError extends Error {
  constructor(message, status = 0, code = 'ERROR', data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// Only one refresh call runs at a time, even if many requests fail together.
let refreshing = null;
function refreshSession() {
  if (!refreshing) {
    refreshing = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

function buildUrl(path, params) {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });
  }
  return url.pathname + url.search;
}

function filenameFrom(res) {
  const header = res.headers.get('content-disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function request(
  path,
  { method = 'GET', body, params, blob = false, skipRefresh = false, signal } = {}
) {
  const init = { method, credentials: 'same-origin', headers: {}, signal };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(buildUrl(path, params), init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server. Please check your connection.', 0, 'NETWORK_ERROR');
  }

  if (res.status === 401 && !skipRefresh) {
    if (await refreshSession()) {
      return request(path, { method, body, params, blob, skipRefresh: true, signal });
    }
    window.dispatchEvent(new Event('auth:expired'));
  }

  if (blob && res.ok) {
    return { blob: await res.blob(), filename: filenameFrom(res) };
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError(
      data?.message || `Request failed (${res.status})`,
      res.status,
      data?.code || 'ERROR',
      data
    );
  }
  return data;
}

const post = (path, body = {}) => request(path, { method: 'POST', body });
const put = (path, body) => request(path, { method: 'PUT', body });

export const api = {
  auth: {
    adminLogin: (body) => request('/auth/admin/login', { method: 'POST', body, skipRefresh: true }),
    lockStatus: (email) => request('/auth/admin/lock-status', { params: { email }, skipRefresh: true }),
    studentLogin: (email) => request('/auth/student/login', { method: 'POST', body: { email }, skipRefresh: true }),
    googleLogin: (credential) => request('/auth/student/google', { method: 'POST', body: { credential }, skipRefresh: true }),
    me: () => request('/auth/me'),
    logout: () => request('/auth/logout', { method: 'POST', body: {}, skipRefresh: true }),
  },

  master: {
    courses: () => request('/master/courses'),
    createCourse: (body) => post('/master/courses', body),
    updateCourse: (id, body) => put(`/master/courses/${id}`, body),
    deleteCourse: (id) => request(`/master/courses/${id}`, { method: 'DELETE' }),
    plans: (params) => request('/master/plans', { params }),
    createPlan: (body) => post('/master/plans', body),
    updatePlan: (id, body) => put(`/master/plans/${id}`, body),
    deletePlan: (id) => request(`/master/plans/${id}`, { method: 'DELETE' }),
    auditLogs: (params) => request('/master/audit-logs', { params }),
  },

  students: {
    list: (params) => request('/students', { params }),
    create: (body) => post('/students', body),
    update: (id, body) => put(`/students/${id}`, body),
    setStatus: (id, status) => request(`/students/${id}/status`, { method: 'PATCH', body: { status } }),
    remove: (id) => request(`/students/${id}`, { method: 'DELETE' }),
    exportXlsx: (params) => request('/students/export', { params, blob: true }),
    sampleCsv: () => request('/students/sample-csv', { blob: true }),
    importPreview: (formData) => request('/students/import/preview', { method: 'POST', body: formData }),
    importConfirm: (body) => post('/students/import/confirm', body),
    importJob: (id) => request(`/students/import/jobs/${id}`),
    importErrors: (id) => request(`/students/import/jobs/${id}/errors`, { blob: true }),
    promote: (body) => post('/students/promote', body),
  },

  payments: {
    myPlan: () => request('/payments/my-plan'),
    myPayments: () => request('/payments/my'),
    createOrder: () => post('/payments/order'),
    verify: (body) => post('/payments/verify', body),
    subscriptions: (params) => request('/payments/subscriptions', { params }),
    exportSubscriptions: (params) => request('/payments/subscriptions/export', { params, blob: true }),
    needsAttention: () => request('/payments/subscriptions/needs-attention'),
    manual: (body) => post('/payments/manual', body),
    waive: (body) => post('/payments/waive', body),
    refund: (id, body) => post(`/payments/${id}/refund`, body),
    receipt: (id, mode = 'download') => request(`/payments/${id}/receipt`, { params: { mode }, blob: true }),
  },

  admitCards: {
    defaults: () => request('/admit-cards/defaults'),
    sessions: (params) => request('/admit-cards/sessions', { params }),
    session: (id) => request(`/admit-cards/sessions/${id}`),
    createSession: (body) => post('/admit-cards/sessions', body),
    updateSession: (id, body) => put(`/admit-cards/sessions/${id}`, body),
    deleteSession: (id) => request(`/admit-cards/sessions/${id}`, { method: 'DELETE' }),
    preview: (body) => request('/admit-cards/preview', { method: 'POST', body, blob: true }),
    publish: (id) => post(`/admit-cards/sessions/${id}/publish`),
    unpublish: (id) => post(`/admit-cards/sessions/${id}/unpublish`),
    sync: (id) => post(`/admit-cards/sessions/${id}/sync`),
    cohort: (id, params) => request(`/admit-cards/sessions/${id}/cohort`, { params }),
    cardPdf: (cardId, mode = 'preview') => request(`/admit-cards/cards/${cardId}/pdf`, { params: { mode }, blob: true }),
    startBulk: (id) => post(`/admit-cards/sessions/${id}/bulk`),
    bulkJob: (jobId) => request(`/admit-cards/bulk-jobs/${jobId}`),
    bulkDownload: (jobId) => request(`/admit-cards/bulk-jobs/${jobId}/download`, { blob: true }),
    my: () => request('/admit-cards/my'),
    myPdf: (cardId, mode = 'preview') => request(`/admit-cards/my/${cardId}/pdf`, { params: { mode }, blob: true }),
    verify: (token) => request(`/admit-cards/verify/${token}`, { skipRefresh: true }),
  },
};