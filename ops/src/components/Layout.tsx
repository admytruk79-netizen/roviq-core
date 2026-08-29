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
    `rounded-lg px-3 py-2 text-sm whitespace-nowrap transition ${location.pathname === path ? 'bg-white/8 text-[var(--roviq-green)]' : 'text-[var(--roviq-muted)] hover:text-white'}`;

  return (
    <div className="roviq-shell">
      <header className="roviq-header">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3 sm:gap-5">
              <Link to="/" className="roviq-brand shrink-0" aria-label="ROVIQ Operations home">
                <span className="roviq-mark"><span>R</span></span>
                <span className="hidden sm:inline">ROVIQ</span>
              </Link>
              <div className="hidden h-7 w-px bg-white/10 sm:block" />
              <span className="hidden text-xs font-bold uppercase tracking-[.18em] text-[var(--roviq-muted)] lg:inline">Operations</span>
            </div>
            {principal && <button onClick={handleLogout} className="roviq-btn-secondary shrink-0 text-sm">Sign out</button>}
          </div>
          <nav className="mt-3 flex max-w-full gap-1 overflow-x-auto pb-1 sm:mt-2 sm:justify-end" aria-label="Operations navigation">
            <Link to="/" className={navClass('/')}>Cases</Link>
            <Link to="/exceptions" className={navClass('/exceptions')}>Exceptions</Link>
            <Link to="/map" className={navClass('/map')}>Oversight map</Link>
          </nav>
        </div>
      </header>
      <main className="roviq-grid-glow mx-auto min-h-[calc(100vh-73px)] max-w-7xl px-4 py-7 sm:px-6 sm:py-9">
        <Outlet />
      </main>
    </div>
  );
}
