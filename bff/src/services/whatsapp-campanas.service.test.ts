/**
 * Campañas de marketing por escuela (plan B5 T3).
 *
 * Lo que se vigila: el cupo (tope de Meta, piloto, reparto), el horario
 * (domingo, festivo, sábado 15:01), los 3 botones `smc:` y el «familia» de
 * respaldo, la conciliación (131050, 131049, otro), que un lease vencido quede
 * 'incierto' sin reenvío, que el segundo tick no reenvíe, que aprobar exija la
 * declaración, y que una escuela sin ajustes cueste UNA lectura.
 *
 * Base en memoria que filtra de verdad; Graph y push simulados. Nada sale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const db = vi.hoisted(() => ({
    t: {} as Record<string, any[]>,
    rpc: {} as Record<string, (args: any) => { data: any; error: any }>,
    llamadas: [] as { tabla: string; op: string }[],
    rpcLlamadas: [] as { fn: string; args: any }[],
    fallan: new Set<string>(),
    seq: 0,
}));
const meta = vi.hoisted(() => ({
    enviados: [] as any[],
    respuesta: null as null | ((payload: any) => { ok: boolean; waMessageId?: string; error?: string }),
    calidad: 'GREEN' as string | null,
}));

vi.mock('../config/supabase', () => {
    const campo = (r: any, c: string) => {
        if (!c.includes('->>')) return r[c];
        const [col, clave] = c.split('->>');
        return (r[col] ?? {})[clave];
    };
    function builder(tabla: string) {
        const filtros: ((r: any) => boolean)[] = [];
        let op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
        let payload: any = null;
        let single = false;
        let lim = Infinity;
        let rango: [number, number] | null = null;
        let head = false;
        let onConflict = '';
        const resolver = () => {
            db.llamadas.push({ tabla, op });
            if (db.fallan.has(tabla)) return { data: null, count: null, error: { code: '42P01', message: `relation ${tabla} does not exist` } };
            const filas = (db.t[tabla] ??= []);
            if (op === 'insert') {
                const lista = (Array.isArray(payload) ? payload : [payload])
                    .map((p: any) => ({ id: `${tabla}-${++db.seq}`, created_at: new Date().toISOString(), ...p }));
                filas.push(...lista);
                return { data: single ? lista[0] : lista, error: null };
            }
            if (op === 'upsert') {
                const claves = onConflict.split(',');
                for (const p of Array.isArray(payload) ? payload : [payload]) {
                    const previa = filas.find((r) => claves.every((k) => r[k] === p[k]));
                    if (previa) Object.assign(previa, p);
                    else filas.push({ id: `${tabla}-${++db.seq}`, ...p });
                }
                return { data: null, error: null };
            }
            const sel = filas.filter((r) => filtros.every((f) => f(r)));
            if (op === 'update') {
                for (const r of sel) Object.assign(r, payload);
                return { data: sel, error: null };
            }
            if (head) return { data: null, count: sel.length, error: null };
            const pagina = rango ? sel.slice(rango[0], rango[1] + 1) : sel.slice(0, lim);
            return { data: single ? (pagina[0] ?? null) : pagina.map((r) => ({ ...r })), error: null };
        };
        const api: any = {
            select: (_c?: string, o?: any) => { if (op === 'select' && o?.head) head = true; return api; },
            eq: (c: string, v: any) => { filtros.push((r) => campo(r, c) === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((r) => vs.includes(campo(r, c))); return api; },
            is: (c: string, v: any) => { filtros.push((r) => (r[c] ?? null) === v); return api; },
            gte: (c: string, v: any) => { filtros.push((r) => r[c] != null && r[c] >= v); return api; },
            lt: (c: string, v: any) => { filtros.push((r) => r[c] != null && r[c] < v); return api; },
            or: () => api,
            order: () => api,
            limit: (n: number) => { lim = n; return api; },
            range: (a: number, b: number) => { rango = [a, b]; return api; },
            insert: (p: any) => { op = 'insert'; payload = p; return api; },
            update: (p: any) => { op = 'update'; payload = p; return api; },
            upsert: (p: any, o: any) => { op = 'upsert'; payload = p; onConflict = o?.onConflict ?? 'id'; return api; },
            maybeSingle: () => { single = true; return api; },
            single: () => { single = true; return api; },
            then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: any) => {
                db.rpcLlamadas.push({ fn, args });
                return Promise.resolve(db.rpc[fn]?.(args) ?? { data: null, error: null });
            },
        },
    };
});

vi.mock('./whatsapp.service', () => ({
    decryptToken: () => 'token-claro',
    sendRawPayload: vi.fn(async (_i: any, payload: any) => {
        meta.enviados.push(payload);
        return meta.respuesta ? meta.respuesta(payload) : { ok: true, waMessageId: `wamid.${meta.enviados.length}` };
    }),
}));
vi.mock('./push.service', () => ({ sendToUser: vi.fn(async () => ({ sent: 1 })) }));
vi.mock('./plataforma-wa.service', () => ({
    adminsDeEscuela: vi.fn(async () => new Set(['admin-1'])),
    nombreDeEscuela: vi.fn(async () => 'Monster´s Volley Club'),
}));
vi.mock('./avisos-correo.service', async () => {
    const real = await vi.importActual<typeof import('./avisos-correo.service')>('./avisos-correo.service');
    return { ...real, enviarConReserva: vi.fn(async () => 'enviado') };
});

const svc = await import('./whatsapp-campanas.service');
const {
    cupoDelTick, ticksRestantesDelDia, limiteDeTier, armarPayloadCampana, primerNombre, variablesDeCampana,
    validarPlantillaDeCampana, destinoTrasErrorDeEnvio, destinoTrasFalloAsincrono, leaseVencido,
    motivoParaPosponer, runCampanas, aprobarCampana, simularCampana, filtroCoincide, contarFilas,
    ajustesCampanasDesdeFila, payloadDeBoton,
} = svc;

const PLANTILLA_MONSTER = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../whatsapp-templates/escuelas/monster/monster_cierre_2026.json'), 'utf8'));

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const INTEG = 'integ-monster';
const WABA = 'waba-monster';
const CAMP = '11111111-1111-4111-8111-111111111111';
/** Martes 3 de noviembre de 2026, 10:00 en Bogotá. */
const MARTES_10AM = new Date('2026-11-03T15:00:00Z');
const iso = (d: Date, msMas = 0) => new Date(d.getTime() + msMas).toISOString();

