/**
 * Bandeja de comprobantes: clasificación por motivo, cierre por la escuela y
 * qué filas se cierran solas. Puro, sin base.
 */
import { describe, expect, it, vi } from 'vitest';

// Solo para importar `esRecuperable` sin tocar la base.
vi.mock('../config/supabase', () => ({ supabase: { from: () => ({}) } }));

import {
    clasificarFila, estaCerrada, filasParaAutocierre, marcaDeCierre, motivoDeFila, referenciaUsada,
    resumenDeGrupos, PREFIJO_CERRADA, type PagoMinimo,
} from './whatsapp-bandeja.service';

const fila = (status: string, error_message: string | null, extra: Record<string, any> = {}) =>
    ({ id: 'q', status, error_message, ...extra });

describe('motivoDeFila / clasificarFila', () => {
    it.each([
        ['recuperado: varios_cobros — 2 cobros pendientes y ni el monto…', 'varios_cobros', 'accion'],
        ['recuperado: monto_distinto — leído 25000', 'monto_distinto', 'accion'],
        ['recuperado: sin_familia — el número no está en ninguna ficha', 'sin_familia', 'accion'],
        ['recuperado: destino_ajeno — el dinero fue a 52784471', 'destino_ajeno', 'accion'],
        ['recuperado: otro_concepto — uniforme', 'otro_concepto', 'accion'],
        ['familia_sin_cuenta', 'familia_sin_cuenta', 'accion'],
        ['destino no es de la escuela', 'destino_ajeno', 'accion'],
        ['otro_concepto: Uniforme (pie: «uniforme»)', 'otro_concepto', 'accion'],
        ['pregunta_vencida: la familia no dijo a qué cobro va en 24 h; aplicarlo a mano', 'pregunta_vencida', 'accion'],
        ['recuperado: sin_pendientes — la familia no tiene cobros pendientes', 'sin_pendientes', 'revisar'],
        ['sin pagos pendientes', 'sin_pendientes', 'revisar'],
        ['contacto_no_atendido', 'contacto_no_atendido', 'revisar'],
        ['bot_apagado', 'bot_apagado', 'revisar'],
        ['recuperado: no_es_comprobante — el archivo no es un comprobante', 'no_es_comprobante', 'informativo'],
        ['no es un comprobante', 'no_es_comprobante', 'informativo'],
        ['no_es_comprobante_sin_contexto', 'no_es_comprobante', 'informativo'],
        ['consulta_no_comprobante:texto', 'no_es_comprobante', 'informativo'],
        ['recuperado: ya_registrado — ya hay un pago paid de 180000', 'ya_registrado', 'informativo'],
        ['referencia ya usada: M123', 'ya_registrado', 'informativo'],
        ['admin no acudiente, comprobante no aplicado', 'enviado_por_equipo', 'informativo'],
    ])('%s → %s / %s', (em, motivo, grupo) => {
        const c = clasificarFila(fila('ignored', em));
        expect(c.motivo).toBe(motivo);
        expect(c.grupo).toBe(grupo);
        expect(c.etiqueta.length).toBeGreaterThan(3);
    });

    it('failed sin motivo conocido pide acción; waiting_user es para revisar', () => {
        expect(clasificarFila(fila('failed', 'no se entendió la elección; va al inbox')).grupo).toBe('accion');
        expect(clasificarFila(fila('waiting_user', null)).motivo).toBe('esperando_familia');
        expect(clasificarFila(fila('waiting_user', null)).grupo).toBe('revisar');
    });

    it('el detalle de la recuperación se separa del código', () => {
        expect(motivoDeFila(fila('ignored', 'recuperado: monto_distinto — leído 150000: MAYOR que X')).detalle)
            .toBe('leído 150000: MAYOR que X');
    });

    it('contacto personal o del equipo baja un escalón', () => {
        expect(clasificarFila(fila('ignored', 'contacto_no_atendido'), 'personal').grupo).toBe('informativo');
        expect(clasificarFila(fila('ignored', 'recuperado: sin_familia — x'), 'personal').grupo).toBe('revisar');
        expect(clasificarFila(fila('ignored', 'destino no es de la escuela'), 'staff').grupo).toBe('revisar');
        // Una familia no baja.
        expect(clasificarFila(fila('ignored', 'familia_sin_cuenta'), 'familia_sin_cuenta').grupo).toBe('accion');
    });

    it('resumen cuenta por grupo', () => {
        const r = resumenDeGrupos([
            clasificarFila(fila('ignored', 'familia_sin_cuenta')),
            clasificarFila(fila('ignored', 'no es un comprobante')),
            clasificarFila(fila('ignored', 'no es un comprobante')),
            clasificarFila(fila('waiting_user', null)),
        ]);
        expect(r).toEqual({ accion: 1, revisar: 1, informativo: 2, total: 4 });
    });
});

