/**
 * Coherencia de la ficha libre contra el catálogo (frente B, 2026-11-08). La
 * ficha vieja de Monster decía «Preventa: $300.000 hasta el 9 de noviembre.
 * Desde el 10 de noviembre: $350.000»; el catálogo, tramo desde el 11.
 */
import { describe, it, expect } from 'vitest';
import {
    auditarFichaContraCatalogo, esEncabezado, permitidosDeTextoLibre,
} from './whatsapp-coherencia-ficha';
import type { ItemConFicha } from './whatsapp-anuncio-destino';

const HOY = '2026-11-08';
const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00+00:00', ends_at: '2026-11-23T04:59:00+00:00',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null,
    description: '💰 Inversión: *$300.000.* Valor de preventa hasta el 10 de noviembre\n\nValor neto después del 10 de noviembre *$350.000*\n\nquienes adquieran su cupo desde ahora conservarán el valor de *$300.000*, incluso si debemos modificar la fecha del evento.',
};
const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional',
    price: 100000, active: true, event_id: null, starts_at: '2026-11-17T13:00:00+00:00', ends_at: '2026-12-10T16:00:00+00:00',
    allow_installments: false, precio_afiliado: null, precios_por_fecha: null, abono_minimo_pct: null,
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
        { clave: '4', etiqueta: '4 semanas', precio: 200000, precio_afiliado: 170000 },
    ],
};
const ITEMS = [CLINICA, VACACIONAL];

/** Partes del club de la ficha real de Monster (no deben dar falsos avisos). */
const CLUB = [
    "CLUB DEPORTIVO MONSTER'S VOLLEY · Vive y respira Volley 🏐",
    '',
    'VALORES 2026',
    '• Matrícula 2026: $310.000 en las dos sedes. Incluye el kit de uniforme oficial de competencia.',
    '• Uniformes de entrenamiento: $60.000 (2 camisetas), en las dos sedes.',
    '• Mensualidad Sede Norte: $165.000.',
    '• Mensualidad Sede Suba: $145.000. Mayores Mixto: $135.000 (sin coliseo).',
    '',
    '🎁 REGALO DE CIERRE DE AÑO (Sede Norte y Sede Suba)',
    '¿Cuánto pagas para ingresar? Solo $370.000 (matrícula $310.000 + uniformes de entrenamiento $60.000).',
    'A finales de enero renuevas la matrícula por solo $170.000, porque no incluye la sudadera.',
    '',
    'CLASE DE PRUEBA',
    '• Para empezar en el club se agenda una clase de prueba, que cuesta $15.000.',
    '• En la Sede Norte la clase de prueba es sábado o domingo de 8:00 a 10:00 a. m.',
    '• Para agendarla se paga por Nequi o Daviplata al 319 450 5150 y se envía el comprobante por este chat.',
].join('\n');

const VACACIONAL_FICHA = [
    '🏐 VACACIONAL DE VOLEIBOL · SEDE SUBA (si preguntan por el vacacional, comparte esta información con este tono)',
    '📍 Parque Pinar de Suba 2',
    '📅 Del 17 de noviembre al 10 de diciembre',
    '⏰ 8:00 a. m. a 11:00 a. m.',
    "💰 Afiliados a Monster's Volley: 1 semana $80.000 · 2 semanas $120.000 · 3 semanas $150.000 · 4 semanas $170.000.",
    '💰 Deportistas externos: 1 semana $100.000 · 2 semanas $140.000 · 3 semanas $170.000 · 4 semanas $200.000.',
].join('\n');

const clinica = (valores: string[]) => [
    '🏐 CLÍNICA DE ARMADORES Y ATACANTES (para deportistas del club y de fuera).',
    'Dirigida por Jorge Mesa, armador de la Selección Colombia ⭐',
    '📅 21 y 22 de noviembre (dos jornadas; el valor incluye las dos)',
    '🕘 9:00 a. m. a 3:00 p. m.',
    '👥 Hombres y mujeres desde 14 años; menores con experiencia en la posición también pueden ir.',
    '💰 Valores:',
    ...valores,
    '💳 Nequi o Daviplata 319 450 5150, a nombre de Iván Sossa (también por llave).',
].join('\n');

const FICHA_VIEJA = [CLUB, '', clinica([
    '• Afiliados al club: $250.000.',
    '• Preventa: $300.000 hasta el 9 de noviembre.',
    '• Desde el 10 de noviembre: $350.000.',
    '• Separas tu cupo con el 50 % de la preventa ($150.000) y se te mantiene el precio.',
]), '', VACACIONAL_FICHA, '', 'PAGOS Y MATRÍCULA', '• Todos los pagos (clase de prueba, matrícula, clínica y vacacional) se hacen por Nequi al 319 450 5150.'].join('\n');

const FICHA_CORREGIDA = FICHA_VIEJA
    .replace('• Preventa: $300.000 hasta el 9 de noviembre.', '• Preventa: $300.000 hasta el martes 10 de noviembre.')
    .replace('• Desde el 10 de noviembre: $350.000.', '• Desde el miércoles 11 de noviembre: $350.000.');