function filaPlantilla(extra: Record<string, any> = {}) {
    return {
        integration_id: INTEG, school_id: ESC, waba_id: WABA, name: 'monster_cierre_2026', language: 'es_CO',
        category: 'MARKETING', status: 'APPROVED', components: PLANTILLA_MONSTER.components, ...extra,
    };
}

function sembrar(opts: { base?: 'optin' | 'contacto_previo_declarado'; contactos?: number } = {}) {
    const contactos = Array.from({ length: opts.contactos ?? 3 }, (_, i) => `57300000000${i}`);
    db.t = {
        whatsapp_campanas_ajustes: [{
            school_id: ESC, habilitadas: true, base_consentimiento: opts.base ?? 'contacto_previo_declarado',
            tope_diario_max: 200, lote_piloto: 50, frecuencia_min_dias: 7, antiguedad_max_dias: 180, palabras_sede: [],
            pausada_at: null, pausa_motivo: null,
        }],
        school_whatsapp_integrations: [{
            id: INTEG, school_id: ESC, phone_number_id: 'pn-1', waba_id: WABA, display_phone_number: '573188682241',
            access_token_encrypted: 'gcm:x', status: 'active',
        }],
        whatsapp_template_status: [filaPlantilla()],
        whatsapp_campanas: [{
            id: CAMP, integration_id: INTEG, school_id: ESC, nombre: 'Cierre 2026', plantilla: 'monster_cierre_2026',
            idioma: 'es_CO', filtro: { intereses: [], branch_ids: [] }, variables: ['nombre'], respuesta_si: 'Te cuento…',
            estado: 'aprobada', destinatarios: contactos.length, aprobada_at: iso(MARTES_10AM, -3600_000), vence_at: null,
            pausa_motivo: null,
        }],
        whatsapp_campana_envios: contactos.map((wa, i) => ({
            id: `env-${i}`, campana_id: CAMP, integration_id: INTEG, school_id: ESC, contact_wa_id: wa,
            estado: 'pendiente', intentos: 0, wa_message_id: null, lease_hasta: null, proximo_intento_at: null, enviado_at: null,
        })),
        whatsapp_conversations: contactos.map((wa, i) => ({
            id: `conv-${i}`, integration_id: INTEG, school_id: ESC, contact_wa_id: wa,
            contact_name: i === 0 ? 'María José Pérez' : i === 1 ? '🏐🏐' : 'Ferretería El Clavo',
            last_inbound_at: iso(MARTES_10AM, -40 * 24 * 3600_000),
        })),
        whatsapp_messages: [],
        whatsapp_optins: [],
        whatsapp_account_events: [],
        whatsapp_audiencia: [],
        notifications: [],
    };
    // La RPC real (M3): pendientes con próximo intento vencido → 'enviando', lease 10 min, intentos+1.
    db.rpc.wa_campana_tomar_lote = ({ p_campana_id, p_max }: any) => {
        const ahora = MARTES_10AM.toISOString();
        const tomados = db.t.whatsapp_campana_envios
            .filter((e) => e.campana_id === p_campana_id && e.estado === 'pendiente'
                && (!e.proximo_intento_at || e.proximo_intento_at <= ahora))
            .slice(0, p_max);
        for (const e of tomados) {
            e.estado = 'enviando'; e.intentos += 1; e.lease_hasta = iso(MARTES_10AM, 10 * 60_000);
        }
        return { data: tomados.map((e) => ({ ...e })), error: null };
    };
}

