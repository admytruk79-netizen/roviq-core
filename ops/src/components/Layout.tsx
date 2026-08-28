import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Layout() {
  const { principal, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  const navClass = (path: string) =>
    `rounded-lg px-3 py-2 text-sm transition ${location.pathname === path ? 'bg-white/8 text-[var(--roviq-green)]' : 'text-[var(--roviq-muted)] hover:text-white'}`;

  return (
    <div className="roviq-shell">
      <header className="roviq-header">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-6">
            <Link to="/" className="roviq-brand shrink-0">
              <span className="roviq-mark"><span>R</span></span>
              <span className="hidden sm:inline">ROVIQ</span>
            </Link>
            <div className="hidden h-7 w-px bg-white/10 sm:block" />
            <span className="hidden text-xs font-bold uppercase tracking-[.18em] text-[var(--roviq-muted)] md:inline">Operations</span>
            <nav className="flex gap-1">
              <Link to="/" className={navClass('/')}>Cases</Link>
              <Link to="/exceptions" className={navClass('/exceptions')}>Exceptions</Link>
            </nav>
          </div>
          {principal && <button onClick={handleLogout} className="roviq-btn-secondary shrink-0 text-sm">Sign out</button>}
        </div>
      </header>
      <main className="roviq-grid-glow mx-auto min-h-[calc(100vh-73px)] max-w-7xl px-4 py-7 sm:px-6 sm:py-9">
        <Outlet />
      </main>
    </div>
  );
}