describe('cierre por la escuela', () => {
    it('la marca conserva el motivo original y se reconoce como cerrada', () => {
        const m = marcaDeCierre('descartado', 'foto personal | de la familia', 'abcdef12-3456', 'contacto_no_atendido');
        expect(m.startsWith(PREFIJO_CERRADA)).toBe(true);
        expect(m).toContain('descartado — foto personal / de la familia (por abcdef12)');
        expect(m.endsWith('| contacto_no_atendido')).toBe(true);
        expect(estaCerrada(m)).toBe(true);
        expect(estaCerrada('recuperado: ya_registrado — x')).toBe(false);
        expect(estaCerrada(null)).toBe(false);
    });

    it('una fila cerrada no es recuperable por la recuperación', async () => {
        const { esRecuperable } = await import('./whatsapp-recuperacion.service');
        const m = marcaDeCierre('resuelto', 'lo registré en Pagos', 'u', 'recuperado: varios_cobros — x');
        expect(esRecuperable({ status: 'ignored', error_message: m, media_id: 'm' }, true)).toBe(false);
    }, 30_000); // el import dinámico del servicio arrastra el bot y tarda ~5 s en frío
});

describe('filasParaAutocierre', () => {
    const S = 'school-a';
    const pago = (id: string, status: string, school_id = S, ocr_reference: string | null = null): PagoMinimo =>
        ({ id, status, school_id, concept: 'Mensualidad 10/2026', ocr_reference });

    it('cierra ya_registrado con pago vivo de la escuela; deja anulados, ajenos y otros motivos', () => {
        const filas = [
            fila('ignored', 'recuperado: ya_registrado — ya hay un pago paid', { id: 'ok', result_ref_id: 'p1' }),
            fila('ignored', 'recuperado: ya_registrado — x', { id: 'anulado', result_ref_id: 'p2' }),
            fila('ignored', 'recuperado: ya_registrado — x', { id: 'ajeno', result_ref_id: 'p3' }),
            fila('ignored', 'recuperado: varios_cobros — x', { id: 'varios', result_ref_id: 'p1' }),
            fila('ignored', 'referencia ya usada: REF9', { id: 'ref' }),
            fila('ignored', marcaDeCierre('resuelto', 'x', null, 'recuperado: ya_registrado — x'), { id: 'cerrada', result_ref_id: 'p1' }),
        ];
        const porId = new Map([
            ['p1', pago('p1', 'paid')], ['p2', pago('p2', 'cancelled')], ['p3', pago('p3', 'paid', 'school-b')],
        ]);
        const porRef = new Map([['REF9', pago('p9', 'awaiting_approval', S, 'REF9')]]);
        const r = filasParaAutocierre(S, filas, porId, porRef).map((x) => x.fila.id);
        expect(r).toEqual(['ok', 'ref']);
    });

    it('referenciaUsada lee la referencia del worker', () => {
        expect(referenciaUsada('referencia ya usada: 8e7040c3-0461')).toBe('8e7040c3-0461');
        expect(referenciaUsada('no es un comprobante')).toBeNull();
    });
});