beforeEach(() => {
    db.t = {}; db.rpc = {}; db.llamadas = []; db.rpcLlamadas = []; db.fallan = new Set(); db.seq = 0;
    meta.enviados = []; meta.respuesta = null; meta.calidad = 'GREEN';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ quality_rating: meta.calidad }) })));
});
afterEach(() => { vi.unstubAllGlobals(); });

// ─── Puras ───────────────────────────────────────────────────────────────────

describe('cupo del tick', () => {
    const base = { topeDiario: 200, lotePiloto: 50, primerDia: false, enviadosHoyEscuela: 0, enviadosHoyCampana: 0, limiteMeta: 250, ticksRestantes: 1 };

    it('TIER_250 menos lo ya usado en 24 h', () => {
        expect(limiteDeTier('TIER_250')).toBe(250);
        expect(limiteDeTier('TIER_1K')).toBe(1000);
        expect(limiteDeTier('TIER_UNLIMITED')).toBe(1_000_000);
        expect(limiteDeTier('ONBOARDING')).toBeNull();
        expect(cupoDelTick({ ...base, topeDiario: 1000, usadosMeta: 230 })).toBe(20);
        expect(cupoDelTick({ ...base, usadosMeta: 250 })).toBe(0);
    });

    it('el primer día manda el piloto', () => {
        expect(cupoDelTick({ ...base, primerDia: true })).toBe(50);
        expect(cupoDelTick({ ...base, primerDia: true, enviadosHoyCampana: 45, enviadosHoyEscuela: 45 })).toBe(5);
        expect(cupoDelTick({ ...base, primerDia: false, enviadosHoyEscuela: 45 })).toBe(155);
    });

    it('se reparte entre los ticks que quedan (no 200 a las 7:00)', () => {
        // Martes 7:00 → 72 ticks de 10 min hasta las 19:00.
        const siete = new Date('2026-11-03T12:00:00Z');
        expect(ticksRestantesDelDia(siete)).toBe(72);
        expect(cupoDelTick({ ...base, ticksRestantes: 72 })).toBe(3);
        expect(cupoDelTick({ ...base, ticksRestantes: 72, primerDia: true })).toBe(1);
        expect(cupoDelTick({ ...base, ticksRestantes: 0 })).toBe(0);
    });
});

describe('horario («Ley 2300» del código)', () => {
    it('domingo, festivo (2-nov) y sábado 15:01: cero ticks', () => {
        expect(ticksRestantesDelDia(new Date('2026-11-01T15:00:00Z'))).toBe(0); // domingo 1-nov 10:00
        expect(ticksRestantesDelDia(new Date('2026-11-02T15:00:00Z'))).toBe(0); // lunes festivo
        expect(ticksRestantesDelDia(new Date('2026-11-07T20:01:00Z'))).toBe(0); // sábado 15:01
        expect(ticksRestantesDelDia(new Date('2026-11-07T19:55:00Z'))).toBe(1); // sábado 14:55
        expect(ticksRestantesDelDia(MARTES_10AM)).toBe(54);
    });
});

