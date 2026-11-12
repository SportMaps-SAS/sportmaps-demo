/**
 * Enlace público del estado de cuenta (/api/v1/public/estado-cuenta/:token) y
 * «Enviar al acudiente» (/api/v1/estado-cuenta/enviar).
 *
 * Lo que se vigila es lo que se podría romper sin que nadie lo note:
 *   · token mal formado / inexistente / migración sin aplicar → 404 idéntico; vencido y revocado → 410;
 *   · lo que sale por el enlace: nombre corto, sin ids ni correos ni rutas de comprobante;
 *   · los datos de OTRA escuela nunca aparecen aunque el id del deportista coincida;
 *   · el botón «Pagar» abre el cobro abierto MÁS VIEJO;
 *   · enviar: solo administración de ESA escuela; simular no escribe nada; fuera de horario,
 *     segundo envío del día y familia ya contactada no mandan; sin correo avisa;
 *   · el cuerpo no puede nombrar la escuela.
 *
 * Cero red y cero base: Supabase, correo y auth están moqueados.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

type Fila = Record<string, any>;

const estado = vi.hoisted(() => ({
    tablas: {} as Record<string, Fila[]>,
    tokens: {} as Record<string, Fila>,
    rpcError: null as null | { message: string },
    emitirError: null as null | { message: string },
    rpcLlamadas: [] as { nombre: string; args: any }[],
    horario: true,
    contactadosHoy: new Set<string>(),
    reservaNull: false,
    correos: [] as { to: string; subject: string; html: string }[],
    correoOk: true,
    reservas: [] as any[],
    cierres: [] as any[],
    tokensDeCobro: [] as string[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas: Fila[] = [...(estado.tablas[tabla] ?? [])];
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filas = filas.filter((f) => f[c] === v); return api; },
            in: (c: string, vs: any[]) => { filas = filas.filter((f) => vs.includes(f[c])); return api; },
            gte: (c: string, v: any) => { filas = filas.filter((f) => String(f[c]) >= String(v)); return api; },
            order: () => api,
            limit: (n: number) => { filas = filas.slice(0, n); return api; },
            maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
            then: (ok: any, ko: any) => Promise.resolve({ data: filas, error: null }).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (nombre: string, args: any) => {
                estado.rpcLlamadas.push({ nombre, args });
                if (estado.rpcError) return { data: null, error: estado.rpcError };
                if (nombre === 'estado_cuenta_enlace_resolver') {
                    const f = estado.tokens[args.p_token];
                    return { data: f ? [f] : [], error: null };
                }
                if (nombre === 'estado_cuenta_enlace_emitir') {
                    if (estado.emitirError) return { data: null, error: estado.emitirError };
                    return { data: [{ enlace_token: 'EnlaceNuevoEnlaceNuevo12', vence_en: '2027-01-11T00:00:00Z' }], error: null };
                }
                return { data: null, error: null };
            },
        },
    };
});

// Auth: lee el rol de un encabezado de prueba y reproduce la regla real de requireRole (los privilegiados pasan).
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, res: any, next: any) => {
        const rol = req.headers['x-test-rol'];
        if (!rol) return res.status(401).json({ error: 'Token de autorización requerido.' });
        req.user = { id: 'perfil-admin', email: 'admin@club.co' };
        req.schoolId = String(req.headers['x-school-id'] ?? '');
        req.role = rol;
        next();
    },
    requireRole: (...roles: string[]) => (req: any, res: any, next: any) => {
        if (['owner', 'super_admin', 'admin'].includes(req.role) || roles.includes(req.role)) return next();
        return res.status(403).json({ error: 'Acceso denegado.' });
    },
}));

vi.mock('../services/whatsapp-plantillas.service', () => ({ dentroDeHorarioDeCobranza: () => estado.horario, aWaId: (t: any) => t }));
vi.mock('../services/estado-de-cuenta.service', () => ({ contactosConEstadoDeCuentaHoy: async () => estado.contactadosHoy }));
vi.mock('../services/avisos-correo.service', () => ({
    reservarEnvio: async (p: any) => { if (estado.reservaNull) return null; estado.reservas.push(p); return { id: 'reserva-1' }; },
    cerrarEnvio: async (_r: any, r: any) => { estado.cierres.push(r); },
}));
vi.mock('../utils/emailClient', () => ({
    emailClient: { send: async (p: any) => { estado.correos.push(p); return estado.correoOk ? { success: true } : { success: false, error: { message: 'Resend caído' } }; } },
}));
vi.mock('../utils/schoolBrandingResolver', () => ({
    resolveSchoolBranding: async () => ({ schoolId: 's', schoolName: 'CLUB DEPORTIVO BESSER', logoUrl: 'https://x/logo.jpg', primaryColor: '#E3000F', secondaryColor: '#FFCC00', showWatermark: true, hasWhitelabel: false }),
    escapeHtml: (s: string) => s,
}));
vi.mock('../services/cobro-enlace-publico.service', () => ({
    emitirTokenCobro: async (id: string) => { estado.tokensDeCobro.push(id); return 'CobroTokenCobroToken123'; },
}));

import { estadoCuentaPublicoRouter, estadoCuentaAdminRouter } from './estado-cuenta-enlace.routes';

const BESSER = 'b0000000-0000-4000-8000-000000000001';
const OTRA = 'c0000000-0000-4000-8000-000000000002';
const HIJA = 'a1000000-0000-4000-8000-000000000001';
const HERMANO = 'a2000000-0000-4000-8000-000000000002';
const AJENO = 'a3000000-0000-4000-8000-000000000003';
const FICHA = 'f1000000-0000-4000-8000-000000000001';
const PADRE = 'd1000000-0000-4000-8000-000000000001';
const TOKEN = 'TokenFamiliaTokenFamil12';       // 24
const TOKEN_VENCIDO = 'TokenVencidoXXXXXXXXXXXX';
const TOKEN_REVOCADO = 'TokenRevocadoXXXXXXXXXXX';
const TOKEN_INVALIDO = 'TokenAtletasMalosMalos12';
const TOKEN_NO_EXISTE = 'NoExisteNoExisteNoExiste';

const pago = (id: string, extra: Fila = {}): Fila => ({
    id, school_id: BESSER, status: 'paid', amount: 380000, amount_paid: 380000, late_fee_amount: 0,
    concept: 'Mensualidad 09/2026 - ISABELLA ALFONSO', due_date: '2026-09-10', payment_date: '2026-09-08',
    period_year: 2026, period_month: 9, created_at: '2026-09-01T06:30:00Z',
    payment_method: 'transfer', payment_channel: 'transfer', payment_provider: 'wompi', receipt_url: 'ruta/privada/comprobante-1.png',
    wompi_reference: null, wompi_transaction_id: null, provider_transaction_id: null,
    child_id: HIJA, user_id: null, unregistered_athlete_id: null, parent_id: PADRE, ...extra,
});

let base = '';
let server: http.Server;

beforeAll(async () => {
    const app = express();
    app.use('/api/v1/public/estado-cuenta', estadoCuentaPublicoRouter);
    app.use('/api/v1/estado-cuenta', estadoCuentaAdminRouter);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => { server.close(); });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T15:00:00Z'));
    estado.tablas = {
        payments: [
            pago('p-sep'),
            pago('p-oct', { status: 'overdue', amount_paid: null, payment_date: null, receipt_url: null, payment_channel: null, due_date: '2026-10-10', period_month: 10, concept: 'Mensualidad 10/2026 - ISABELLA ALFONSO' }),
            pago('p-nov', { status: 'pending', amount_paid: null, payment_date: null, receipt_url: null, payment_channel: null, due_date: '2026-11-10', period_month: 11, concept: 'Mensualidad 11/2026 - ISABELLA ALFONSO' }),
            // OTRA escuela, MISMA hija: no debe aparecer jamás.
            pago('p-otra', { school_id: OTRA, amount: 777777, concept: 'Mensualidad OTRA ESCUELA' }),
            // Hermano del mismo acudiente en Besser.
            pago('p-herm', { child_id: HERMANO, concept: 'Mensualidad 09/2026 - JUAN ALFONSO', receipt_url: null, payment_channel: 'cash' }),
            // Hijo de otro acudiente.
            pago('p-ajeno', { child_id: AJENO, parent_id: 'otro-padre', concept: 'Mensualidad - PERSONA AJENA' }),
            // Ficha sin cuenta.
            pago('p-ficha', { child_id: null, unregistered_athlete_id: FICHA, parent_id: null }),
        ],
        children: [
            { id: HIJA, full_name: 'Isabella Alfonso', parent_id: PADRE, parent_name_temp: null, parent_email_temp: null, parent_phone_temp: null },
            { id: HERMANO, full_name: 'Juan Alfonso', parent_id: PADRE, parent_name_temp: null, parent_email_temp: null, parent_phone_temp: null },
            { id: AJENO, full_name: 'Persona Ajena', parent_id: 'otro-padre', parent_name_temp: null, parent_email_temp: null, parent_phone_temp: null },
        ],
        profiles: [{ id: PADRE, full_name: 'Carolina Pérez', email: 'Carolina.Perez@Correo.co', phone: '3009998877' }],
        unregistered_athletes: [{ id: FICHA, full_name: 'Ficha Sin Cuenta', email: null, phone: null, date_of_birth: '2010-01-01', guardian_full_name: null, guardian_email: null, guardian_phone: null }],
        attendance_records: [
            { school_id: BESSER, child_id: HIJA, user_id: null, unregistered_athlete_id: null, attendance_date: '2026-10-02', status: 'present' },
            { school_id: BESSER, child_id: HIJA, user_id: null, unregistered_athlete_id: null, attendance_date: '2026-10-09', status: 'absent' },
            { school_id: OTRA, child_id: HIJA, user_id: null, unregistered_athlete_id: null, attendance_date: '2026-10-10', status: 'present' },
        ],
    };
    const dosAtletas = [{ tipo: 'hijo', id: HIJA }, { tipo: 'hijo', id: HERMANO }];
    estado.tokens = {
        [TOKEN]: { school_id: BESSER, atletas: [{ tipo: 'hijo', id: HIJA }], meses: 12, vence_en: '2027-01-01T00:00:00Z', estado: 'vigente' },
        [TOKEN_INVALIDO]: { school_id: BESSER, atletas: [{ tipo: 'hijo', id: 'no-es-uuid' }], meses: 12, vence_en: '2027-01-01T00:00:00Z', estado: 'vigente' },
        [TOKEN_VENCIDO]: { school_id: BESSER, atletas: dosAtletas, meses: 12, vence_en: '2020-01-01T00:00:00Z', estado: 'vencido' },
        [TOKEN_REVOCADO]: { school_id: BESSER, atletas: dosAtletas, meses: 12, vence_en: '2027-01-01T00:00:00Z', estado: 'revocado' },
    };
    estado.rpcError = null; estado.emitirError = null; estado.rpcLlamadas = [];
    estado.horario = true; estado.contactadosHoy = new Set(); estado.reservaNull = false;
    estado.correos = []; estado.correoOk = true; estado.reservas = []; estado.cierres = []; estado.tokensDeCobro = [];
    process.env.FAMILIAS_APP_URL = 'https://app.sportmaps.co';
});
afterEach(() => { vi.useRealTimers(); });

const get = (t: string) => fetch(`${base}/public/estado-cuenta/${t}`);
const enviar = (body: any, headers: Record<string, string> = { 'x-test-rol': 'school_admin', 'x-school-id': BESSER }) =>
    fetch(`${base}/estado-cuenta/enviar`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('el enlace público: token', () => {
    it('mal formado e inexistente responden el MISMO 404, y el mal formado no llega a la base', async () => {
        const a = await get('corto');
        const b = await get(TOKEN_NO_EXISTE);
        expect(a.status).toBe(404);
        expect(b.status).toBe(404);
        expect(await a.json()).toEqual(await b.json());
        expect(estado.rpcLlamadas.filter((l) => l.args?.p_token === 'corto')).toHaveLength(0);
    });
    it('vencido y revocado → 410 con su motivo', async () => {
        const v = await get(TOKEN_VENCIDO);
        const r = await get(TOKEN_REVOCADO);
        expect(v.status).toBe(410); expect((await v.json()).error).toBe('vencido');
        expect(r.status).toBe(410); expect((await r.json()).error).toBe('revocado');
    });
    it('migración sin aplicar (la RPC falla) → 404, no un 500', async () => {
        estado.rpcError = { message: 'function does not exist' };
        expect((await get(TOKEN)).status).toBe(404);
    });
    it('un token cuyos atletas no son uuid válidos → 404', async () => {
        expect((await get(TOKEN_INVALIDO)).status).toBe(404);
    });
    it('nunca se cachea ni se indexa', async () => {
        const r = await get(TOKEN);
        expect(r.headers.get('cache-control')).toBe('no-store');
        expect(r.headers.get('x-robots-tag')).toContain('noindex');
    });
});

describe('el enlace público: lo que ve la familia', () => {
    it('trae la escuela, el período, el deportista con nombre corto y sus meses', async () => {
        const r = await get(TOKEN);
        expect(r.status).toBe(200);
        const v = await r.json();
        expect(v.escuela).toMatchObject({ nombre: 'CLUB DEPORTIVO BESSER', colorPrimario: '#E3000F', mostrarMarcaSportmaps: true });
        expect(v.periodo).toEqual({ desde: '2025-12-01', hasta: '2026-11-12', meses: 12 });
        expect(v.atletas).toHaveLength(1);
        expect(v.atletas[0].nombre).toBe('Isabella A.');
        expect(v.atletas[0].cobros.map((c: any) => c.due_date)).toEqual(['2026-09-10', '2026-10-10', '2026-11-10']);
        expect(v.atletas[0].asistencia['2026-10']).toEqual({ asistio: 1, tarde: 0, excusada: 0, falto: 1, total: 2 });
    });

    it('NO deja salir correo, teléfono, ids ni la ruta del comprobante', async () => {
        const texto = JSON.stringify(await (await get(TOKEN)).json());
        for (const prohibido of ['Carolina', 'correo.co', '3009998877', PADRE, HIJA, 'p-sep', 'comprobante-1', 'ruta/privada', 'ALFONSO', 'Alfonso']) {
            expect(texto, prohibido).not.toContain(prohibido);
        }
    });

    it('jamás mezcla los datos de OTRA escuela, aunque sea el mismo deportista', async () => {
        const v = await (await get(TOKEN)).json();
        const texto = JSON.stringify(v);
        expect(texto).not.toContain('OTRA ESCUELA');
        expect(texto).not.toContain('777777');
        expect(v.atletas[0].asistencia['2026-10'].total).toBe(2); // la clase de OTRA no cuenta
    });

    it('el resumen es el de la base: lo que debe es lo abierto', async () => {
        const v = await (await get(TOKEN)).json();
        expect(v.atletas[0].resumen).toMatchObject({ count_expected: 3, total_expected: 1140000, total_settled: 380000, total_open: 760000, count_open: 2 });
    });

    it('«Pagar» abre el cobro abierto MÁS VIEJO y el id del cobro no sale en la vista', async () => {
        const v = await (await get(TOKEN)).json();
        expect(estado.tokensDeCobro).toEqual(['p-oct']);
        expect(v.pagarUrl).toBe('https://app.sportmaps.co/p/CobroTokenCobroToken123');
        expect(JSON.stringify(v)).not.toContain('p-oct');
    });

    it('sin nada que deber no hay botón de pagar ni se emite un token de cobro', async () => {
        estado.tablas.payments = [pago('p-sep')];
        const v = await (await get(TOKEN)).json();
        expect(v.pagarUrl).toBeNull();
        expect(estado.tokensDeCobro).toEqual([]);
    });

    it('un enlace vigente cuyo deportista ya no tiene nada en la escuela no se publica vacío', async () => {
        estado.tablas.payments = [pago('p-otra', { school_id: OTRA })];
        estado.tablas.attendance_records = [];
        expect((await get(TOKEN)).status).toBe(404);
    });
});

describe('«Enviar al acudiente»: quién puede', () => {
    it('sin sesión → 401', async () => {
        expect((await enviar({ atleta: { tipo: 'hijo', id: HIJA } }, {})).status).toBe(401);
    });
    it('el coach, el padre y el contador → 403', async () => {
        for (const rol of ['coach', 'parent', 'accountant', 'athlete']) {
            const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA } }, { 'x-test-rol': rol, 'x-school-id': BESSER });
            expect(r.status, rol).toBe(403);
        }
    });
    it('owner, admin, school_admin y super_admin pasan', async () => {
        for (const rol of ['owner', 'admin', 'school_admin', 'super_admin']) {
            const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA } }, { 'x-test-rol': rol, 'x-school-id': BESSER });
            expect(r.status, rol).toBe(200);
        }
    });
    it('el cuerpo no puede nombrar la escuela ni traer campos de más', async () => {
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, schoolId: OTRA });
        expect(r.status).toBe(400);
    });
    it('datos inválidos → 400', async () => {
        expect((await enviar({ atleta: { tipo: 'hijo', id: 'no-uuid' } })).status).toBe(400);
        expect((await enviar({ atleta: { tipo: 'perro', id: HIJA } })).status).toBe(400);
        expect((await enviar({})).status).toBe(400);
    });
    it('la escuela sale de la membresía: un deportista de OTRA escuela es 404', async () => {
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA } }, { 'x-test-rol': 'school_admin', 'x-school-id': OTRA });
        // En OTRA la hija sí tiene un pago (p-otra), así que existe; pero la familia se arma solo con lo de OTRA:
        // el hermano (que solo tiene cobros en Besser) no aparece.
        expect(r.status).toBe(200);
        expect((await r.json()).atletas).toEqual(['Isabella A.']);
        const sinPagos = await enviar({ atleta: { tipo: 'hijo', id: AJENO } }, { 'x-test-rol': 'school_admin', 'x-school-id': OTRA });
        expect(sinPagos.status).toBe(404);
        expect((await sinPagos.json()).motivo).toBe('no_pertenece');
    });
});

describe('«Enviar al acudiente»: simular no escribe nada', () => {
    it('por defecto simula: dice a dónde llegaría y no reserva, ni emite, ni manda', async () => {
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA } });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j).toMatchObject({ ok: true, simulado: true, canal: 'correo', vigenciaDias: 60 });
        expect(j.destino).toBe('c••••••@correo.co');
        expect(j.destino).not.toContain('arolina');
        expect(j.atletas.sort()).toEqual(['Isabella A.', 'Juan A.']);
        expect(estado.reservas).toHaveLength(0);
        expect(estado.correos).toHaveLength(0);
        expect(estado.rpcLlamadas.filter((l) => l.nombre === 'estado_cuenta_enlace_emitir')).toHaveLength(0);
    });
    it('simular también avisa lo que frenaría el envío real', async () => {
        estado.horario = false;
        expect((await enviar({ atleta: { tipo: 'hijo', id: HIJA } })).status).toBe(409);
        estado.horario = true;
        estado.contactadosHoy = new Set(['carolina.perez@correo.co']);
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA } });
        expect(r.status).toBe(409);
        expect((await r.json()).motivo).toBe('contactada_hoy');
    });
});

describe('«Enviar al acudiente»: el envío de verdad', () => {
    it('manda un correo con el enlace de la familia y los dos hermanos', async () => {
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect(r.status).toBe(200);
        expect((await r.json()).simulado).toBe(false);
        expect(estado.correos).toHaveLength(1);
        const c = estado.correos[0];
        expect(c.to).toBe('carolina.perez@correo.co');
        expect(c.subject).toBe('Estado de cuenta — CLUB DEPORTIVO BESSER');
        expect(c.html).toContain('https://app.sportmaps.co/e/EnlaceNuevoEnlaceNuevo12');
        expect(c.html).toContain('Isabella A.');
        expect(c.html).toContain('Juan A.');
        expect(c.html).not.toContain('Persona A.'); // el hijo de otro acudiente no va
        expect(c.html).not.toContain('Alfonso');
        expect(c.html).not.toContain('comprobante-1');
        expect(estado.reservas).toHaveLength(1);
        expect(estado.reservas[0]).toMatchObject({ tipo: 'estado_cuenta_enlace', schoolId: BESSER, destinos: ['carolina.perez@correo.co'] });
        expect(estado.reservas[0].clave).toBe('estado_cuenta_enlace:' + BESSER + ':carolina.perez@correo.co:2026-11-12');
        expect(estado.cierres).toEqual([{ ok: true, error: undefined }]);
    });

    it('emite el enlace con los hermanos ordenados y con quien lo envió', async () => {
        await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        const emitir = estado.rpcLlamadas.find((l) => l.nombre === 'estado_cuenta_enlace_emitir')!;
        expect(emitir.args).toMatchObject({ p_school_id: BESSER, p_familia_clave: 'carolina.perez@correo.co', p_created_by: 'perfil-admin', p_dias: 60, p_meses: 12 });
        expect(emitir.args.p_atletas.map((a: any) => a.id)).toEqual([HIJA, HERMANO]);
    });

    it('«Reenviar» usa su propia clave: no la frena el envío de hoy', async () => {
        await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true, reenviar: true });
        expect(estado.reservas[0].clave).toContain('estado_cuenta_enlace_reenvio:');
    });

    it('fuera de horario de cobranza → 409 y no se manda nada', async () => {
        estado.horario = false;
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect(r.status).toBe(409);
        expect((await r.json()).motivo).toBe('fuera_de_horario');
        expect(estado.correos).toHaveLength(0);
        expect(estado.reservas).toHaveLength(0);
    });

    it('ya enviado hoy (la reserva choca) → 409 y no se manda otro', async () => {
        estado.reservaNull = true;
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect(r.status).toBe(409);
        expect((await r.json()).motivo).toBe('ya_enviado_hoy');
        expect(estado.correos).toHaveLength(0);
    });

    it('la familia ya recibió un estado de cuenta hoy → 409, un contacto por día', async () => {
        estado.contactadosHoy = new Set(['carolina.perez@correo.co']);
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect((await r.json()).motivo).toBe('contactada_hoy');
        expect(estado.correos).toHaveLength(0);
    });

    it('sin correo registrado → 422 y se dice qué hacer', async () => {
        estado.tablas.profiles = [];
        const r = await enviar({ atleta: { tipo: 'ficha', id: FICHA }, aplicar: true });
        expect(r.status).toBe(422);
        const j = await r.json();
        expect(j.motivo).toBe('sin_correo');
        expect(j.mensaje).toContain('correo');
        expect(estado.correos).toHaveLength(0);
    });

    it('el correo del contacto temporal del menor (sin cuenta) también sirve', async () => {
        estado.tablas.children = [{ id: HIJA, full_name: 'Isabella Alfonso', parent_id: null, parent_name_temp: 'Don Pedro', parent_email_temp: 'pedro@correo.co', parent_phone_temp: null }];
        estado.tablas.payments = [pago('p-sep', { parent_id: null })];
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect(r.status).toBe(200);
        expect(estado.correos[0].to).toBe('pedro@correo.co');
        expect(estado.correos[0].html).toContain('Don Pedro');
    });

    it('si el correo falla → 502 y la reserva se cierra como fallida', async () => {
        estado.correoOk = false;
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect(r.status).toBe(502);
        expect((await r.json()).motivo).toBe('fallo_envio');
        expect(estado.cierres[0]).toMatchObject({ ok: false });
    });

    it('migración sin aplicar (no se puede emitir el enlace) → 503, sin mandar un correo sin enlace', async () => {
        estado.emitirError = { message: 'relation estado_cuenta_enlaces does not exist' };
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect(r.status).toBe(503);
        expect((await r.json()).motivo).toBe('no_disponible');
        expect(estado.correos).toHaveLength(0);
        expect(estado.cierres[0]).toMatchObject({ ok: false });
    });

    it('una URL de familias que no es pública detiene el envío', async () => {
        process.env.FAMILIAS_APP_URL = 'http://localhost:5173';
        const r = await enviar({ atleta: { tipo: 'hijo', id: HIJA }, aplicar: true });
        expect(r.status).toBe(503);
        expect(estado.correos).toHaveLength(0);
    });
});
