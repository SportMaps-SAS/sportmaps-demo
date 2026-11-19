import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import { supabase } from '../config/supabase';
import { esCerradaPorEscuela } from './whatsapp-bandeja.service';
import { decidirPorClasificar, MOTIVOS_CON_PLATA, porClasificarActivoPara, lecturaComoOcr, cerrarPorClasificar } from './wa-comprobante-por-clasificar.service';

const ocr = (o: Record<string, unknown> = {}) => ({
    amount: 150000, reference: 'M20540656', date: '2026-11-15', bank: 'Nequi', destination: '319 450 5150', isReceipt: true, ...o,
});

describe('decidirPorClasificar', () => {
    it('un comprobante de venta con monto que no cuadra pasa a «servicio nuevo»', () => {
        const d = decidirPorClasificar({
            errorMessage: 'venta_monto_no_cuadra: comprobante de $150.000 para Clínica de armadores y atacantes; el valor de hoy es $350.000',
            ocr: ocr(), texto: 'Isaac zaidman',
        });
        expect(d).not.toBeNull();
        expect(d!.etiqueta).toBe('servicio_nuevo');
        expect(d!.monto).toBe(150000);
        expect(d!.referencia).toBe('M20540656');
        expect(d!.fecha).toBe('2026-11-15');
    });

    it('un número que no es de ninguna ficha queda «por identificar»', () => {
        const d = decidirPorClasificar({ errorMessage: 'sin_familia: el número no está en ninguna ficha de la escuela', ocr: ocr({ amount: 174900 }) });
        expect(d?.etiqueta).toBe('por_identificar');
    });

    it('la clase de prueba se reconoce por el detalle', () => {
        const d = decidirPorClasificar({
            errorMessage: 'otro_concepto: clase de prueba (chat: «De la clase de prueba y tienen carrera deportiva»)',
            ocr: ocr({ amount: 30000, reference: null }),
        });
        expect(d?.etiqueta).toBe('clase_de_prueba');
        expect(d?.referencia).toBeNull();
    });

    it('un excedente y un saldo tienen su propia etiqueta', () => {
        expect(decidirPorClasificar({ errorMessage: 'excedente_de_parcial: pagó más', ocr: ocr() })?.etiqueta).toBe('exceso');
        expect(decidirPorClasificar({ errorMessage: 'saldo_de_parcial: es el saldo', ocr: ocr() })?.etiqueta).toBe('saldo_de_cobro');
    });

    it('«contacto no atendido» con un comprobante leído es plata (los 3 × $140.000 del 15-nov)', () => {
        const d = decidirPorClasificar({ errorMessage: 'contacto_no_atendido', ocr: ocr({ amount: 140000 }) });
        expect(d?.etiqueta).toBe('por_identificar');
    });

    it('sin monto leído no hay nada que clasificar', () => {
        expect(decidirPorClasificar({ errorMessage: 'contacto_no_atendido', ocr: ocr({ amount: null }) })).toBeNull();
        expect(decidirPorClasificar({ errorMessage: 'sin_familia: x', ocr: null })).toBeNull();
    });

    it('no es comprobante / listado de movimientos: no entra aunque traiga un número', () => {
        expect(decidirPorClasificar({ errorMessage: 'sin_familia: x', ocr: ocr({ isReceipt: false }) })).toBeNull();
        expect(decidirPorClasificar({ errorMessage: 'sin_familia: x', ocr: ocr({ isTransactionList: true }) })).toBeNull();
    });

    it('lo que ya está resuelto o no es de la escuela nunca entra', () => {
        for (const em of [
            'abono_en_revision: Clínica — abono de $150.000', // el abono YA quedó en revisión en un cobro
            'comprobante ya recibido (misma imagen)',
            'referencia ya usada: M0001',
            'ya registrado: Mensualidad',
            'destino no es de la escuela',
            'pago por fuera de SportMaps',
            'no es un comprobante',
            'listado de movimientos',
            'admin no acudiente',
            'venta_comprobante_repetido: x',
        ]) {
            expect(decidirPorClasificar({ errorMessage: em, ocr: ocr() }), em).toBeNull();
        }
    });

    it('una fila ya cerrada por la escuela no vuelve a entrar', () => {
        expect(decidirPorClasificar({
            errorMessage: 'cerrado_escuela: resuelto — ya aplicado | sin_familia: x', ocr: ocr(),
        })).toBeNull();
    });

    it('la propuesta no arrastra el texto crudo del comprobante ni datos de más', () => {
        const d = decidirPorClasificar({
            errorMessage: 'sin_familia: el número no está en ninguna ficha', ocr: { ...ocr(), rawText: 'TEXTO CRUDO CON CUENTA 4810' } as any,
        });
        expect(JSON.stringify(d!.propuesta)).not.toContain('TEXTO CRUDO');
    });

    it('MOTIVOS_CON_PLATA cubre los motivos de acción de la bandeja', () => {
        for (const m of ['varios_cobros', 'monto_distinto', 'sin_familia', 'otro_concepto', 'venta_servicio', 'escuela_tomo', 'excedente_de_parcial']) {
            expect(MOTIVOS_CON_PLATA).toContain(m);
        }
        expect(MOTIVOS_CON_PLATA).not.toContain('monto_distinto_aplicado');
    });
});