describe('plantilla y payload', () => {
    it('la plantilla de Monster sirve: MARKETING, 3 botones con la baja de tercera, {{1}} = nombre', () => {
        const v = validarPlantillaDeCampana(filaPlantilla(), WABA);
        expect(v).toMatchObject({ ok: true, variables: 1 });
    });

    it('no sirve: UTILITY, otra WABA, sin aprobar, botones en otro orden o de más', () => {
        expect(validarPlantillaDeCampana(filaPlantilla({ category: 'UTILITY' }), WABA)).toMatchObject({ ok: false, motivo: 'no_es_marketing' });
        expect(validarPlantillaDeCampana(filaPlantilla(), 'otra')).toMatchObject({ ok: false, motivo: 'otra_waba' });
        expect(validarPlantillaDeCampana(filaPlantilla({ status: 'PENDING' }), WABA)).toMatchObject({ ok: false, motivo: 'plantilla_no_aprobada' });
        const desordenada = PLANTILLA_MONSTER.components.map((c: any) => (c.type === 'BUTTONS'
            ? { ...c, buttons: [c.buttons[2], c.buttons[0], c.buttons[1]] } : c));
        expect(validarPlantillaDeCampana(filaPlantilla({ components: desordenada }), WABA)).toMatchObject({ ok: false, motivo: 'botones_no_cuadran' });
        const dos = PLANTILLA_MONSTER.components.map((c: any) => (c.type === 'BUTTONS' ? { ...c, buttons: c.buttons.slice(0, 2) } : c));
        expect(validarPlantillaDeCampana(filaPlantilla({ components: dos }), WABA)).toMatchObject({ ok: false, motivo: 'botones_no_cuadran' });
    });

    it('3 botones smc:<campaña>:si|luego|baja en el orden de la plantilla; nombre limpio o «familia»', () => {
        const p = armarPayloadCampana({
            toWaId: '573001112233', plantilla: 'monster_cierre_2026', idioma: 'es_CO', campanaId: CAMP,
            variables: variablesDeCampana(1, '🏐 '),
        });
        expect(p.type).toBe('template');
        expect(p.template.components[0]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'familia' }] });
        expect(p.template.components.slice(1)).toEqual(['si', 'luego', 'baja'].map((a, i) => ({
            type: 'button', sub_type: 'quick_reply', index: String(i),
            parameters: [{ type: 'payload', payload: `smc:${CAMP}:${a}` }],
        })));
        expect(payloadDeBoton(CAMP, 'baja')).toBe(`smc:${CAMP}:baja`);
        // Sin variables no va el body.
        const sin = armarPayloadCampana({ toWaId: '57300', plantilla: 'x', idioma: 'es_CO', campanaId: CAMP, variables: [] });
        expect(sin.template.components.map((c: any) => c.type)).toEqual(['button', 'button', 'button']);
    });

    it('primer nombre: limpio; negocio, emoji, número o «Mamá» → «familia»', () => {
        expect(primerNombre('MARÍA JOSÉ Pérez')).toBe('María');
        expect(primerNombre('~Caro 💕')).toBe('Caro');
        expect(primerNombre('Mamá de Sofi')).toBe('familia');
        expect(primerNombre('Ferretería El Clavo SAS')).toBe('familia');
        expect(primerNombre('+57 300 111')).toBe('familia');
        expect(primerNombre('🏐🏐')).toBe('familia');
        expect(primerNombre(null)).toBe('familia');
    });
});

describe('reintentos y conciliación', () => {
    const t0 = MARTES_10AM.getTime();
    it('error de Graph: 5 min, 30 min, al tercero fallido', () => {
        expect(destinoTrasErrorDeEnvio(1, 'timeout', t0)).toMatchObject({ estado: 'pendiente', proximoIntentoAt: iso(MARTES_10AM, 5 * 60_000) });
        expect(destinoTrasErrorDeEnvio(2, 'timeout', t0)).toMatchObject({ estado: 'pendiente', proximoIntentoAt: iso(MARTES_10AM, 30 * 60_000) });
        expect(destinoTrasErrorDeEnvio(3, 'timeout', t0)).toMatchObject({ estado: 'fallido' });
    });

    it('asíncrono: 131050 → baja; 131049 → un reintento a las 24 h; otro → fallido', () => {
        expect(destinoTrasFalloAsincrono(1, '(#131050) User has stopped receiving marketing messages', t0)).toMatchObject({ estado: 'baja' });
        expect(destinoTrasFalloAsincrono(1, 'This message was not delivered to maintain healthy ecosystem engagement.', t0))
            .toMatchObject({ estado: 'pendiente', proximoIntentoAt: iso(MARTES_10AM, 24 * 3600_000), motivo: 'meta_131049' });
        expect(destinoTrasFalloAsincrono(2, '131049', t0)).toMatchObject({ estado: 'fallido' });
        expect(destinoTrasFalloAsincrono(1, 'Message undeliverable', t0)).toMatchObject({ estado: 'fallido' });
    });

    it('lease vencido = incierto (solo si sigue «enviando»)', () => {
        expect(leaseVencido({ estado: 'enviando', lease_hasta: iso(MARTES_10AM, -1) }, t0)).toBe(true);
        expect(leaseVencido({ estado: 'enviando', lease_hasta: iso(MARTES_10AM, 60_000) }, t0)).toBe(false);
        expect(leaseVencido({ estado: 'enviado', lease_hasta: iso(MARTES_10AM, -1) }, t0)).toBe(false);
    });

    it('se pospone a quien tiene la ventana abierta o a quien la escuela le escribió en 12 h', () => {
        expect(motivoParaPosponer({ ultimoEntrante: iso(MARTES_10AM, -3600_000), recientes: [], ahora: t0 })).toBe('ventana_abierta');
        const deMilena = [{ direction: 'outbound', ai_generated: false, payload: {}, created_at: iso(MARTES_10AM, -2 * 3600_000) }];
        expect(motivoParaPosponer({ ultimoEntrante: iso(MARTES_10AM, -5 * 24 * 3600_000), recientes: deMilena, ahora: t0 })).toBe('escuela_escribio');
        expect(motivoParaPosponer({ ultimoEntrante: iso(MARTES_10AM, -5 * 24 * 3600_000), recientes: [], ahora: t0 })).toBeNull();
    });
});

