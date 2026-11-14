/**
 * Referidos en el bot (spec campanas-descuento-referidos-y-plazos-por-whatsapp §4.4): la pregunta opcional
 * «¿Te refirió alguien del club?» y la respuesta sobre la campaña activa. Sin campaña activa, flujo idéntico.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import {
    campanaVigente, preguntaPorReferidos, leerRespuestaDeReferido, textoDeCampana, campanaDeLaEscuela,
    responderPreguntaDeReferidos, atenderRespuestaDeReferido, preguntarPorReferido, limpiarCacheReferidos,
    TEXTO_REFERIDO_PREGUNTA, TEXTO_REFERIDO_GRACIAS, TEXTO_REFERIDO_NO, TEXTO_REFERIDOS_A_LA_ESCUELA,
    PASO_REFERIDO_PREGUNTA, PASO_REFERIDOS_INFO, PASO_REFERIDO_RESPUESTA, PASO_REFERIDOS_A_LA_ESCUELA,
    type DepsReferidos, type CtxReferidos,
} from './whatsapp-referidos-bot';
import type { CampanaFila } from './referidos.service';
import type { FilaReciente } from './whatsapp-reglas-turno';

const CAMPANA: CampanaFila = {
    id: 'c1', school_id: 's1', kind: 'referral', name: 'Trae un amigo', active: true,
    tiers: [{ age_min: 4, age_max: 15, pct: 50 }, { age_min: 16, age_max: null, pct: 25 }],
    starts_on: null, ends_on: null, reward_months: 1, max_pending: 12, require_referrer_current: true,
    updated_at: '2026-11-06T00:00:00Z',
};

const PROHIBIDAS = /\b(mora|deuda|atraso|vencid|multa|recargo|gratis)/i;

function armar(opts: { campana?: CampanaFila | null | 'error'; ultimoPaso?: string | null; yaPregunto?: boolean; yaDerivo?: boolean; lead?: boolean } = {}) {
    const enviados: { texto: string; context: any }[] = [];
    const guardados: any[] = [];
    let derivado = 0;
    const deps: DepsReferidos = {
        leer: vi.fn(async () => { if (opts.campana === 'error') throw new Error('42P01'); return opts.campana === undefined ? CAMPANA : opts.campana; }),
        ultimoPaso: vi.fn(async () => opts.ultimoPaso ?? null),
        pasoEnviado: vi.fn(async (_c, step) => (step === PASO_REFERIDO_PREGUNTA ? !!opts.yaPregunto : step === PASO_REFERIDOS_A_LA_ESCUELA ? !!opts.yaDerivo : false)),
        guardarEnLead: vi.fn(async (_s, _c, _w, d) => { guardados.push(d); return opts.lead !== false; }),
    };
    const ctx = (discreto = false): CtxReferidos => ({
        schoolId: 's1', conversationId: 'conv', contactWaId: '573000000001', discreto,
        enviar: async (texto, context) => { enviados.push({ texto, context }); },
        derivar: async () => { derivado++; },
    });
    return { deps, ctx, enviados, guardados, derivado: () => derivado };
}

const out = (texto: string, step: string, min = 1): FilaReciente =>
    ({ direction: 'outbound', type: 'text', text_body: texto, payload: { step }, ai_generated: true, created_at: new Date(Date.now() - min * 60_000).toISOString() });
const inn = (texto: string, min = 0): FilaReciente =>
    ({ direction: 'inbound', type: 'text', text_body: texto, payload: {}, ai_generated: null, created_at: new Date(Date.now() - min * 60_000).toISOString() });

beforeEach(() => { limpiarCacheReferidos(); delete process.env.WA_REFERIDOS_BOT; });

describe('reglas puras', () => {
    it('detecta la pregunta por descuento de referidos', () => {
        for (const t of ['¿Tienen descuento por referidos?', 'si traigo a un amigo hay descuento?', 'hay promoción por recomendar a alguien', 'beneficio por referir a una amiga']) {
            expect(preguntaPorReferidos(t), t).toBe(true);
        }
        for (const t of ['Cuánto vale la mensualidad', 'hay descuento por hermanos?', 'horario del sábado', 'ya referí a mi prima, cuándo me aplican el descuento?']) {
            expect(preguntaPorReferidos(t), t).toBe(false);
        }
    });

    it('lee la respuesta al «¿te refirió alguien?»', () => {
        expect(leerRespuestaDeReferido('No')).toEqual({ tipo: 'no' });
        expect(leerRespuestaDeReferido('nadie')).toEqual({ tipo: 'no' });
        expect(leerRespuestaDeReferido('Me refirió Laura Pérez')).toEqual({ tipo: 'nombre', nombre: 'Laura Pérez' });
        expect(leerRespuestaDeReferido('Fue la familia de Sofía Gómez.')).toEqual({ tipo: 'nombre', nombre: 'Sofía Gómez' });
        expect(leerRespuestaDeReferido('Laura')).toEqual({ tipo: 'nombre', nombre: 'Laura' });
        for (const t of ['¿Cuánto vale?', 'a qué hora es la clase', 'Sí, claro', 'gracias', 'Hola buenas tardes', 'una frase muy larga que de ninguna manera es el nombre de una persona sino otra cosa']) {
            expect(leerRespuestaDeReferido(t).tipo, t).toBe('otra_cosa');
        }
    });

    it('la campaña vigente respeta activo y fechas', () => {
        expect(campanaVigente({ active: true, starts_on: null, ends_on: null }, '2026-11-06')).toBe(true);
        expect(campanaVigente({ active: false, starts_on: null, ends_on: null }, '2026-11-06')).toBe(false);
        expect(campanaVigente({ active: true, starts_on: '2026-12-01', ends_on: null }, '2026-11-06')).toBe(false);
        expect(campanaVigente({ active: true, starts_on: null, ends_on: '2026-11-01' }, '2026-11-06')).toBe(false);
    });

    it('el texto de la campaña dice SOLO lo configurado (tramos y mes siguiente) y no calcula ni promete', () => {
        const t = textoDeCampana(CAMPANA);
        expect(t).toContain('Trae un amigo');
        expect(t).toContain('de 4 a 15 años');
        expect(t).toContain('*50 %*');
        expect(t).toContain('16 años o más');
        expect(t).toContain('*25 %*');
        expect(t).toContain('mes siguiente');
        expect(t).not.toMatch(/\$|pesos|total|ahorr/i);
        expect(t).not.toMatch(PROHIBIDAS);
    });

    it('ningún texto nuevo contiene palabras prohibidas', () => {
        for (const t of [TEXTO_REFERIDO_PREGUNTA, TEXTO_REFERIDO_GRACIAS('Laura'), TEXTO_REFERIDO_NO, TEXTO_REFERIDOS_A_LA_ESCUELA, textoDeCampana(CAMPANA)]) {
            expect(t).not.toMatch(PROHIBIDAS);
        }
    });
});

describe('(b) «¿tienen descuento por referidos?»', () => {
    it('con campaña activa responde con ESA campaña', async () => {
        const a = armar();
        expect(await responderPreguntaDeReferidos(a.ctx(), '¿Tienen descuento por referidos?', a.deps)).toBe(true);
        expect(a.enviados).toHaveLength(1);
        expect(a.enviados[0].context.step).toBe(PASO_REFERIDOS_INFO);
        expect(a.enviados[0].texto).toContain('*50 %*');
    });

    it('sin campaña activa deriva a la escuela (una vez) y no inventa porcentajes', async () => {
        const a = armar({ campana: { ...CAMPANA, active: false } });
        expect(await responderPreguntaDeReferidos(a.ctx(), '¿hay descuento por referidos?', a.deps)).toBe(true);
        expect(a.enviados[0].texto).toBe(TEXTO_REFERIDOS_A_LA_ESCUELA);
        expect(a.enviados[0].texto).not.toMatch(/%/);
        expect(a.derivado()).toBe(1);
        // ya derivó hoy: no repite
        const b = armar({ campana: null, yaDerivo: true });
        expect(await responderPreguntaDeReferidos(b.ctx(), '¿hay descuento por referidos?', b.deps)).toBe(false);
    });

    it('sin campaña y en modo discreto el bot calla como siempre', async () => {
        const a = armar({ campana: null });
        expect(await responderPreguntaDeReferidos(a.ctx(true), '¿hay descuento por referidos?', a.deps)).toBe(false);
        expect(a.enviados).toHaveLength(0);
    });

    it('con la tabla sin migrar (error de lectura) no cambia nada', async () => {
        const a = armar({ campana: 'error' });
        expect(await responderPreguntaDeReferidos(a.ctx(), '¿hay descuento por referidos?', a.deps)).toBe(false);
        expect(a.enviados).toHaveLength(0);
    });

    it('otra pregunta no se toca; apagado por env tampoco', async () => {
        const a = armar();
        expect(await responderPreguntaDeReferidos(a.ctx(), 'cuánto vale la mensualidad', a.deps)).toBe(false);
        process.env.WA_REFERIDOS_BOT = 'false';
        expect(await responderPreguntaDeReferidos(a.ctx(), '¿hay descuento por referidos?', a.deps)).toBe(false);
        expect(a.enviados).toHaveLength(0);
    });
});

describe('(a) la pregunta opcional tras agendar la clase', () => {
    it('con campaña activa y la clase recién agendada, pregunta UNA vez', async () => {
        const a = armar({ ultimoPaso: 'embudo_agendada' });
        expect(await preguntarPorReferido(a.ctx(), a.deps)).toBe(true);
        expect(a.enviados[0].texto).toBe(TEXTO_REFERIDO_PREGUNTA);
        expect(a.enviados[0].context.step).toBe(PASO_REFERIDO_PREGUNTA);
        expect(a.enviados[0].texto).toContain('opcional');
    });

    it('también al cerrar la clase de cortesía', async () => {
        const a = armar({ ultimoPaso: 'cortesia_reservada' });
        expect(await preguntarPorReferido(a.ctx(), a.deps)).toBe(true);
    });

    it('sin campaña activa NO pregunta: flujo idéntico (ni siquiera consulta el último paso)', async () => {
        for (const campana of [null, { ...CAMPANA, active: false }] as const) {
            limpiarCacheReferidos();
            const a = armar({ campana, ultimoPaso: 'embudo_agendada' });
            expect(await preguntarPorReferido(a.ctx(), a.deps)).toBe(false);
            expect(a.enviados).toHaveLength(0);
            expect(a.deps.ultimoPaso).not.toHaveBeenCalled();
        }
    });

    it('no pregunta si el consentimiento va después (último paso = embudo_consentimiento) ni a mitad del embudo', async () => {
        for (const paso of ['embudo_consentimiento', 'embudo_horarios', null]) {
            const a = armar({ ultimoPaso: paso });
            expect(await preguntarPorReferido(a.ctx(), a.deps), String(paso)).toBe(false);
        }
    });

    it('una sola vez por conversación', async () => {
        const a = armar({ ultimoPaso: 'embudo_agendada', yaPregunto: true });
        expect(await preguntarPorReferido(a.ctx(), a.deps)).toBe(false);
    });
});

describe('(a) la respuesta se guarda sin confirmar', () => {
    const conPregunta = (texto: string) => [out(TEXTO_REFERIDO_PREGUNTA, PASO_REFERIDO_PREGUNTA, 2), inn(texto, 0)];

    it('un nombre queda en source_detail.referido_por, sin confirmar', async () => {
        const a = armar();
        expect(await atenderRespuestaDeReferido(a.ctx(), 'Me refirió Laura Pérez', conPregunta('Me refirió Laura Pérez'), a.deps)).toBe(true);
        expect(a.guardados[0]).toMatchObject({ referido_por: 'Laura Pérez', referido_confirmado: false, referido_respondio: 'nombre' });
        expect(a.enviados[0].context.step).toBe(PASO_REFERIDO_RESPUESTA);
        expect(a.enviados[0].texto).toContain('Laura Pérez');
    });

    it('«no» se anota como que respondió que no, sin nombre', async () => {
        const a = armar();
        expect(await atenderRespuestaDeReferido(a.ctx(), 'No', conPregunta('No'), a.deps)).toBe(true);
        expect(a.guardados[0].referido_por).toBeUndefined();
        expect(a.guardados[0].referido_respondio).toBe('no');
    });

    it('una pregunta de otro tema NO se lee como nombre y sigue su camino', async () => {
        const a = armar();
        expect(await atenderRespuestaDeReferido(a.ctx(), '¿A qué hora es la clase?', conPregunta('¿A qué hora es la clase?'), a.deps)).toBe(false);
        expect(a.guardados).toHaveLength(0);
        expect(a.enviados).toHaveLength(0);
    });

    it('solo cuenta el mensaje inmediato: dos entrantes después de la pregunta ya no', async () => {
        const a = armar();
        const filas = [out(TEXTO_REFERIDO_PREGUNTA, PASO_REFERIDO_PREGUNTA, 5), inn('Hola', 3), inn('Laura', 0)];
        expect(await atenderRespuestaDeReferido(a.ctx(), 'Laura', filas, a.deps)).toBe(false);
    });

    it('si después de la pregunta habló otro paso, ya no es la respuesta', async () => {
        const a = armar();
        const filas = [out(TEXTO_REFERIDO_PREGUNTA, PASO_REFERIDO_PREGUNTA, 5), out('Martes 6 pm', 'embudo_horarios', 3), inn('Laura', 0)];
        expect(await atenderRespuestaDeReferido(a.ctx(), 'Laura', filas, a.deps)).toBe(false);
    });

    it('un botón (por ejemplo el del consentimiento) nunca es la respuesta', async () => {
        const a = armar();
        expect(await atenderRespuestaDeReferido(a.ctx(), 'Sí, claro', conPregunta('Sí, claro'), a.deps, 'sm_em_optin_si')).toBe(false);
    });

    it('sin lead donde anotarlo no promete nada; sin campaña activa no lee nada', async () => {
        const a = armar({ lead: false });
        expect(await atenderRespuestaDeReferido(a.ctx(), 'Laura', conPregunta('Laura'), a.deps)).toBe(false);
        limpiarCacheReferidos();
        const b = armar({ campana: null });
        const leer = vi.fn(async () => conPregunta('Laura'));
        expect(await atenderRespuestaDeReferido(b.ctx(), 'Laura', leer, b.deps)).toBe(false);
        expect(leer).not.toHaveBeenCalled();
    });
});

describe('campanaDeLaEscuela', () => {
    it('cachea 60 s y distingue activa / sin campaña / no disponible', async () => {
        const a = armar();
        expect((await campanaDeLaEscuela('s1', a.deps)).estado).toBe('activa');
        await campanaDeLaEscuela('s1', a.deps);
        expect(a.deps.leer).toHaveBeenCalledTimes(1);
        limpiarCacheReferidos();
        expect((await campanaDeLaEscuela('s1', armar({ campana: null }).deps)).estado).toBe('sin_campana_activa');
        limpiarCacheReferidos();
        expect((await campanaDeLaEscuela('s1', armar({ campana: 'error' }).deps)).estado).toBe('no_disponible');
    });
});
