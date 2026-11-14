import { describe, expect, it } from 'vitest';
import {
    FORMULARIO_VACIO,
    abonoMinimo,
    abonoMinimoPct,
    claveDeEtiqueta,
    etiquetasDePrecios,
    fechaCorta,
    columnasDePrecios,
    formularioDePrecios,
    parseOpciones,
    parsePesos,
    parsePreciosPorFecha,
    precioDeServicio,
    precioGeneralEn,
    type FormularioDePrecios,
} from './preciosDeServicio';

/** La clínica de Monster (2026-10-30): $250.000 afiliados, preventa $300.000, desde el 10-nov $350.000, cupo con 50 %. */
const CLINICA = {
    price: 300_000,
    precio_afiliado: 250_000,
    precios_por_fecha: [{ desde: '2026-11-10', precio: 350_000 }],
    abono_minimo_pct: 50,
};

/** El vacacional de Suba: por semanas, afiliados y externos. */
const VACACIONAL = {
    price: 100_000,
    opciones: [
        { clave: '1_semana', etiqueta: '1 semana', precio: 100_000, precio_afiliado: 80_000 },
        { clave: '2_semanas', etiqueta: '2 semanas', precio: 140_000, precio_afiliado: 120_000 },
        { clave: '3_semanas', etiqueta: '3 semanas', precio: 170_000, precio_afiliado: 150_000 },
        { clave: '4_semanas', etiqueta: '4 semanas', precio: 200_000, precio_afiliado: 170_000 },
    ],
};

describe('precioDeServicio', () => {
    it('clínica: afiliado siempre $250.000; externo $300.000 en preventa y $350.000 desde el 10-nov', () => {
        expect(precioDeServicio(CLINICA, { afiliado: true, hoy: '2026-11-01' })).toBe(250_000);
        expect(precioDeServicio(CLINICA, { afiliado: true, hoy: '2026-11-15' })).toBe(250_000);
        expect(precioDeServicio(CLINICA, { afiliado: false, hoy: '2026-11-09' })).toBe(300_000);
        expect(precioDeServicio(CLINICA, { afiliado: false, hoy: '2026-11-10' })).toBe(350_000);
    });

    it('vacacional: el precio de la opción, de afiliado o de externo', () => {
        expect(precioDeServicio(VACACIONAL, { afiliado: true, hoy: '2026-11-01', opcion: '2_semanas' })).toBe(120_000);
        expect(precioDeServicio(VACACIONAL, { afiliado: false, hoy: '2026-11-01', opcion: '4_semanas' })).toBe(200_000);
        // Opción desconocida → precio del ítem.
        expect(precioDeServicio(VACACIONAL, { afiliado: false, hoy: '2026-11-01', opcion: 'nada' })).toBe(100_000);
    });

    it('sin los campos nuevos (migración sin aplicar) es el precio de siempre', () => {
        expect(precioDeServicio({ price: 50_000 }, { afiliado: true, hoy: '2026-11-01' })).toBe(50_000);
        expect(precioDeServicio({ price: 50_000, precio_afiliado: null, opciones: 'basura', precios_por_fecha: {} }, { afiliado: true, hoy: '2026-11-01' })).toBe(50_000);
    });

    it('opción sin precio de afiliado: el afiliado paga el de la opción', () => {
        const item = { price: 1, opciones: [{ clave: 'a', etiqueta: 'A', precio: 9_000 }] };
        expect(precioDeServicio(item, { afiliado: true, hoy: '2026-01-01', opcion: 'a' })).toBe(9_000);
    });

    it('varios cambios por fecha: manda el último ya vigente', () => {
        const item = { price: 10, precios_por_fecha: [{ desde: '2026-12-01', precio: 30 }, { desde: '2026-11-01', precio: 20 }] };
        expect(precioGeneralEn(item, '2026-10-31')).toBe(10);
        expect(precioGeneralEn(item, '2026-11-20')).toBe(20);
        expect(precioGeneralEn(item, '2026-12-01')).toBe(30);
    });
});

describe('lectura tolerante de los jsonb', () => {
    it('opciones: descarta filas sin nombre o sin precio y claves repetidas', () => {
        expect(parseOpciones([
            { etiqueta: '1 semana', precio: 1 },
            { etiqueta: '', precio: 2 },
            { etiqueta: 'Sin precio' },
            { clave: '1_semana', etiqueta: 'Repetida', precio: 3 },
            null,
            { etiqueta: 'Texto', precio: '4000', precio_afiliado: 'x' },
        ])).toEqual([
            { clave: '1_semana', etiqueta: '1 semana', precio: 1, precio_afiliado: null },
            { clave: 'texto', etiqueta: 'Texto', precio: 4000, precio_afiliado: null },
        ]);
        expect(parseOpciones(null)).toEqual([]);
    });

    it('precios por fecha: ordena y descarta fechas inválidas', () => {
        expect(parsePreciosPorFecha([
            { desde: '2026-12-01', precio: 2 },
            { desde: '2026-02-30', precio: 9 },
            { desde: '2026-11-01T05:00:00Z', precio: 1 },
            { desde: '2026-12-01', precio: 3 },
        ])).toEqual([{ desde: '2026-11-01', precio: 1 }, { desde: '2026-12-01', precio: 2 }]);
    });

    it('abono: 1–100 o nada; el valor se redondea hacia arriba', () => {
        expect(abonoMinimoPct({ abono_minimo_pct: 50 })).toBe(50);
        expect(abonoMinimoPct({ abono_minimo_pct: 0 })).toBeNull();
        expect(abonoMinimoPct({ abono_minimo_pct: null })).toBeNull();
        expect(abonoMinimo(300_000, 50)).toBe(150_000);
        expect(abonoMinimo(15_001, 50)).toBe(7_501);
        expect(abonoMinimo(300_000, null)).toBeNull();
    });

    it('pesos y claves', () => {
        expect(parsePesos('$250.000')).toBe(250_000);
        expect(parsePesos('250,000')).toBe(250_000);
        expect(parsePesos('  ')).toBeNull();
        expect(parsePesos('12a')).toBeNaN();
        expect(claveDeEtiqueta('2 Semanas — Niños')).toBe('2_semanas_ninos');
        expect(claveDeEtiqueta('¡!')).toBe('opcion');
    });
});

