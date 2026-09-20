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

export const api = {
  auth: {
    adminLogin: (body) => request('/auth/admin/login', { method: 'POST', body, skipRefresh: true }),
    lockStatus: (email) => request('/auth/admin/lock-status', { params: { email }, skipRefresh: true }),
    me: () => request('/auth/me'),
    logout: () => request('/auth/logout', { method: 'POST', body: {}, skipRefresh: true }),
  },
};