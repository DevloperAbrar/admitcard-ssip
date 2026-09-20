import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Spinner } from '../components/ui.jsx';

const APP_NAME = import.meta.env.VITE_APP_NAME || 'College Portal';

export default function Verify() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  useEffect(() => {
    let alive = true;
    api.admitCards
      .verify(token)
      .then((data) => alive && setState({ loading: false, data, error: '' }))
      .catch((err) =>
        alive &&
        setState({
          loading: false,
          data: null,
          error: err.status === 404 ? 'No admit card was found for this QR code.' : err.message,
        })
      );
    return () => {
      alive = false;
    };
  }, [token]);

  const { loading, data, error } = state;
  const valid = data?.valid;

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-center text-sm font-medium text-slate-500">{APP_NAME}</p>
        <h1 className="mt-1 text-center text-lg font-semibold text-slate-900">Admit Card Verification</h1>

        {loading && (
          <div className="mt-8 flex justify-center text-indigo-600">
            <Spinner className="h-8 w-8" />
          </div>
        )}

        {!loading && error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-800" role="alert">
            {error}
          </div>
        )}

        {!loading && data && (
          <>
            <div
              className={`mt-6 rounded-lg border p-4 text-center ${
                valid ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              <p className="text-2xl font-bold">{valid ? '✔ Valid' : '✖ Revoked'}</p>
              <p className="mt-1 text-xs">
                {valid ? 'This admit card is genuine and active.' : 'This admit card is no longer valid.'}
              </p>
            </div>

            <dl className="mt-5 divide-y divide-slate-100 text-sm">
              {[
                ['Name', data.card.name],
                ['Enrollment No.', data.card.enrollmentNo],
                ['Course', data.card.course],
                ['Semester', data.card.semester],
                ['Examination', data.card.examName],
                ['Academic Session', data.card.session],
                ['Card No.', data.card.cardNo],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 py-2">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-right font-medium text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}