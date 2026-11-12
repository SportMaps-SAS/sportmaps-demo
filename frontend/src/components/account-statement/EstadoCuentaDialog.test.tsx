import { describe, it, expect, vi } from 'vitest';
import { parametrosEstadoCuenta } from './estadoCuentaModel';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

const base = { child_id: null, adult_id: null, unregistered_athlete_id: null, name: 'Sofía Herrera' };

describe('parametrosEstadoCuenta', () => {
  it('un hijo va por child_id', () => {
    expect(parametrosEstadoCuenta({ ...base, child_id: 'h1' })).toBe('child_id=h1');
  });
  it('un adulto con cuenta va por user_id', () => {
    expect(parametrosEstadoCuenta({ ...base, adult_id: 'u1' })).toBe('user_id=u1');
  });
  it('una ficha sin cuenta va por unregistered_athlete_id', () => {
    expect(parametrosEstadoCuenta({ ...base, unregistered_athlete_id: 'f1' })).toBe('unregistered_athlete_id=f1');
  });
  it('si hay varios ids gana el hijo (el mismo orden que usa la pantalla)', () => {
    expect(parametrosEstadoCuenta({ ...base, child_id: 'h1', adult_id: 'u1', unregistered_athlete_id: 'f1' })).toBe('child_id=h1');
  });
});
