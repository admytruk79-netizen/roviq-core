import { useEffect, useState } from 'react';
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
import { ShopOsRepairOrderDetailControl } from './ShopOsRepairOrderDetailControl';
import { CoreCaseQueue } from './CoreCaseQueue';
import { NetworkSharingControl } from './NetworkSharingControl';
import { ShopOsTakingsControl } from './ShopOsTakingsControl';

const TABS = [['today', 'Today'], ['schedule', 'Schedule'], ['orders', 'Repair orders'], ['floor', 'Repair floor'], ['takings', 'Takings'], ['network', 'ROVIQ network']] as const;
type Tab = (typeof TABS)[number][0];
const TAB_KEY = 'roviq_shop_os_tab';

function savedTab(): Tab {
  try { const t = localStorage.getItem(TAB_KEY); if (TABS.some(([id]) => id === t)) return t as Tab; } catch { /* storage unavailable */ }
  return 'today';
}

function Portal() {
  const { principal } = useAuth();
  const [tab, setTab] = useState<Tab>(savedTab);
  const [openOffers, setOpenOffers] = useState(0);
  function chooseTab(next: Tab) {
    setTab(next);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* storage unavailable */ }
    window.scrollTo({ top: 0 });
  }

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
    <Dashboard showNetwork={tab === 'network'} onOpenOffers={setOpenOffers}>
      <nav className="shop-tabs mt-6" role="tablist" aria-label="Shop OS sections">
        {TABS.map(([id, label]) => (
          <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls="shop-tab-panel"
            className={tab === id ? 'shop-tab active' : 'shop-tab'} onClick={() => chooseTab(id)}>{label}{id === 'network' && openOffers > 0 && <span className="shop-tab-badge" aria-label={`${openOffers} new offer${openOffers === 1 ? '' : 's'}`}>{openOffers}</span>}</button>
        ))}
      </nav>
      <div id="shop-tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'today' && <><ShopOsWorkspace /><ShopOsRecoveryControl /><ShopOsWaitlistControl /></>}
        {tab === 'schedule' && <ShopOsScheduleControl />}
        {tab === 'orders' && <><ShopOsRepairOrderDetailControl /><ShopOsDeferredServiceControl /></>}
        {tab === 'floor' && <><ShopOsFloorControl /><ShopOsDviControl /></>}
        {tab === 'takings' && <ShopOsTakingsControl />}
        {tab === 'network' && <><CoreCaseQueue /><NetworkSharingControl /><LocalMap /></>}
      </div>
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
