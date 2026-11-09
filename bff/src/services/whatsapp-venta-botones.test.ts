/**
 * Botones de la venta de un servicio (Monster, clínica de armadores, 2026-11-09):
 * «que todo sea más fácil y concreto, la idea es vender más rápido».
 *
 *   entrada  → [Separar mi cupo] [Ver detalles] [Hablar con alguien]
 *   separar  → los datos de pago (precio de HOY, abono, cuentas) con [Ya pagué]
 *   detalles → la ficha de la escuela con [Separar mi cupo] [Hablar con alguien]
 *   humano   → aviso a la escuela, una sola vez
 *   ya pagué → «envía el comprobante» (o «ya lo tenemos»)
 */
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import {
    atenderBotonDeVenta, atenderVentaDeServicio, botonesDeVenta, idBotonDeVenta, parsearBotonDeVenta,
    BOTONES_DE_ENTRADA, MAX_CUERPO_CON_BOTONES, PASO_VENTA, TEXTO_A_LA_ESCUELA_REPETIDO, TEXTO_COMPROBANTE_YA_RECIBIDO,
    TEXTO_HUMANO, TEXTO_TRAS_DETALLES, TEXTO_YA_PAGO, TITULO_BOTON_VENTA,
    type BotonDeVenta, type CtxVentaServicio,
} from './whatsapp-venta-servicio';
import { MARCA_VENTA, type VentaActiva } from './whatsapp-venta-contexto';
import type { ItemConFicha } from './whatsapp-anuncio-destino';
import type { CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import type { FilaReciente } from './whatsapp-reglas-turno';

const ID = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';
const CLINICA: ItemConFicha = {
    id: ID, name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: '300000.00' as any, active: true, event_id: null,
    starts_at: '2026-11-21 00:00:00-05', ends_at: '2026-11-22 23:59:00-05',
    allow_installments: true, precio_afiliado: '250000' as any, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null,
    description: '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES! 21 y 22 de noviembre · Colegio Bilingüe La Enseñanza.',
};
const CUENTAS: CuentaDePagoEmbudo[] = [{ tipo: 'Nequi', numero: '3194505150', titular: 'Iván Sossa' }];
// Lunes 9-nov-2026, 7:00 p. m. en Bogotá (preventa vigente).
const AHORA = new Date('2026-11-10T00:00:00Z');
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();

interface Enviado { texto: string; contexto: Record<string, unknown>; botones?: BotonDeVenta[] }
function ctxDe(o: { recientes?: FilaReciente[]; afiliado?: boolean; cuentas?: CuentaDePagoEmbudo[]; enCola?: boolean; ahora?: Date } = {}) {
    const reg = { enviados: [] as Enviado[], avisos: [] as string[], esperados: [] as any[], leads: [] as any[] };
    const ctx: CtxVentaServicio = {
        schoolId: 'school-monster', conversationId: 'conv-1', recientes: o.recientes ?? [],
        afiliado: async () => o.afiliado ?? false,
        cuentas: async () => o.cuentas ?? CUENTAS,
        guardarLead: async (s) => { reg.leads.push(s); return 'lead-1'; },
        registrarEsperado: async (e) => { reg.esperados.push(e); return true; },
        responderPregunta: async () => ({ tipo: 'no_se', motivo: 'sin_dato' }),
        enviar: async (texto, contexto, botones) => { reg.enviados.push({ texto, contexto, ...(botones ? { botones } : {}) }); },
        avisarEscuela: async (d) => { reg.avisos.push(d); },
        comprobanteEnCurso: async () => o.enCola ?? false,
        ahora: () => o.ahora ?? AHORA,
    };
    return { ctx, reg };
}
const titulos = (e: Enviado) => (e.botones ?? []).map((b) => b.title);

describe('ids y títulos de los botones', () => {
    it('ida y vuelta: vs:<servicio>:<acción>', () => {
        for (const a of ['separar', 'detalles', 'humano', 'ya_pague'] as const) {
            expect(parsearBotonDeVenta(idBotonDeVenta(ID, a))).toEqual({ itemId: ID, accion: a });
        }
    });
    it('cualquier otro botón no es de la venta (campaña, club, basura)', () => {
        for (const id of [null, '', 'smc:abc:si', 'sm_em_sede', `vs:${ID}:otra`, 'vs:no-es-uuid:separar', `vs:${ID}`]) {
            expect(parsearBotonDeVenta(id)).toBeNull();
        }
    });
    it('los títulos caben en los 20 caracteres de Meta y no se repiten', () => {
        const t = Object.values(TITULO_BOTON_VENTA);
        for (const x of t) expect(x.length).toBeLessThanOrEqual(20);
        expect(new Set(t).size).toBe(t.length);
        expect(botonesDeVenta(CLINICA, BOTONES_DE_ENTRADA).map((b) => b.title)).toEqual(['Separar mi cupo', 'Ver detalles', 'Hablar con alguien']);
    });
});

describe('[Separar mi cupo]', () => {
    it('manda los datos de pago de HOY con [Ya pagué], deja el lead y el esperado', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderBotonDeVenta(ctx, CLINICA, 'separar')).toBe('venta_pago');
        expect(reg.enviados).toHaveLength(1);
        const pago = reg.enviados[0];
        expect(pago.texto).toContain('Valor hoy: *$300.000* (hasta el martes 10 de noviembre; desde el 11, *$350.000*).');
        expect(pago.texto).toContain('abono mínimo de *$150.000* (50 %)');
        expect(pago.texto).toContain('Nequi al 319 450 5150, a nombre de Iván Sossa');
        expect(pago.texto).toContain('nombre completo de quien asiste');
        expect(titulos(pago)).toEqual(['Ya pagué']);
        expect(pago.botones![0].id).toBe(`vs:${ID}:ya_pague`);
        expect(pago.contexto).toMatchObject({ [MARCA_VENTA]: ID, step: PASO_VENTA.PAGO, boton_venta: 'separar', datos_de_pago: true });
        expect(reg.leads).toHaveLength(1);
        expect(reg.esperados).toHaveLength(1);
    });
    it('desde el 11 de noviembre el precio sube solo a $350.000', async () => {
        const { ctx, reg } = ctxDe({ ahora: new Date('2026-11-11T05:00:00Z') });
        await atenderBotonDeVenta(ctx, CLINICA, 'separar');
        expect(reg.enviados[0].texto).toContain('Valor hoy: *$350.000*');
        expect(reg.enviados[0].texto).not.toContain('$300.000');
    });
    it('una familia del club (afiliado) ve su valor de afiliado', async () => {
        const { ctx, reg } = ctxDe({ afiliado: true });
        await atenderBotonDeVenta(ctx, CLINICA, 'separar');
        expect(reg.enviados[0].texto).toContain('Tu valor como afiliado del club: *$250.000*.');
    });
    it('sin cuentas de pago cargadas: no hay [Ya pagué] y se avisa a la escuela', async () => {
        const { ctx, reg } = ctxDe({ cuentas: [] });
        await atenderBotonDeVenta(ctx, CLINICA, 'separar');
        expect(reg.enviados[0].botones).toBeUndefined();
        expect(reg.avisos).toHaveLength(1);
    });
});

