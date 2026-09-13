import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const waitlistUi=readFileSync(new URL('../../partner/src/ShopOsWaitlistControl.tsx',import.meta.url),'utf8');
const route=readFileSync(new URL('../http/routes/shop-os-deferred-appointment-choices.ts',import.meta.url),'utf8');
const deferredChoices=readFileSync(new URL('./shop-os-deferred-appointment-choices.ts',import.meta.url),'utf8');

describe('waitlist and deferred appointment choice invariants',()=>{
  it('loads waitlist choices from the dedicated server-authoritative endpoint',()=>{
    expect(route).toContain("/api/shop-os/waitlist/:entryId/appointment-choices");
    expect(waitlistUi).toContain("/api/shop-os/waitlist/${entry.id}/appointment-choices");
    expect(waitlistUi).not.toContain('/api/shop-os/board');
  });

  it('mirrors the current deferred booking category compatibility contract',()=>{
    expect(deferredChoices).toContain('l.service_category is null or a.service_category is null or l.service_category=a.service_category');
  });
});
