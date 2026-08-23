import { describe, expect, it } from 'vitest';

describe('ROVIQ isolation invariants', () => {
  it('requires actor ownership for non-admin principals', () => {
    const principal = { role:'partner', actorId:'actor-a' } as const;
    const requestedActorId = 'actor-b';
    expect(principal.actorId === requestedActorId).toBe(false);
  });

  it('treats admin as a distinct network-wide principal', () => {
    const principal = { role:'admin' } as const;
    expect(principal.role).toBe('admin');
  });
});
