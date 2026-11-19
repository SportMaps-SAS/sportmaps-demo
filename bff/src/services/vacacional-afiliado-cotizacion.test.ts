/**
 * Vacacional de Monster's (2026-11-18): la ficha tiene precio de externo y de afiliado por opción, pero el bot solo
 * cotizaba el de lista. Un afiliado pagaba lo suyo ($120.000 por 2 semanas), el comprobante no cuadraba y caía a la bandeja.
 * Cubre: el texto «Valores» con los dos precios, y el chequeo del monto contra el valor de afiliado.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: vi.fn() }, supabaseAnon: {} }));

import { precioDelServicio, lineasDeValor, type ItemConFicha } from './whatsapp-anuncio-destino';
import { lineasDeValorDeVenta } from './whatsapp-venta-servicio';
import { decidirMontoDeVenta, valorDeAfiliadoQueCoincide } from './wa-cobro-desde-comprobante.service';
import { textoVentaAfiliadoSinVerificar } from '../jobs/whatsapp-queue.job';

const VACACIONAL = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: null,
    active: true, event_id: null, starts_at: null, ends_at: '2099-12-31T00:00:00Z',
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
        { clave: '4', etiqueta: '4 semanas', precio: 200000, precio_afiliado: 170000 },
    ],
} as unknown as ItemConFicha;
const HOY = '2026-11-18';
const AHORA = Date.parse(`${HOY}T10:00:00-05:00`);

describe('vacacional: el texto de «Valores» dice los dos precios', () => {
    it('a quien no es afiliado: lista y, entre paréntesis, el de afiliado de la misma opción', () => {
        const l = lineasDeValorDeVenta(precioDelServicio(VACACIONAL, { afiliado: false, hoy: HOY }));
        expect(l).toEqual([
            'Valores:',
            '• 1 semana: *$100.000* (afiliados *$80.000*)',
            '• 2 semanas: *$140.000* (afiliados *$120.000*)',
            '• 3 semanas: *$170.000* (afiliados *$150.000*)',
            '• 4 semanas: *$200.000* (afiliados *$170.000*)',
        ]);
        expect(lineasDeValor(precioDelServicio(VACACIONAL, { afiliado: false, hoy: HOY }))).toEqual(l);
    });

    it('a un afiliado reconocido: solo el suyo, como «de afiliado»', () => {
        const l = lineasDeValorDeVenta(precioDelServicio(VACACIONAL, { afiliado: true, hoy: HOY }));
        expect(l).toEqual(['Valores de afiliado:', '• 1 semana: *$80.000*', '• 2 semanas: *$120.000*', '• 3 semanas: *$150.000*', '• 4 semanas: *$170.000*']);
    });

    it('opción sin precio de afiliado: queda como estaba (sin paréntesis)', () => {
        const item = { ...VACACIONAL, opciones: [{ clave: '1', etiqueta: '1 semana', precio: 100000 }, { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 }] } as unknown as ItemConFicha;
        const l = lineasDeValorDeVenta(precioDelServicio(item, { afiliado: false, hoy: HOY }));
        expect(l[1]).toBe('• 1 semana: *$100.000*');
        expect(l[2]).toBe('• 2 semanas: *$140.000* (afiliados *$120.000*)');
    });

    it('opciones sin ningún precio de afiliado: idéntico a antes', () => {
        const item = { ...VACACIONAL, opciones: [{ clave: '1', etiqueta: '1 semana', precio: 100000 }] } as unknown as ItemConFicha;
        expect(lineasDeValorDeVenta(precioDelServicio(item, { afiliado: false, hoy: HOY }))).toEqual(['Valores:', '• 1 semana: *$100.000*']);
    });
});

describe('vacacional: el monto de afiliado ya no es un «monto no cuadra» anónimo', () => {
    it('afiliado reconocido paga $120.000: completo, opción 2 (la RPC cobra lo mismo)', () => {
        expect(decidirMontoDeVenta(120000, VACACIONAL, { ahora: AHORA, afiliado: true }))
            .toMatchObject({ tipo: 'completo', precio: { monto: 120000, opcion: '2' } });
    });

    it('NO afiliado paga $140.000: completo, opción 2 (lista)', () => {
        expect(decidirMontoDeVenta(140000, VACACIONAL, { ahora: AHORA, afiliado: false }))
            .toMatchObject({ tipo: 'completo', precio: { monto: 140000, opcion: '2' } });
    });

    it('número NO reconocido como afiliado paga $120.000: nunca «completo» (la RPC cobraría $140.000); se reconoce el valor de afiliado', () => {
        const d = decidirMontoDeVenta(120000, VACACIONAL, { ahora: AHORA, afiliado: false });
        expect(d.tipo).toBe('no_cuadra');
        expect(d).toMatchObject({ afiliadoCoincide: { monto: 120000, etiqueta: 'Vacacional de voleibol — Sede Suba — 2 semanas' } });
    });

    it('±$1 también cuenta; un monto que no es de ninguno sigue sin coincidir', () => {
        expect(valorDeAfiliadoQueCoincide(VACACIONAL, 119999, AHORA)).toMatchObject({ monto: 120000 });
        expect(valorDeAfiliadoQueCoincide(VACACIONAL, 125000, AHORA)).toBeNull();
        expect(decidirMontoDeVenta(125000, VACACIONAL, { ahora: AHORA, afiliado: false })).toEqual({ tipo: 'no_cuadra', precios: [100000, 140000, 170000, 200000], minimo: null });
    });

    it('servicio sin precio de afiliado: nada que reconocer', () => {
        const sin = { ...VACACIONAL, opciones: [{ clave: '2', etiqueta: '2 semanas', precio: 140000 }] } as unknown as ItemConFicha;
        expect(valorDeAfiliadoQueCoincide(sin, 120000, AHORA)).toBeNull();
    });

    it('el texto al usuario explica que es tarifa de afiliado y que la escuela lo confirma', () => {
        const t = textoVentaAfiliadoSinVerificar(120000, 'Vacacional de voleibol — Sede Suba — 2 semanas');
        expect(t).toContain('$120.000');
        expect(t).toContain('valor de afiliado');
        expect(t).toContain('la escuela confirma que ya entrenas en el club');
    });
});