describe('ajustes y filtro', () => {
    it('sin fila = null; solo `true` prende; valores raros → defaults', () => {
        expect(ajustesCampanasDesdeFila(null)).toBeNull();
        expect(ajustesCampanasDesdeFila({ habilitadas: 'true' })?.habilitadas).toBe(false);
        const a = ajustesCampanasDesdeFila({ habilitadas: true, tope_diario_max: -3, palabras_sede: [{ branch_id: 'x', palabras: ['a'] }] })!;
        expect(a).toMatchObject({ habilitadas: true, baseConsentimiento: 'optin', topeDiarioMax: 200, palabrasSede: [] });
    });

    it('filtro: algún interés en común y una de las sedes elegidas', () => {
        const f = { intereses: ['clinica', 'clase_prueba'], branch_id: 'S1' };
        expect(filtroCoincide(f, {})).toBe(true);
        expect(filtroCoincide(f, { intereses: ['clinica'] })).toBe(true);
        expect(filtroCoincide(f, { intereses: ['precio'] })).toBe(false);
        expect(filtroCoincide(f, { branch_ids: ['S2'] })).toBe(false);
        expect(filtroCoincide({ intereses: ['clinica'], branch_id: null }, { branch_ids: ['S1'] })).toBe(false);
        expect(contarFilas([{ contact_wa_id: 'a', ...f }, { contact_wa_id: 'b', intereses: ['precio'], branch_id: null }]))
            .toEqual({ total: 2, porInteres: { clinica: 1, clase_prueba: 1, precio: 1 }, porSede: { S1: 1, sin_sede: 1 } });
    });
});

// ─── Con base ────────────────────────────────────────────────────────────────