describe('[Ver detalles]', () => {
    it('ficha corta: la ficha con [Separar mi cupo] [Hablar con alguien] en UN mensaje', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderBotonDeVenta(ctx, CLINICA, 'detalles')).toBe('venta_detalles');
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toBe(CLINICA.description);
        expect(titulos(reg.enviados[0])).toEqual(['Separar mi cupo', 'Hablar con alguien']);
        expect(reg.enviados[0].contexto).toMatchObject({ step: PASO_VENTA.DETALLES, texto_de_la_escuela: true });
    });
    it('ficha larga (más de lo que Meta deja bajo botones): la ficha sola y los botones aparte', async () => {
        const larga = { ...CLINICA, description: 'Clínica de armadores. '.repeat(Math.ceil(MAX_CUERPO_CON_BOTONES / 20) + 5) };
        const { ctx, reg } = ctxDe();
        await atenderBotonDeVenta(ctx, larga, 'detalles');
        expect(reg.enviados).toHaveLength(2);
        expect(reg.enviados[0].botones).toBeUndefined();
        expect(reg.enviados[1].texto).toBe(TEXTO_TRAS_DETALLES);
        expect(titulos(reg.enviados[1])).toEqual(['Separar mi cupo', 'Hablar con alguien']);
    });
});

describe('[Hablar con alguien]', () => {
    it('avisa a la escuela una sola vez; el segundo toque no repite el aviso', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderBotonDeVenta(ctx, CLINICA, 'humano')).toBe('venta_humano');
        expect(reg.enviados[0].texto).toBe(TEXTO_HUMANO);
        expect(reg.avisos).toHaveLength(1);
        const segundo = ctxDe({ recientes: [{ direction: 'outbound', type: 'text', text_body: TEXTO_HUMANO,
            created_at: hace(2), wa_timestamp: hace(2), payload: { step: PASO_VENTA.HUMANO, [MARCA_VENTA]: ID } } as FilaReciente] });
        await atenderBotonDeVenta(segundo.ctx, CLINICA, 'humano');
        expect(segundo.reg.enviados[0].texto).toBe(TEXTO_A_LA_ESCUELA_REPETIDO);
        expect(segundo.reg.avisos).toHaveLength(0);
    });
});

describe('[Ya pagué]', () => {
    it('sin comprobante: pide la foto con el nombre de quien asiste', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderBotonDeVenta(ctx, CLINICA, 'ya_pague')).toBe('venta_ya_pago');
        expect(reg.enviados[0].texto).toBe(TEXTO_YA_PAGO);
    });
    it('con la foto ya enviada: «ya lo tenemos»', async () => {
        const { ctx, reg } = ctxDe({ recientes: [{ direction: 'inbound', type: 'image', text_body: null,
            created_at: hace(5), wa_timestamp: hace(5) } as FilaReciente] });
        await atenderBotonDeVenta(ctx, CLINICA, 'ya_pague');
        expect(reg.enviados[0].texto).toBe(TEXTO_COMPROBANTE_YA_RECIBIDO);
    });
    it('con el comprobante en la cola: silencio (lo contesta la cola)', async () => {
        const { ctx, reg } = ctxDe({ enCola: true });
        expect(await atenderBotonDeVenta(ctx, CLINICA, 'ya_pague')).toBe('venta_silencio');
        expect(reg.enviados).toHaveLength(0);
    });
});

describe('saludo dentro de la venta', () => {
    it('«Hola» → la línea de la venta con los tres botones de entrada', async () => {
        const { ctx, reg } = ctxDe();
        const venta: VentaActiva = { item: CLINICA, origen: 'marca', desde: hace(60) };
        expect(await atenderVentaDeServicio(ctx, venta, 'Hola')).toBe('venta_saludo');
        expect(titulos(reg.enviados[0])).toEqual(['Separar mi cupo', 'Ver detalles', 'Hablar con alguien']);
    });
});