describe('auditarFichaContraCatalogo', () => {
    it('la ficha vieja de Monster: «hasta el 9» y «desde el 10» contradicen el catálogo (desde el 11)', () => {
        const c = auditarFichaContraCatalogo(FICHA_VIEJA, ITEMS, { hoy: HOY });
        expect(c).toHaveLength(2);
        expect(c[0]).toMatchObject({
            fuente: 'ficha', tipo: 'fecha_de_precio', servicioId: CLINICA.id,
            dice: 'Preventa: $300.000 hasta el 9 de noviembre',
            catalogo: 'hasta el martes 10 de noviembre ($300.000; desde el miércoles 11 de noviembre, $350.000)',
        });
        expect(c[0].mensaje).toBe('Tu texto para el asistente dice “Preventa: $300.000 hasta el 9 de noviembre”; '
            + 'el catálogo de Clínica de armadores y atacantes dice hasta el martes 10 de noviembre ($300.000; desde el miércoles 11 de noviembre, $350.000).');
        expect(c[1]).toMatchObject({
            tipo: 'fecha_de_precio', dice: 'Desde el 10 de noviembre: $350.000',
            catalogo: 'desde el miércoles 11 de noviembre, $350.000 (hasta el martes 10 de noviembre, $300.000)',
        });
        // Cada aviso apunta a su línea de la ficha.
        const lineas = FICHA_VIEJA.split('\n');
        expect(lineas[c[0].linea - 1]).toContain('hasta el 9 de noviembre');
        expect(lineas[c[1].linea - 1]).toContain('Desde el 10 de noviembre');
    });

    it('la ficha corregida no da avisos (ni por la matrícula, la clase de prueba o el vacacional)', () => {
        expect(auditarFichaContraCatalogo(FICHA_CORREGIDA, ITEMS, { hoy: HOY })).toEqual([]);
    });

    it('un precio que el catálogo no tiene, en una línea de la sección de la clínica', () => {
        const ficha = FICHA_CORREGIDA.replace('• Preventa: $300.000 hasta el martes 10 de noviembre.', '• Preventa: $280.000 hasta el martes 10 de noviembre.');
        const c = auditarFichaContraCatalogo(ficha, ITEMS, { hoy: HOY });
        expect(c).toEqual([expect.objectContaining({
            tipo: 'monto', servicioId: CLINICA.id, dice: 'Preventa: $280.000 hasta el martes 10 de noviembre',
            catalogo: '$300.000 hasta el martes 10 de noviembre; desde el miércoles 11, $350.000',
        })]);
    });

    it('una preventa en un servicio que no tiene tramos por fecha', () => {
        const ficha = VACACIONAL_FICHA + '\n• Precio especial de $100.000 la semana hasta el 15 de noviembre.';
        const c = auditarFichaContraCatalogo(ficha, ITEMS, { hoy: HOY });
        expect(c).toEqual([expect.objectContaining({ tipo: 'fecha_de_precio', servicioId: VACACIONAL.id })]);
        expect(c[0].catalogo).toBe('no tiene cambio de precio por fecha (valor: $100.000)');
    });

    it('la descripción del ítem contra sus propios precios', () => {
        expect(auditarFichaContraCatalogo(CLINICA.description, ITEMS, { hoy: HOY, fuente: 'descripcion', itemFijo: CLINICA })).toEqual([]);
        const mala = 'Valor de preventa $300.000 hasta el 12 de noviembre';
        const c = auditarFichaContraCatalogo(mala, ITEMS, { hoy: HOY, fuente: 'descripcion', itemFijo: CLINICA });
        expect(c[0].mensaje).toMatch(/^La descripción de Clínica de armadores y atacantes dice “Valor de preventa \$300\.000 hasta el 12 de noviembre”; los precios del catálogo dicen hasta el martes 10 de noviembre/);
    });

    it('sin ficha o sin catálogo no hay nada que auditar', () => {
        expect(auditarFichaContraCatalogo(null, ITEMS)).toEqual([]);
        expect(auditarFichaContraCatalogo(FICHA_VIEJA, [])).toEqual([]);
    });

    it('encabezados', () => {
        expect(esEncabezado('VALORES 2026')).toBe(true);
        expect(esEncabezado('🎁 REGALO DE CIERRE DE AÑO (Sede Norte y Sede Suba)')).toBe(true);
        expect(esEncabezado('• Preventa: $300.000 hasta el 9 de noviembre.')).toBe(false);
        expect(esEncabezado('🕘 9:00 a. m. a 3:00 p. m.')).toBe(false);
    });
});

describe('permitidosDeTextoLibre', () => {
    it('lo de la ficha que no contradice queda permitido; la línea del «hasta el 9», no', () => {
        const p = permitidosDeTextoLibre(FICHA_VIEJA, ITEMS, { hoy: HOY });
        expect(p.montos.has(370000)).toBe(true);   // matrícula + uniformes
        expect(p.montos.has(15000)).toBe(true);    // clase de prueba
        expect(p.cortes.has('11-10')).toBe(false); // «hasta el 9» / «desde el 10»
        const ok = permitidosDeTextoLibre(FICHA_CORREGIDA, ITEMS, { hoy: HOY });
        expect(ok.cortes.has('11-11')).toBe(true);
    });
});
