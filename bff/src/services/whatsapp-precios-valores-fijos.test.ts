/**
 * Matrícula y artículos en lo que el bot puede decir (Monster 2026-11-16).
 *
 * La ficha de Monster decía a mano «matrícula $310.000 + uniformes de entrenamiento
 * $60.000 = $370.000»; el bot solo conocía la mensualidad y el verificador de salida
 * rechazaba cualquier otra cifra. Ahora la matrícula (`offering_plans.registration_fee`)
 * y los artículos activos (`school_merchandise_items`) salen de los campos: en la lista
 * de «¿cuánto cuesta?», en <precios> del prompt y en lo que el verificador deja pasar
 * (cada valor y la suma matrícula + un artículo). Todo detrás de `wa_responder_precios`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    const state = { tablas: {} as Record<string, any[]>, leidas: [] as string[] };
    function builder(table: string) {
        const filtros: ((f: any) => boolean)[] = [];
        const b: any = {};
        b.select = () => b;
        b.eq = (c: string, v: any) => { filtros.push((f) => f[c] === v); return b; };
        b.is = (c: string, v: any) => { filtros.push((f) => (f[c] ?? null) === v); return b; };
        b.in = (c: string, vs: any[]) => { filtros.push((f) => vs.includes(f[c])); return b; };
        b.order = () => b;
        b.limit = () => b;
        const correr = () => {
            state.leidas.push(table);
            return { data: (state.tablas[table] ?? []).filter((f) => filtros.every((p) => p(f))), error: null };
        };
        b.maybeSingle = () => Promise.resolve({ data: correr().data[0] ?? null, error: null });
        b.then = (res: any, rej: any) => Promise.resolve(correr()).then(res, rej);
        return b;
    }
    return { state, supabase: { from: (t: string) => builder(t), rpc: vi.fn(async () => ({ data: null, error: null })) } };
});
vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
const llm = vi.hoisted(() => ({ chatWithTools: vi.fn() }));
vi.mock('./llm.service', () => llm);
vi.mock('./whatsapp-anuncio-destino', async (orig) => ({
    ...(await orig<typeof import('./whatsapp-anuncio-destino')>()),
    serviciosDeAnuncio: vi.fn(async () => []),
}));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn(async () => ({ cuentas: [] })) }));

import {
    valoresFijosDe, textoDeValoresFijos, montosDeValoresFijos, valoresFijosDeEscuela,
    textoDePreciosDeEscuela, preciosParaProspecto,
} from './whatsapp-precios.service';
import { catalogoParaProspecto, promptDeProspecto, redactarRespuestaDeProspecto } from './whatsapp-prospecto-ia.service';
import { verificarSalida } from './whatsapp-verificador-montos';
import type { PrecioDeMotivo } from './wa-cobro-desde-comprobante.service';

const S = 'school-1';
const PLAN_PRO = { id: 'plan-1', school_id: S, is_active: true, name: 'PRO', price: 180000, max_sessions: 8, registration_fee: 310000 };
const UNIFORMES = { id: 'art-1', school_id: S, active: true, name: 'Uniformes de entrenamiento (2 camisetas)', price: 60000, price_by_size: null };
const FICHA = 'Entrenamos en dos sedes. Para empezar: matrícula $300.000 y uniformes $60.000.';

const LISTA_MONSTER = [
    '💰 Estos son los valores de la mensualidad:',
    '• Pro: *$180.000* · 8 clases al mes',
    '',
    '📝 Matrícula: *$310.000*',
    '',
    '👕 Uniformes y artículos:',
    '• Uniformes de entrenamiento (2 camisetas): *$60.000*',
].join('\n');

beforeEach(() => {
    llm.chatWithTools.mockReset();
    h.state.leidas = [];
    h.state.tablas = {
        offering_plans: [PLAN_PRO],
        school_merchandise_items: [UNIFORMES],
        school_settings: [{ school_id: S, wa_ficha_prospectos: FICHA }],
    };
});

describe('valores fijos (puras)', () => {
    const MATRICULA: PrecioDeMotivo = { motivo: 'inscripcion', monto: 310000, fuente: 'registration_fee', fuenteId: 'plan-1', etiqueta: 'Inscripción' };
    const ART: PrecioDeMotivo = { motivo: 'articulos', monto: 60000, fuente: 'merchandise_item', fuenteId: 'art-1', etiqueta: 'Uniformes de entrenamiento (2 camisetas)' };

    it('matrícula y artículo en líneas aparte', () => {
        const v = valoresFijosDe([MATRICULA, ART]);
        expect(v).toEqual({ matricula: 310000, articulos: [{ nombre: 'Uniformes de entrenamiento (2 camisetas)', precios: [60000] }] });
        expect(textoDeValoresFijos(v)).toBe(
            '📝 Matrícula: *$310.000*\n\n👕 Uniformes y artículos:\n• Uniformes de entrenamiento (2 camisetas): *$60.000*');
    });

    it('dos matrículas distintas: no se afirma ninguna', () => {
        const v = valoresFijosDe([MATRICULA, { ...MATRICULA, monto: 250000, fuenteId: 'plan-2' }, ART]);
        expect(v.matricula).toBeNull();
        expect(textoDeValoresFijos(v)).not.toContain('Matrícula');
        // Sin matrícula tampoco hay suma permitida.
        expect(montosDeValoresFijos(v)).toEqual([60000]);
    });

    it('un artículo con precio por talla: el rango, y los servicios o abonos no entran', () => {
        const v = valoresFijosDe([
            ART, { ...ART, monto: 75000 },
            { motivo: 'clase_extra', monto: 300000, fuente: 'tournament_item', fuenteId: 'it-1', etiqueta: 'Clínica' },
        ]);
        expect(textoDeValoresFijos(v)).toBe(
            '👕 Uniformes y artículos:\n• Uniformes de entrenamiento (2 camisetas): de *$60.000* a *$75.000* según la talla');
    });

    it('lo que el verificador deja pasar: cada valor y matrícula + UN artículo', () => {
        expect(montosDeValoresFijos(valoresFijosDe([MATRICULA, ART])).sort((a, b) => a - b)).toEqual([60000, 310000, 370000]);
        expect(montosDeValoresFijos(null)).toEqual([]);
        expect(textoDeValoresFijos({ matricula: null, articulos: [] })).toBeNull();
    });
});

describe('«¿cuánto cuesta?»: la lista determinista', () => {
    it('mensualidad, matrícula y artículos activos, cada uno en su bloque', async () => {
        expect(await textoDePreciosDeEscuela(S)).toBe(LISTA_MONSTER);
    });

    it('artículo inactivo, sin precio o de otra escuela: no sale', async () => {
        h.state.tablas.school_merchandise_items = [
            { ...UNIFORMES, active: false },
            { ...UNIFORMES, id: 'art-2', name: 'Balón', price: 0 },
            { ...UNIFORMES, id: 'art-3', school_id: 'otra', name: 'Maleta' },
        ];
        const t = await textoDePreciosDeEscuela(S);
        expect(t).toContain('📝 Matrícula: *$310.000*');
        expect(t).not.toContain('Uniformes y artículos');
    });

    it('planes activos con matrículas distintas: la matrícula no se dice (misma regla que el comprobante)', async () => {
        h.state.tablas.offering_plans = [PLAN_PRO, { ...PLAN_PRO, id: 'plan-2', name: 'Élite', price: 220000, registration_fee: 250000 }];
        const t = await textoDePreciosDeEscuela(S);
        expect(t).not.toContain('Matrícula');
        expect(t).toContain('• Uniformes de entrenamiento (2 camisetas): *$60.000*');
        expect((await valoresFijosDeEscuela(S)).matricula).toBeNull();
    });

    it('sin matrícula ni artículos: la lista de siempre, letra por letra', async () => {
        h.state.tablas.offering_plans = [{ ...PLAN_PRO, registration_fee: 0 }];
        h.state.tablas.school_merchandise_items = [];
        expect(await textoDePreciosDeEscuela(S)).toBe('💰 Estos son los valores de la mensualidad:\n• Pro: *$180.000* · 8 clases al mes');
    });

    it('`wa_responder_precios` apagado: no se dice nada y no se lee nada', async () => {
        expect(await preciosParaProspecto(S, false)).toBeNull();
        expect(h.state.leidas).toEqual([]);
        expect(await preciosParaProspecto(S, true)).toBe(LISTA_MONSTER);
    });
});

describe('verificador de salida del prospecto', () => {
    it('con <precios>: pasan la matrícula, el artículo y la suma de los dos; dos artículos no', async () => {
        const c = await catalogoParaProspecto(S, FICHA, { precios: LISTA_MONSTER });
        expect(c.valoresDeCampos).toBe(true);
        expect(verificarSalida('La matrícula es de $310.000 y los uniformes $60.000: en total $370.000.', c.permitidos)).toEqual({ ok: true });
        expect(verificarSalida('Con dos uniformes serían $430.000.', c.permitidos)).toMatchObject({ ok: false });
    });

    it('sin <precios> (interruptor apagado): no se lee la base y $370.000 no pasa', async () => {
        const c = await catalogoParaProspecto(S, 'Entrenamos en dos sedes.', { precios: null });
        expect(c.valoresDeCampos).toBe(false);
        expect(h.state.leidas).not.toContain('school_merchandise_items');
        expect(h.state.leidas).not.toContain('offering_plans');
        expect(verificarSalida('La matrícula es de $310.000.', c.permitidos)).toMatchObject({ ok: false });
        expect(verificarSalida('En total $370.000.', c.permitidos)).toMatchObject({ ok: false });
    });
});

describe('prompt del prospecto', () => {
    const base = { escuela: 'Monster', ficha: FICHA, estilo: null, grupos: null, enlace: null, atencion: null };

    it('con valores de campos: <precios> los trae y la instrucción dice que mandan sobre la ficha', () => {
        const p = promptDeProspecto({ ...base, precios: LISTA_MONSTER, valoresDeCampos: true });
        expect(p).toContain(`<precios>\n${LISTA_MONSTER}\n</precios>`);
        expect(p).toContain('MANDAN sobre la ficha');
        expect(p).toContain('usa SIEMPRE la de <precios>');
        expect(p).toContain('puedes sumar la matrícula con UN artículo');
    });

    it('sin valores de campos: el prompt de siempre, letra por letra', () => {
        const antes = promptDeProspecto({ ...base, precios: 'x' });
        expect(antes).not.toContain('Matrícula y artículos');
        expect(promptDeProspecto({ ...base, precios: 'x', valoresDeCampos: false })).toBe(antes);
    });
});

describe('redactarRespuestaDeProspecto con matrícula y artículos', () => {
    const args = {
        schoolId: S, conversationId: 'c1', escuela: 'Monster', nuevo: '¿Cuánto pago para empezar?',
        recientes: [] as any[], grupos: null, enlace: null,
        textos: { nombre: 'clase de prueba', nombreInicial: 'Clase de prueba', gratis: false, precio: '$15.000' } as any,
    };

    it('la suma matrícula + uniformes sale; la regla de «manda el campo» va en el prompt', async () => {
        const respuesta = 'Para empezar pagas la matrícula de *$310.000* y los uniformes de entrenamiento de *$60.000*: *$370.000* en total.';
        llm.chatWithTools.mockResolvedValueOnce({ text: respuesta, provider: 'claude' });
        expect(await redactarRespuestaDeProspecto({ ...args, precios: await preciosParaProspecto(S, true) })).toBe(respuesta);
        const system: string = llm.chatWithTools.mock.calls[0][0].system;
        expect(system).toContain('📝 Matrícula: *$310.000*');
        expect(system).toContain('• Uniformes de entrenamiento (2 camisetas): *$60.000*');
        expect(system).toContain('MANDAN sobre la ficha');
    });

    it('interruptor apagado: sin <precios>, sin la regla y una cifra que no está en la ficha no sale', async () => {
        llm.chatWithTools.mockResolvedValue({ text: 'La matrícula es de $310.000.', provider: 'claude' });
        expect(await redactarRespuestaDeProspecto({ ...args, precios: await preciosParaProspecto(S, false) })).toBeNull();
        const system: string = llm.chatWithTools.mock.calls[0][0].system;
        expect(system).toContain('<precios>\n\n</precios>');
        expect(system).not.toContain('MANDAN sobre la ficha');
    });
});
