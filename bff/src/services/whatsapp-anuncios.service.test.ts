/**
 * whatsapp-anuncios.service — lo puro: rango de fechas de Bogotá, filas de la
 * RPC wa_embudo_anuncios y validación del mapeo «este anuncio va a…».
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {}, SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'anon' }));

import {
    DIAS_MAXIMO, FILA_VACIA, SOURCE_ID, esMigracionPendiente, hoyBogota, leerRangoAnuncios, normalizarEmbudo, validarMapeo,
} from './whatsapp-anuncios.service';

// 2026-11-05 03:00 UTC = 2026-11-04 22:00 en Bogotá.
const AHORA = Date.parse('2026-11-05T03:00:00Z');

describe('hoyBogota', () => {
    it('usa la fecha de Bogotá, no la UTC', () => {
        expect(hoyBogota(AHORA)).toBe('2026-11-04');
        expect(hoyBogota(Date.parse('2026-11-05T05:00:00Z'))).toBe('2026-11-05');
    });
});

describe('leerRangoAnuncios', () => {
    it('sin fechas: los últimos 30 días hasta hoy (ambos incluidos)', () => {
        expect(leerRangoAnuncios(undefined, undefined, AHORA)).toEqual({ ok: true, desde: '2026-10-06', hasta: '2026-11-04' });
    });
    it('solo hasta: 30 días hacia atrás desde esa fecha', () => {
        expect(leerRangoAnuncios('', '2026-10-31', AHORA)).toEqual({ ok: true, desde: '2026-10-02', hasta: '2026-10-31' });
    });
    it('un solo día vale', () => {
        expect(leerRangoAnuncios('2026-11-04', '2026-11-04', AHORA)).toEqual({ ok: true, desde: '2026-11-04', hasta: '2026-11-04' });
    });
    it('fechas inválidas, al revés o demasiado largas', () => {
        expect(leerRangoAnuncios('2026-02-30', undefined, AHORA)).toEqual({ ok: false, error: 'fecha_invalida' });
        expect(leerRangoAnuncios('04/11/2026', undefined, AHORA)).toEqual({ ok: false, error: 'fecha_invalida' });
        expect(leerRangoAnuncios('2026-11-05', '2026-11-04', AHORA)).toEqual({ ok: false, error: 'rango_invalido' });
        expect(leerRangoAnuncios('2025-01-01', '2026-11-04', AHORA)).toEqual({ ok: false, error: 'rango_demasiado_largo' });
    });
    it('el tope coincide con el de la RPC (400 días)', () => {
        expect(DIAS_MAXIMO).toBe(400);
        expect(leerRangoAnuncios('2025-09-30', '2026-11-04', AHORA).ok).toBe(true);    // 400 días
        expect(leerRangoAnuncios('2025-09-29', '2026-11-04', AHORA).ok).toBe(false);   // 401
    });
});

describe('normalizarEmbudo', () => {
    const fila = (x: Record<string, unknown>) => ({
        es_total: false, source_id: 'AD1', source_type: 'ad', headline: 'Clase de prueba', body: null, source_url: null,
        media_url: null, conversaciones: 3, de_historial: 0, contestaron: 2, separaron_o_agendaron: 1, pagaron: 1,
        monto: '30000', pagos_por_motivo: [{ motivo: 'clase_prueba', servicio_id: null, servicio: null, conversaciones: 1, pagos: 1, monto: '30000' }],
        asistieron: 1, matriculados: 0, volvieron: 0, primera_conversacion: '2026-11-04T13:00:00Z', ultima_conversacion: null,
        ...x,
    });

    it('separa la fila total y convierte los numeric a número', () => {
        const r = normalizarEmbudo([
            fila({}),
            fila({ source_id: 'AD2', monto: 0, pagos_por_motivo: [] }),
            fila({ es_total: true, source_id: null, conversaciones: 5, monto: '30000.00' }),
        ]);
        expect(r.anuncios.map((a) => a.source_id)).toEqual(['AD1', 'AD2']);
        expect(r.anuncios[0].monto).toBe(30000);
        expect(r.anuncios[0].pagos_por_motivo[0]).toEqual({
            motivo: 'clase_prueba', servicio_id: null, servicio: null, conversaciones: 1, pagos: 1, monto: 30000,
        });
        expect(r.total.conversaciones).toBe(5);
        expect(r.total.monto).toBe(30000);
        expect(r.total.source_id).toBeNull();
    });

    it('sin datos (o sin fila total): todo en cero, nunca revienta', () => {
        expect(normalizarEmbudo(null)).toEqual({ anuncios: [], total: FILA_VACIA });
        expect(normalizarEmbudo([fila({})]).total).toEqual(FILA_VACIA);
        expect(normalizarEmbudo([fila({ pagos_por_motivo: 'x', conversaciones: 'abc' })]).anuncios[0])
            .toMatchObject({ pagos_por_motivo: [], conversaciones: 0 });
    });

    it('descarta filas de anuncio sin id', () => {
        expect(normalizarEmbudo([fila({ source_id: '' })]).anuncios).toEqual([]);
    });
});

describe('validarMapeo', () => {
    const SERV = '11111111-1111-4111-8111-111111111111';
    it('clase de prueba y persona no llevan servicio (aunque lo manden)', () => {
        expect(validarMapeo({ destino: 'clase_prueba', servicio_id: SERV })).toEqual({
            ok: true, valor: { destino: 'clase_prueba', servicio_id: null, nota: null },
        });
        expect(validarMapeo({ destino: 'persona', nota: '  Lo atiende Milena  ' })).toEqual({
            ok: true, valor: { destino: 'persona', servicio_id: null, nota: 'Lo atiende Milena' },
        });
    });
    it('servicio exige el id del catálogo', () => {
        expect(validarMapeo({ destino: 'servicio', servicio_id: SERV })).toEqual({
            ok: true, valor: { destino: 'servicio', servicio_id: SERV, nota: null },
        });
        expect(validarMapeo({ destino: 'servicio' })).toEqual({ ok: false, error: 'falta_servicio' });
        expect(validarMapeo({ destino: 'servicio', servicio_id: 'clinica' })).toEqual({ ok: false, error: 'falta_servicio' });
    });
    it('destino desconocido o nota larga', () => {
        expect(validarMapeo({ destino: 'torneo' })).toEqual({ ok: false, error: 'destino_invalido' });
        expect(validarMapeo(null)).toEqual({ ok: false, error: 'destino_invalido' });
        expect(validarMapeo({ destino: 'persona', nota: 'x'.repeat(301) })).toEqual({ ok: false, error: 'nota_muy_larga' });
    });
});

describe('SOURCE_ID', () => {
    it('acepta los ids de Meta (anuncio numérico, post página_post) y nada raro', () => {
        expect(SOURCE_ID.test('120251275521150783')).toBe(true);
        expect(SOURCE_ID.test('102938_5647382910')).toBe(true);
        expect(SOURCE_ID.test('')).toBe(false);
        expect(SOURCE_ID.test('1 OR 1=1')).toBe(false);
        expect(SOURCE_ID.test('a/b')).toBe(false);
    });
});

describe('esMigracionPendiente', () => {
    it('reconoce función o tabla inexistente', () => {
        expect(esMigracionPendiente({ code: 'PGRST202' })).toBe(true);
        expect(esMigracionPendiente({ code: 'PGRST205' })).toBe(true);
        expect(esMigracionPendiente({ code: '42P01' })).toBe(true);
        expect(esMigracionPendiente({ message: 'Could not find the function public.wa_embudo_anuncios' })).toBe(true);
        expect(esMigracionPendiente({ code: '42501', message: 'Forbidden' })).toBe(false);
        expect(esMigracionPendiente(null)).toBe(false);
    });
});
