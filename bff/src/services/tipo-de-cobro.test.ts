/**
 * Pagos únicos (inscripción, seguro y los que vengan) en el lado de WhatsApp,
 * 2026-10-10. Todo puro: sin base ni red. Datos de ejemplo, sin personas reales.
 */
import { describe, it, expect } from 'vitest';
import {
    categoriaDelCobro, esMensualidad, esPagoUnico, etiquetaDelCobro, etiquetaCortaDelCobro, resumenDeDeuda,
} from './tipo-de-cobro';
import {
    conceptoDePago, decidirOtroConcepto, detectarOtroConcepto,
} from './whatsapp-otro-concepto.service';
import { resolverPago, type PagoPendiente } from './whatsapp-receipt-matching.service';
import { entraEnRecordatorios } from './recordatorios-cobro.service';
import { esMensualidad as esMensualidadCartera } from './informe-cartera.service';

// El alta de Dreamers del 10-oct: mensualidad (categoría NULL, como llega del
// alta) + inscripción + seguro, todo con vencimiento el día del alta.
const mensualidad: PagoPendiente = {
    id: 'm1', amount: 180000, concept: 'Plan PGX — Mensualidad completa, vence día 10 — Atleta Uno',
    due_date: '2026-10-10', child_id: 'c1', atleta: 'Atleta Uno', categoria: 'mensualidad',
};
const inscripcion: PagoPendiente = {
    id: 'i1', amount: 300000, concept: 'Inscripción — PLAN RM MENSUAL — Atleta Uno',
    due_date: '2026-10-10', child_id: 'c1', atleta: 'Atleta Uno', categoria: 'inscripcion',
};
const seguro: PagoPendiente = {
    id: 's1', amount: 35000, concept: 'Seguro de accidentes — PLAN RM MENSUAL — Atleta Uno',
    due_date: '2026-10-10', child_id: 'c1', atleta: 'Atleta Uno', categoria: 'seguro',
};
const alta = [mensualidad, inscripcion, seguro];

describe('categoriaDelCobro: la categoría manda, genérica', () => {
    it('payment_category específica gana, también una categoría nueva', () => {
        expect(categoriaDelCobro({ payment_category: 'inscripcion', payment_type: 'one_time', concept: 'Inscripción — PLAN MENSUAL' }))
            .toBe('inscripcion');
        expect(categoriaDelCobro({ payment_category: 'seguro', concept: 'Seguro de accidentes — X' })).toBe('seguro');
        expect(categoriaDelCobro({ payment_category: 'uniforme_gala', payment_type: 'one_time', concept: 'Uniforme de gala' }))
            .toBe('uniforme_gala');
    });
    it('la fila mensual del alta llega con categoría NULL y payment_type subscription → mensualidad', () => {
        expect(categoriaDelCobro({ payment_category: null, payment_type: 'subscription', concept: 'Equipo sub 11 — Ciclo 30 días' }))
            .toBe('mensualidad');
    });
    it('payment_type no es fiable: one_time con concepto de mensualidad sigue siendo mensualidad', () => {
        expect(categoriaDelCobro({ payment_category: null, payment_type: 'one_time', concept: 'Mensualidad 10/2026 - Atleta Dos' }))
            .toBe('mensualidad');
    });
    it("'otro' mira el concepto; sin pista queda 'otro'", () => {
        expect(categoriaDelCobro({ payment_category: 'otro', concept: 'Pago mensualidad octubre' })).toBe('mensualidad');
        expect(categoriaDelCobro({ payment_category: 'otro', concept: 'Rifa de fin de año' })).toBe('otro');
        expect(categoriaDelCobro({ payment_type: 'one_time', concept: 'Algo sin pista' })).toBe('otro');
    });
    it('esMensualidad / esPagoUnico', () => {
        expect(esMensualidad({ payment_type: 'subscription' })).toBe(true);
        expect(esPagoUnico({ payment_category: 'seguro' })).toBe(true);
        expect(esPagoUnico({ payment_category: 'torneo' })).toBe(true);
    });
});