import { registrarPorClasificar } from './wa-comprobante-por-clasificar.service';
import { supabase } from '../config/supabase';

describe('registrarPorClasificar', () => {
    const base = () => ({
        schoolId: 's1', queueId: 'q1', storagePath: null, telefono: '573001112233', nombre: null, motivoBot: 'sin_familia: x',
        decision: decidirPorClasificar({ errorMessage: 'sin_familia: x', ocr: ocr() })!,
    });

    it('devuelve el id y manda los parámetros de la RPC tal cual', async () => {
        (supabase.rpc as any).mockResolvedValueOnce({ data: { ok: true, id: 'abc', ya_existia: false }, error: null });
        const r = await registrarPorClasificar(base());
        expect(r).toEqual({ ok: true, id: 'abc', yaExistia: false, repetido: false });
        const [nombre, args] = (supabase.rpc as any).mock.calls.at(-1);
        expect(nombre).toBe('wa_crear_comprobante_por_clasificar');
        expect(args).toMatchObject({ p_school_id: 's1', p_queue_id: 'q1', p_etiqueta: 'por_identificar', p_monto: 150000 });
    });

    it('sin la migración aplicada no rompe: devuelve migracion_pendiente', async () => {
        (supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.wa_crear_comprobante_por_clasificar' } });
        expect(await registrarPorClasificar(base())).toEqual({ ok: false, codigo: 'migracion_pendiente' });
    });

    it('una referencia ya usada por un pago devuelve el pago, no crea nada', async () => {
        (supabase.rpc as any).mockResolvedValueOnce({ data: { ok: false, codigo: 'referencia_ya_usada', payment_id: 'p9' }, error: null });
        expect(await registrarPorClasificar(base())).toEqual({ ok: false, codigo: 'referencia_ya_usada', paymentId: 'p9' });
    });

    it('si la RPC lanza, no lanza el worker', async () => {
        (supabase.rpc as any).mockRejectedValueOnce(new Error('red'));
        expect(await registrarPorClasificar(base())).toEqual({ ok: false, codigo: 'error' });
    });
});

describe('porClasificarActivoPara (solo las escuelas de la lista)', () => {
    const MONSTER = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
    const DYNASTY = '2d509571-3238-4c04-ac3f-6dfe20539226';
    const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

    it('sin la variable, nadie (lo seguro)', () => {
        expect(porClasificarActivoPara(MONSTER, env({}))).toBe(false);
        expect(porClasificarActivoPara(MONSTER, env({ WA_POR_CLASIFICAR_ESCUELAS: '' }))).toBe(false);
    });
    it('solo las escuelas listadas', () => {
        const e = env({ WA_POR_CLASIFICAR_ESCUELAS: `${MONSTER}, ${DYNASTY.toUpperCase()}` });
        expect(porClasificarActivoPara(MONSTER, e)).toBe(true);
        expect(porClasificarActivoPara(DYNASTY, e)).toBe(true);
        expect(porClasificarActivoPara('00000000-0000-0000-0000-000000000000', e)).toBe(false);
    });
    it('el interruptor de emergencia apaga todo, aunque esté en la lista', () => {
        expect(porClasificarActivoPara(MONSTER, env({ WA_POR_CLASIFICAR_ESCUELAS: MONSTER, WA_POR_CLASIFICAR_OFF: '1' }))).toBe(false);
    });
});

describe('lecturaComoOcr (la lectura de la cola es un resumen: se completa para el veredicto)', () => {
    it('completa lo que evaluateVerdict da por sentado (missingFields, isTransactionList…)', () => {
        const o = lecturaComoOcr({ amount: '120000', reference: 'R1', date: '2026-11-18', bank: 'BBVA', destination: '@3194505150', description: '2 semanas vacacional MJZM' });
        expect(o.missingFields).toEqual([]);
        expect(o.isReceipt).toBe(true);
        expect(o.isTransactionList).toBe(false);
        expect(o.amount).toBe(120000);
        expect(o.currency).toBe('COP');
        expect(o.provider).toBe('gemini');
    });
    it('respeta lo que la lectura sí trae y no inventa datos', () => {
        const o = lecturaComoOcr({ amount: 5, isReceipt: false, isTransactionList: true, missingFields: ['date'], provider: 'claude', reference: null });
        expect(o.isReceipt).toBe(false);
        expect(o.isTransactionList).toBe(true);
        expect(o.missingFields).toEqual(['date']);
        expect(o.provider).toBe('claude');
        expect(o.reference).toBeNull();
        expect(o.date).toBeNull();
    });
    it('una lectura vacía o nula no rompe', () => {
        expect(lecturaComoOcr(null).amount).toBeNull();
        expect(lecturaComoOcr(undefined).missingFields).toEqual([]);
    });
});

describe('esCerradaPorEscuela (A-1: una fila waiting_user con prefijo ya no espera a la familia)', () => {
    it('reconoce el prefijo que antepone la RPC', () => {
        expect(esCerradaPorEscuela('cerrado_escuela: resuelto_auto — pasó a «Por clasificar» en Cobros | sin_familia: x')).toBe(true);
    });
    it('no toca las demás filas (null, vacío, otros motivos)', () => {
        expect(esCerradaPorEscuela(null)).toBe(false);
        expect(esCerradaPorEscuela(undefined)).toBe(false);
        expect(esCerradaPorEscuela('')).toBe(false);
        expect(esCerradaPorEscuela('sin_familia: el número no está en ninguna ficha')).toBe(false);
        expect(esCerradaPorEscuela('x cerrado_escuela: no al inicio')).toBe(false);
    });
});

describe('cerrarPorClasificar (A-2: el resultado del cierre se revisa)', () => {
    const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
    const args = { id: 'f1', paymentId: 'p1', resolucion: 'aplicado_a_cobro_existente', por: 'u1' };

    it('ok y ya_aplicado (idempotente) cierran bien', async () => {
        rpc.mockReset().mockResolvedValueOnce({ data: { ok: true, ya_aplicado: false }, error: null });
        expect(await cerrarPorClasificar(args)).toEqual({ ok: true, yaAplicado: false });
        rpc.mockReset().mockResolvedValueOnce({ data: { ok: true, ya_aplicado: true }, error: null });
        expect(await cerrarPorClasificar(args)).toEqual({ ok: true, yaAplicado: true });
    });

    it('ya_cerrado (otro administrador ganó la carrera) → 409 con el estado, sin reintentar', async () => {
        rpc.mockReset().mockResolvedValue({ data: { ok: false, codigo: 'ya_cerrado', estado: 'aplicado' }, error: null });
        expect(await cerrarPorClasificar(args)).toEqual({ ok: false, codigo: 'ya_cerrado', http: 409, estado: 'aplicado' });
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('no_existe → 404; pago_ajeno → 422', async () => {
        rpc.mockReset().mockResolvedValueOnce({ data: { ok: false, codigo: 'no_existe' }, error: null });
        expect(await cerrarPorClasificar(args)).toMatchObject({ ok: false, http: 404 });
        rpc.mockReset().mockResolvedValueOnce({ data: { ok: false, codigo: 'pago_ajeno' }, error: null });
        expect(await cerrarPorClasificar(args)).toMatchObject({ ok: false, http: 422 });
    });

    it('un error de la RPC se reintenta una vez y si se recupera cierra', async () => {
        rpc.mockReset()
            .mockResolvedValueOnce({ data: null, error: { message: 'fetch failed' } })
            .mockResolvedValueOnce({ data: { ok: true, ya_aplicado: false }, error: null });
        expect(await cerrarPorClasificar(args)).toEqual({ ok: true, yaAplicado: false });
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('si falla las dos veces (error o excepción) responde 502 cierre_fallo y nunca lanza', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        rpc.mockReset().mockRejectedValue(new Error('red caída'));
        expect(await cerrarPorClasificar(args)).toEqual({ ok: false, codigo: 'cierre_fallo', http: 502 });
        expect(rpc).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });
});