// ─── Auditoría de producción 1–16 nov 2026: códigos con plata que caían en «Sin clasificar» / «revisar» (22 filas) ──

describe('códigos con plata: etiqueta clara y grupo correcto (R3)', () => {
    it.each([
        // prefijo «sin_pendientes:» (antes solo se reconocía el texto exacto «sin pagos pendientes»)
        ['sin_pendientes: pagó $180.000 y no tiene cobros abiertos: puede ser otro concepto o un mes que no se ha generado | Propuesta → pagó: Luz Ríos', 'sin_pendientes_con_pago', 'accion', 'Pagó y no tiene cobros abiertos'],
        ['sin_pendientes: Samuel Ríos no tiene cobro de noviembre 2026 · comprobante de $180.000 | Propuesta → deportista: Samuel Ríos · mes: noviembre 2026', 'sin_pendientes_con_pago', 'accion', 'Pagó y no tiene cobros abiertos'],
        ['excedente_de_parcial: La familia mandó $145.000; Mensualidad 11/2026 tiene un saldo de $125.000', 'excedente_de_parcial', 'accion', 'Pagó más que el saldo del cobro'],
        ['saldo_de_parcial: La familia mandó $80.000 como saldo de Mensualidad 10/2026', 'saldo_de_parcial', 'accion', 'Es el saldo de un cobro abonado'],
        ['prospecto_sin_concepto: Andrea López mandó $370.000 a 3001112222; el monto no corresponde a un precio de la escuela', 'prospecto_sin_concepto', 'accion', 'Pago de un prospecto: falta saber de qué es'],
        ['prospecto_con_cantidad: Andrea López mandó $370.000; cuadra con varias unidades de un artículo', 'prospecto_sin_concepto', 'accion', 'Pago de un prospecto: falta saber de qué es'],
        ['limite_ocr: limite_numero', 'limite_ocr', 'accion', 'No se leyó (tope de lecturas): revisarlo a mano'],
        ['limite_ocr: limite_escuela', 'limite_ocr', 'accion', 'No se leyó (tope de lecturas): revisarlo a mano'],
        ['familia_sin_cuenta: la ficha no tiene cobros pendientes', 'familia_sin_cuenta', 'accion', 'Familia sin cuenta en la app'],
        ['familia_sin_cuenta: la ficha no tiene cobros pendientes | Propuesta → pagó: Luz Ríos · deportista: Samuel Ríos', 'familia_sin_cuenta', 'accion', 'Familia sin cuenta en la app'],
        // ya registrado: informativo (no hay plata por aplicar)
        ['ya registrado: Mensualidad 10/2026', 'ya_registrado', 'informativo', 'El pago ya estaba registrado'],
        ['numero_sin_verificar: comprobante repetido (misma imagen)', 'duplicado', 'informativo', 'Comprobante repetido (misma imagen)'],
        // venta_* que faltaban
        ['venta_monto_no_cuadra: comprobante de $120.000 para Clínica; el valor de hoy es $300.000', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        ['venta_sin_monto: comprobante para Clínica sin monto leído', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        ['venta_destino_no_confirmado: comprobante de $300.000 para Clínica a un destino sin leer', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        ['venta_ya_tiene_cobro: Nicolás ya tiene el cobro de Clínica', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        ['venta_saldo_con_abono_en_revision: saldo de $150.000 de Clínica', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        ['venta_tramo_por_fecha_de_pago: $300.000 pagados el 2026-11-01 para Clínica', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        ['venta_cobro_abierto_monto: $100.000 para Clínica; el cobro abierto de la escuela es de $175.000', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        ['venta_sin_cupos: Clínica · $300.000 · la base respondió sin_cupos', 'venta_servicio', 'accion', 'Pago de un servicio por registrar'],
        // los de las reglas nuevas
        ['torneo_o_club: $900.000 que parece de un torneo o de un club · dijo: «Inscripción del equipo Halcones sub 15»', 'torneo_o_club', 'accion', 'Pago de torneo o de un club'],
        ['pago_partido: $9.000 + $81.000 = $90.000, el valor de Mensualidad 11/2026 (llegó en 2 comprobantes)', 'pago_partido', 'accion', 'Pago partido en varios comprobantes'],
        ['monto_distinto_aplicado: comprobante de $197.000 aplicado a Mensualidad 10/2026, que vale $180.000 ($17.000 de más): revisar antes de aprobar', 'monto_distinto_aplicado', 'accion', 'Se aplicó, pero el monto no es el del cobro'],
        ['reclamo_del_cliente: la familia corrige el mes o el concepto (dice noviembre): «Ahora estoy pagando noviembre»', 'reclamo_del_cliente', 'accion', 'La familia corrigió o reclamó el resultado'],
        ['varios_cobros: la familia eligió 2 cobros por un solo comprobante: repartirlo a mano', 'varios_cobros', 'accion', 'Hay varios cobros posibles'],
        ['motivo_esperado_no_coincide (monto): se esperaba clase de prueba por $15.000 y llegó $20.000', 'motivo_esperado', 'accion', 'Pago de un prospecto que no coincide con lo esperado'],
        ['ocr_omitido: ráfaga de imágenes de un contacto sin ficha', 'ocr_omitido', 'revisar', 'No se leyó: ráfaga de imágenes de un número sin ficha'],
    ])('%s → %s (%s)', (em, motivo, grupo, etiqueta) => {
        const c = clasificarFila(fila('ignored', em, { result_type: 'escalated' }));
        expect(c).toMatchObject({ motivo, grupo, etiqueta });
        expect(c.etiqueta).not.toBe('Sin clasificar');
    });

    it('el archivo que no se pudo abrir (fila failed) dice por qué', () => {
        expect(clasificarFila(fila('failed', 'archivo_muy_grande:9400000'))).toMatchObject({ grupo: 'accion', motivo: 'archivo_no_leido' });
        expect(clasificarFila(fila('failed', 'mime_no_soportado:image/gif'))).toMatchObject({ grupo: 'accion', motivo: 'archivo_no_leido' });
    });

    it('los que se comparan por igualdad exacta siguen igual', () => {
        expect(motivoDeFila(fila('ignored', 'sin pagos pendientes')).motivo).toBe('sin_pendientes');
        expect(motivoDeFila(fila('ignored', 'contacto_no_atendido')).motivo).toBe('contacto_no_atendido');
        expect(motivoDeFila(fila('ignored', 'familia_sin_cuenta')).motivo).toBe('familia_sin_cuenta');
        expect(motivoDeFila(fila('ignored', 'destino no es de la escuela')).motivo).toBe('destino_ajeno');
    });

    it('el detalle conserva el monto y la propuesta (sin el código)', () => {
        const c = clasificarFila(fila('ignored', 'sin_pendientes: pagó $180.000 y no tiene cobros abiertos | Propuesta → pagó: Luz Ríos'));
        expect(c.detalle).toBe('pagó $180.000 y no tiene cobros abiertos | Propuesta → pagó: Luz Ríos');
    });

    it('«ya registrado:» con su cobro registrado se cierra solo en el barrido (antes quedaba abierta en «Sin clasificar»)', () => {
        const f = fila('ignored', 'ya registrado: Mensualidad 10/2026', { result_ref_id: 'p1' });
        const pagos = new Map<string, PagoMinimo>([['p1', { id: 'p1', school_id: 's1', status: 'paid', concept: 'Mensualidad 10/2026' }]]);
        expect(filasParaAutocierre('s1', [f], pagos, new Map())).toHaveLength(1);
    });

    it('una fila aplicada con otro monto (ignored + payment_receipt) conserva su grupo aunque el contacto esté marcado «también es familia»', () => {
        const f = fila('ignored', 'monto_distinto_aplicado: comprobante de $708.000 aplicado a Mensualidad 10/2026, que vale $180.000', { result_type: 'payment_receipt', result_ref_id: 'p1' });
        expect(clasificarFila(f, 'personal', true).grupo).toBe('accion');
    });
});
