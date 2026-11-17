/**
 * Auditoría 1–16 nov 2026 (lo que quedó fuera de la cola): métricas que cuentan `payment_receipt` sin mirar el estado,
 * recuperación que vuelve a tomar los `sin_pendientes: pagó…`, huellas con quién pagó, y las reglas puras de los abonos
 * de un servicio juzgados por la fecha de pago y la afiliación (Monster, clínica).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: () => ({}) } }));

import { clasificarComprobante } from './whatsapp-metricas';
import { esRecuperable, MOTIVOS_DEL_WORKER_REPROCESABLES } from './whatsapp-recuperacion.service';
import { huellasDelComprobante } from './whatsapp-excedente.service';
import {
    textoMinimosEnFecha, sumaDeAbonosDeServicio, propuestaSumaDeAbonos, textoSumaDeAbonos, propuestaDeCobroPrevio,
    type MinimosEnFecha,
} from './wa-cola-reglas';

describe('métricas: `payment_receipt` es «aplicado» sin importar el estado de la fila', () => {
    it('R9/R11 dejan la fila `ignored`, pero el comprobante SIGUE en el cobro', () => {
        expect(clasificarComprobante({ status: 'ignored', result_type: 'payment_receipt' }, { status: 'awaiting_approval' })).toBe('esperando_revision');
        expect(clasificarComprobante({ status: 'ignored', result_type: 'payment_receipt' }, { status: 'paid', approved_by: 'admin-1' })).toBe('aprobado_por_escuela');
        expect(clasificarComprobante({ status: 'ignored', result_type: 'payment_receipt' }, { status: 'paid' })).toBe('aprobado_solo');
        expect(clasificarComprobante({ status: 'ignored', result_type: 'payment_receipt' }, { status: 'rejected' })).toBe('rechazado');
    });
    it('lo de siempre no cambia', () => {
        expect(clasificarComprobante({ status: 'done', result_type: 'payment_receipt' }, { status: 'awaiting_approval' })).toBe('esperando_revision');
        expect(clasificarComprobante({ status: 'ignored', result_type: 'escalated' })).toBe('escalado');
        expect(clasificarComprobante({ status: 'ignored', result_type: 'none' })).toBe('ignorado');
        expect(clasificarComprobante({ status: 'failed' })).toBe('fallido');
        expect(clasificarComprobante({ status: 'done', result_type: 'none' })).toBe('matricula');
    });
});

describe('recuperación: las filas nuevas `sin_pendientes: pagó…` se vuelven a tomar con --reprocesar', () => {
    const fila = (error_message: string) => ({ status: 'ignored', error_message, media_id: 'm1' });
    it('el worker ahora cierra «sin_pendientes: pagó $180.000 y no tiene cobros abiertos…»: igual que el texto viejo', () => {
        expect(MOTIVOS_DEL_WORKER_REPROCESABLES).toContain('sin pagos pendientes');
        expect(esRecuperable(fila('sin pagos pendientes'), true)).toBe(true);
        expect(esRecuperable(fila('sin_pendientes: pagó $180.000 y no tiene cobros abiertos: puede ser otro concepto o un mes que no se ha generado | Propuesta → pagó: Luz'), true)).toBe(true);
        expect(esRecuperable(fila('sin_pendientes: pagó $180.000 y no tiene cobros abiertos…'), false)).toBe(false);   // sin --reprocesar, nunca
    });
    it('el `sin_pendientes:` de «la familia dijo el mes» NO se vuelve a tomar (ya trae su propuesta; lo decide la escuela)', () => {
        expect(esRecuperable(fila('sin_pendientes: Samuel Ríos no tiene cobro de noviembre 2026 · comprobante de $180.000'), true)).toBe(false);
    });
    it('una fila cerrada por la escuela no se toca', () => {
        expect(esRecuperable(fila('cerrado_escuela: resuelto — ya está (por admin-a) | sin_pendientes: pagó $180.000…'), true)).toBe(false);
    });
});

describe('huellas del comprobante: quién pagó, la nota y el titular del destino', () => {
    const OCR = {
        amount: 180000, reference: 'M1234567', destination: '3001112222', date: '2026-11-03', bank: 'Nequi',
        originName: 'Carolina Amórtegui', description: '  Mensualidad   Isabella ', destinationName: 'Club SAS', rawText: 'texto crudo con datos de terceros',
    };
    it('guarda pagador, nota (recortada) y titular; el texto crudo NO se guarda', () => {
        const h = huellasDelComprobante({ sha: 'abc', ocr: OCR as any, storagePath: 's/f1.jpg', parentId: 'p1' }) as any;
        expect(h.ocr).toMatchObject({
            amount: 180000, reference: 'M1234567', destination: '3001112222', date: '2026-11-03', bank: 'Nequi',
            originName: 'Carolina Amórtegui', description: 'Mensualidad Isabella', destinationName: 'Club SAS',
        });
        expect(JSON.stringify(h)).not.toContain('texto crudo');
        expect(h).toMatchObject({ sha: 'abc', storagePath: 's/f1.jpg', parentId: 'p1', referencias: expect.any(Array) });
    });
    it('la bandeja sigue leyendo lo de siempre (sha y referencias)', () => {
        const h = huellasDelComprobante({ sha: 'abc', ocr: { ...OCR, originName: undefined, description: undefined } as any }) as any;
        expect(h.ocr.originName).toBeNull();
        expect(h.ocr.description).toBeNull();
        expect(h.referencias).toContain('M1234567');
    });
    it('sin sha ni lectura: nada', () => {
        expect(huellasDelComprobante({ sha: null, ocr: null })).toBeNull();
    });
});

// ─── Abonos de la clínica (valores reales de Monster, 2026-11-16) ────────────────────────────────────────────────────

describe('abonos de un servicio: explicar los mínimos y proponer la suma', () => {
    const EL_10: MinimosEnFecha = { fecha: '2026-11-10', noAfiliado: { total: 300000, minimo: 150000 }, afiliado: { total: 250000, minimo: 125000 } };
    const EL_11: MinimosEnFecha = { fecha: '2026-11-11', noAfiliado: { total: 350000, minimo: 175000 }, afiliado: { total: 250000, minimo: 125000 } };

    it('textoMinimosEnFecha: los dos mínimos y el saldo_hasta; «hoy» en presente', () => {
        expect(textoMinimosEnFecha(EL_11, '2026-11-20', '2026-11-17'))
            .toBe('en la fecha del pago (2026-11-11) el abono mínimo era $175.000 (precio $350.000) si no es afiliado o $125.000 (precio $250.000) si es afiliado; el saldo se paga hasta el 2026-11-20');
        expect(textoMinimosEnFecha(EL_11, null, '2026-11-11')).toBe('hoy (2026-11-11) el abono mínimo es $175.000 (precio $350.000) si no es afiliado o $125.000 (precio $250.000) si es afiliado');
        expect(textoMinimosEnFecha({ fecha: '2026-11-11', noAfiliado: null, afiliado: null }, '2026-11-20')).toBe('el saldo se paga hasta el 2026-11-20');
        expect(textoMinimosEnFecha({ fecha: '2026-11-11', noAfiliado: null, afiliado: null }, null)).toBe('');
    });

    it('dos de $100.000 (10-nov y 12-nov) suman $200.000: alcanza el mínimo de no afiliado del 10-nov ($150.000)', () => {
        const r = sumaDeAbonosDeServicio({ previos: [{ id: 'f1', monto: 100000, fecha: '2026-11-10' }], monto: 100000, minimosPrimera: EL_10, afiliado: null });
        expect(r).toMatchObject({ suma: 200000, nivel: 'abono', conAfiliado: false, minimo: 150000, total: 300000, afiliadoSinConfirmar: false });
        expect(propuestaSumaDeAbonos(r!, 'Clínica de armadores y atacantes'))
            .toBe('sumar 2 comprobantes del mismo contacto para Clínica de armadores y atacantes ($100.000 (2026-11-10) + este = $200.000): '
                + 'alcanza el abono mínimo de no afiliado ($150.000) vigente el 2026-11-10; si la escuela lo confirma, registrar el abono por la suma (filas f1). No se aplica solo');
        expect(textoSumaDeAbonos(100000, r!, 'de la *Clínica de armadores y atacantes*'))
            .toBe('Recibí tu comprobante de *$100.000* 📄 Con lo que enviaste antes (*$100.000*) suman *$200.000* de la *Clínica de armadores y atacantes*; la escuela lo revisa y te confirma por aquí.');
    });

    it('la suma alcanza solo el mínimo de afiliado y no se sabe si lo es: se propone, pidiendo verificarlo', () => {
        // $60.000 + $70.000 = $130.000: ≥ $125.000 (afiliado) pero < $150.000 (no afiliado)
        const r = sumaDeAbonosDeServicio({ previos: [{ id: 'f1', monto: 60000, fecha: '2026-11-10' }], monto: 70000, minimosPrimera: EL_10, afiliado: null });
        expect(r).toMatchObject({ conAfiliado: true, afiliadoSinConfirmar: true, minimo: 125000 });
        expect(propuestaSumaDeAbonos(r!, 'Clínica')).toContain('(solo si es afiliado: verificarlo)');
        // Sabiendo que NO es afiliado, no alcanza.
        expect(sumaDeAbonosDeServicio({ previos: [{ id: 'f1', monto: 60000, fecha: null }], monto: 70000, minimosPrimera: EL_10, afiliado: false })).toBeNull();
    });

    it('la suma que llega al precio completo se dice como precio completo', () => {
        const r = sumaDeAbonosDeServicio({ previos: [{ id: 'f1', monto: 150000, fecha: '2026-11-10' }], monto: 150000, minimosPrimera: EL_10, afiliado: false });
        expect(r).toMatchObject({ nivel: 'completo', total: 300000 });
        expect(propuestaSumaDeAbonos(r!, 'Clínica')).toContain('alcanza el precio completo ($300.000)');
    });

    it('no alcanza el mínimo, o no hay anteriores: null', () => {
        expect(sumaDeAbonosDeServicio({ previos: [{ id: 'f1', monto: 100000, fecha: null }], monto: 20000, minimosPrimera: EL_10, afiliado: null })).toBeNull();
        expect(sumaDeAbonosDeServicio({ previos: [], monto: 200000, minimosPrimera: EL_10, afiliado: null })).toBeNull();
    });

    it('propuestaDeCobroPrevio: el cobro previo parcial del mismo contacto y lo que quedaría', () => {
        const previo = { id: 'pay-1', amount: 350000, amountPaid: 100000, ocrAmount: 100000, status: 'partial' };
        expect(propuestaDeCobroPrevio({ previo, monto: 150000 }))
            .toBe('ya tiene el cobro pay-1 de $350.000 con $100.000 abonados: sumando este comprobante de $150.000 serían $250.000 (faltarían $100.000); sumarlo al mismo cobro, no crear otro');
        expect(propuestaDeCobroPrevio({ previo: { ...previo, status: 'awaiting_approval', amountPaid: 0 }, monto: 250000 }))
            .toContain('con $100.000 en revisión: sumando este comprobante de $250.000 serían $350.000 (el cobro completo)');
        expect(propuestaDeCobroPrevio({ previo: { ...previo, status: 'pending', amountPaid: 0, ocrAmount: null }, monto: 150000 })).toBeNull();
    });
});
