import { describe, expect, it } from 'vitest';
import {
    camposDeCategoria,
    conceptoDeServicios,
    conceptoDisponible,
    conceptoInicial,
    esConceptoDeCarrito,
    itemDeServicio,
    lineasDeServicio,
    motivoDelConcepto,
    opcionesDeCheckout,
    primeraQueResponda,
    tiposConItems,
    totalDeServicios,
    type ConceptoCheckout,
    type DisponibilidadCheckout,
} from './checkoutConcepto';

const DISP: DisponibilidadCheckout = {
    conceptoMensualidad: 'Plan Sub-12',
    montoPlan: 180_000,
    permiteAbonos: true,
    hayArticulos: true,
    tiposDeServicio: [],
};

describe('opciones de «Tipo de Pago» (salidas de hoy)', () => {
    it('las de siempre, con los mismos textos y en el mismo orden', () => {
        expect(opcionesDeCheckout({ ...DISP, tiposDeServicio: ['torneo'] })).toEqual([
            { value: 'mensualidad', label: 'Mensualidad (Plan Sub-12)' },
            { value: 'inscripcion_fija', label: 'Inscripción Anual (Monto Fijo)' },
            { value: 'inscripcion_variable', label: 'Inscripción Anual (Monto Variable)' },
            { value: 'otro', label: 'Otro Concepto / Abono libre' },
            { value: 'articulos', label: 'Artículos Deportivos' },
            { value: 'servicio:torneo', label: 'Torneos' },
        ]);
    });

    it('escuela sin abonos ni tarifa ni catálogos (Dynasty): solo la mensualidad', () => {
        expect(opcionesDeCheckout({ ...DISP, montoPlan: 0, permiteAbonos: false, hayArticulos: false }).map((o) => o.value))
            .toEqual(['mensualidad']);
    });

    it('un servicio por tipo presente en el catálogo (bug L8: antes todo era «Torneos»)', () => {
        expect(opcionesDeCheckout({ ...DISP, permiteAbonos: false, tiposDeServicio: ['otro', 'vacacional', 'clase_extra', 'torneo', 'viaje'] })
            .filter((o) => o.value.startsWith('servicio:'))).toEqual([
            { value: 'servicio:torneo', label: 'Torneos' },
            { value: 'servicio:clase_extra', label: 'Clases extra y clínicas' },
            { value: 'servicio:vacacional', label: 'Vacacionales' },
            { value: 'servicio:viaje', label: 'Viajes' },
            { value: 'servicio:otro', label: 'Otros servicios' },
        ]);
    });
});

describe('categoría del cobro que inserta el modal, desde el catálogo', () => {
    it.each([
        ['mensualidad', 'mensualidad', false],
        ['inscripcion_fija', 'inscripcion', true],
        ['inscripcion_variable', 'inscripcion', true],
        ['otro', 'otro', true],
        ['articulos', 'articulos', true],
        ['servicio:torneo', 'torneo', true],
        ['servicio:clase_extra', 'clase_extra', true],
        ['servicio:vacacional', 'vacacional', true],
        ['servicio:viaje', 'viaje', true],
        ['servicio:otro', 'otro', true],
    ] as [ConceptoCheckout, string, boolean][])('%s → %s (exento: %s)', (concepto, categoria, exento) => {
        expect(motivoDelConcepto(concepto)).toBe(categoria);
        expect(camposDeCategoria(concepto)).toEqual({ payment_category: categoria, period_uniqueness_exempt: exento });
    });

    it('carrito = artículos o servicios', () => {
        expect(esConceptoDeCarrito('articulos')).toBe(true);
        expect(esConceptoDeCarrito('servicio:viaje')).toBe(true);
        expect(esConceptoDeCarrito('otro')).toBe(false);
        expect(esConceptoDeCarrito('mensualidad')).toBe(false);
    });
});

