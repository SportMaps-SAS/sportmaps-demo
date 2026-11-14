/**
 * Acuerdos de pago: reparto exacto en pesos, calendario, topes (D9), estados, permisos y errores.
 * Lo puro; las RPC y la RLS se prueban en supabase/migrations/_smoke/acuerdos_smoke.sql.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {}, SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' }));

import {
    repartirEnCuotas, fechasPorDefecto, proponerCalendario, estadoInicial, puedeTransicionar, esEstadoFinal, esVivo,
    puedeResolver, puedeCancelar, puedeVer, mapearErrorRpc, hoyBogota, sumarDias, diasEntre, esFechaValida,
    TOPES_POR_DEFECTO, type TopesAcuerdo, type AcuerdoMin, type Actor,
    guardarTopes,
} from './acuerdos-de-pago.service';

const HOY = '2026-11-06';
const TOPES: TopesAcuerdo = { habilitado: true, maxCuotas: 3, maxDias: 60, autoAprobar: true };

describe('repartirEnCuotas', () => {
    it('reparte exacto y la última ajusta el redondeo', () => {
        expect(repartirEnCuotas(150000, 3)).toEqual([50000, 50000, 50000]);
        expect(repartirEnCuotas(100000, 3)).toEqual([33333, 33333, 33334]);
        expect(repartirEnCuotas(100001, 2)).toEqual([50000, 50001]);
    });
    it('la suma siempre es el total', () => {
        for (const [t, n] of [[155000, 4], [99999, 7], [10, 3], [1, 1], [12345, 12]] as const) {
            expect(repartirEnCuotas(t, n)!.reduce((a, b) => a + b, 0)).toBe(t);
        }
    });
    it('rechaza lo imposible', () => {
        expect(repartirEnCuotas(0, 3)).toBeNull();
        expect(repartirEnCuotas(1000.5, 3)).toBeNull();
        expect(repartirEnCuotas(1000, 0)).toBeNull();
        expect(repartirEnCuotas(1000, 13)).toBeNull();
        expect(repartirEnCuotas(2, 3)).toBeNull(); // cuota de $0
    });
});

describe('fechas', () => {
    it('hoy en Bogotá (UTC-5)', () => {
        expect(hoyBogota(Date.parse('2026-11-06T04:59:00Z'))).toBe('2026-11-05');
        expect(hoyBogota(Date.parse('2026-11-06T05:00:00Z'))).toBe('2026-11-06');
    });
    it('suma de días, diferencia y validez', () => {
        expect(sumarDias('2026-11-30', 1)).toBe('2026-12-01');
        expect(diasEntre('2026-11-06', '2027-01-05')).toBe(60);
        expect(esFechaValida('2026-02-30')).toBe(false);
        expect(esFechaValida('2026-11-06')).toBe(true);
        expect(esFechaValida('06/11/2026')).toBe(false);
    });
    it('fechas por defecto: 3 cuotas con tope 60 días cada 20 días; nunca pasa de 30', () => {
        expect(fechasPorDefecto(HOY, 3, 60)).toEqual(['2026-11-26', '2026-12-16', '2027-01-05']);
        expect(fechasPorDefecto(HOY, 2, 365)).toEqual(['2026-12-06', '2027-01-05']);
    });
});

describe('proponerCalendario', () => {
    it('propone cuotas parejas dentro de los topes → no requiere aprobación', () => {
        const r = proponerCalendario({ saldoTotal: 100000, cuotas: 3, hoy: HOY, topes: TOPES });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.calendario.cuotas.map((c) => c.monto)).toEqual([33333, 33333, 33334]);
        expect(r.calendario.cuotas.map((c) => c.seq)).toEqual([1, 2, 3]);
        expect(r.calendario.dias).toBe(60);
        expect(r.calendario.requiereAprobacion).toBe(false);
        expect(estadoInicial(r.calendario)).toBe('activo');
    });
    it('más cuotas que el tope → requiere aprobación (no es error)', () => {
        const r = proponerCalendario({ saldoTotal: 120000, cuotas: 4, hoy: HOY, topes: TOPES });
        expect(r.ok && r.calendario.requiereAprobacion).toBe(true);
        expect(r.ok && r.calendario.motivos).toContain('mas_cuotas_del_tope');
        expect(r.ok && estadoInicial(r.calendario)).toBe('solicitado');
    });
    it('más días que el tope → requiere aprobación', () => {
        const r = proponerCalendario({ saldoTotal: 90000, fechas: ['2026-12-06', '2027-02-10'], hoy: HOY, topes: TOPES });
        expect(r.ok && r.calendario.motivos).toEqual(['mas_dias_del_tope']);
    });
    it('topes configurables por escuela: con maxCuotas 6 y maxDias 120, 5 cuotas a 100 días caben', () => {
        const r = proponerCalendario({
            saldoTotal: 500000, fechas: ['2026-11-26', '2026-12-16', '2027-01-05', '2027-01-25', '2027-02-14'],
            hoy: HOY, topes: { ...TOPES, maxCuotas: 6, maxDias: 120 },
        });
        expect(r.ok && r.calendario.requiereAprobacion).toBe(false);
    });
    it('sin autoaprobación o con un incumplimiento previo, siempre va a la administración', () => {
        const a = proponerCalendario({ saldoTotal: 90000, cuotas: 2, hoy: HOY, topes: { ...TOPES, autoAprobar: false } });
        expect(a.ok && a.calendario.motivos).toEqual(['sin_autoaprobacion']);
        const b = proponerCalendario({ saldoTotal: 90000, cuotas: 2, hoy: HOY, topes: TOPES, incumplioAntes: true });
        expect(b.ok && b.calendario.motivos).toEqual(['incumplio_antes']);
    });
    it('el administrador la deja activa aunque exceda', () => {
        const r = proponerCalendario({ saldoTotal: 120000, cuotas: 4, hoy: HOY, topes: TOPES });
        expect(r.ok && estadoInicial(r.calendario, true)).toBe('activo');
    });
    it('montos y fechas elegidas por la persona se respetan', () => {
        const r = proponerCalendario({ saldoTotal: 100000, fechas: ['2026-11-20', '2026-12-20'], montos: [70000, 30000], hoy: HOY, topes: TOPES });
        expect(r.ok && r.calendario.cuotas).toEqual([{ seq: 1, fecha: '2026-11-20', monto: 70000 }, { seq: 2, fecha: '2026-12-20', monto: 30000 }]);
    });
    it('errores: apagado, suma, fechas, rango', () => {
        const err = (e: any) => { const r = proponerCalendario({ hoy: HOY, topes: TOPES, saldoTotal: 100000, ...e }); return r.ok ? 'ok' : r.error; };
        expect(proponerCalendario({ saldoTotal: 1000, cuotas: 2, hoy: HOY, topes: TOPES_POR_DEFECTO })).toMatchObject({ ok: false, status: 409, error: 'acuerdos_apagados' });
        expect(err({ montos: [60000, 30000], fechas: ['2026-11-20', '2026-12-20'] })).toBe('suma_distinta_del_saldo');
        expect(err({ cuotas: 2, fechas: ['2026-11-05', '2026-12-20'] })).toBe('fecha_pasada');
        expect(err({ cuotas: 2, fechas: ['2026-12-20', '2026-11-20'] })).toBe('fechas_desordenadas');
        expect(err({ cuotas: 2, fechas: ['2026-11-20', '2028-01-01'] })).toBe('fecha_lejana');
        expect(err({ cuotas: 2, fechas: ['2026-11-20', 'mañana'] })).toBe('fecha_invalida');
        expect(err({ cuotas: 13 })).toBe('cuotas_fuera_de_rango');
        expect(err({ cuotas: 3, fechas: ['2026-11-20'] })).toBe('cuotas_fuera_de_rango');
        expect(err({ saldoTotal: 0, cuotas: 2 })).toBe('saldo_invalido');
        expect(err({ cuotas: 2, montos: [100000, 0] })).toBe('monto_invalido');
    });
    it('una fecha igual a hoy es válida (la primera cuota puede ser hoy)', () => {
        expect(proponerCalendario({ saldoTotal: 1000, cuotas: 1, fechas: [HOY], hoy: HOY, topes: TOPES }).ok).toBe(true);
    });
});

describe('estados y permisos', () => {
    it('transiciones', () => {
        expect(puedeTransicionar('solicitado', 'activo')).toBe(true);
        expect(puedeTransicionar('solicitado', 'rechazado')).toBe(true);
        expect(puedeTransicionar('activo', 'incumplido')).toBe(true);
        expect(puedeTransicionar('activo', 'cumplido')).toBe(true);
        expect(puedeTransicionar('activo', 'solicitado')).toBe(false);
        expect(puedeTransicionar('incumplido', 'activo')).toBe(false);
        expect(puedeTransicionar('cumplido', 'cancelado')).toBe(false);
        expect(esEstadoFinal('rechazado')).toBe(true);
        expect(esVivo('activo') && esVivo('solicitado') && !esVivo('cumplido')).toBe(true);
    });
    const acuerdo = (o: Partial<AcuerdoMin> = {}): AcuerdoMin => ({ school_id: 'S1', payer_profile_id: 'U1', requested_by: 'U1', status: 'solicitado', ...o });
    const actor = (o: Partial<Actor> = {}): Actor => ({ userId: 'U9', esAdminDeLaEscuela: false, esStaffDeLaEscuela: false, ...o });
    it('solo la administración resuelve, y solo lo solicitado', () => {
        expect(puedeResolver(acuerdo(), actor({ esAdminDeLaEscuela: true }))).toBe(true);
        expect(puedeResolver(acuerdo(), actor({ userId: 'U1' }))).toBe(false);          // el pagador no
        expect(puedeResolver(acuerdo(), actor({ esStaffDeLaEscuela: true }))).toBe(false); // un coach no
        expect(puedeResolver(acuerdo({ status: 'activo' }), actor({ esAdminDeLaEscuela: true }))).toBe(false);
    });
    it('cancela el pagador o la administración, solo si está vivo', () => {
        expect(puedeCancelar(acuerdo({ status: 'activo' }), actor({ userId: 'U1' }))).toBe(true);
        expect(puedeCancelar(acuerdo({ status: 'activo' }), actor({ esAdminDeLaEscuela: true }))).toBe(true);
        expect(puedeCancelar(acuerdo({ status: 'activo' }), actor())).toBe(false);
        expect(puedeCancelar(acuerdo({ status: 'cumplido' }), actor({ userId: 'U1' }))).toBe(false);
    });
    it('ve el pagador y el staff de esa escuela; un ajeno no', () => {
        expect(puedeVer(acuerdo(), actor({ userId: 'U1' }))).toBe(true);
        expect(puedeVer(acuerdo(), actor({ esStaffDeLaEscuela: true }))).toBe(true);
        expect(puedeVer(acuerdo(), actor())).toBe(false);
    });
});

describe('mapearErrorRpc', () => {
    it('traduce los códigos de la base', () => {
        expect(mapearErrorRpc({ code: '42501', message: 'SIN_PERMISO' })).toEqual({ status: 403, error: 'forbidden' });
        expect(mapearErrorRpc({ code: '55000', message: 'ACUERDOS_APAGADO' })).toEqual({ status: 409, error: 'acuerdos_apagados' });
        expect(mapearErrorRpc({ code: '23505', message: 'COBRO_YA_EN_ACUERDO' })).toEqual({ status: 409, error: 'cobro_ya_en_acuerdo' });
        expect(mapearErrorRpc({ code: '22023', message: 'COBRO_NO_ELEGIBLE' })).toEqual({ status: 422, error: 'cobro_no_elegible' });
        expect(mapearErrorRpc({ code: '22023', message: 'DATOS_INVALIDOS:fecha_pasada' })).toEqual({ status: 400, error: 'fecha_pasada' });
        expect(mapearErrorRpc({ code: 'P0002', message: 'ACUERDO_NO_ENCONTRADO' })).toEqual({ status: 404, error: 'acuerdo_no_encontrado' });
        expect(mapearErrorRpc({ code: '55000', message: 'ESTADO_INVALIDO:activo' })).toEqual({ status: 409, error: 'estado_invalido' });
        expect(mapearErrorRpc({ code: 'PGRST202', message: 'x' })).toEqual({ status: 503, error: 'migracion_pendiente' });
        expect(mapearErrorRpc({ code: 'XX', message: 'boom' }).status).toBe(500);
    });
});

describe('guardarTopes', () => {
    const topes = { habilitado: true, maxCuotas: 3, maxDias: 60, autoAprobar: true };
    // Doble de la cadena del cliente: from().update().eq().select() y from().insert().
    function db(opts: { filas?: any[]; updError?: any; insError?: any }) {
        const llamadas: any = { update: null, insert: null };
        const cliente = {
            from: () => ({
                update: (v: any) => { llamadas.update = v; return { eq: () => ({ select: async () => ({ data: opts.filas ?? [{ school_id: 'S' }], error: opts.updError ?? null }) }) }; },
                insert: async (v: any) => { llamadas.insert = v; return { error: opts.insError ?? null }; },
            }),
        };
        return { cliente: cliente as any, llamadas };
    }

    it('rechaza rangos inválidos sin tocar la base', async () => {
        const { cliente, llamadas } = db({});
        expect(await guardarTopes('S', { ...topes, maxCuotas: 0 }, cliente)).toMatchObject({ ok: false, status: 400 });
        expect(await guardarTopes('S', { ...topes, maxCuotas: 13 }, cliente)).toMatchObject({ ok: false, status: 400 });
        expect(await guardarTopes('S', { ...topes, maxDias: 366 }, cliente)).toMatchObject({ ok: false, status: 400 });
        expect(await guardarTopes('S', { ...topes, maxDias: 1.5 }, cliente)).toMatchObject({ ok: false, status: 400 });
        expect(llamadas.update).toBeNull();
    });
    it('actualiza la fila existente con los cuatro ajustes', async () => {
        const { cliente, llamadas } = db({});
        const r = await guardarTopes('S', { habilitado: true, maxCuotas: 4, maxDias: 90, autoAprobar: false }, cliente);
        expect(r).toMatchObject({ ok: true });
        expect(llamadas.update).toEqual({
            payment_agreements_enabled: true, agreement_max_installments: 4, agreement_max_days: 90, agreement_auto_approve: false,
        });
        expect(llamadas.insert).toBeNull();
    });
    it('si la escuela aún no tiene fila de ajustes, la crea', async () => {
        const { cliente, llamadas } = db({ filas: [] });
        const r = await guardarTopes('S', topes, cliente);
        expect(r).toMatchObject({ ok: true });
        expect(llamadas.insert).toMatchObject({ school_id: 'S', payment_agreements_enabled: true });
    });
    it('sin las columnas (migración sin aplicar) responde 503', async () => {
        const { cliente } = db({ updError: { code: '42703', message: 'column does not exist' } });
        expect(await guardarTopes('S', topes, cliente)).toMatchObject({ ok: false, status: 503, error: 'migracion_pendiente' });
    });
    it('un error distinto se propaga', async () => {
        const { cliente } = db({ updError: { code: 'XX000', message: 'boom' } });
        await expect(guardarTopes('S', topes, cliente)).rejects.toThrow(/school_settings/);
    });
});