describe('etiquetaDelCobro', () => {
    it('nombra cada cobro como lo entiende la familia', () => {
        expect(etiquetaDelCobro({ payment_type: 'subscription', period_year: 2026, period_month: 10 })).toBe('Mensualidad octubre 2026');
        expect(etiquetaDelCobro({ payment_type: 'subscription', due_date: '2026-11-05' })).toBe('Mensualidad noviembre 2026');
        expect(etiquetaDelCobro({ payment_category: 'inscripcion' })).toBe('Inscripción');
        expect(etiquetaDelCobro({ payment_category: 'seguro' })).toBe('Seguro de accidentes');
        expect(etiquetaDelCobro({ payment_category: 'clase_extra' })).toBe('Clase extra');
    });
    it('categoría nueva sin etiqueta: se humaniza la clave; otro: el comienzo del concepto', () => {
        expect(etiquetaDelCobro({ payment_category: 'uniforme_gala' })).toBe('Uniforme gala');
        expect(etiquetaDelCobro({ payment_category: 'otro', concept: 'Rifa de fin de año — Atleta Uno' })).toBe('Rifa de fin de año');
    });
    it('etiqueta corta para botones (≤ 9)', () => {
        expect(etiquetaCortaDelCobro({ payment_category: 'inscripcion' })).toBe('Inscrip.');
        expect(etiquetaCortaDelCobro({ payment_category: 'seguro' })).toBe('Seguro');
        expect(etiquetaCortaDelCobro({ payment_type: 'subscription', due_date: '2026-10-10' })).toBe('Oct');
        expect(etiquetaCortaDelCobro({ payment_category: 'uniforme_gala' })!.length).toBeLessThanOrEqual(9);
    });
});

describe('resumenDeDeuda', () => {
    it('suma solo lo que debe pagarse, con saldo', () => {
        const r = resumenDeDeuda([
            { debe_pagarse: true, saldo: 180000 },
            { debe_pagarse: true, saldo: 300000 },
            { debe_pagarse: true, saldo: 35000 },
            { debe_pagarse: false, saldo: 0 },
        ]);
        expect(r).toEqual({ cantidad: 3, total: 515000 });
    });
    it('sin saldo usa amount - amount_paid', () => {
        expect(resumenDeDeuda([{ debe_pagarse: true, amount: 100000, amount_paid: 40000 }]).total).toBe(60000);
    });
});

describe('comprobante del alta: mensualidad + inscripción + seguro', () => {
    it('$515.000 = los tres → combinación única (no se estampa en uno)', () => {
        const m = resolverPago(alta, 515000);
        expect(m.tipo).toBe('combinacion');
        expect((m as any).pagos.map((p: PagoPendiente) => p.id).sort()).toEqual(['i1', 'm1', 's1']);
    });
    it('el monto de UN cobro lo elige', () => {
        expect(resolverPago(alta, 35000)).toEqual({ tipo: 'por_monto', pago: seguro });
        expect(resolverPago(alta, 300000)).toEqual({ tipo: 'por_monto', pago: inscripcion });
    });
});

describe('el pie dice «seguro» / «inscripción»', () => {
    it('«seguro» en el pie es el seguro; «seguro» suelto en el chat no (es «claro que sí»)', () => {
        expect(detectarOtroConcepto({ pie: 'seguro' })?.concepto).toBe('seguro');
        expect(detectarOtroConcepto({ pie: 'pago del seguro de accidentes' })?.concepto).toBe('seguro');
        expect(detectarOtroConcepto({ chat: ['Seguro'] })).toBeNull();
        expect(detectarOtroConcepto({ pie: 'seguro que mañana pago' })).toBeNull();
    });
    it('la categoría manda sobre el texto: «Inscripción — PLAN RM MENSUAL» es inscripción', () => {
        expect(conceptoDePago(inscripcion)).toBe('inscripcion');
        expect(conceptoDePago(seguro)).toBe('seguro');
        expect(conceptoDePago(mensualidad)).toBeNull();
        // Opciones viejas sin categoría: por el texto, como antes.
        expect(conceptoDePago({ concept: 'Uniforme talla M' })).toBe('uniforme');
    });
    it('pie «seguro» + monto del seguro → ese cobro', () => {
        const d = decidirOtroConcepto(detectarOtroConcepto({ pie: 'seguro' }), alta, 35000);
        expect(d).toMatchObject({ tipo: 'aplicar', pago: { id: 's1' } });
    });
    it('pie «inscripción» + monto de la inscripción → la inscripción, aunque el plan diga MENSUAL', () => {
        const d = decidirOtroConcepto(detectarOtroConcepto({ pie: 'inscripción' }), alta, 300000);
        expect(d).toMatchObject({ tipo: 'aplicar', pago: { id: 'i1' } });
    });
    it('pie «inscripción» + $515.000 (los tres) → sigue al flujo de varios cobros, no «otro concepto sin cobro»', () => {
        expect(decidirOtroConcepto(detectarOtroConcepto({ pie: 'inscripción' }), alta, 515000)).toEqual({ tipo: 'seguir' });
    });
    it('pie «inscripción» con un monto que no cuadra con nada → a la escuela, como siempre', () => {
        expect(decidirOtroConcepto(detectarOtroConcepto({ pie: 'inscripción' }), alta, 999000).tipo).toBe('a_la_escuela');
    });
});

