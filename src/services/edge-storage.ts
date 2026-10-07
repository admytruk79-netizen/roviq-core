// Core has no direct R2 credentials -- only the Cloudflare Worker has the R2 binding. Core
// authorizes every read/write (case/org/location scope) and then asks the Worker to move the
// bytes, over a path the Worker never proxies to Render (see cloudflare/worker.js's
// `/internal/storage/` handler), authenticated by a shared secret only Core and the Worker know.

function httpError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function endpoint(key: string) {
  const base = process.env.EDGE_STORAGE_URL;
  if (!base) throw httpError('edge_storage_not_configured', 503);
  return new URL(`/internal/storage/${encodeURIComponent(key)}`, base);
}

export async function putEdgeObject(
  key: string, body: Buffer, contentType: string | null | undefined, fetcher: typeof fetch = fetch
): Promise<void> {
  const secret = process.env.EDGE_STORAGE_KEY;
  if (!secret) throw httpError('edge_storage_not_configured', 503);
  const res = await fetcher(endpoint(key), {
    method: 'PUT',
    headers: { 'x-edge-storage-key': secret, 'content-type': contentType || 'application/octet-stream' },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw httpError(`edge_storage_put_failed:${res.status}`, 502);
}

export async function getEdgeObject(
  key: string, fetcher: typeof fetch = fetch
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const secret = process.env.EDGE_STORAGE_KEY;
  if (!secret) throw httpError('edge_storage_not_configured', 503);
  const res = await fetcher(endpoint(key), {
    method: 'GET',
    headers: { 'x-edge-storage-key': secret },
    signal: AbortSignal.timeout(30000)
  });
  if (res.status === 404) throw httpError('edge_storage_object_not_found', 404);
  if (!res.ok) throw httpError(`edge_storage_get_failed:${res.status}`, 502);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: res.headers.get('content-type') };
}
