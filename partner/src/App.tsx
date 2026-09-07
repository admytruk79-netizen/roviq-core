import { useEffect } from 'react';
import { AuthProvider, useAuth } from './auth';
import { Dashboard } from './Dashboard';
import { LocalMap } from './LocalMap';
import { Login } from './Login';
import { ShopOsWorkspace } from './ShopOsWorkspace';
import { ShopOsDviControl } from './ShopOsDviControl';
import { ShopOsFloorControl } from './ShopOsFloorControl';

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

  return principal ? <><Dashboard /><div className="shell"><main className="mx-auto max-w-7xl px-4 pb-10 sm:px-6"><ShopOsWorkspace /><ShopOsDviControl /><ShopOsFloorControl /></main></div><LocalMap /></> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <Portal />
    </AuthProvider>
  );
}
