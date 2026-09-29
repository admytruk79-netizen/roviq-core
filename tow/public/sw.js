// Minimal service worker: exists only to receive Web Push while the tab is closed and to route
// notification clicks back into the app. No offline caching -- this is a live-data app (case
// status, dispatch state), so serving stale API responses from a cache would be actively wrong.
// Every URL resolves against this worker's scope: the Tow app is served both standalone at `/`
// and as the Tow tab of the Service app at `/tow/`.
const scoped = (path) => new URL(path, self.registration.scope).href;
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'ROVIQ update';
  const url = scoped(data.url || './');
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: scoped('favicon.svg'),
      badge: scoped('favicon.svg'),
      data: { url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : scoped('./');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Standalone Tow window: bring it to the notification's page.
      const standalone = clients.find((c) => c.frameType === 'top-level' && c.url.startsWith(self.registration.scope));
      if (standalone) return standalone.navigate(url).then((c) => (c || standalone).focus());
      // Tow tab inside the Service app: focus the Service app rather than replacing it.
      const embedded = clients.some((c) => c.frameType === 'nested' && c.url.startsWith(self.registration.scope));
      const shell = embedded && clients.find((c) => c.frameType === 'top-level' && c.url.startsWith(self.location.origin));
      if (shell) return shell.focus();
      return self.clients.openWindow(url);
    })
  );
});
