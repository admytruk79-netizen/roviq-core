import { useEffect } from 'react';
import { AuthProvider, useAuth } from './auth';
import { Dashboard } from './Dashboard';
import { LocalMap } from './LocalMap';
import { Login } from './Login';
import { ShopOsWorkspace } from './ShopOsWorkspace';
import { ShopOsDviControl } from './ShopOsDviControl';
import { ShopOsFloorControl } from './ShopOsFloorControl';
import { ShopOsScheduleControl } from './ShopOsScheduleControl';
import { ShopOsWaitlistControl } from './ShopOsWaitlistControl';
import { ShopOsRecoveryControl } from './ShopOsRecoveryControl';
import { ShopOsDeferredServiceControl } from './ShopOsDeferredServiceControl';

function Portal() {
  const { principal } = useAuth();

  useEffect(() => {
    if (!principal) return;
    history.replaceState({ ...history.state, roviqRoot: true }, '');
    history.pushState({ roviqGuard: true }, '');
    let exiting = false;
    const onBack = () => {
      if (exiting) return;
      const backEvent = new Event('roviq:back', { cancelable: true });
      window.dispatchEvent(backEvent);
      if (backEvent.defaultPrevented) {
        history.pushState({ roviqGuard: true }, '');
        return;
      }
      exiting = true;
      history.back();
    };
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, [principal]);

  return principal ? (
    <Dashboard>
      <section className="mt-8" aria-labelledby="shop-os-heading">
        <div className="mb-4">
          <p className="kicker">Operations workspace</p>
          <h2 id="shop-os-heading" className="mt-1 text-2xl font-bold">Run today’s service work</h2>
          <p className="muted mt-1 max-w-2xl text-sm">Move from coordinated demand to repair execution without leaving the partner workspace.</p>
        </div>
        <ShopOsScheduleControl />
        <ShopOsWorkspace />
        <ShopOsRecoveryControl />
        <ShopOsWaitlistControl />
        <ShopOsDviControl />
        <ShopOsFloorControl />
        <ShopOsDeferredServiceControl />
      </section>
      <LocalMap />
    </Dashboard>
  ) : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <Portal />
    </AuthProvider>
  );
}
