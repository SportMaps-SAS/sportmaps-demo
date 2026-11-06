import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeJoinCode, isJoinCodeShape, formatJoinCode, buildJoinUrl, buildJoinWhatsAppText,
  validateJoinRequestForm, adultChildWarning, ageOn,
  buildPorAsignarInbox, buildEnrollPayload,
  savePendingJoinCode, readPendingJoinCode, clearPendingJoinCode, PENDING_JOIN_CODE_KEY,
  joinErrorMessage,
  type JoinRequestRow,
} from './schoolJoinCode';

describe('normalizeJoinCode / formato', () => {
  it('quita guiones y espacios y pasa a mayúsculas', () => {
    expect(normalizeJoinCode(' bes-4k7q ')).toBe('BES4K7Q');
    expect(normalizeJoinCode('BES 4K7Q')).toBe('BES4K7Q');
  });

  it('en el prefijo un 0 es O y un 1 es I (el sufijo no se toca)', () => {
    expect(normalizeJoinCode('B0S-4K7Q')).toBe('BOS4K7Q');
    expect(normalizeJoinCode('1ND-2345')).toBe('IND2345');
  });

  it('no inventa: un largo distinto de 7 se devuelve tal cual (normalizado)', () => {
    expect(normalizeJoinCode('ab-1')).toBe('AB1');
    expect(normalizeJoinCode(null)).toBe('');
  });

  it('valida la forma: 3 letras + 4 del alfabeto sin ambiguos', () => {
    expect(isJoinCodeShape('BES-4K7Q')).toBe(true);
    expect(isJoinCodeShape('bes4k7q')).toBe(true);
    expect(isJoinCodeShape('BES-4K0Q')).toBe(false); // 0 en el sufijo
    expect(isJoinCodeShape('BES-4KLQ')).toBe(false); // L en el sufijo
    expect(isJoinCodeShape('BES-4K7')).toBe(false);
    expect(isJoinCodeShape('BE5-4K7Q')).toBe(false);
  });

  it('formatea con guion para mostrar', () => {
    expect(formatJoinCode('bes4k7q')).toBe('BES-4K7Q');
    expect(formatJoinCode('abc')).toBe('ABC');
  });

  it('arma el enlace y el texto de WhatsApp con el código formateado', () => {
    const url = buildJoinUrl('https://app.sportmaps.co/', 'BES4K7Q');
    expect(url).toBe('https://app.sportmaps.co/unirse?codigo=BES-4K7Q');
    const txt = buildJoinWhatsAppText('Club Besser', 'BES4K7Q', url);
    expect(txt).toContain('BES-4K7Q');
    expect(txt).toContain(url);
    expect(txt).toContain('Club Besser');
  });
});

describe('validateJoinRequestForm', () => {
  const today = '2026-10-26';
  const ok = { forWhom: 'child' as const, name: 'Isabella Millán', birthDate: '2010-03-14', category: 'Sub-17' };

  it('acepta un formulario completo', () => {
    expect(validateJoinRequestForm(ok, today)).toEqual({});
  });

  it('pide para quién es', () => {
    expect(validateJoinRequestForm({ ...ok, forWhom: null }, today).forWhom).toBeTruthy();
  });

  it('pide nombre y apellido', () => {
    expect(validateJoinRequestForm({ ...ok, name: ' ' }, today).name).toBeTruthy();
    expect(validateJoinRequestForm({ ...ok, name: 'Isabella' }, today).name).toBe('Escribe nombre y apellido.');
  });

  it('rechaza fechas futuras, vacías o absurdas', () => {
    expect(validateJoinRequestForm({ ...ok, birthDate: '' }, today).birthDate).toBeTruthy();
    expect(validateJoinRequestForm({ ...ok, birthDate: '2027-01-01' }, today).birthDate).toBeTruthy();
    expect(validateJoinRequestForm({ ...ok, birthDate: '1900-01-01' }, today).birthDate).toBeTruthy();
  });

  it('limita la categoría sugerida', () => {
    expect(validateJoinRequestForm({ ...ok, category: 'x'.repeat(121) }, today).category).toBeTruthy();
  });

  it('calcula la edad cumplida', () => {
    expect(ageOn('2010-10-27', today)).toBe(15);
    expect(ageOn('2010-10-26', today)).toBe(16);
    expect(ageOn('nope', today)).toBeNull();
  });

  it('avisa (sin bloquear) cuando el «hijo» es mayor de edad', () => {
    expect(adultChildWarning({ ...ok, birthDate: '2000-01-01' }, today)).toContain('26 años');
    expect(adultChildWarning(ok, today)).toBeNull();
    expect(adultChildWarning({ ...ok, forWhom: 'self', birthDate: '2000-01-01' }, today)).toBeNull();
  });
});

