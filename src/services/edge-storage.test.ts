import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEdgeObject, putEdgeObject } from './edge-storage.js';

afterEach(()=>{ vi.unstubAllEnvs(); });

describe('edge storage client',()=>{
  it('refuses to call out when EDGE_STORAGE_URL or EDGE_STORAGE_KEY is unset',async()=>{
    await expect(putEdgeObject('k',Buffer.from('x'),'image/jpeg')).rejects.toMatchObject({message:'edge_storage_not_configured',statusCode:503});
    await expect(getEdgeObject('k')).rejects.toMatchObject({message:'edge_storage_not_configured',statusCode:503});
  });

  it('PUTs the exact bytes with the shared secret and content type', async () => {
    vi.stubEnv('EDGE_STORAGE_URL','https://edge.example.com');
    vi.stubEnv('EDGE_STORAGE_KEY','secret-123');
    const fetcher=vi.fn(async ()=>new Response('{}',{status:200}));
    await putEdgeObject('dvi/abc/photo/1.jpeg',Buffer.from('hello'),'image/jpeg',fetcher as unknown as typeof fetch);
    const [url,init]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];
    expect(String(url)).toBe('https://edge.example.com/internal/storage/dvi%2Fabc%2Fphoto%2F1.jpeg');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string,string>)['x-edge-storage-key']).toBe('secret-123');
    expect((init.headers as Record<string,string>)['content-type']).toBe('image/jpeg');
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('hello');
  });

  it('raises a 502 when the storage service rejects the write',async()=>{
    vi.stubEnv('EDGE_STORAGE_URL','https://edge.example.com');
    vi.stubEnv('EDGE_STORAGE_KEY','secret-123');
    const fetcher=vi.fn(async ()=>new Response('nope',{status:500}));
    await expect(putEdgeObject('k',Buffer.from('x'),'image/jpeg',fetcher as unknown as typeof fetch))
      .rejects.toMatchObject({statusCode:502});
  });

  it('raises a 404 when the object is missing on read',async()=>{
    vi.stubEnv('EDGE_STORAGE_URL','https://edge.example.com');
    vi.stubEnv('EDGE_STORAGE_KEY','secret-123');
    const fetcher=vi.fn(async ()=>new Response(null,{status:404}));
    await expect(getEdgeObject('missing',fetcher as unknown as typeof fetch)).rejects.toMatchObject({message:'edge_storage_object_not_found',statusCode:404});
  });

  it('returns the bytes and content type on a successful read',async()=>{
    vi.stubEnv('EDGE_STORAGE_URL','https://edge.example.com');
    vi.stubEnv('EDGE_STORAGE_KEY','secret-123');
    const fetcher=vi.fn(async ()=>new Response(Buffer.from('hello'),{status:200,headers:{'content-type':'image/jpeg'}}));
    const result=await getEdgeObject('k',fetcher as unknown as typeof fetch);
    expect(result.buffer.toString()).toBe('hello');
    expect(result.contentType).toBe('image/jpeg');
  });
});
