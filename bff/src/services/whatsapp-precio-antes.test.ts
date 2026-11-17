/**
 * «antes $X» al cotizar un servicio (2026-11-15): aparece SOLO cuando el precio que rige hoy es
 * menor que el que regía justo antes de que empezara el tramo de hoy. Todo sale del catálogo
 * (`price`, `precios_por_fecha`, `precio_afiliado`, `precios_afiliado_por_fecha`). Datos inventados.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import { precioAntesDelTramo, precioDelServicio, lineasDeValor, type ItemConFicha } from './whatsapp-anuncio-destino';
import { lineasDeValorDeVenta } from './whatsapp-venta-servicio';
import { fichaDeServicioParaIa } from './whatsapp-catalogo-para-ia';

/** Clínica: $350.000 de lista; del 17 al 20 de noviembre, 5 % de descuento; el 21 vuelve a $350.000. */
const CLINICA: ItemConFicha = {
    id: 'srv-clinica', name: 'Clínica de armadores', kind: 'clase_extra', price: 350000, active: true,
    event_id: null, starts_at: '2026-11-28T05:00:00Z', ends_at: '2026-11-30T04:59:00Z',
    allow_installments: false, precio_afiliado: 250000,
    precios_por_fecha: [{ desde: '2026-11-17', precio: 332500 }, { desde: '2026-11-21', precio: 350000 }],
    precios_afiliado_por_fecha: [{ desde: '2026-11-17', precio: 237500 }, { desde: '2026-11-21', precio: 250000 }],
    abono_minimo_pct: null, opciones: null, description: null, image_url: null,
} as ItemConFicha;

const en = (hoy: string, afiliado = false, item: ItemConFicha = CLINICA) => precioDelServicio(item, { afiliado, hoy });

describe('precioAntesDelTramo', () => {
    it('antes del primer tramo rige el precio base: no hubo uno anterior', () => {
        expect(precioAntesDelTramo(CLINICA, { afiliado: false, hoy: '2026-11-16' })).toBeNull();
        expect(en('2026-11-16')).not.toHaveProperty('antes');
    });
    it('en el tramo con descuento: el precio base que regía la víspera', () => {
        expect(precioAntesDelTramo(CLINICA, { afiliado: false, hoy: '2026-11-17' })).toBe(350000);
        expect(en('2026-11-20')).toMatchObject({ hoy: 332500, antes: 350000, siguiente: { desde: '2026-11-21', precio: 350000 } });
    });
    it('cuando el precio SUBE (fin de la preventa o del descuento) no hay «antes»', () => {
        expect(precioAntesDelTramo(CLINICA, { afiliado: false, hoy: '2026-11-21' })).toBeNull();
        expect(en('2026-11-25')).not.toHaveProperty('antes');
        const preventa = { ...CLINICA, price: 300000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }] } as ItemConFicha;
        expect(en('2026-11-12', false, preventa)).not.toHaveProperty('antes');
    });
    it('el anterior a un segundo tramo es el tramo previo, no el precio base', () => {
        const item = { ...CLINICA, price: 400000,
            precios_por_fecha: [{ desde: '2026-11-10', precio: 350000 }, { desde: '2026-11-17', precio: 332500 }] } as ItemConFicha;
        expect(precioAntesDelTramo(item, { afiliado: false, hoy: '2026-11-18' })).toBe(350000);
        expect(precioAntesDelTramo(item, { afiliado: false, hoy: '2026-11-12' })).toBe(400000);
    });
    it('mismo precio que antes, sin tramos, o sin precio base: nada', () => {
        expect(en('2026-11-18', false, { ...CLINICA, precios_por_fecha: [{ desde: '2026-11-17', precio: 350000 }] } as ItemConFicha)).not.toHaveProperty('antes');
        expect(en('2026-11-18', false, { ...CLINICA, precios_por_fecha: null } as ItemConFicha)).not.toHaveProperty('antes');
        expect(en('2026-11-18', false, { ...CLINICA, price: null } as ItemConFicha)).not.toHaveProperty('antes');
        expect(en('2026-11-18', false, { ...CLINICA, precios_por_fecha: 'roto' } as unknown as ItemConFicha)).not.toHaveProperty('antes');
    });
    it('dos tramos con la misma fecha: el que nunca rigió no cuenta como «antes»', () => {
        const item = { ...CLINICA, precios_por_fecha: [{ desde: '2026-11-17', precio: 340000 }, { desde: '2026-11-17', precio: 332500 }] } as ItemConFicha;
        // Rige el último de esa fecha (como en `precioVigente`); el anterior real es el precio base.
        const p = en('2026-11-18', false, item);
        expect(p.hoy).toBe(332500);
        expect(p.antes).toBe(350000);
    });
    it('afiliado: usa el precio de afiliado y SUS tramos, nunca el de lista', () => {
        expect(en('2026-11-16', true)).toMatchObject({ hoy: 250000, deAfiliado: true });
        expect(en('2026-11-16', true)).not.toHaveProperty('antes');
        expect(en('2026-11-18', true)).toMatchObject({ hoy: 237500, deAfiliado: true, antes: 250000 });
        expect(en('2026-11-22', true)).not.toHaveProperty('antes');
        // Afiliado sin tramos propios: su precio no cambió aunque el de lista tenga descuento.
        const sinTramosDeAfiliado = { ...CLINICA, precios_afiliado_por_fecha: null } as ItemConFicha;
        expect(en('2026-11-18', true, sinTramosDeAfiliado)).toMatchObject({ hoy: 250000 });
        expect(en('2026-11-18', true, sinTramosDeAfiliado)).not.toHaveProperty('antes');
    });
    it('servicio por opciones (1, 2, 3 semanas): no se muestra «antes»', () => {
        const item = { ...CLINICA, opciones: [{ clave: '1s', etiqueta: '1 semana', precio: 200000, precio_afiliado: null }] } as ItemConFicha;
        expect(precioAntesDelTramo(item, { afiliado: false, hoy: '2026-11-18' })).toBeNull();
        expect(en('2026-11-18', false, item)).not.toHaveProperty('antes');
    });
});