describe('motivo preseleccionado (enlace de cobro)', () => {
    it.each([
        [undefined, 180_000, 'mensualidad'],
        ['mensualidad', 180_000, 'mensualidad'],
        ['inscripcion', 180_000, 'inscripcion_fija'],
        ['inscripcion', 0, 'inscripcion_variable'],
        ['inscripcion_variable', 180_000, 'inscripcion_variable'],
        ['articulos', 0, 'articulos'],
        ['torneo', 0, 'servicio:torneo'],
        ['clase_extra', 0, 'servicio:clase_extra'],
        ['vacacional', 0, 'servicio:vacacional'],
        ['otro', 0, 'otro'],
        ['seguro', 0, 'mensualidad'],
        ['clase_prueba', 0, 'mensualidad'],
        ['reserva', 0, 'mensualidad'],
    ] as const)('%s (tarifa %s) → %s', (motivo, monto, esperado) => {
        expect(conceptoInicial(motivo, monto)).toBe(esperado);
    });

    it('si la escuela no lo ofrece: su equivalente o la primera opción', () => {
        const sinAbonos = opcionesDeCheckout({ ...DISP, permiteAbonos: false, tiposDeServicio: ['otro', 'torneo'] });
        expect(conceptoDisponible('servicio:torneo', sinAbonos)).toBe('servicio:torneo');
        expect(conceptoDisponible('servicio:vacacional', sinAbonos)).toBe('mensualidad');
        expect(conceptoDisponible('otro', sinAbonos)).toBe('servicio:otro');
        const sinTarifa = opcionesDeCheckout({ ...DISP, montoPlan: 0 });
        expect(conceptoDisponible('inscripcion_fija', sinTarifa)).toBe('inscripcion_variable');
        expect(conceptoDisponible('articulos', [])).toBe('mensualidad');
    });
});

describe('carrito de servicios', () => {
    const CATALOGO = [
        itemDeServicio({ id: 't1', name: 'Copa Halloween', price: 50_000, kind: 'torneo' }),
        itemDeServicio({ id: 'c1', name: 'Clínica de armadores', price: 300_000, kind: 'clase_extra', precio_afiliado: 250_000, precios_por_fecha: [{ desde: '2026-11-10', precio: 350_000 }] }),
        itemDeServicio({
            id: 'v1', name: 'Vacacional Suba', price: 100_000, kind: 'vacacional',
            opciones: [{ clave: '1_semana', etiqueta: '1 semana', precio: 100_000, precio_afiliado: 80_000 }, { clave: '2_semanas', etiqueta: '2 semanas', precio: 140_000, precio_afiliado: 120_000 }],
        }),
        itemDeServicio({ id: 'x1', name: 'Viejo sin kind', price: 10_000 }),
    ];

    it('sin kind (F0 sin aplicar) es torneo, como antes', () => {
        expect(CATALOGO[3].kind).toBe('torneo');
        expect(tiposConItems(CATALOGO)).toEqual(['torneo', 'clase_extra', 'vacacional']);
    });

    it('solo cuenta lo elegido del tipo en pantalla, con precio de afiliado y opción', () => {
        const sel = { t1: { qty: 2, opcion: null }, c1: { qty: 1, opcion: null }, v1: { qty: 1, opcion: '2_semanas' } };
        const ctx = { afiliado: true, hoy: '2026-11-12' };
        const clinica = lineasDeServicio(CATALOGO, sel, 'clase_extra', ctx);
        expect(clinica.map((l) => [l.item.id, l.precio])).toEqual([['c1', 250_000]]);
        expect(totalDeServicios(clinica)).toBe(250_000);
        expect(conceptoDeServicios('clase_extra', clinica)).toBe('Clases extra y clínicas: Clínica de armadores x1');

        const vac = lineasDeServicio(CATALOGO, sel, 'vacacional', ctx);
        expect(totalDeServicios(vac)).toBe(120_000);
        expect(conceptoDeServicios('vacacional', vac)).toBe('Vacacionales: Vacacional Suba (2 semanas) x1');

        const torneos = lineasDeServicio(CATALOGO, sel, 'torneo', ctx);
        expect(totalDeServicios(torneos)).toBe(100_000);
        expect(conceptoDeServicios('torneo', torneos)).toBe('Torneos: Copa Halloween x2');
        expect(conceptoDeServicios('torneo', [])).toBe('Torneos: sin seleccionar');
        expect(lineasDeServicio(CATALOGO, sel, null, ctx)).toEqual([]);
    });
});

describe('primeraQueResponda', () => {
    it('salta las consultas que fallan (columna inexistente) y para en la primera buena', async () => {
        const llamadas: string[] = [];
        const r = await primeraQueResponda<string[]>([
            async () => { llamadas.push('m2'); return { data: null, error: { code: '42703' } }; },
            async () => { llamadas.push('f0'); return { data: ['ok'], error: null }; },
            async () => { llamadas.push('base'); return { data: ['no'], error: null }; },
        ]);
        expect(r).toEqual(['ok']);
        expect(llamadas).toEqual(['m2', 'f0']);
        expect(await primeraQueResponda([async () => ({ data: null, error: 'x' })])).toBeNull();
    });
});
