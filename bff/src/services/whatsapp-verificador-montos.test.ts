/**
 * Verificador de montos y fechas de precio (frente B del blindaje de ventas de
 * servicio, 2026-11-08). Los textos son los reales de Monster: la ficha que decía
 * «hasta el 9 de noviembre», la descripción de la clínica y sus preguntas.
 */
import { describe, it, expect } from 'vitest';
import {
    extraerMontos, extraerFechasDePrecio, verificarSalida, permitidosDelCatalogo, permitidosDeTexto, unirPermitidos,
    conNumerosIgnorados, montosDelItem, cortesDelItem, describirViolaciones,
} from './whatsapp-verificador-montos';
import type { ItemConFicha } from './whatsapp-anuncio-destino';

const HOY = '2026-11-08';
const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null,
};
const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional',
    price: 100000, active: true, event_id: null, starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-12-10T16:00:00Z',
    allow_installments: false, precio_afiliado: null, precios_por_fecha: null, abono_minimo_pct: null,
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
        { clave: '4', etiqueta: '4 semanas', precio: 200000, precio_afiliado: 170000 },
    ],
};

const valores = (t: string) => extraerMontos(t).map((m) => m.valor);

describe('extraerMontos', () => {
    it('reconoce las formas en que se escribe la plata', () => {
        expect(valores('Inversión: *$300.000.* y desde el 11, $350.000')).toEqual([300000, 350000]);
        expect(valores('Separas con $ 150.000 o 150 mil, o 150000, o 150k')).toEqual([150000, 150000, 150000, 150000]);
        expect(valores('vale 300.000 pesos')).toEqual([300000]);
        expect(valores('$300,000')).toEqual([300000]);
        expect(valores('un millón o $1,5 millones')).toEqual([1000000, 1500000]);
        expect(valores('$300 mil')).toEqual([300000]);
    });

    it('no confunde horas, años, edades, porcentajes, teléfonos ni direcciones', () => {
        expect(valores('🕘 9:00 a. m. a 3:00 p. m., de 8 a 11')).toEqual([]);
        expect(valores('Categorías 2015-2016, año 2026')).toEqual([]);
        expect(valores('Hombres y mujeres de 14 años en adelante')).toEqual([]);
        expect(valores('Separas con el 50 % de la preventa')).toEqual([]);
        expect(valores('Nequi 3194505150, también 319 450 5150 o +57 319 4505150')).toEqual([]);
        expect(valores('Av. El Polo, Cl. 201 #67-12; Cl. 152 #94A-67')).toEqual([]);
        expect(valores('Informes: 318 868 2241')).toEqual([]);
        expect(valores('mapa https://maps.app.goo.gl/E3w7yzGCZ300000')).toEqual([]);
        expect(valores('21 y 22 de noviembre')).toEqual([]);
    });

    it('una cuenta de 7 cifras de la escuela no es un monto (solo sin signo)', () => {
        expect(extraerMontos('Cuenta 1234567', { ignorarNumeros: ['1234567'] })).toEqual([]);
        expect(extraerMontos('Cuesta $1.234.567', { ignorarNumeros: ['1234567'] }).map((m) => m.valor)).toEqual([1234567]);
    });
});

describe('extraerFechasDePrecio', () => {
    it('el caso Monster: «hasta el 9» y «desde el 10» → corte del 10 de noviembre', () => {
        const f = extraerFechasDePrecio('Preventa: $300.000 hasta el 9 de noviembre. Desde el 10 de noviembre: $350.000', { hoy: HOY });
        expect(f.map((x) => [x.tipo, x.declarada, x.corte])).toEqual([['hasta', '11-09', '11-10'], ['desde', '11-10', '11-10']]);
    });

    it('lo correcto según el catálogo: «hasta el martes 10», «desde el miércoles 11», «después del 10», «antes del 11»', () => {
        const textos = [
            '$300.000 hasta el martes 10 de noviembre; desde el miércoles 11, $350.000',
            'Valor de preventa hasta el 10 de noviembre. Valor neto después del 10 de noviembre $350.000',
            'La preventa de $300.000 aplica antes del 11 de noviembre',
            'Desde el 11 cuesta $350.000',
        ];
        for (const t of textos) {
            const f = extraerFechasDePrecio(t, { hoy: HOY });
            expect(f.length, t).toBeGreaterThan(0);
            expect(new Set(f.map((x) => x.corte)), t).toEqual(new Set(['11-11']));
        }
    });

    it('el mes que falta sale de la fecha anterior del texto', () => {
        const f = extraerFechasDePrecio('El 21 de noviembre es la clínica. Cuesta $300.000 hasta el 10 y luego $350.000', { hoy: HOY });
        expect(f.map((x) => x.corte)).toEqual(['11-11']);
    });

    it('no son fechas de precio: días del evento, rangos, edades, horas, semanas, frases sin plata', () => {
        expect(extraerFechasDePrecio('Este 21 y 22 de noviembre, dos jornadas. Inversión $300.000', { hoy: HOY })).toEqual([]);
        expect(extraerFechasDePrecio('📅 Del 17 de noviembre al 10 de diciembre · 1 semana $100.000', { hoy: HOY })).toEqual([]);
        expect(extraerFechasDePrecio('Vale $100.000 desde el 17 de noviembre hasta el 10 de diciembre', { hoy: HOY })).toEqual([]);
        expect(extraerFechasDePrecio('Desde 14 años; cuesta $300.000', { hoy: HOY })).toEqual([]);
        expect(extraerFechasDePrecio('Cuesta $300.000, de 9:00 a. m. hasta las 3:00 p. m.', { hoy: HOY })).toEqual([]);
        expect(extraerFechasDePrecio('Hasta 4 semanas por $200.000', { hoy: HOY })).toEqual([]);
        expect(extraerFechasDePrecio('Te esperamos desde el 21 de noviembre en el coliseo', { hoy: HOY })).toEqual([]);
    });
});

