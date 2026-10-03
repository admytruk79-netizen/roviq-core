import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type TouchEvent } from 'react';
import { isTabSignOut, lastTab, rememberTab, restoreSession, signIn, signInMessage, signOut, workspaceFor, type Role, type ServiceSession } from './session';
import roviqLogo from './brand/roviq-lockup-dark.svg';
import roviqMark from './brand/roviq-mark-dark.svg';

const SWIPE_MIN_PX = 60;

function SignIn({ onSignedIn, notice }: { onSignedIn: (session: ServiceSession) => void; notice: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'home' | 'sign-in'>('home');
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onSignedIn(await signIn(email.trim(), password));
    } catch (err) {
      setError(signInMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar guest-topbar">
        <div className="topbar-row">
          <p className="brand"><img className="roviq-logo" src={roviqLogo} alt="ROVIQ" /><img className="roviq-logo-mark" src={roviqMark} alt="ROVIQ" /></p>
          <nav className="guest-nav" aria-label="Public navigation">
            <button type="button" aria-current={view === 'home' ? 'page' : undefined} onClick={() => setView('home')}>Home</button>
            <button type="button" className={view === 'sign-in' ? 'guest-nav-action active' : 'guest-nav-action'} aria-current={view === 'sign-in' ? 'page' : undefined} onClick={() => setView('sign-in')}>Sign in</button>
          </nav>
        </div>
      </header>
      {view === 'home' ? (
        <main id="main-content" className="guest-home">
          <div className="guest-content">
            <div className="guest-copy">
              <p className="eyebrow">One ROVIQ app</p>
              <h1>Your service, connected.</h1>
              <p>Book and follow a request as a customer. Coordinate diagnostics, towing, repairs, parts and mobility as a team. Your account opens the right workspace after sign in.</p>
              <button type="button" className="primary" onClick={() => setView('sign-in')}>Sign in to continue <span aria-hidden="true">→</span></button>
              <p className="guest-note">No account? Contact your ROVIQ team for access.</p>
            </div>
            <div className="guest-preview" aria-label="How ROVIQ works">
              <p className="preview-label">A connected service flow</p>
              <ol>
                <li><span className="preview-number">01</span><span><strong>Request</strong><small>Start and track service</small></span></li>
                <li><span className="preview-number">02</span><span><strong>Coordinate</strong><small>Route work to the right team</small></span></li>
                <li><span className="preview-number">03</span><span><strong>Resolve</strong><small>Keep everyone informed</small></span></li>
              </ol>
              <p className="preview-foot">Workspaces appear according to your account access.</p>
            </div>
          </div>
        </main>
      ) : (
        <main id="main-content" className="signin">
          <form className="signin-card" onSubmit={submit} aria-busy={busy}>
            <h1>Sign in to ROVIQ</h1>
            <p className="hint">Your account opens only the tabs you are allowed to use.</p>
            {notice && <p className="notice" role="status">{notice}</p>}
            <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label>Password<span className="password-row"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /><button type="button" className="password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide' : 'Show'}</button></span></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Open my workspaces'}</button>
          </form>
        </main>
      )}
    </div>
  );
}

function Workspaces({ session, onSignOut }: { session: ServiceSession; onSignOut: (notice?: string) => void }) {
  const [active, setActive] = useState<Role>(() => lastTab(session));
  // Frames mount on first visit and then stay mounted, so switching tabs keeps each tab's place.
  const [opened, setOpened] = useState<Role[]>(() => [lastTab(session)]);
  const tabRefs = useRef<Partial<Record<Role, HTMLButtonElement | null>>>({});
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  function open(role: Role, focus = false) {
    setActive(role);
    setOpened((current) => (current.includes(role) ? current : [...current, role]));
    rememberTab(role);
    tabRefs.current[role]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus) tabRefs.current[role]?.focus();
  }

  function step(delta: number, focus = false) {
    const index = session.roles.indexOf(active);
    const next = session.roles[(index + delta + session.roles.length) % session.roles.length];
    open(next, focus);
  }

  function onTabKey(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') { event.preventDefault(); step(1, true); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1, true); }
    else if (event.key === 'Home') { event.preventDefault(); open(session.roles[0], true); }
    else if (event.key === 'End') { event.preventDefault(); open(session.roles[session.roles.length - 1], true); }
  }

  function onTouchStart(event: TouchEvent) {
    const t = event.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  }

  function onTouchEnd(event: TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || session.roles.length < 2) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - start.x;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(t.clientY - start.y) * 1.5) step(dx < 0 ? 1 : -1);
  }

  useEffect(() => {
    // A tab whose sign-in expires or is revoked clears its token; sign out of every tab together
    // rather than leaving the others signed in behind a tab that shows its own login screen.
    const onStorage = (event: StorageEvent) => {
      if (isTabSignOut(event, session)) onSignOut('You were signed out. Sign in again to continue.');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [session, onSignOut]);

  const single = session.roles.length === 1;

  return (
    <div className="shell">
      <header className="topbar" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="topbar-row">
          <p className="brand"><img className="roviq-logo" src={roviqLogo} alt="ROVIQ" /><img className="roviq-logo-mark" src={roviqMark} alt="ROVIQ" /><span>Core</span></p>
          <span className="account-label" title={session.email}>{session.email}</span>
          {session.testMode && <span className="test-badge" title="Customer and service workspaces use admin test accounts">Test mode</span>}
          <button type="button" className="signout" onClick={() => onSignOut()}>Sign out</button>
        </div>
        {!single && (
          <div className="tabs" role="tablist" aria-label="Your workspaces" onKeyDown={onTabKey}>
            {session.roles.map((role) => (
              <button
                key={role}
                ref={(el) => { tabRefs.current[role] = el; }}
                type="button"
                role="tab"
                id={`tab-${role}`}
                aria-selected={role === active}
                aria-controls={`panel-${role}`}
                tabIndex={role === active ? 0 : -1}
                className={role === active ? 'tab active' : 'tab'}
                onClick={() => open(role)}
              >
                {workspaceFor(role).label}
              </button>
            ))}
          </div>
        )}
      </header>
      <main id="main-content" className="panels">
        {opened.map((role) => {
          const workspace = workspaceFor(role);
          return (
            <section
              key={role}
              id={`panel-${role}`}
              role={single ? undefined : 'tabpanel'}
              aria-labelledby={single ? undefined : `tab-${role}`}
              className="panel"
              hidden={role !== active}
            >
              <iframe title={`${workspace.label} workspace`} src={`${import.meta.env.BASE_URL}${workspace.path}`} allow="geolocation; camera" />
            </section>
          );
        })}
      </main>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<ServiceSession | null>(restoreSession);
  const [notice, setNotice] = useState('');

  const handleSignOut = useCallback((message?: string) => {
    signOut();
    setSession(null);
    setNotice(message ?? '');
  }, []);

  if (!session) return <SignIn notice={notice} onSignedIn={(s) => { setNotice(''); setSession(s); }} />;
  return <Workspaces session={session} onSignOut={handleSignOut} />;
}
