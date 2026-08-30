import { useEffect } from 'react';
import { AuthProvider, useAuth } from './auth';
import { Dashboard } from './Dashboard';
import { LocalMap } from './LocalMap';
import { Login } from './Login';

function Portal() {
  const { principal } = useAuth();

  useEffect(() => {
    if (!principal) return;
    history.replaceState({ ...history.state, roviqRoot: true }, '');
    history.pushState({ roviqGuard: true }, '');
    const onBack = () => {
      history.pushState({ roviqGuard: true }, '');
      window.dispatchEvent(new Event('roviq:back'));
    };
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, [principal]);

  return principal ? <><Dashboard /><LocalMap /></> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <Portal />
    </AuthProvider>
  );
}
