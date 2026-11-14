import { describe, it, expect } from 'vitest';
import { getRoutePermission } from './routePermissions';

describe('routePermissions: /venue/* y /facilities', () => {
  const rutas = ['/venue/onboarding', '/venue/dashboard', '/venue/reservas', '/venue/cobros'];

  it.each(rutas)('%s es solo del dueño de espacios', (r) => {
    const p = getRoutePermission(r);
    expect(p?.allowedRoles).toEqual(['facility_manager']);
    for (const rol of ['athlete', 'parent', 'coach', 'wellness_professional', 'store_owner'] as const) {
      expect(p?.allowedRoles).not.toContain(rol);
    }
  });

  it('/facilities no admite athlete/parent/coach', () => {
    const p = getRoutePermission('/facilities');
    expect(p?.allowedRoles).toContain('facility_manager');
    for (const rol of ['athlete', 'parent', 'coach'] as const) expect(p?.allowedRoles).not.toContain(rol);
  });

  it('el dueño de espacios no entra a rutas de academia', () => {
    for (const r of ['/students', '/payments', '/enrollments']) {
      const p = getRoutePermission(r);
      if (p?.allowedRoles) expect(p.allowedRoles).not.toContain('facility_manager');
    }
  });
});