describe('runCampanas', () => {
    it('sin campañas en curso: UNA lectura y nada más', async () => {
        db.t = { whatsapp_campanas: [] };
        const r = await runCampanas(MARTES_10AM);
        expect(r.campanas).toBe(0);
        expect(db.llamadas).toEqual([{ tabla: 'whatsapp_campanas', op: 'select' }]);
    });

    it('migración sin aplicar: no revienta y no lee nada más', async () => {
        db.fallan.add('whatsapp_campanas');
        const r = await runCampanas(MARTES_10AM);
        expect(r.campanas).toBe(0);
        expect(db.llamadas).toHaveLength(1);
    });

    it('escuela sin ajustes: no toca whatsapp_messages ni manda nada', async () => {
        sembrar();
        db.t.whatsapp_campanas_ajustes = [];
        const r = await runCampanas(MARTES_10AM);
        expect(r.saltadas.apagadas).toBe(1);
        expect(meta.enviados).toHaveLength(0);
        expect(db.llamadas.some((l) => l.tabla === 'whatsapp_messages')).toBe(false);
        expect(db.rpcLlamadas).toHaveLength(0);
    });

    it('primer tick: manda el piloto con smc: y {{1}}; queda en el buzón con step campana; el 2.º tick no reenvía', async () => {
        sembrar({ contactos: 3 });
        // Último tick del día: el piloto entero cabe en este tick.
        const ultimoTick = new Date('2026-11-03T23:55:00Z');
        db.rpc.wa_record_outbound_message = (a: any) => { db.t.whatsapp_messages.push({ ...a }); return { data: null, error: null }; };
        const r1 = await runCampanas(ultimoTick);
        expect(r1.enviados).toBe(3);
        expect(meta.enviados.map((p) => p.template.components[0].parameters[0].text)).toEqual(['María', 'familia', 'familia']);
        expect(meta.enviados[0].template.components.at(-1).parameters[0].payload).toBe(`smc:${CAMP}:baja`);
        expect(db.t.whatsapp_campana_envios.every((e) => e.estado === 'enviado' && e.wa_message_id)).toBe(true);
        const salientes = db.rpcLlamadas.filter((l) => l.fn === 'wa_record_outbound_message');
        expect(salientes).toHaveLength(3);
        expect(salientes[0].args.p_payload).toMatchObject({ step: 'campana', campana_id: CAMP, automatico: true });
        expect(salientes[0].args.p_text_body).toMatch(/^¡Hola María! 🏐/);
        // Sin pendientes: la campaña termina.
        expect(db.t.whatsapp_campanas[0].estado).toBe('terminada');

        db.t.whatsapp_campanas[0].estado = 'enviando';
        const r2 = await runCampanas(ultimoTick);
        expect(r2.enviados).toBe(0);
        expect(meta.enviados).toHaveLength(3);
    });

    it('lease vencido → incierto y NO se reenvía', async () => {
        sembrar({ contactos: 1 });
        Object.assign(db.t.whatsapp_campana_envios[0], { estado: 'enviando', intentos: 1, lease_hasta: iso(MARTES_10AM, -60_000) });
        await runCampanas(MARTES_10AM);
        expect(db.t.whatsapp_campana_envios[0]).toMatchObject({ estado: 'incierto', motivo: 'lease_vencido' });
        expect(meta.enviados).toHaveLength(0);
    });

    it('ventana abierta → se pospone 24 h sin gastar el intento', async () => {
        sembrar({ contactos: 1 });
        db.t.whatsapp_conversations[0].last_inbound_at = iso(MARTES_10AM, -3600_000);
        const r = await runCampanas(new Date('2026-11-03T23:55:00Z'));
        expect(r.pospuestos).toBe(1);
        expect(meta.enviados).toHaveLength(0);
        expect(db.t.whatsapp_campana_envios[0]).toMatchObject({ estado: 'pendiente', motivo: 'ventana_abierta', intentos: 0 });
    });

    it('base opt-in: sin opt-in vigente no sale; con baja tampoco (aun con la otra base)', async () => {
        sembrar({ base: 'optin', contactos: 2 });
        db.t.whatsapp_optins = [{ integration_id: INTEG, contact_wa_id: '573000000001', opted_in_at: iso(MARTES_10AM, -9e8), opted_out_at: null }];
        await runCampanas(new Date('2026-11-03T23:55:00Z'));
        expect(meta.enviados.map((p) => p.to)).toEqual(['573000000001']);
        expect(db.t.whatsapp_campana_envios[0]).toMatchObject({ estado: 'omitido', motivo: 'sin_optin' });

        sembrar({ base: 'contacto_previo_declarado', contactos: 1 });
        meta.enviados = [];
        db.t.whatsapp_optins = [{ integration_id: INTEG, contact_wa_id: '573000000000', opted_in_at: null, opted_out_at: iso(MARTES_10AM, -9e8) }];
        await runCampanas(new Date('2026-11-03T23:55:00Z'));
        expect(meta.enviados).toHaveLength(0);
        expect(db.t.whatsapp_campana_envios[0]).toMatchObject({ estado: 'omitido', motivo: 'baja' });
    });

    it('error de Graph → pendiente a 5 min; 131050 asíncrono → baja y fuera de la audiencia', async () => {
        sembrar({ contactos: 2 });
        meta.respuesta = (p) => (p.to === '573000000000' ? { ok: false, error: 'Service unavailable' } : { ok: true, waMessageId: 'wamid.ok' });
        const ultimoTick = new Date('2026-11-03T23:55:00Z');
        const r = await runCampanas(ultimoTick);
        expect(r).toMatchObject({ enviados: 1, reintentos: 1 });
        expect(db.t.whatsapp_campana_envios[0]).toMatchObject({ estado: 'pendiente', proximo_intento_at: iso(ultimoTick, 5 * 60_000) });

        // Meta avisa después que el segundo no quiere marketing.
        db.t.whatsapp_audiencia = [{ integration_id: INTEG, contact_wa_id: '573000000001', excluido: null }];
        db.t.whatsapp_messages = [{
            integration_id: INTEG, wa_message_id: 'wamid.ok', status: 'failed', created_at: iso(ultimoTick, -60_000),
            error_detail: 'User has stopped receiving marketing messages (131050)', payload: { campana_id: CAMP },
        }];
        db.t.whatsapp_campanas[0].estado = 'enviando';
        await runCampanas(ultimoTick);
        expect(db.t.whatsapp_campana_envios[1]).toMatchObject({ estado: 'baja', motivo: 'meta_131050' });
        expect(db.t.whatsapp_audiencia[0].excluido).toBe('baja');
    });

    it('freno: número en amarillo pausa la escuela y avisa; nada sale', async () => {
        sembrar({ contactos: 2 });
        meta.calidad = 'YELLOW';
        const r = await runCampanas(MARTES_10AM);
        expect(r.pausadas).toBe(1);
        expect(meta.enviados).toHaveLength(0);
        expect(db.t.whatsapp_campanas[0]).toMatchObject({ estado: 'pausada', pausa_motivo: 'calidad_del_numero' });
        expect(db.t.whatsapp_campanas_ajustes[0].pausada_at).toBeTruthy();
        expect(db.t.notifications).toHaveLength(1);
        expect(db.t.notifications[0]).toMatchObject({ user_id: 'admin-1', link: '/whatsapp?tab=campanas', category: 'support' });
    });

    it('freno: ACCOUNT_DELETED y ONBOARDING no frenan', async () => {
        sembrar({ contactos: 1 });
        db.t.whatsapp_account_events = [
            { integration_id: INTEG, field: 'account_update', motivo: 'ACCOUNT_DELETED', created_at: iso(MARTES_10AM, -60_000) },
            { integration_id: INTEG, field: 'phone_number_quality_update', motivo: 'ONBOARDING', nuevo_estado: 'TIER_250',
                payload: { value: { event: 'ONBOARDING', current_limit: 'TIER_250' } }, created_at: iso(MARTES_10AM, -60_000) },
        ];
        const r = await runCampanas(new Date('2026-11-03T23:55:00Z'));
        expect(r.pausadas).toBe(0);
        expect(r.enviados).toBe(1);
    });

    it('domingo: no corre (ni lee el lote)', async () => {
        sembrar();
        const r = await runCampanas(new Date('2026-11-08T15:00:00Z'));
        expect(r.saltadas.fuera_de_horario).toBe(1);
        expect(db.rpcLlamadas.some((l) => l.fn === 'wa_campana_tomar_lote')).toBe(false);
    });
});

