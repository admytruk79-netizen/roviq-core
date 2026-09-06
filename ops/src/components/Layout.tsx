import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Layout() {
  const { principal, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  const navClass = (path: string) =>
    `rounded-lg px-3 py-2 text-sm whitespace-nowrap transition ${location.pathname === path ? 'bg-white/8 text-[var(--roviq-green)]' : 'text-[var(--roviq-muted)] hover:text-white'}`;

  return (
    <div className="roviq-shell">
      <header className="roviq-header">
        <div className="mx-auto max-w-7xl px-4 py-2.5 sm:px-6 sm:py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Link to="/" className="roviq-brand shrink-0" aria-label="ROVIQ Operations home">
                <span className="roviq-mark"><span>R</span></span>
                <span className="hidden sm:inline">ROVIQ</span>
              </Link>
              <span className="text-xs font-bold uppercase tracking-[.16em] text-[var(--roviq-muted)]">Ops</span>
            </div>
            <div className="flex items-center gap-2">
              <nav className="hidden items-center gap-1 sm:flex" aria-label="Operations navigation">
                <Link to="/" className={navClass('/')}>Cases</Link>
                <Link to="/exceptions" className={navClass('/exceptions')}>Exceptions</Link>
                <Link to="/map" className={navClass('/map')}>Map</Link>
              </nav>
              <details className="relative sm:hidden">
                <summary className="roviq-btn-secondary cursor-pointer list-none text-sm">More</summary>
                <nav className="absolute right-0 top-11 z-50 grid min-w-40 gap-1 rounded-xl border border-white/10 bg-[var(--roviq-navy)] p-2 shadow-2xl" aria-label="Operations navigation">
                  <Link to="/" className={navClass('/')}>Cases</Link>
                  <Link to="/exceptions" className={navClass('/exceptions')}>Exceptions</Link>
                  <Link to="/map" className={navClass('/map')}>Map</Link>
                </nav>
              </details>
              {principal && <button onClick={handleLogout} className="roviq-btn-secondary shrink-0 text-sm">Sign out</button>}
            </div>
          </div>
        </div>
      </header>
      <main className="roviq-grid-glow mx-auto min-h-[calc(100vh-60px)] max-w-7xl px-4 py-5 sm:px-6 sm:py-7">
        <Outlet />
      </main>
    </div>
  );
}
