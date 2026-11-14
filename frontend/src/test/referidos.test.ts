import { describe, expect, it, vi } from 'vitest';

// La lógica pura no toca la red ni Supabase: se aíslan los clientes.
vi.mock('@/lib/api/bffClient', () => ({ bffClient: {} }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  armarCuerpoReferido, edadEn, fechaNacimientoValida, fmtCOP, fmtPct, mensajeErrorReferido, mesDelDescuento,
  nombreReferente, tramoParaEdad, TRAMOS_POR_DEFECTO, validarFechasCampana, validarTramos,
} from '@/lib/api/referidos';

describe('edadEn', () => {
  it('cuenta años cumplidos', () => {
    expect(edadEn('2010-11-07', '2026-11-06')).toBe(15);
    expect(edadEn('2010-11-06', '2026-11-06')).toBe(16);
    expect(edadEn('2022-11-07', '2026-11-06')).toBe(3);
  });
  it('sin fecha o fecha futura: null', () => {
    expect(edadEn(null, '2026-11-06')).toBeNull();
    expect(edadEn('', '2026-11-06')).toBeNull();
    expect(edadEn('2030-01-01', '2026-11-06')).toBeNull();
  });
});

describe('tramoParaEdad (50 % y 25 % por defecto)', () => {
  it('4 a 15 = 50 %, 16 o más = 25 %, menor de 4 no califica', () => {
    expect(tramoParaEdad(TRAMOS_POR_DEFECTO, 4)?.pct).toBe(50);
    expect(tramoParaEdad(TRAMOS_POR_DEFECTO, 15)?.pct).toBe(50);
    expect(tramoParaEdad(TRAMOS_POR_DEFECTO, 16)?.pct).toBe(25);
    expect(tramoParaEdad(TRAMOS_POR_DEFECTO, 42)?.pct).toBe(25);
    expect(tramoParaEdad(TRAMOS_POR_DEFECTO, 3)).toBeNull();
    expect(tramoParaEdad(TRAMOS_POR_DEFECTO, null)).toBeNull();
  });
});

describe('validarTramos', () => {
  it('los de por defecto sirven', () => expect(validarTramos(TRAMOS_POR_DEFECTO)).toBeNull());
  it('vacío', () => expect(validarTramos([])).toMatch(/al menos un tramo/));
  it('porcentaje fuera de rango', () => {
    expect(validarTramos([{ age_min: 4, age_max: null, pct: 0 }])).toMatch(/entre 1 y 100/);
    expect(validarTramos([{ age_min: 4, age_max: null, pct: 101 }])).toMatch(/entre 1 y 100/);
  });
  it('edad final menor que la inicial', () => {
    expect(validarTramos([{ age_min: 10, age_max: 5, pct: 50 }])).toMatch(/final/);
  });
  it('tramos cruzados', () => {
    expect(validarTramos([
      { age_min: 4, age_max: 16, pct: 50 },
      { age_min: 16, age_max: null, pct: 25 },
    ])).toMatch(/cruzarse/);
  });
  it('solo el último puede ir sin tope', () => {
    expect(validarTramos([
      { age_min: 4, age_max: null, pct: 50 },
      { age_min: 16, age_max: null, pct: 25 },
    ])).toMatch(/último/);
  });
});

describe('fechas y formato', () => {
  it('fechas de campaña', () => {
    expect(validarFechasCampana('2026-12-01', '2026-11-01')).toMatch(/anterior/);
    expect(validarFechasCampana('2026-11-01', null)).toBeNull();
  });
  it('fecha de nacimiento válida', () => {
    expect(fechaNacimientoValida('2015-05-01', '2026-11-06')).toBe(true);
    expect(fechaNacimientoValida('2027-05-01', '2026-11-06')).toBe(false);
    expect(fechaNacimientoValida('1900-05-01', '2026-11-06')).toBe(false);
    expect(fechaNacimientoValida('01/05/2015', '2026-11-06')).toBe(false);
  });
  it('mes del descuento, porcentaje y pesos', () => {
    expect(mesDelDescuento(2026, 12)).toBe('diciembre de 2026');
    expect(mesDelDescuento(null, 12)).toBe('');
    expect(fmtPct(50)).toBe('50 %');
    expect(fmtPct(12.5)).toBe('12,5 %');
    expect(fmtCOP(150000)).toMatch(/150\.000/);
  });
});

describe('armarCuerpoReferido', () => {
  it('inscripción del referente manda sobre el texto', () => {
    expect(armarCuerpoReferido('E1', { enrollmentId: 'E2', nombre: 'Ana' })).toEqual({
      referred_enrollment_id: 'E1', referrer_enrollment_id: 'E2',
    });
  });
  it('texto libre recortado', () => {
    const c = armarCuerpoReferido('E1', { texto: '  María López  ', nombre: 'María López' });
    expect(c).toEqual({ referred_enrollment_id: 'E1', referrer_name_text: 'María López' });
  });
});

describe('mensajes de error', () => {
  it('traduce los códigos del contrato', () => {
    expect(mensajeErrorReferido({ status: 409, body: { code: 'REF_NO_ES_NUEVO' } })).toMatch(/ya estaba inscrita/);
    expect(mensajeErrorReferido({ status: 422, body: { code: 'REF_SIN_FECHA_NACIMIENTO' } })).toMatch(/fecha de nacimiento/);
    expect(mensajeErrorReferido({ status: 403, body: {} })).toMatch(/permiso/);
    expect(mensajeErrorReferido({ status: 503, body: { code: 'MIGRACION_PENDIENTE' } })).toMatch(/todavía no están activos/);
  });
  it('nombre del referente', () => {
    expect(nombreReferente({ referrer_name: null, referrer_name_text: ' Pedro ' })).toBe('Pedro');
    expect(nombreReferente({ referrer_name: null, referrer_name_text: null })).toBe('Sin nombre');
  });
});