describe('verificarSalida', () => {
    const permitidos = conNumerosIgnorados(
        unirPermitidos(
            permitidosDelCatalogo([CLINICA, VACACIONAL], { afiliado: false }),
            permitidosDeTexto('La clase de prueba vale $15.000', '• Mensualidad Sede Norte: *$165.000*'),
        ),
        ['3194505150'],
    );

    it('lo que dice el catálogo pasa', () => {
        const ok = [
            'La preventa es de *$300.000* hasta el martes 10 de noviembre; desde el miércoles 11, $350.000.',
            'Separas el cupo con $150.000 (50 %) y el resto ($150.000) queda pendiente. Nequi 3194505150 a nombre de Iván Sossa.',
            'Es el sábado 21 y domingo 22 de noviembre, de 9:00 a. m. a 3:00 p. m., para hombres y mujeres desde 14 años.',
            'El vacacional va del 17 de noviembre al 10 de diciembre: 1 semana $100.000, 4 semanas $200.000.',
            'La clínica va hasta el 22 de noviembre y vale $300.000.',
            'La clase de prueba vale $15.000 y la mensualidad de Norte $165.000.',
        ];
        for (const t of ok) expect(verificarSalida(t, permitidos, { hoy: HOY }), t).toEqual({ ok: true });
    });

    it('la fecha de la ficha vieja («hasta el 9 de noviembre») no sale', () => {
        const r = verificarSalida('La preventa es de $300.000 hasta el 9 de noviembre.', permitidos, { hoy: HOY });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.violaciones).toEqual([expect.objectContaining({ tipo: 'fecha_de_precio', corte: '11-10' })]);
            expect(describirViolaciones(r.violaciones)).toContain('hasta el 9 de noviembre');
        }
    });

    it('un monto inventado no sale (descuento, precio de afiliado a quien no es del club)', () => {
        const r1 = verificarSalida('Te queda en $280.000 si pagas hoy', permitidos, { hoy: HOY });
        expect(r1).toEqual({ ok: false, violaciones: [{ tipo: 'monto', valor: 280000, texto: '$280.000' }] });
        const r2 = verificarSalida('Para afiliados son $250.000', permitidos, { hoy: HOY });
        expect(r2.ok).toBe(false);
        // Con el número de una familia, el de afiliado sí está en los datos.
        const deFamilia = permitidosDelCatalogo([CLINICA], { afiliado: true });
        expect(verificarSalida('Tu valor como afiliado es $250.000', deFamilia, { hoy: HOY })).toEqual({ ok: true });
    });
});

describe('montos y cortes del ítem', () => {
    it('precio, tramos, abono y saldo; afiliado solo si toca', () => {
        expect([...montosDelItem(CLINICA, { afiliado: false })].sort()).toEqual([150000, 175000, 300000, 350000].sort());
        expect(montosDelItem(CLINICA, { afiliado: true })).toEqual(new Set([250000, 125000]));
        expect(montosDelItem(CLINICA, { afiliado: 'todos' }).has(250000)).toBe(true);
        expect(cortesDelItem(CLINICA)).toEqual(new Set(['11-11']));
    });
    it('opciones del vacacional con y sin afiliado', () => {
        expect(montosDelItem(VACACIONAL, { afiliado: false })).toEqual(new Set([100000, 140000, 170000, 200000]));
        expect(montosDelItem(VACACIONAL, { afiliado: true })).toEqual(new Set([80000, 120000, 150000, 170000]));
    });
});