describe('lo que muestra la lista del catálogo', () => {
    it('resume afiliados, opciones, cambios por fecha y abono', () => {
        expect(etiquetasDePrecios(CLINICA)).toEqual(['Afiliados $250.000', 'Desde 10 nov: $350.000', 'Abono 50 %']);
        expect(etiquetasDePrecios(VACACIONAL)).toEqual(['4 opciones']);
        expect(etiquetasDePrecios({ price: 1 })).toEqual([]);
        expect(fechaCorta('2026-01-05')).toBe('5 ene');
        expect(fechaCorta('basura')).toBe('basura');
    });
});

describe('formulario del editor ↔ columnas', () => {
    const form = (p: Partial<FormularioDePrecios>): FormularioDePrecios => ({ ...FORMULARIO_VACIO, opciones: [], preciosPorFecha: [], ...p });

    it('vacío = sin ajustes (todo null)', () => {
        expect(columnasDePrecios(form({}))).toEqual({
            ok: true,
            columnas: { precio_afiliado: null, opciones: null, precios_por_fecha: null, abono_minimo_pct: null },
        });
    });

    it('la clínica de Monster', () => {
        const r = columnasDePrecios(form({
            precioAfiliado: '250.000',
            preciosPorFecha: [{ desde: '2026-11-10', precio: '350.000' }, { desde: '', precio: '' }],
            abonoPct: '50',
        }));
        expect(r).toEqual({
            ok: true,
            columnas: {
                precio_afiliado: 250_000,
                opciones: null,
                precios_por_fecha: [{ desde: '2026-11-10', precio: 350_000 }],
                abono_minimo_pct: 50,
            },
        });
    });

    it('opciones: genera la clave, conserva la existente y no repite', () => {
        const r = columnasDePrecios(form({
            opciones: [
                { clave: 'una', etiqueta: '1 semana', precio: '100000', precioAfiliado: '80000' },
                { etiqueta: '2 semanas', precio: '140.000', precioAfiliado: '' },
                { etiqueta: '', precio: '', precioAfiliado: '' },
            ],
        }));
        expect(r.ok && r.columnas.opciones).toEqual([
            { clave: 'una', etiqueta: '1 semana', precio: 100_000, precio_afiliado: 80_000 },
            { clave: '2_semanas', etiqueta: '2 semanas', precio: 140_000, precio_afiliado: null },
        ]);
    });

    it.each([
        [{ precioAfiliado: 'abc' }, 'El precio para afiliados debe ser un número.'],
        [{ opciones: [{ etiqueta: '', precio: '1', precioAfiliado: '' }] }, 'Cada opción necesita un nombre, p. ej. «1 semana».'],
        [{ opciones: [{ etiqueta: '1 semana', precio: '', precioAfiliado: '' }] }, 'Falta el precio de «1 semana».'],
        [{ opciones: [{ etiqueta: 'A', precio: '1', precioAfiliado: '' }, { etiqueta: 'a', precio: '2', precioAfiliado: '' }] }, 'La opción «a» está repetida.'],
        [{ preciosPorFecha: [{ desde: '', precio: '5' }] }, 'Elige la fecha desde la que cambia el precio.'],
        [{ preciosPorFecha: [{ desde: '2026-11-10', precio: '' }] }, 'Falta el precio desde el 2026-11-10.'],
        [{ abonoPct: '0' }, 'El abono debe ser un porcentaje entre 1 y 100.'],
        [{ abonoPct: '150' }, 'El abono debe ser un porcentaje entre 1 y 100.'],
    ] as [Partial<FormularioDePrecios>, string][])('error en español: %j', (parcial, error) => {
        expect(columnasDePrecios(form(parcial))).toEqual({ ok: false, error });
    });

    it('ida y vuelta: lo guardado se puede volver a editar igual', () => {
        const f = formularioDePrecios({ ...CLINICA, ...VACACIONAL, price: 1 });
        expect(f.precioAfiliado).toBe('250000');
        expect(f.abonoPct).toBe('50');
        expect(f.opciones).toHaveLength(4);
        const r = columnasDePrecios(f);
        expect(r.ok && r.columnas.opciones).toEqual(VACACIONAL.opciones);
        expect(r.ok && r.columnas.precios_por_fecha).toEqual(CLINICA.precios_por_fecha);
        expect(formularioDePrecios(null)).toEqual(form({}));
    });
});
