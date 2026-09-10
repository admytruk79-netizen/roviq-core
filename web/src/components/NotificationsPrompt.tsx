import { useEffect, useState } from 'react';
import { isPushSupported, subscribeToPush } from '../lib/push';

const DISMISSED_KEY = 'roviq_push_dismissed';

export function NotificationsPrompt() {
  const [visible, setVisible] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!isPushSupported()) return;
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      const existing = await registration?.pushManager.getSubscription().catch(() => null);
      if (existing || cancelled) return;
      // Permission was already granted (e.g. a returning session whose subscription lapsed) --
      // consent already exists, so re-subscribe silently instead of asking again.
      if (Notification.permission === 'granted') {
        await subscribeToPush().catch(() => {});
        return;
      }
      if (Notification.permission === 'default' && !localStorage.getItem(DISMISSED_KEY)) setVisible(true);
    }
    void check();
    return () => { cancelled = true; };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1');
    setVisible(false);
  }

  async function enable() {
    setSubscribing(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        dismiss();
        return;
      }
      await subscribeToPush();
      setVisible(false);
    } catch {
      setError('Could not enable notifications on this device. Please try again.');
    } finally {
      setSubscribing(false);
    }
  }

  if (!visible) return null;

  return (
    <div className="roviq-panel roviq-notify-banner" role="region" aria-label="Enable notifications">
      <div>
        <p className="roviq-kicker">Stay in the loop</p>
        <p className="roviq-muted">Get a notification the moment your case status changes.</p>
        {error && <p className="roviq-muted" role="alert">{error}</p>}
      </div>
      <div className="roviq-notify-banner-actions">
        <button type="button" className="roviq-btn-secondary" onClick={dismiss} disabled={subscribing}>Not now</button>
        <button type="button" className="roviq-btn-primary" onClick={() => void enable()} disabled={subscribing}>
          {subscribing ? 'Enabling…' : 'Enable notifications'}
        </button>
      </div>
    </div>
  );
}
