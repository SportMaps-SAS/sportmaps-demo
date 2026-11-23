/**
 * Monster 2026-11-22: auditoría del vacacional antes de prender anuncios de Meta. Cuatro respuestas del bot que podían
 * costar plata o la venta:
 *  1. A la familia del club la ficha le decía «Como afiliado, tu valor es $100.000» (el precio BASE del ítem), cuando
 *     el suyo era $80.000, $120.000 o $150.000 según las semanas.
 *  2. «Para dos hermanos», «son dos niñas, 3 semanas cada una»: cotizaba el valor de UNA persona.
 *  3. «¿Puedo abonar la mitad?» recibía los datos de pago, en un servicio que no admite abonos.
 *  4. «Soy afiliado», la respuesta a «cuéntame cuál es tu caso», se iba a la IA y de ahí a la escuela.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: () => ({}) } }));

import { precioDelServicio, textoFichaDeServicio, type ItemConFicha } from './whatsapp-anuncio-destino';
import {
    PASO_VENTA, TEXTO_DICE_SER_AFILIADO, TEXTO_VARIOS_CUPOS, atenderVentaDeServicio, diceSerAfiliado, pideAbonar,
    pideVariosCupos, textoSinAbonos, type CtxVentaServicio,
} from './whatsapp-venta-servicio';

const VAC: ItemConFicha = {
    id: 'vac', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: 100000, active: true, event_id: null,
    starts_at: '2026-11-17T08:00:00-05:00', ends_at: '2026-12-11T11:00:00-05:00', allow_installments: false,
    description: `🏐 Vacacional de voleibol · Sede Suba. ${'Texto completo de la escuela. '.repeat(30)}`,
    opciones: [
        { clave: '1', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
    ],
};
const HOY = '2026-11-22';
const AHORA = new Date('2026-11-22T12:00:00-05:00');

describe('1. la ficha no le dice un precio falso al afiliado', () => {
    it('con opciones: sin la línea «Como afiliado… $100.000»', () => {
        const t = textoFichaDeServicio(VAC, precioDelServicio(VAC, { afiliado: true, hoy: HOY }), []);
        expect(t).not.toMatch(/Como afiliado/);
        expect(t).not.toMatch(/\$\s?100\.000/);
    });
    it('sin opciones (la clínica): la línea de afiliado sigue saliendo con SU valor', () => {
        const clinica: ItemConFicha = { ...VAC, id: 'cli', name: 'Clínica', kind: 'clase_extra', price: 350000, precio_afiliado: 250000, opciones: null };
        const t = textoFichaDeServicio(clinica, precioDelServicio(clinica, { afiliado: true, hoy: HOY }), []);
        expect(t).toMatch(/Como afiliado del club, tu valor es \*\$\s?250\.000\*/);
    });
});

describe('2. más de una persona', () => {
    it('lo detecta', () => {
        for (const m of [
            'para dos hermanos cuánto es', 'son dos niñas, 3 semanas cada una', '2 cupos de 3 semanas', 'tengo 3 hijos',
            'quiero inscribir a mis hijas', '2 semanas para una y 3 para la otra', 'es para los dos', 'son 2',
            'hay descuento para dos hermanos?',
        ]) expect(pideVariosCupos(m), m).toBe(true);
    });
    it('una sola persona NO entra', () => {
        for (const m of [
            '3 semanas', 'son 3 semanas', 'pago 2 semanas', 'para mi hija', 'cuánto vale', 'quiero las 3 semanas',
            'del 24 al 26 de noviembre', 'son 2 semanas verdad?', 'para las 2 semanas que quedan',
        ]) expect(pideVariosCupos(m), m).toBe(false);
    });
});

describe('3. abonos', () => {
    it('lo detecta', () => {
        for (const m of ['puedo abonar la mitad', 'se puede pagar en cuotas?', 'pago una parte ahora y el resto después', 'me guardan el cupo sin pagar?', 'puedo hacer un abono'])
            expect(pideAbonar(m), m).toBe(true);
    });
    it('pagar completo NO entra', () => {
        for (const m of ['quiero pagar', 'me pasas el nequi', 'cuánto vale', 'pago 2 semanas', 'separar mi cupo']) expect(pideAbonar(m), m).toBe(false);
    });
    it('el texto dice pago total y no trae cuentas ni valores', () => {
        const t = textoSinAbonos(VAC);
        expect(t).toMatch(/pago total/);
        expect(t).toMatch(/no manejamos abonos/);
        expect(t).not.toMatch(/\$|Nequi|Daviplata/);
    });
});

