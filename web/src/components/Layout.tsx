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
        <div className="roviq-header-inner mx-auto max-w-6xl px-4 sm:px-6">
          <Link to="/" className="roviq-brand" aria-label="ROVIQ customer home">
            <span className="roviq-mark"><span>R</span></span>
            <span>ROVIQ</span>
          </Link>
          {principal && (
            <nav className="roviq-customer-nav" aria-label="Customer navigation">
              <Link to="/" className="roviq-nav-link">My cases</Link>
              <Link to="/cases/new" className="roviq-nav-link roviq-nav-primary">Start service</Link>
              <button onClick={handleLogout} className="roviq-nav-link" type="button">Sign out</button>
            </nav>
          )}
        </div>
      </header>
      <main className="roviq-grid-glow mx-auto min-h-[calc(100vh-65px)] max-w-6xl px-4 py-5 sm:px-6 sm:py-9">
        <Outlet />
      </main>
    </div>
  );
}
