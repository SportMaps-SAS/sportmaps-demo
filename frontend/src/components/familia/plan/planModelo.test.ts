import { describe, expect, it } from 'vitest';
import {
    detalleSolicitud, mesesEntre, mesLegible, opcionesMes, puedeReactivar, resultadoPausa,
    validarPausa, validarReactivacion, validarRetiro,
} from './planModelo';
import type { SolicitudPlan } from '@/lib/api/planRequestsFamilia';

const HOY = '2026-11-06';

describe('meses', () => {
    it('cuenta meses completos incluyendo ambos extremos', () => {
        expect(mesesEntre('2026-11', '2026-11')).toBe(1);
        expect(mesesEntre('2026-11', '2027-02')).toBe(4);
        expect(mesesEntre('2026-01', '2026-12')).toBe(12);
    });
    it('ofrece 13 meses desde el actual y los nombra en español', () => {
        const o = opcionesMes(HOY);
        expect(o).toHaveLength(13);
        expect(o[0]).toEqual({ value: '2026-11', label: 'noviembre 2026' });
        expect(o[2].value).toBe('2027-01');
        expect(mesLegible('2027-03-01')).toBe('marzo 2027');
    });
});

describe('validarPausa', () => {
    it('acepta un rango válido', () => {
        expect(validarPausa('2026-12', '2027-02', HOY)).toBeNull();
        expect(validarPausa('2026-11', '2026-11', HOY)).toBeNull();
    });
    it('rechaza mes pasado, rango invertido y más de 12 meses', () => {
        expect(validarPausa('2026-10', '2026-11', HOY)).toMatch(/ya pasó/i);
        expect(validarPausa('2026-12', '2026-11', HOY)).toMatch(/anterior/i);
        expect(validarPausa('2026-11', '2027-11', HOY)).toMatch(/12 meses/);
        expect(validarPausa('', '2026-11', HOY)).toMatch(/Elige/);
    });
    it('exactamente 12 meses es válido', () => {
        expect(validarPausa('2026-11', '2027-10', HOY)).toBeNull();
    });
});

describe('retiro y reactivación', () => {
    it('el retiro pide fecha y no acepta pasado', () => {
        expect(validarRetiro('', HOY)).toMatch(/Elige/);
        expect(validarRetiro('2026-11-05', HOY)).toMatch(/anterior a hoy/);
        expect(validarRetiro('2026-12-20', HOY)).toBeNull();
        expect(validarRetiro(HOY, HOY)).toBeNull();
    });
    it('la reactivación pide un mes de hoy en adelante', () => {
        expect(validarReactivacion('', HOY)).toMatch(/Elige/);
        expect(validarReactivacion('2026-10', HOY)).toMatch(/ya pasó/);
        expect(validarReactivacion('2027-01', HOY)).toBeNull();
    });
});

describe('textos y estados', () => {
    it('explica si la pausa quedó aprobada o pendiente', () => {
        expect(resultadoPausa({ auto_aprobada: true, fuera_de_tope: false })).toMatch(/aprobada/);
        const fuera = resultadoPausa({ auto_aprobada: false, fuera_de_tope: true, tope: 3 });
        expect(fuera).toMatch(/cupo es de 3 meses/);
        expect(fuera).toMatch(/pendiente/);
        expect(resultadoPausa({ auto_aprobada: false, fuera_de_tope: false })).toMatch(/pendiente/);
    });
    it('solo se reactiva lo que no está activo ni en trámite', () => {
        expect(puedeReactivar('active')).toBe(false);
        expect(puedeReactivar('pending')).toBe(false);
        expect(puedeReactivar('cancelled')).toBe(true);
        expect(puedeReactivar('inactive')).toBe(true);
        expect(puedeReactivar(null)).toBe(false);
    });
    it('resume cada solicitud en una línea', () => {
        const base = {
            id: '1', enrollment_id: 'e', school_id: 's', estado: 'solicitado', atleta_nombre: null, motivo: null,
            detalle_motivo: null, canal: 'app', solicitante_rol: null, auto_aprobada: null, fuera_de_tope: null,
            nota_administracion: null, creada_at: '', resuelta_at: null,
        };
        const s = (x: Record<string, unknown>) => ({ ...base, ...x }) as unknown as SolicitudPlan;
        expect(detalleSolicitud(s({ tipo: 'pausa', desde: '2026-12-01', hasta: '2027-02-01' }))).toBe('diciembre 2026 a febrero 2027');
        expect(detalleSolicitud(s({ tipo: 'pausa', desde: '2026-12-01', hasta: '2026-12-01' }))).toBe('diciembre 2026');
        expect(detalleSolicitud(s({ tipo: 'retiro', desde: '2026-12-20', hasta: null }))).toBe('Salida el 20/12/2026');
        expect(detalleSolicitud(s({ tipo: 'reactivacion', desde: '2027-01-01', hasta: null }))).toBe('Regreso en enero 2027');
    });
});
