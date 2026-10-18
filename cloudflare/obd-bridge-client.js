export function createObdBridgeClient(bridge, { timeoutMs = 150000 } = {}) {
  const pending = new Map();
  let closed = false;
  const onmessage = event => {
    if (typeof event.data !== 'string' || event.data.length > 65536) return;
    let response;
    try { response = JSON.parse(event.data); } catch { return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error)); else request.resolve(response);
  };
  bridge.onmessage = onmessage;
  function request(action, address) {
    if (closed) return Promise.reject(new Error('scanner_client_closed'));
    if (!['list', 'scan'].includes(action)) return Promise.reject(new Error('scanner_action_not_allowed'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        try { bridge.postMessage(JSON.stringify({ id: crypto.randomUUID(), action: 'cancel' })); } catch {}
        reject(new Error('scanner_timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { bridge.postMessage(JSON.stringify({ id, action, address })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function cancel() {
    try { bridge.postMessage(JSON.stringify({ id: crypto.randomUUID(), action: 'cancel' })); } catch {}
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('scanner_cancelled')); }
    pending.clear();
  }
  return { request, cancel, dispose() { cancel(); closed = true; if (bridge.onmessage === onmessage) bridge.onmessage = null; } };
}