describe('4. «soy afiliado»', () => {
    it('lo detecta', () => {
        for (const m of ['soy afiliado', 'mi hija entrena en el club', 'ya entrena con ustedes', 'somos del club', 'mi hijo ya es afiliado', 'ella está afiliada'])
            expect(diceSerAfiliado(m), m).toBe(true);
    });
    it('la negación y lo que no viene al caso NO entran', () => {
        for (const m of ['no soy afiliado', 'no somos del club', 'mi hija no entrena en el club', 'cuánto vale', 'quiero entrenar en el club'])
            expect(diceSerAfiliado(m), m).toBe(false);
    });
});

function ctxDe(o: { recientes?: any[]; enCola?: boolean } = {}) {
    const enviados: { texto: string; payload: any; botones?: any }[] = [];
    const avisos: string[] = [];
    const ctx = {
        schoolId: 's1', conversationId: 'c1', contactWaId: '573001112233', recientes: o.recientes ?? [], ahora: () => AHORA,
        enviar: async (texto: string, payload: any, botones?: any) => { enviados.push({ texto, payload, botones }); },
        avisarEscuela: async (t: string) => { avisos.push(t); },
        cuentas: async () => [],
        comprobanteEnCurso: async () => o.enCola === true,
    } as unknown as CtxVentaServicio;
    return { ctx, enviados, avisos };
}
const venta = { item: VAC, desde: AHORA.getTime() - 3600_000 } as any;

describe('en la conversación', () => {
    it('«para dos hermanos cuánto es»: no cotiza el valor de uno; pide los datos de cada uno y avisa a la escuela', async () => {
        const { ctx, enviados, avisos } = ctxDe();
        expect(await atenderVentaDeServicio(ctx, venta, 'para dos hermanos cuánto es')).toBe('venta_a_la_escuela');
        expect(enviados).toHaveLength(1);
        expect(enviados[0].texto).toBe(TEXTO_VARIOS_CUPOS);
        expect(enviados[0].texto).not.toMatch(/\$/);
        expect(enviados[0].payload.step).toBe(PASO_VENTA.A_LA_ESCUELA);
        expect(avisos[0]).toMatch(/más de una persona/);
    });
    it('«son dos niñas, 3 semanas cada una»: tampoco responde «3 semanas: $170.000»', async () => {
        const { ctx, enviados } = ctxDe();
        await atenderVentaDeServicio(ctx, venta, 'son dos niñas, 3 semanas cada una');
        expect(enviados[0].texto).toBe(TEXTO_VARIOS_CUPOS);
    });
    it('«puedo abonar la mitad»: dice que es pago total y NO manda datos de pago', async () => {
        const { ctx, enviados, avisos } = ctxDe();
        expect(await atenderVentaDeServicio(ctx, venta, 'puedo abonar la mitad')).toBe('venta_respuesta');
        expect(enviados[0].texto).toBe(textoSinAbonos(VAC));
        expect(avisos).toHaveLength(0);
    });
    it('un servicio que SÍ admite abonos no recibe esa respuesta', async () => {
        const { ctx, enviados } = ctxDe();
        await atenderVentaDeServicio(ctx, { ...venta, item: { ...VAC, allow_installments: true, abono_minimo_pct: 50, opciones: null } }, 'puedo abonar la mitad');
        expect(enviados.some((e) => /no manejamos abonos/.test(e.texto))).toBe(false);
    });
    it('«soy afiliado»: respuesta fija, sin cifra y sin pasar a la escuela', async () => {
        const { ctx, enviados, avisos } = ctxDe();
        expect(await atenderVentaDeServicio(ctx, venta, 'soy afiliado')).toBe('venta_respuesta');
        expect(enviados[0].texto).toBe(TEXTO_DICE_SER_AFILIADO);
        expect(enviados[0].texto).not.toMatch(/\$/);
        expect(avisos).toHaveLength(0);
    });
    it('con un comprobante en la cola, ninguna de las tres se adelanta a la cola', async () => {
        const { ctx, enviados } = ctxDe({ enCola: true });
        await atenderVentaDeServicio(ctx, venta, 'puedo abonar la mitad');
        expect(enviados.some((e) => e.payload?.fija_de_venta)).toBe(false);
    });
});
