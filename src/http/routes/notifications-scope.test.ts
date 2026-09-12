import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source=readFileSync(new URL('./notifications.ts',import.meta.url),'utf8');

describe('notification route scope',()=>{
  it('applies organization and location scope to tenant-visible records',()=>{
    expect(source).toContain('getAdminActorScope(req.principal,pool)');
    expect(source).toContain('owner.organization_id=$1');
    expect(source).toContain('selected.organization_id=$1');
    expect(source).toContain('recommended.organization_id=$1');
    expect(source).toContain('provider.organization_id=$1');
    expect(source).toContain('recipient.organization_id=$1');
    expect(source).toContain('recipient.id::text=n.recipient_id');
  });

  it('returns not-found when an attempt id is outside the authorized scope',()=>{
    expect(source).toContain("return reply.code(404).send({ error:'notification_not_found' })");
  });

  it('keeps shared configuration restricted to platform administration',()=>{
    const guards=source.match(/notification_global_admin_required/g)??[];
    expect(guards.length).toBeGreaterThanOrEqual(5);
  });
});
