import { describe, expect, it } from 'vitest';
import { registeredRouteModules } from './register-routes.js';

describe('HTTP route composition', () => {
  it('keeps domain modules explicit and non-empty', () => {
    const modules = registeredRouteModules();
    expect(modules.length).toBeGreaterThanOrEqual(8);
    expect(new Set(modules.map(module => module.name)).size).toBe(modules.length);
    expect(modules.every(module => module.routeCount > 0)).toBe(true);
  });

  it('keeps Shop OS isolated as an explicit module', () => {
    const shopOs = registeredRouteModules().find(module => module.name === 'shop-os');
    expect(shopOs).toEqual({ name:'shop-os', routeCount:3 });
  });
});
