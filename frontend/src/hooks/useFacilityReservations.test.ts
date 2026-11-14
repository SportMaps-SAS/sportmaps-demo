import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({}) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: () => undefined }) }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: {} }));

import { expandOccupiedSlots, friendlyReservationError, friendlyCancelError } from './useFacilityReservations';

describe('expandOccupiedSlots', () => {
  it('bloquea todas las franjas del rango [inicio, fin)', () => {
    expect(expandOccupiedSlots('08:00:00', '10:00:00')).toEqual(['08:00', '09:00']);
  });
  it('acepta HH:mm y horas sin cero inicial', () => {
    expect(expandOccupiedSlots('8:00', '9:00')).toEqual(['08:00']);
  });
  it('un rango invertido ocupa al menos la hora de inicio', () => {
    expect(expandOccupiedSlots('10:00', '10:00')).toEqual(['10:00']);
  });
});

describe('errores amigables', () => {
  it('traduce facility_slot_conflict', () => {
    expect(friendlyReservationError(new Error('facility_slot_conflict'))).toMatch(/ya está ocupado/);
  });
  it('409 al cancelar sin mensaje útil da explicación', () => {
    expect(friendlyCancelError({ status: 409, message: 'Error 409' })).toMatch(/ventana de cancelación/);
  });
});

describe('errores de las rutas nuevas (códigos del BFF)', () => {
  it('SLOT_TAKEN y MINOR_CANNOT_BOOK se traducen en friendlyReservationError', () => {
    expect(friendlyReservationError({ status: 409, message: 'SLOT_TAKEN', body: { error: 'SLOT_TAKEN' } })).toMatch(/otra reserva/);
    expect(friendlyReservationError({ status: 403, message: 'MINOR_CANNOT_BOOK', body: { error: 'MINOR_CANNOT_BOOK' } }))
      .toBe('Los menores no pueden reservar; pídele a tu acudiente.');
  });
  it('cancelar fuera de plazo con código muestra el texto del código', () => {
    expect(friendlyCancelError({ status: 409, message: 'CANCELLATION_WINDOW_CLOSED', body: { error: 'CANCELLATION_WINDOW_CLOSED' } })).toMatch(/plazo para cancelar/);
  });
});
