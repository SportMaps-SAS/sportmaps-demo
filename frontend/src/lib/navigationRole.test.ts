import { describe, expect, it } from 'vitest';
import { roleForNavigation } from './navigationRole';

describe('roleForNavigation', () => {
  it("una membresía 'admin' de club NO se ve como admin de plataforma", () => {
    expect(roleForNavigation('athlete', 'admin')).toBe('school_admin');
    expect(roleForNavigation('school', 'admin')).toBe('school_admin');
  });
  it('el admin de plataforma (perfil) siempre gana, tenga o no membresía', () => {
    expect(roleForNavigation('admin', 'admin')).toBe('admin');
    expect(roleForNavigation('super_admin', 'owner')).toBe('super_admin');
    expect(roleForNavigation('admin', null)).toBe('admin');
  });
  it('personal_trainer del perfil gana a la membresía', () => {
    expect(roleForNavigation('personal_trainer', 'coach')).toBe('personal_trainer');
  });
  it('facility_manager del perfil gana a la membresía owner de su escuela-venue', () => {
    expect(roleForNavigation('facility_manager', 'owner')).toBe('facility_manager');
    expect(roleForNavigation('facility_manager', null)).toBe('facility_manager');
  });
  it('los demás roles de membresía se respetan', () => {
    expect(roleForNavigation('athlete', 'owner')).toBe('owner');
    expect(roleForNavigation('athlete', 'coach')).toBe('coach');
    expect(roleForNavigation('athlete', 'school_admin')).toBe('school_admin');
  });
  it('sin membresía vale el rol del perfil', () => {
    expect(roleForNavigation('parent', null)).toBe('parent');
    expect(roleForNavigation(undefined, undefined)).toBeUndefined();
  });
});