describe('lo que dice el bot', () => {
    it('mensaje de pago: «antes $350.000» junto al tramo, solo con descuento', () => {
        expect(lineasDeValorDeVenta(en('2026-11-18'))[0])
            .toBe('Valor hoy: *$332.500* (antes $350.000; hasta el viernes 20 de noviembre; desde el 21, *$350.000*).');
        expect(lineasDeValorDeVenta(en('2026-11-16'))[0])
            .toBe('Valor hoy: *$350.000* (hasta el lunes 16 de noviembre; desde el 17, *$332.500*).');
        expect(lineasDeValorDeVenta(en('2026-11-22'))[0]).toBe('Valor hoy: *$350.000*.');
        expect(lineasDeValorDeVenta(en('2026-11-18', true))[0]).toBe('Tu valor como afiliado del club: *$237.500* (antes $250.000).');
        expect(lineasDeValorDeVenta(en('2026-11-22', true))[0]).toBe('Tu valor como afiliado del club: *$250.000*.');
    });
    it('descuento sin tramo siguiente: solo «antes»', () => {
        const item = { ...CLINICA, precios_por_fecha: [{ desde: '2026-11-17', precio: 332500 }] } as ItemConFicha;
        expect(lineasDeValorDeVenta(en('2026-11-18', false, item))[0]).toBe('Valor hoy: *$332.500* (antes $350.000).');
        expect(lineasDeValor(en('2026-11-18', false, item))[0]).toBe('Valor hoy: *$332.500* (antes $350.000)');
    });
    it('ficha del servicio: igual', () => {
        expect(lineasDeValor(en('2026-11-18'))[0])
            .toBe('Valor hoy: *$332.500* (antes $350.000; hasta el 20 de noviembre; desde el 21 de noviembre, *$350.000*)');
        expect(lineasDeValor(en('2026-11-22'))[0]).toBe('Valor hoy: *$350.000*');
        expect(lineasDeValor(en('2026-11-18', true))[0]).toBe('Tu valor como afiliado: *$237.500* (antes $250.000)');
        expect(lineasDeValor(en('2026-11-16', true))[0]).toBe('Tu valor como afiliado: *$250.000*');
    });
    it('lo que ve el modelo: el «antes» en la línea del valor de hoy, solo con descuento', () => {
        const con = fichaDeServicioParaIa(CLINICA, { hoy: '2026-11-18', afiliado: false, cuentas: [] });
        expect(con).toContain('$332.500 (antes $350.000)');
        const sin = fichaDeServicioParaIa(CLINICA, { hoy: '2026-11-22', afiliado: false, cuentas: [] });
        expect(sin).not.toMatch(/antes \$/);
    });
});
