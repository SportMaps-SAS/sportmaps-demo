/**
 * referidos.service — lógica pura: tramos por edad, edad en una fecha, validación de tramos,
 * esquemas Zod, mapeo de errores de la base y texto del aviso. Cero red.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    ActualizarReferidoSchema, CampanaSchema, InformeQuerySchema, RegistrarReferidoSchema, TRAMOS_POR_DEFECTO,
    avisoGanado, claveAvisoGanado, edadEnFecha, mapearErrorRpc, motivoTramosInvalidos, porcentajeParaEdad,
} from './referidos.service';

describe('porcentajeParaEdad (D1: 4–15 → 50, 16+ → 25, <4 → no califica)', () => {
    it.each([[4, 50], [10, 50], [15, 50], [16, 25], [17, 25], [40, 25]])('edad %i → %i %%', (edad, pct) => {
        expect(porcentajeParaEdad(TRAMOS_POR_DEFECTO, edad)).toBe(pct);
    });
    it.each([[0], [1], [3]])('edad %i (menor de 4) → null', (edad) => {
        expect(porcentajeParaEdad(TRAMOS_POR_DEFECTO, edad)).toBeNull();
    });
    it('edad inválida → null', () => {
        expect(porcentajeParaEdad(TRAMOS_POR_DEFECTO, -1)).toBeNull();
        expect(porcentajeParaEdad(TRAMOS_POR_DEFECTO, Number.NaN)).toBeNull();
    });
    it('respeta los tramos propios de la escuela', () => {
        expect(porcentajeParaEdad([{ age_min: 6, age_max: 12, pct: 30 }], 12)).toBe(30);
        expect(porcentajeParaEdad([{ age_min: 6, age_max: 12, pct: 30 }], 13)).toBeNull();
    });
});

describe('edadEnFecha', () => {
    it('cuenta años cumplidos a la fecha', () => {
        expect(edadEnFecha('2016-11-07', '2026-11-06')).toBe(9);
        expect(edadEnFecha('2016-11-06', '2026-11-06')).toBe(10);
        expect(edadEnFecha('2009-01-01', '2026-11-06')).toBe(17);
    });
    it('sin fecha de nacimiento → null', () => {
        expect(edadEnFecha(null, '2026-11-06')).toBeNull();
        expect(edadEnFecha('basura', '2026-11-06')).toBeNull();
    });
});

describe('motivoTramosInvalidos (espejo de _referral_tiers_valid)', () => {
    it('los tramos por defecto son válidos', () => {
        expect(motivoTramosInvalidos(TRAMOS_POR_DEFECTO)).toBeNull();
    });
    it('rechaza tramos que se pisan, pct fuera de rango y edades invertidas', () => {
        expect(motivoTramosInvalidos([{ age_min: 4, age_max: 15, pct: 50 }, { age_min: 15, age_max: null, pct: 25 }])).toMatch(/pisarse/);
        expect(motivoTramosInvalidos([{ age_min: 4, age_max: 15, pct: 100 }])).toMatch(/entre 1 y 99/);
        expect(motivoTramosInvalidos([{ age_min: 4, age_max: 15, pct: 0 }])).toMatch(/entre 1 y 99/);
        expect(motivoTramosInvalidos([{ age_min: 10, age_max: 5, pct: 20 }])).toMatch(/máxima/);
        expect(motivoTramosInvalidos([])).toMatch(/1 y 10/);
    });
});

describe('esquemas Zod', () => {
    const base = { name: 'Referidos', active: false, tiers: [...TRAMOS_POR_DEFECTO] };
    it('campaña: aplica defaults (tope 12, referente al día) y exige tramos válidos', () => {
        const r = CampanaSchema.safeParse(base);
        expect(r.success).toBe(true);
        if (r.success) expect(r.data).toMatchObject({ max_pending: 12, require_referrer_current: true });
        expect(CampanaSchema.safeParse({ ...base, tiers: [] }).success).toBe(false);
        expect(CampanaSchema.safeParse({ ...base, tiers: [{ age_min: 4, age_max: 15, pct: 50 }, { age_min: 10, age_max: null, pct: 25 }] }).success).toBe(false);
        expect(CampanaSchema.safeParse({ ...base, starts_on: '2026-12-01', ends_on: '2026-11-01' }).success).toBe(false);
        expect(CampanaSchema.safeParse({ ...base, max_pending: 99 }).success).toBe(false);
        expect(CampanaSchema.safeParse({ ...base, name: '  ' }).success).toBe(false);
    });
    it('registro: pide al menos un referente y UUID válidos', () => {
        const id = '11111111-1111-4111-8111-111111111111';
        expect(RegistrarReferidoSchema.safeParse({ referred_enrollment_id: id }).success).toBe(false);
        expect(RegistrarReferidoSchema.safeParse({ referred_enrollment_id: id, referrer_name_text: 'Ana' }).success).toBe(true);
        expect(RegistrarReferidoSchema.safeParse({ referred_enrollment_id: id, referrer_profile_id: id }).success).toBe(true);
        expect(RegistrarReferidoSchema.safeParse({ referred_enrollment_id: 'x', referrer_name_text: 'Ana' }).success).toBe(false);
    });
    it('actualización: vincular y cambiar exigen referente; anular no', () => {
        const id = '11111111-1111-4111-8111-111111111111';
        expect(ActualizarReferidoSchema.safeParse({ action: 'anular' }).success).toBe(true);
        expect(ActualizarReferidoSchema.safeParse({ action: 'vincular' }).success).toBe(false);
        expect(ActualizarReferidoSchema.safeParse({ action: 'vincular', referrer_profile_id: id }).success).toBe(true);
        expect(ActualizarReferidoSchema.safeParse({ action: 'cambiar_inscripcion', referrer_profile_id: id }).success).toBe(false);
        expect(ActualizarReferidoSchema.safeParse({ action: 'cambiar_inscripcion', referrer_enrollment_id: id }).success).toBe(true);
        expect(ActualizarReferidoSchema.safeParse({ action: 'borrar' }).success).toBe(false);
    });
    it('informe: mes exige año; rangos', () => {
        expect(InformeQuerySchema.safeParse({ month: '12' }).success).toBe(false);
        expect(InformeQuerySchema.safeParse({ year: '2026', month: '12' }).success).toBe(true);
        expect(InformeQuerySchema.safeParse({ year: '2026', month: '13' }).success).toBe(false);
        expect(InformeQuerySchema.safeParse({ status: 'ganado' }).success).toBe(true);
        expect(InformeQuerySchema.safeParse({ status: 'otro' }).success).toBe(false);
    });
});

describe('mapearErrorRpc', () => {
    it.each([
        [{ code: 'P0001', message: 'REF_CAMPANA_INACTIVA' }, 409, 'REF_CAMPANA_INACTIVA'],
        [{ code: 'P0001', message: 'REF_MISMA_FAMILIA' }, 422, 'REF_MISMA_FAMILIA'],
        [{ code: 'P0001', message: 'REF_NO_ES_NUEVO' }, 409, 'REF_NO_ES_NUEVO'],
        [{ code: 'P0002', message: 'REF_INSCRIPCION_NO_ENCONTRADA' }, 404, 'REF_INSCRIPCION_NO_ENCONTRADA'],
        [{ code: '42501', message: 'No autorizado' }, 403, 'SIN_PERMISO'],
        [{ code: '23505', message: 'duplicate key' }, 409, 'YA_REGISTRADO'],
        [{ code: 'PGRST202', message: 'Could not find the function' }, 503, 'MIGRACION_PENDIENTE'],
        [{ code: 'XX000', message: 'boom' }, 500, 'ERROR_INTERNO'],
    ])('%j → %i %s', (error, status, code) => {
        const e = mapearErrorRpc(error);
        expect(e.status).toBe(status);
        expect(e.code).toBe(code);
    });
});

describe('aviso a quien refiere', () => {
    it('texto con porcentaje, mes y nombre', () => {
        const a = avisoGanado({ referral_id: 'r1', pct: 50, apply_year: 2026, apply_month: 12, referrer_user_id: 'u', referred_name: 'Sofía' });
        expect(a.mensaje).toBe('¡Ganaste 50 % en tu mensualidad de diciembre por referir a Sofía!');
    });
    it('clave estable para no repetir', () => {
        expect(claveAvisoGanado('abc')).toBe('referido-ganado:abc');
    });
});