const req = (over: Partial<JoinRequestRow>): JoinRequestRow => ({
  id: 'r1', for_whom: 'child', athlete_name: 'Ana Pérez', birth_date: '2012-01-01', suggested_category: null,
  status: 'pending', created_at: '2026-10-20T10:00:00Z', child_id: null, assigned_team_id: null, team_name: null,
  assigned_branch_id: null, enrollment_id: null, requester_profile_id: 'p1', requester_name: 'Mamá',
  requester_email: null, requester_phone: null, needs_enrollment: false, has_enrollment: false, candidates: [],
  ...over,
});
describe('buildPorAsignarInbox (D1)', () => {
  it('ordena las solicitudes abiertas, la más antigua primero', () => {
    const items = buildPorAsignarInbox([
      req({ id: 'r1', created_at: '2026-10-22T00:00:00Z' }),
      req({ id: 'r2', created_at: '2026-10-19T00:00:00Z' }),
      req({ id: 'r3', created_at: '2026-10-20T00:00:00Z' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('deja afuera lo resuelto, salvo lo asignado que aún no tiene inscripción', () => {
    const items = buildPorAsignarInbox([
      req({ id: 'hecha', status: 'assigned', needs_enrollment: false }),
      req({ id: 'falta', status: 'assigned', needs_enrollment: true }),
      req({ id: 'rech', status: 'rejected' }),
      req({ id: 'canc', status: 'cancelled' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['falta']);
  });

  it('tolera una lista vacía o nula', () => {
    expect(buildPorAsignarInbox(null)).toEqual([]);
    expect(buildPorAsignarInbox(undefined)).toEqual([]);
  });
});

describe('buildEnrollPayload (mismo camino que «Agregar atleta»)', () => {
  const base = { teamId: 't1', branchId: 'b1', startDate: '2026-10-26', userId: null, childId: 'c1' };

  it('menor: child_existing con la cuota del equipo', () => {
    expect(buildEnrollPayload({ ...base, forWhom: 'child', plan: null, teamPrice: 120000 })).toEqual({
      type: 'child_existing', child_id: 'c1', team_id: 't1', branch_id: 'b1', start_date: '2026-10-26',
      offering_plan_id: null, offering_id: null, monthly_fee: 120000,
    });
  });

  it('menor con plan: manda el plan y su precio (el plan manda sobre el equipo)', () => {
    const p = buildEnrollPayload({ ...base, forWhom: 'child', plan: { id: 'pl', offeringId: 'of', price: 90000 }, teamPrice: 120000 });
    expect(p).toMatchObject({ offering_plan_id: 'pl', offering_id: 'of', monthly_fee: 90000 });
  });

  it('sin cuota o por debajo del mínimo del BFF no inventa monto', () => {
    expect(buildEnrollPayload({ ...base, forWhom: 'child', plan: null, teamPrice: null })).not.toHaveProperty('monthly_fee');
    expect(buildEnrollPayload({ ...base, forWhom: 'child', plan: null, teamPrice: 5000 })).not.toHaveProperty('monthly_fee');
  });

  it('«para mí»: adult_existing con la cuenta, sin monthly_fee (lo calcula el BFF)', () => {
    const p = buildEnrollPayload({ ...base, forWhom: 'self', userId: 'u1', childId: null, plan: null, teamPrice: 120000 });
    expect(p).toEqual({
      type: 'adult_existing', user_id: 'u1', team_id: 't1', branch_id: 'b1', start_date: '2026-10-26',
      offering_plan_id: null, offering_id: null,
    });
  });

  it('falla claro si falta a quién inscribir', () => {
    expect(() => buildEnrollPayload({ ...base, forWhom: 'child', childId: null, plan: null, teamPrice: null })).toThrow();
    expect(() => buildEnrollPayload({ ...base, forWhom: 'self', userId: null, plan: null, teamPrice: null })).toThrow();
  });
});

describe('código pendiente (registro → /unirse)', () => {
  beforeEach(() => localStorage.clear());

  it('guarda normalizado y lo lee', () => {
    savePendingJoinCode('bes-4k7q', 1000);
    expect(readPendingJoinCode(2000)).toBe('BES4K7Q');
  });

  it('vence a los 7 días y se borra', () => {
    savePendingJoinCode('BES4K7Q', 0);
    expect(readPendingJoinCode(8 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(localStorage.getItem(PENDING_JOIN_CODE_KEY)).toBeNull();
  });

  it('se limpia', () => {
    savePendingJoinCode('BES4K7Q');
    clearPendingJoinCode();
    expect(readPendingJoinCode()).toBeNull();
  });
});

describe('joinErrorMessage', () => {
  it('prefiere el mensaje del BFF, luego el de la RPC', () => {
    expect(joinErrorMessage({ body: { error: 'Periodo ocupado' }, message: 'HTTP 409' })).toBe('Periodo ocupado');
    expect(joinErrorMessage({ message: 'Esta solicitud ya fue resuelta' })).toBe('Esta solicitud ya fue resuelta');
    expect(joinErrorMessage(null, 'x')).toBe('x');
  });
});

describe('documento en la solicitud (identidad solo por datos únicos)', () => {
  const base = { forWhom: 'child' as const, name: 'Juan Perez', birthDate: '2014-03-05', category: '' };
  const today = '2026-11-05';

  it('sin el campo docNumber no se exige documento (compatibilidad)', () => {
    expect(validateJoinRequestForm(base, today)).toEqual({});
  });
  it('con el campo vacío y sin «no lo tengo» pide el documento', () => {
    expect(validateJoinRequestForm({ ...base, docNumber: '' }, today).docNumber).toMatch(/documento/i);
  });
  it('marcar «no lo tengo a la mano» permite enviar sin documento', () => {
    expect(validateJoinRequestForm({ ...base, docNumber: '', noDoc: true }, today)).toEqual({});
  });
  it('rechaza documentos muy cortos o muy largos', () => {
    expect(validateJoinRequestForm({ ...base, docNumber: '123' }, today).docNumber).toBeTruthy();
    expect(validateJoinRequestForm({ ...base, docNumber: '1'.repeat(21) }, today).docNumber).toBeTruthy();
  });
  it('acepta un documento con puntos y lo normaliza', () => {
    expect(validateJoinRequestForm({ ...base, docNumber: '1.031.847.289' }, today)).toEqual({});
  });
});