describe('aprobar', () => {
    beforeEach(() => {
        sembrar();
        db.t.whatsapp_campanas[0].estado = 'borrador';
        db.t.whatsapp_audiencia = [
            { integration_id: INTEG, contact_wa_id: 'a', intereses: ['clinica'], branch_id: null, excluido: null, ultimo_entrante_at: iso(MARTES_10AM, -864e5) },
            { integration_id: INTEG, contact_wa_id: 'b', intereses: ['clase_prueba'], branch_id: null, excluido: null, ultimo_entrante_at: iso(MARTES_10AM, -864e5) },
            { integration_id: INTEG, contact_wa_id: 'c', intereses: ['clinica'], branch_id: null, excluido: 'familia', ultimo_entrante_at: iso(MARTES_10AM, -864e5) },
        ];
        // La RPC real toma la foto de la audiencia con el mismo filtro.
        db.rpc.wa_campana_aprobar = ({ p_campana_id }: any) => {
            const c = db.t.whatsapp_campanas.find((x) => x.id === p_campana_id);
            const n = db.t.whatsapp_audiencia.filter((f) => !f.excluido && filtroCoincide(f, c.filtro)).length;
            Object.assign(c, { estado: 'aprobada', destinatarios: n });
            return { data: n, error: null };
        };
    });

    it('con la base declarada exige la declaración; aprobada = conteo previsto', async () => {
        const sin = await aprobarCampana({ schoolId: ESC, campanaId: CAMP, por: 'admin-1', declaracionAceptada: false });
        expect(sin).toMatchObject({ ok: false, status: 400, error: 'falta_declaracion' });

        const previsto = await simularCampana(ESC, CAMP);
        expect(previsto).toMatchObject({ ok: true, conteo: { total: 2 } });
        const r = await aprobarCampana({ schoolId: ESC, campanaId: CAMP, por: 'admin-1', declaracionAceptada: true });
        expect(r).toEqual({ ok: true, destinatarios: 2 });
        const llamada = db.rpcLlamadas.find((l) => l.fn === 'wa_campana_aprobar')!;
        expect(llamada.args).toEqual({ p_campana_id: CAMP, p_por: 'admin-1', p_declaracion: 'contacto_previo_v1' });
    });

    it('campañas apagadas → 409; plantilla en revisión → 409; ya aprobada → 409', async () => {
        db.t.whatsapp_campanas_ajustes[0].habilitadas = false;
        expect(await aprobarCampana({ schoolId: ESC, campanaId: CAMP, por: 'admin-1', declaracionAceptada: true }))
            .toMatchObject({ ok: false, status: 409, error: 'campanas_apagadas' });
        db.t.whatsapp_campanas_ajustes[0].habilitadas = true;
        db.t.whatsapp_template_status[0].status = 'PENDING';
        expect(await aprobarCampana({ schoolId: ESC, campanaId: CAMP, por: 'admin-1', declaracionAceptada: true }))
            .toMatchObject({ ok: false, status: 409, error: 'plantilla_no_lista' });
        db.t.whatsapp_campanas[0].estado = 'enviando';
        expect(await aprobarCampana({ schoolId: ESC, campanaId: CAMP, por: 'admin-1', declaracionAceptada: true }))
            .toMatchObject({ ok: false, status: 409, error: 'no_es_borrador' });
        expect(db.rpcLlamadas.some((l) => l.fn === 'wa_campana_aprobar')).toBe(false);
    });

    it('otra escuela no ve la campaña', async () => {
        expect(await aprobarCampana({ schoolId: 'otra-escuela', campanaId: CAMP, por: 'x', declaracionAceptada: true }))
            .toMatchObject({ ok: false, status: 404 });
    });

    // Integración (2026-10-30): el conteo previsto usa el MISMO filtro que wa_campana_aprobar (M3).
    it('el conteo previsto deja fuera lo mismo que la RPC: baja, número bloqueado y contacto personal', async () => {
        const reciente = iso(MARTES_10AM, -864e5);
        db.t.whatsapp_audiencia.push(
            { integration_id: INTEG, contact_wa_id: 'baja', intereses: ['clinica'], branch_id: null, excluido: null, ultimo_entrante_at: reciente },
            { integration_id: INTEG, contact_wa_id: 'bloq', intereses: ['clinica'], branch_id: null, excluido: null, ultimo_entrante_at: reciente },
            { integration_id: INTEG, contact_wa_id: 'tia', intereses: ['clinica'], branch_id: null, excluido: null, ultimo_entrante_at: reciente },
        );
        db.t.whatsapp_optins.push({ integration_id: INTEG, contact_wa_id: 'baja', opted_in_at: null, opted_out_at: reciente });
        db.t.whatsapp_blocked_numbers = [{ integration_id: null, contact_wa_id: 'bloq' }];
        db.t.whatsapp_conversations.push({ id: 'conv-tia', integration_id: INTEG, contact_wa_id: 'tia', contact_kind: 'personal' });
        expect(await simularCampana(ESC, CAMP)).toMatchObject({ ok: true, conteo: { total: 2 } });
    });

    it('con base opt-in no se aplica la antigüedad (igual que la RPC): cuenta quien tiene opt-in vigente', async () => {
        db.t.whatsapp_campanas_ajustes[0].base_consentimiento = 'optin';
        db.t.whatsapp_audiencia[0].ultimo_entrante_at = iso(MARTES_10AM, -400 * 864e5);   // escribió hace 400 días
        db.t.whatsapp_optins.push(
            { integration_id: INTEG, contact_wa_id: 'a', opted_in_at: iso(MARTES_10AM, -500 * 864e5), opted_out_at: null },
            { integration_id: INTEG, contact_wa_id: 'b', opted_in_at: iso(MARTES_10AM, -10 * 864e5), opted_out_at: iso(MARTES_10AM, -864e5) },
        );
        expect(await simularCampana(ESC, CAMP)).toMatchObject({ ok: true, conteo: { total: 1 } });
    });

    it('nadie cumple el filtro: la RPC devuelve 0 y la aprobación no es un éxito', async () => {
        for (const f of db.t.whatsapp_audiencia) f.excluido = 'familia';
        expect(await aprobarCampana({ schoolId: ESC, campanaId: CAMP, por: 'admin-1', declaracionAceptada: true }))
            .toMatchObject({ ok: false, status: 409, error: 'sin_destinatarios' });
    });
});
