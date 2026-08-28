import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Layout() {
  const { principal, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-semibold tracking-tight">ROVIQ Ops</Link>
            <nav className="flex gap-4 text-sm text-slate-600">
              <Link to="/" className="hover:text-slate-900">Cases</Link>
              <Link to="/exceptions" className="hover:text-slate-900">Exceptions</Link>
            </nav>
          </div>
          {principal && (
            <button onClick={handleLogout} className="text-sm text-slate-500 hover:text-slate-800">
              Sign out
            </button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
