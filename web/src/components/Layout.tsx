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
    <div className="roviq-shell">
      <header className="roviq-header">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Link to="/" className="roviq-brand">
              <span className="roviq-mark"><span>R</span></span>
              <span>ROVIQ</span>
            </Link>
            {principal && <Link to="/local" className="roviq-btn-secondary text-sm">Local map</Link>}
          </div>
          <div className="flex items-center gap-3">
            {principal && <span className="hidden text-xs text-[var(--roviq-muted)] sm:inline">Customer portal</span>}
            {principal && <button onClick={handleLogout} className="roviq-btn-secondary text-sm">Sign out</button>}
          </div>
        </div>
      </header>
      <main className="roviq-grid-glow mx-auto min-h-[calc(100vh-73px)] max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}