describe('recordatorios: solo la mensualidad (las plantillas dicen «la mensualidad de»)', () => {
    it('una fila subscription con categoría de pago único no entra', () => {
        expect(entraEnRecordatorios({ payment_type: 'subscription', payment_category: null, concept: 'Plan PRO — Mensualidad completa' })).toBe(true);
        expect(entraEnRecordatorios({ payment_type: 'subscription', payment_category: 'mensualidad' })).toBe(true);
        expect(entraEnRecordatorios({ payment_type: 'subscription', payment_category: 'inscripcion' })).toBe(false);
        expect(entraEnRecordatorios({ payment_type: 'one_time', payment_category: 'seguro' })).toBe(false);
        expect(entraEnRecordatorios({ payment_type: 'one_time', payment_category: 'torneo' })).toBe(false);
    });
});

describe('informe de cartera: el seguro va en «otros»', () => {
    it('con categoría manda la categoría; sin categoría, «Seguro…» no es mensualidad', () => {
        const base = { id: 'x', amount: 35000, status: 'overdue', due_date: '2026-10-10' } as any;
        expect(esMensualidadCartera({ ...base, payment_category: 'seguro', payment_type: 'one_time' })).toBe(false);
        expect(esMensualidadCartera({ ...base, payment_category: null, payment_type: 'subscription', concept: 'Seguro de accidentes — X' })).toBe(false);
        expect(esMensualidadCartera({ ...base, payment_category: null, payment_type: 'subscription', concept: 'Plan PRO — Mensualidad completa' })).toBe(true);
    });
});

// ─── Caracterización (plan B4 §5, 2026-10-30) ───────────────────────────────
// El catálogo único de motivos (motivos-de-cobro.ts) reemplaza las listas de
// acá: las 10 categorías del CHECK viejo tienen que salir EXACTAMENTE igual.
describe('caracterización: nombres de HOY de las categorías viejas', () => {
    const HOY: [string, string, string][] = [
        // [categoría, etiquetaDelCobro, etiquetaCortaDelCobro]
        ['inscripcion', 'Inscripción', 'Inscrip.'],
        ['articulos', 'Artículos', 'Artículos'],
        ['torneo', 'Torneo', 'Torneo'],
        ['seguro', 'Seguro de accidentes', 'Seguro'],
        ['excedente', 'Horas adicionales', 'Horas'],
        ['clase_extra', 'Clase extra', 'Clase'],
        ['vacacional', 'Vacacional', 'Vacac.'],
        ['viaje', 'Viaje', 'Viaje'],
    ];
    it.each(HOY)('%s → «%s» / «%s»', (cat, larga, corta) => {
        expect(etiquetaDelCobro({ payment_category: cat })).toBe(larga);
        expect(etiquetaCortaDelCobro({ payment_category: cat })).toBe(corta);
    });

    it('mensualidad (por periodo) y otro (por concepto) como hoy', () => {
        expect(etiquetaDelCobro({ payment_category: 'mensualidad', period_year: 2026, period_month: 10 })).toBe('Mensualidad octubre 2026');
        expect(etiquetaCortaDelCobro({ payment_category: 'mensualidad', period_year: 2026, period_month: 10 })).toBe('Oct');
        expect(etiquetaDelCobro({ payment_category: 'otro', concept: 'Rifa navideña — Atleta Uno' })).toBe('Rifa navideña');
        expect(etiquetaCortaDelCobro({ payment_category: 'otro', concept: 'Rifa navideña' })).toBe('Otro');
        expect(etiquetaDelCobro({ payment_category: 'otro', concept: null })).toBe('Otro cobro');
        expect(etiquetaDelCobro({ payment_category: 'uniforme_gala' })).toBe('Uniforme gala');
        expect(etiquetaCortaDelCobro({ payment_category: 'uniforme_gala' })).toBe('Uniforme');
    });
});

describe('motivos nuevos del catálogo único (2026-10-30)', () => {
    it('clase de prueba: «Clase de prueba» / «Prueba» (antes «Clase», igual que la clase extra)', () => {
        expect(etiquetaDelCobro({ payment_category: 'clase_prueba' })).toBe('Clase de prueba');
        expect(etiquetaCortaDelCobro({ payment_category: 'clase_prueba' })).toBe('Prueba');
        expect(etiquetaCortaDelCobro({ payment_category: 'clase_extra' })).toBe('Clase');
    });

    it('reserva: «Reserva»', () => {
        expect(etiquetaDelCobro({ payment_category: 'reserva' })).toBe('Reserva');
        expect(etiquetaCortaDelCobro({ payment_category: 'reserva' })).toBe('Reserva');
        expect(esPagoUnico({ payment_category: 'reserva' })).toBe(true);
    });
});
