/**
 * Mapi para leads del canal de SportMaps: guardarraíles puros, flag, topes,
 * que un suscriptor no entra y que sin promo no se menciona promo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    const state = { salidas: [] as any[], ventana: true, enviados: [] as { texto: string; paso: string }[], llm: 'Hola' as string | Error };
    return { state };
});
vi.mock('../config/supabase', () => {
    const b: any = {};
    for (const m of ['select', 'eq', 'in', 'gte', 'limit']) b[m] = () => b;
    b.then = (res: any, rej: any) => Promise.resolve({ data: h.state.salidas, error: null }).then(res, rej);
    return { supabase: { from: () => b } };
});
vi.mock('./llm.service', () => ({
    chatWithTools: vi.fn(async () => {
        if (h.state.llm instanceof Error) throw h.state.llm;
        return { text: h.state.llm, provider: 'claude' };
    }),
}));
vi.mock('./plataforma-wa.service', () => ({
    VENTANA_MS: 24 * 3600_000,
    ventanaAbiertaCon: vi.fn(async () => h.state.ventana),
    enviarTextoPlataforma: vi.fn(async (_c: any, _to: string, texto: string, o: any) => {
        h.state.enviados.push({ texto, paso: o.paso });
        return { ok: true, waMessageId: 'x' };
    }),
}));

import {
    CONFIG_COMERCIAL, promoVigente, promptDeLeads, verificarRespuesta, pidePersona, debeAtenderLead, leadsMapiActivo,
    evaluarTopes, atenderLeadPlataforma, TOPE_POR_DIA, TOPE_POR_HORA, MARCA_ESCALAR, PASO_LEAD, PASO_LEAD_ESCALADO,
    type ConfigComercial,
} from './plataforma-wa-leads.service';

const AHORA = Date.parse('2026-11-18T15:00:00.000Z');
const SIN_PROMO: ConfigComercial = { ...CONFIG_COMERCIAL, promo: { texto: '', desde: null, hasta: null } };
const CANAL: any = { phone_number_id: '1' };
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

beforeEach(() => { h.state.salidas = []; h.state.ventana = true; h.state.enviados = []; h.state.llm = 'Hola, ¿cuántos alumnos tiene tu escuela?'; });

describe('configuración y promo', () => {
    it('los precios son los de la landing y la promo es la de Black Friday (nov y dic gratis) hasta fin de diciembre', () => {
        const p = Object.fromEntries(CONFIG_COMERCIAL.planes.map((x) => [x.nombre, x.mensual]));
        expect(p).toMatchObject({ 'Free Start': 0, 'Escuela Start': 69000, 'Escuela Pro': 159000, 'Escuela Elite': 349000 });
        expect(promoVigente(CONFIG_COMERCIAL, AHORA)).toContain('noviembre y diciembre gratis');
        expect(promoVigente(CONFIG_COMERCIAL, Date.parse('2027-01-02T00:00:00-05:00'))).toBeNull();
        expect(promoVigente(SIN_PROMO, AHORA)).toBeNull();
    });
    it('sin promo el prompt la prohíbe y no trae la etiqueta <promo>', () => {
        const s = promptDeLeads(SIN_PROMO, AHORA);
        expect(s).toContain('No hay ninguna promoción');
        expect(s).not.toContain('<promo>');
        expect(s).toContain('$159.000');
        expect(s).toContain('$69.000');
    });
    it('con promo vigente entra al prompt; fuera de vigencia, no', () => {
        const c: ConfigComercial = { ...CONFIG_COMERCIAL, promo: { texto: 'Noviembre y diciembre gratis', desde: '2026-11-20T00:00:00Z', hasta: '2026-12-01T00:00:00Z' } };
        expect(promptDeLeads(c, AHORA)).not.toContain('Noviembre y diciembre gratis');
        const dentro = Date.parse('2026-11-25T00:00:00Z');
        expect(promptDeLeads(c, dentro)).toContain('<promo>Noviembre y diciembre gratis</promo>');
    });
});

describe('verificarRespuesta (guardarraíles)', () => {
    it('deja pasar precios de la configuración', () => {
        const v = verificarRespuesta('Escuela Pro cuesta $159.000 al mes y Start $69.000. Más info en https://sportmaps.co', CONFIG_COMERCIAL, AHORA);
        expect(v.texto).toContain('$159.000');
    });
    it('un monto inventado no sale', () => {
        expect(verificarRespuesta('Te queda en $120.000 al mes', CONFIG_COMERCIAL, AHORA)).toMatchObject({ texto: null, motivo: 'monto' });
        expect(verificarRespuesta('Cuesta 120.000 pesos', CONFIG_COMERCIAL, AHORA)).toMatchObject({ texto: null, motivo: 'monto' });
    });
    it('un enlace ajeno no sale', () => {
        expect(verificarRespuesta('Entra a https://malo.example/pago', CONFIG_COMERCIAL, AHORA)).toMatchObject({ texto: null, motivo: 'enlace' });
    });
    it('sin promo, mencionar promo/descuento/Black Friday no sale', () => {
        for (const t of ['Tenemos Black Friday con meses gratis', 'Te hago un descuento', 'Hay una promoción activa']) {
            expect(verificarRespuesta(t, SIN_PROMO, AHORA)).toMatchObject({ texto: null, motivo: 'promo' });
        }
    });
    it('con promo vigente sí se puede mencionar', () => {
        const c: ConfigComercial = { ...CONFIG_COMERCIAL, promo: { texto: 'Black Friday: noviembre y diciembre gratis', desde: null, hasta: null } };
        expect(verificarRespuesta('Estamos en Black Friday: noviembre y diciembre gratis', c, AHORA).texto).toBeTruthy();
    });
    it('la marca de escalado y la fuga del prompt no salen', () => {
        expect(verificarRespuesta(MARCA_ESCALAR, CONFIG_COMERCIAL, AHORA)).toMatchObject({ texto: null, motivo: 'escalar' });
        expect(verificarRespuesta('', CONFIG_COMERCIAL, AHORA)).toMatchObject({ texto: null, motivo: 'vacio' });
    });
    it('Free Start gratis es válido (monto 0)', () => {
        expect(verificarRespuesta('Free Start es gratis ($0) hasta 20 alumnos.', CONFIG_COMERCIAL, AHORA).texto).toBeTruthy();
    });
});

describe('pidePersona', () => {
    it.each([
        ['quiero hablar con un asesor', true], ['me pueden llamar?', true], ['hay precio especial?', true],
        ['tengo una queja', true], ['necesito una cotización', true],
        ['cuánto cuesta el plan pro', false], ['hola, quiero info para mi escuela', false],
    ])('%s -> %s', (t, esperado) => expect(pidePersona(t)).toBe(esperado));
});

describe('flag y quién entra', () => {
    it('flag apagado por defecto', () => {
        expect(leadsMapiActivo(undefined)).toBe(false);
        expect(leadsMapiActivo('false')).toBe(false);
        expect(leadsMapiActivo('true')).toBe(true);
    });
    it('un desconocido con flag entra', () => {
        expect(debeAtenderLead({ flag: true, clase: 'desconocido', suscripcionActiva: false })).toEqual({ atender: true });
    });
    it('un suscriptor activo NO entra, aunque la clase llegue como desconocido', () => {
        expect(debeAtenderLead({ flag: true, clase: 'desconocido', suscripcionActiva: true })).toMatchObject({ atender: false, motivo: 'es_suscriptor' });
        expect(debeAtenderLead({ flag: true, clase: 'suscriptor', suscripcionActiva: false })).toMatchObject({ atender: false });
    });
    it('tester y flag apagado no entran', () => {
        expect(debeAtenderLead({ flag: true, clase: 'tester', suscripcionActiva: false })).toMatchObject({ atender: false, motivo: 'es_tester' });
        expect(debeAtenderLead({ flag: false, clase: 'desconocido', suscripcionActiva: false })).toMatchObject({ atender: false, motivo: 'flag_apagado' });
    });
});

describe('topes', () => {
    it('hora, día y silencio tras escalar', () => {
        expect(evaluarTopes([], AHORA)).toBe('ok');
        const horas = Array.from({ length: TOPE_POR_HORA }, () => ({ paso: PASO_LEAD, created_at: hace(10 * 60_000) }));
        expect(evaluarTopes(horas, AHORA)).toBe('tope_hora');
        const dia = Array.from({ length: TOPE_POR_DIA }, () => ({ paso: PASO_LEAD, created_at: hace(5 * 3600_000) }));
        expect(evaluarTopes(dia, AHORA)).toBe('tope_dia');
        expect(evaluarTopes([{ paso: PASO_LEAD_ESCALADO, created_at: hace(30 * 3600_000) }], AHORA)).toBe('escalado');
        expect(evaluarTopes([{ paso: PASO_LEAD_ESCALADO, created_at: hace(4 * 24 * 3600_000) }], AHORA)).toBe('ok');
    });
});

describe('atenderLeadPlataforma', () => {
    const base = { canal: CANAL, numero: '573001112233', tipo: 'text', ahora: AHORA };
    it('responde con el modelo y registra el paso lead_mapi', async () => {
        const r = await atenderLeadPlataforma({ ...base, texto: 'hola, info?' });
        expect(r).toBe('lead_respondido');
        expect(h.state.enviados).toEqual([{ texto: 'Hola, ¿cuántos alumnos tiene tu escuela?', paso: PASO_LEAD }]);
    });
    it('pide persona: una sola respuesta de escalado, sin llamar al modelo', async () => {
        const r = await atenderLeadPlataforma({ ...base, texto: 'quiero hablar con alguien' });
        expect(r).toBe('lead_escalado');
        expect(h.state.enviados[0].paso).toBe(PASO_LEAD_ESCALADO);
    });
    it('ya escalado: silencio, sin spam', async () => {
        h.state.salidas = [{ paso: PASO_LEAD_ESCALADO, created_at: hace(3600_000) }];
        expect(await atenderLeadPlataforma({ ...base, texto: 'hola?' })).toBe('lead_silencio');
        expect(h.state.enviados).toHaveLength(0);
    });
    it('el modelo no sabe o inventa un monto: escala, y el monto inventado no sale', async () => {
        h.state.llm = MARCA_ESCALAR;
        expect(await atenderLeadPlataforma({ ...base, texto: 'integran con X?' })).toBe('lead_escalado');
        h.state.enviados = [];
        h.state.llm = 'Te queda en $50.000';
        expect(await atenderLeadPlataforma({ ...base, texto: 'cuánto?' })).toBe('lead_escalado');
        expect(h.state.enviados.map((e) => e.texto).join()).not.toContain('50.000');
    });
    it('falla del modelo: escala', async () => {
        h.state.llm = new Error('sin llave');
        expect(await atenderLeadPlataforma({ ...base, texto: 'hola' })).toBe('lead_escalado');
    });
    it('audio/imagen: pide texto una vez; la segunda, silencio', async () => {
        expect(await atenderLeadPlataforma({ ...base, tipo: 'audio', texto: null })).toBe('lead_pide_texto');
        h.state.salidas = [{ paso: 'lead_pide_texto', created_at: hace(60_000) }];
        expect(await atenderLeadPlataforma({ ...base, tipo: 'image', texto: null })).toBe('lead_silencio');
    });
    it('sin ventana de 24 h no se envía nada', async () => {
        h.state.ventana = false;
        expect(await atenderLeadPlataforma({ ...base, texto: 'hola' })).toBe('lead_sin_ventana');
        expect(h.state.enviados).toHaveLength(0);
    });
    it('tope diario: silencio', async () => {
        h.state.salidas = Array.from({ length: TOPE_POR_DIA }, () => ({ paso: PASO_LEAD, created_at: hace(5 * 3600_000) }));
        expect(await atenderLeadPlataforma({ ...base, texto: 'hola' })).toBe('lead_silencio');
    });
});
