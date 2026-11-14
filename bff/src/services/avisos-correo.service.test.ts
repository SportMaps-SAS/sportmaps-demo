/**
 * Avisos por correo del bot: freno de 6 h por conversación, destinatarios
 * deduplicados, resumen diario vacío que no sale, idempotencia diaria y
 * semanal EN LA BASE (los tres BFF comparten Supabase y corren el mismo cron),
 * y respaldo cuando la edge function viva no conoce la plantilla.
 *
 * Supabase y fetch van simulados: la base es un objeto en memoria con el PK de
 * email_sends respetado (23505), que es justo el candado que se prueba.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const estado = vi.hoisted(() => ({ tablas: {} as Record<string, Record<string, any>[]> }));

vi.mock('../config/supabase', () => {
    /** Valor de una columna, con soporte para `payload->>step` / `payload->x`. */
    const valor = (f: any, col: string) => {
        const m = /^(\w+)->>?(\w+)$/.exec(col);
        return m ? f[m[1]]?.[m[2]] : f[col];
    };
    function builder(tabla: string) {
        const filas = () => (estado.tablas[tabla] ??= []);
        const filtros: ((f: any) => boolean)[] = [];
        let op: 'select' | 'insert' | 'update' = 'select';
        let payload: any = null;
        let head = false;
        let unico = false;
        let limite = Infinity;
        let orden: { col: string; asc: boolean } | null = null;
        let alias: [string, string][] = [];
        const api: any = {
            select: (cols?: string, opts?: any) => {
                head = Boolean(opts?.head);
                alias = String(cols ?? '').split(',').map((s) => s.trim())
                    .filter((s) => s.includes(':')).map((s) => s.split(':') as [string, string]);
                return api;
            },
            eq: (c: string, v: any) => { filtros.push((f) => valor(f, c) === v); return api; },
            neq: (c: string, v: any) => { filtros.push((f) => valor(f, c) !== v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((f) => vs.includes(valor(f, c))); return api; },
            gte: (c: string, v: any) => { filtros.push((f) => valor(f, c) != null && valor(f, c) >= v); return api; },
            lt: (c: string, v: any) => { filtros.push((f) => valor(f, c) != null && valor(f, c) < v); return api; },
            is: (c: string, v: any) => { filtros.push((f) => (f[c] ?? null) === v); return api; },
            order: (col: string, o?: any) => { orden = { col, asc: o?.ascending !== false }; return api; },
            limit: (n: number) => { limite = n; return api; },
            maybeSingle: () => { unico = true; return api; },
            insert: (p: any) => { op = 'insert'; payload = p; return api; },
            update: (p: any) => { op = 'update'; payload = p; return api; },
            then: (ok: any, ko: any) => {
                let r: any;
                if (op === 'insert') {
                    const nuevas = (Array.isArray(payload) ? payload : [payload])
                        .map((x: any) => ({ created_at: new Date().toISOString(), ...x }));
                    const choca = nuevas.some((n: any) => n.id && filas().some((f) => f.id === n.id));
                    if (choca) r = { data: null, error: { code: '23505', message: 'duplicate key' } };
                    else { filas().push(...nuevas); r = { data: null, error: null }; }
                } else {
                    let sel = filas().filter((f) => filtros.every((fn) => fn(f)));
                    if (op === 'update') {
                        for (const f of sel) Object.assign(f, payload);
                        r = { data: null, error: null };
                    } else {
                        if (orden) {
                            const { col, asc } = orden;
                            sel = [...sel].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
                        }
                        sel = sel.slice(0, limite).map((f) => {
                            const out = { ...f };
                            for (const [a, c] of alias) out[a] = valor(f, c);
                            return out;
                        });
                        r = head ? { data: null, count: sel.length, error: null }
                            : { data: unico ? (sel[0] ?? null) : sel, error: null };
                    }
                }
                return Promise.resolve(r).then(ok, ko);
            },
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t) } };
});

const svc = await import('./avisos-correo.service');
const diario = await import('../jobs/whatsapp-resumen-diario.job');
const semanal = await import('../jobs/bot-resumen-semanal.job');

// ─── fetch simulado (edge function send-email) ──────────────────────────────

let llamadas: any[] = [];
let respuesta: (body: any) => { status: number; body: any } = () => ({ status: 200, body: { success: true, results: [{ id: 'resend-1' }] } });

beforeEach(() => {
    llamadas = [];
    respuesta = () => ({ status: 200, body: { success: true, results: [{ id: 'resend-1' }] } });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        llamadas.push(body);
        const r = respuesta(body);
        return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) } as any;
    }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z')); // lunes 7:00 a. m. en Colombia
    delete process.env.DISABLE_WHATSAPP_RESUMEN_CORREO;
    delete process.env.DISABLE_BOT_RESUMEN_SEMANAL_CORREO;
    delete process.env.SUPPORT_ALERT_EMAIL;

    const ESC = 'esc-1';
    estado.tablas = {
        schools: [{ id: ESC, name: 'Dynasty', owner_id: 'p-owner' }],
        school_members: [
            // El dueño también es miembro admin: no debe recibir dos correos.
            { school_id: ESC, profile_id: 'p-owner', role: 'owner', status: 'active' },
            { school_id: ESC, profile_id: 'p-admin', role: 'school_admin', status: 'active' },
            { school_id: ESC, profile_id: 'p-admin2', role: 'admin', status: 'active' },
            { school_id: ESC, profile_id: 'p-coach', role: 'coach', status: 'active' },
            { school_id: ESC, profile_id: 'p-ex', role: 'admin', status: 'inactive' },
        ],
        profiles: [
            { id: 'p-owner', email: 'Duena@Dynasty.co', full_name: 'Dueña' },
            // Mismo correo que el dueño con otra capitalización: un solo destinatario.
            { id: 'p-admin', email: 'duena@dynasty.co' },
            { id: 'p-admin2', email: 'admin@dynasty.co' },
            { id: 'p-coach', email: 'coach@dynasty.co' },
            { id: 'p-ex', email: 'ex@dynasty.co' },
        ],
        whatsapp_conversations: [
            { id: 'conv-fam', school_id: ESC, integration_id: 'int-1', contact_name: 'Mamá de Sofía', contact_wa_id: '573001112233', contact_kind: 'familia', status: 'open', last_inbound_at: '2026-10-04T20:00:00Z', last_message_at: '2026-10-04T20:00:00Z' },
            { id: 'conv-amigo', school_id: ESC, integration_id: 'int-1', contact_name: 'Pedro', contact_wa_id: '573009998877', contact_kind: 'personal', status: 'open', last_inbound_at: '2026-10-04T20:00:00Z', last_message_at: '2026-10-04T20:00:00Z' },
        ],
        whatsapp_messages: [
            { conversation_id: 'conv-fam', integration_id: 'int-1', direction: 'inbound', ai_generated: false, text_body: 'Hola, ¿ya aprobaron mi pago?', type: 'text', wa_timestamp: '2026-10-04T20:00:00Z', created_at: '2026-10-04T20:00:00Z', payload: {} },
        ],
        whatsapp_inbound_queue: [],
        school_whatsapp_integrations: [{ id: 'int-1', school_id: ESC, status: 'active' }],
        email_sends: [],
        support_tickets: [],
        support_messages: [],
    };
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const aviso = (extra: Partial<Parameters<typeof svc.avisarEscalamientoPorCorreo>[0]> = {}) => ({
    schoolId: 'esc-1', conversationId: 'conv-fam', contactName: 'Mamá de Sofía',
    contactWaId: '573001112233', motivo: 'user_request', ...extra,
});

// ─── Utilidades ─────────────────────────────────────────────────────────────

describe('utilidades', () => {
    it('uuidDeClave es determinístico y con formato de UUID', () => {
        const a = svc.uuidDeClave('wa_resumen_diario:esc-1:2026-10-05');
        expect(a).toBe(svc.uuidDeClave('wa_resumen_diario:esc-1:2026-10-05'));
        expect(a).not.toBe(svc.uuidDeClave('wa_resumen_diario:esc-1:2026-10-06'));
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('enmascara el número y traduce motivos', () => {
        expect(svc.enmascararNumero('573001112233')).toBe('+57 ••• ••• 2233');
        expect(svc.motivoLegible('tool_error')).toMatch(/no pudo consultar/);
        expect(svc.motivoLegible('Dos cuentas comparten el mismo número')).toBe('Dos cuentas comparten el mismo número');
    });

    it('fechaColombia cambia de día a medianoche de Bogotá, no de UTC', () => {
        expect(svc.fechaColombia(Date.parse('2026-10-05T04:59:00Z'))).toBe('2026-10-04');
        expect(svc.fechaColombia(Date.parse('2026-10-05T05:00:00Z'))).toBe('2026-10-05');
    });
});

// ─── Destinatarios ──────────────────────────────────────────────────────────

describe('destinatariosDeEscuela', () => {
    it('owner + admins activos, deduplicados por perfil y por correo; sin coach ni inactivos', async () => {
        const r = await svc.destinatariosDeEscuela('esc-1');
        expect(r.escuela).toBe('Dynasty');
        expect(r.correos.sort()).toEqual(['admin@dynasty.co', 'duena@dynasty.co']);
    });

    it('suma al dueño aunque no tenga fila en school_members', async () => {
        estado.tablas.school_members = [];
        expect((await svc.destinatariosDeEscuela('esc-1')).correos).toEqual(['duena@dynasty.co']);
    });
});

// ─── 1. Escalamiento ────────────────────────────────────────────────────────

describe('avisarEscalamientoPorCorreo', () => {
    it('manda UN lote a los destinatarios deduplicados, con los últimos mensajes y el enlace al buzón', async () => {
        await svc.avisarEscalamientoPorCorreo(aviso());
        expect(llamadas).toHaveLength(1);
        const lote = llamadas[0].batch;
        expect(lote.map((x: any) => x.to).sort()).toEqual(['admin@dynasty.co', 'duena@dynasty.co']);
        expect(lote[0].type).toBe('wa_escalamiento');
        expect(JSON.parse(lote[0].data.mensajesJson)[0].texto).toBe('Hola, ¿ya aprobaron mi pago?');
        expect(lote[0].data.conversationUrl).toContain('/whatsapp?tab=conversaciones&conversacion=conv-fam');
        const log = estado.tablas.email_sends;
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ status: 'sent', error: null, batch_id: 'conv-fam', email_type: 'wa_escalamiento' });
    });

    it('freno de 6 h: la segunda escalación de la misma conversación no manda; pasadas 6 h sí', async () => {
        await svc.avisarEscalamientoPorCorreo(aviso());
        vi.setSystemTime(new Date('2026-10-05T17:59:00Z')); // 5 h 59 min después
        await svc.avisarEscalamientoPorCorreo(aviso());
        expect(llamadas).toHaveLength(1);

        vi.setSystemTime(new Date('2026-10-05T18:01:00Z')); // 6 h 1 min después
        await svc.avisarEscalamientoPorCorreo(aviso());
        expect(llamadas).toHaveLength(2);
    });

    it('un envío FALLIDO no frena: la siguiente escalación reintenta', async () => {
        respuesta = () => ({ status: 502, body: { error: 'Resend error: 500' } });
        await svc.avisarEscalamientoPorCorreo(aviso());
        expect(estado.tablas.email_sends[0].status).toBe('failed');

        respuesta = () => ({ status: 200, body: { success: true, results: [{ id: 'x' }] } });
        vi.setSystemTime(new Date('2026-10-05T12:05:00Z'));
        await svc.avisarEscalamientoPorCorreo(aviso());
        expect(llamadas).toHaveLength(2);
        expect(estado.tablas.email_sends.filter((f) => f.status === 'sent')).toHaveLength(1);
    });

    it('dos escalaciones simultáneas (dos BFF) chocan en el PK: sale un solo correo', async () => {
        await Promise.all([svc.avisarEscalamientoPorCorreo(aviso()), svc.avisarEscalamientoPorCorreo(aviso())]);
        expect(llamadas).toHaveLength(1);
    });

    it('contacto que no es familia: no hay correo; el prospecto sí avisa', async () => {
        await svc.avisarEscalamientoPorCorreo(aviso({ conversationId: 'conv-amigo', contactName: 'Pedro' }));
        expect(llamadas).toHaveLength(0);

        await svc.avisarEscalamientoPorCorreo(aviso({ conversationId: 'conv-amigo', contactName: null, motivo: 'prospecto' }));
        expect(llamadas).toHaveLength(1);
        expect(llamadas[0].batch[0].data.titulo).toBe('Prospecto pregunta por inscripciones');
    });

    it('si send-email no conoce la plantilla, reintenta con el HTML de respaldo (y lo escapa)', async () => {
        estado.tablas.whatsapp_messages[0].text_body = '<script>alert(1)</script>';
        respuesta = (b) => (b.batch[0].type
            ? { status: 400, body: { error: 'Tipo de correo no soportado: wa_escalamiento' } }
            : { status: 200, body: { success: true, results: [{ id: 'r2' }] } });
        await svc.avisarEscalamientoPorCorreo(aviso());
        expect(llamadas).toHaveLength(2);
        expect(llamadas[1].batch[0].subject).toContain('espera respuesta');
        expect(llamadas[1].batch[0].html).toContain('&lt;script&gt;');
        expect(llamadas[1].batch[0].html).not.toContain('<script>');
        expect(estado.tablas.email_sends[0].status).toBe('sent');
    });

    it('nunca lanza, aunque fetch reviente', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('red caída'); }));
        await expect(svc.avisarEscalamientoPorCorreo(aviso())).resolves.toBeUndefined();
        expect(estado.tablas.email_sends[0].status).toBe('failed');
    });
});

// ─── 2. Resumen diario ──────────────────────────────────────────────────────

describe('runWhatsAppResumenDiario', () => {
    it('sin nada pendiente NO manda ni deja fila en el log', async () => {
        // La escuela ya le respondió a la familia desde el celular.
        estado.tablas.whatsapp_messages.push({ conversation_id: 'conv-fam', integration_id: 'int-1', direction: 'outbound', ai_generated: false, wa_timestamp: '2026-10-04T20:10:00Z', created_at: '2026-10-04T20:10:00Z', payload: { to: '573001112233' } });
        const r = await diario.runWhatsAppResumenDiario();
        expect(r.enviados).toBe(0);
        expect(llamadas).toHaveLength(0);
        expect(estado.tablas.email_sends).toHaveLength(0);
    });

    it('el saludo automático de la app no cuenta como respuesta: la familia sigue pendiente', async () => {
        estado.tablas.whatsapp_messages.push({ conversation_id: 'conv-fam', integration_id: 'int-1', direction: 'outbound', ai_generated: false, wa_timestamp: '2026-10-04T20:00:05Z', created_at: '2026-10-04T20:00:05Z', payload: { automatico: true } });
        const r = await diario.armarResumenEscuela('esc-1', 'int-1');
        expect(r.familias).toHaveLength(1);
        expect(r.familias[0].contacto).toContain('Mamá de Sofía');
    });

    it('lista familias, comprobantes para la escuela y prospectos; el contacto personal no aparece', async () => {
        estado.tablas.whatsapp_inbound_queue = [
            { school_id: 'esc-1', wa_phone_number: '573001112233', status: 'ignored', result_type: 'escalated', created_at: '2026-10-05T01:00:00Z' },
            { school_id: 'esc-1', wa_phone_number: '573001112233', status: 'ignored', result_type: 'none', created_at: '2026-10-05T01:00:00Z' },
            { school_id: 'esc-1', wa_phone_number: '573001112233', status: 'failed', result_type: null, created_at: '2026-10-05T02:00:00Z' },
            { school_id: 'esc-1', wa_phone_number: '573001112233', status: 'failed', result_type: null, created_at: '2026-10-01T02:00:00Z' }, // > 24 h
        ];
        estado.tablas.whatsapp_conversations.push({ id: 'conv-pros', school_id: 'esc-1', contact_name: null, contact_wa_id: '573105556677', contact_kind: 'desconocido', status: 'open', last_inbound_at: '2026-10-05T03:00:00Z', last_message_at: '2026-10-05T03:00:00Z' });
        estado.tablas.whatsapp_messages.push({ conversation_id: 'conv-pros', integration_id: 'int-1', direction: 'outbound', ai_generated: true, wa_timestamp: '2026-10-05T03:00:01Z', created_at: '2026-10-05T03:00:01Z', payload: { step: 'desconocido_tema_escolar', intencion: 'inscripcion', con_enlace: false } });

        const r = await diario.armarResumenEscuela('esc-1', 'int-1');
        expect(r.familias.map((f) => f.contacto)).toEqual(['Mamá de Sofía (+57 ••• ••• 2233)']);
        expect(r.comprobantes).toHaveLength(2);
        expect(r.prospectos).toEqual([expect.objectContaining({ contacto: '+57 ••• ••• 6677', conEnlace: false, respondido: false })]);
    });

    it('idempotente por día: correr dos veces (o en los tres BFF) manda un solo correo', async () => {
        const [a, b] = await Promise.all([diario.runWhatsAppResumenDiario(), diario.runWhatsAppResumenDiario()]);
        await diario.runWhatsAppResumenDiario(); // reinicio del BFF a las 7:00
        expect(a.enviados + b.enviados).toBe(1);
        expect(llamadas).toHaveLength(1);
        expect(llamadas[0].batch.map((x: any) => x.to).sort()).toEqual(['admin@dynasty.co', 'duena@dynasty.co']);
        expect(estado.tablas.email_sends).toHaveLength(1);

        // Al día siguiente sí vuelve a salir.
        vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
        await diario.runWhatsAppResumenDiario();
        expect(llamadas).toHaveLength(2);
    });

    it('kill-switch', async () => {
        process.env.DISABLE_WHATSAPP_RESUMEN_CORREO = 'true';
        await diario.runWhatsAppResumenDiario();
        expect(llamadas).toHaveLength(0);
    });
});

// ─── 3. Tickets de Mapi ─────────────────────────────────────────────────

describe('avisarTicketSoportePorCorreo', () => {
    beforeEach(() => {
        estado.tablas.support_tickets = [{ id: 't-1', requester_id: 'p-admin2', school_id: 'esc-1', status: 'waiting_human', created_at: '2026-10-05T11:00:00Z' }];
        estado.tablas.support_messages = [
            { ticket_id: 't-1', author_type: 'user', body: 'No puedo entrar', created_at: '2026-10-05T11:00:00Z', internal_note: false },
            { ticket_id: 't-1', author_type: 'bot', body: 'Voy a pasar tu caso', created_at: '2026-10-05T11:00:02Z', internal_note: false },
        ];
    });

    it("'nuevo' sale una sola vez por ticket, a SUPPORT_ALERT_EMAIL", async () => {
        process.env.SUPPORT_ALERT_EMAIL = 'soporte@sportmaps.co, Otro@sportmaps.co';
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'nuevo' });
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'nuevo' });
        expect(llamadas).toHaveLength(1);
        const lote = llamadas[0].batch;
        expect(lote.map((x: any) => x.to)).toEqual(['soporte@sportmaps.co', 'otro@sportmaps.co']);
        // El HTML lo arma el BFF (markdown de Mapi → HTML), no la plantilla de send-email.
        expect(lote[0].type).toBeUndefined();
        expect(lote[0].subject).toBe('[Revisar] Nuevo caso en Mapi: admin@dynasty.co');
        expect(lote[0].html).toContain('Dynasty');
        expect(lote[0].html).toContain('Esperando a una persona');
        expect(lote[0].html).toMatch(/href="[^"]*\/admin\/support"/);
    });

    it("'escalado' en el primer mensaje no manda (lo cubre 'nuevo'); en uno posterior sí, con freno de 6 h", async () => {
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'escalado', motivo: 'tool_error' });
        expect(llamadas).toHaveLength(0);

        estado.tablas.support_messages.push({ ticket_id: 't-1', author_type: 'user', body: 'Sigo sin poder', created_at: '2026-10-05T11:30:00Z', internal_note: false });
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'escalado', motivo: 'tool_error' });
        vi.setSystemTime(new Date('2026-10-05T13:00:00Z'));
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'escalado', motivo: 'tool_error' });
        expect(llamadas).toHaveLength(1);
        expect(llamadas[0].batch[0].to).toBe('contacto@sportmaps.co');
        expect(llamadas[0].batch[0].html).toMatch(/no pudo consultar/);
        expect(llamadas[0].batch[0].subject).toBe('[Revisar] Mapi pasó un caso a una persona: admin@dynasty.co');
    });

    it("'nuevo' que Mapi resolvió va sin [Revisar]", async () => {
        estado.tablas.support_tickets[0].status = 'bot_handled';
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'nuevo' });
        expect(llamadas[0].batch[0].subject).toBe('Nuevo caso en Mapi: admin@dynasty.co');
    });

    it("'no_sirvio' sale con [Revisar], uno por respuesta, aunque ya haya salido el 'nuevo'", async () => {
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'nuevo' });
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'no_sirvio', respuestaId: 'm-9' });
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'no_sirvio', respuestaId: 'm-9' });
        expect(llamadas).toHaveLength(2);
        const b = llamadas[1].batch[0];
        expect(b.subject).toBe('[Revisar] A alguien no le sirvió la respuesta de Mapi: admin@dynasty.co');
        expect(b.html).toContain('NO le sirvió');
    });

    it('el cuerpo convierte el markdown de Mapi y escapa lo demás', async () => {
        estado.tablas.support_messages[1].body = '1. Abre **Asistencia**.\n2. Toca **Guardar lista**.\n<img src=x onerror=alert(1)>';
        await svc.avisarTicketSoportePorCorreo({ ticketId: 't-1', origen: 'nuevo' });
        const html = llamadas[0].batch[0].html as string;
        expect(html).toContain('<li>Abre <strong>Asistencia</strong>.</li>');
        expect(html).not.toContain('**');
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
});

describe('markdownAHtml', () => {
    it('negritas, listas y saltos de línea', () => {
        expect(svc.markdownAHtml('Hola **Ana**\nsegunda línea')).toBe('<p style="margin:0 0 8px;">Hola <strong>Ana</strong><br>segunda línea</p>');
        expect(svc.markdownAHtml('- uno\n- **dos**')).toBe('<ul style="margin:0 0 8px;padding-left:20px;"><li>uno</li><li><strong>dos</strong></li></ul>');
        expect(svc.markdownAHtml('Pasos:\n1. a\n2. b\n\nListo')).toBe(
            '<p style="margin:0 0 8px;">Pasos:</p><ol style="margin:0 0 8px;padding-left:20px;"><li>a</li><li>b</li></ol><p style="margin:0 0 8px;">Listo</p>');
    });

    it('escapa ANTES de dibujar: un ** con HTML adentro no se cuela', () => {
        const html = svc.markdownAHtml('**<script>alert(1)</script>** & "x"');
        expect(html).toContain('<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>');
        expect(html).toContain('&amp; &quot;x&quot;');
        expect(html).not.toMatch(/<script/);
    });

    it('asuntoTicket', () => {
        expect(svc.asuntoTicket({ origen: 'nuevo', status: 'bot_handled', nombre: 'Ana' })).toBe('Nuevo caso en Mapi: Ana');
        expect(svc.asuntoTicket({ origen: 'nuevo', status: 'waiting_human', nombre: 'Ana' })).toBe('[Revisar] Nuevo caso en Mapi: Ana');
        expect(svc.asuntoTicket({ origen: 'escalado', nombre: 'Ana' })).toMatch(/^\[Revisar\] Mapi pasó/);
    });
});

// ─── 4. Resumen semanal ─────────────────────────────────────────────────────

describe('resumen semanal', () => {
    it('rango: lunes a lunes en hora Colombia', () => {
        const r = semanal.rangoSemanaAnterior(Date.parse('2026-10-05T12:00:00Z'));
        expect(new Date(r.inicio).toISOString()).toBe('2026-09-28T05:00:00.000Z');
        expect(new Date(r.fin).toISOString()).toBe('2026-10-05T05:00:00.000Z');
        expect(r.lunes).toBe('2026-10-05');
    });

    it('métricas: resuelta sin humano, escalada y mediana a primera respuesta humana', () => {
        const kinds = new Map<string, string | null>([['a', 'familia'], ['b', 'familia'], ['c', 'desconocido']]);
        const m = (conv: string, dir: string, ai: boolean, min: number, extra: any = {}) => ({
            conversation_id: conv, direction: dir, ai_generated: ai,
            wa_timestamp: new Date(Date.parse('2026-09-30T15:00:00Z') + min * 60_000).toISOString(), ...extra,
        });
        const r = semanal.calcularMetricasEscuela([
            m('a', 'inbound', false, 0), m('a', 'outbound', true, 1),                       // bot la resolvió
            m('b', 'inbound', false, 0), m('b', 'outbound', true, 1, { step: 'escalated' }),
            m('b', 'outbound', false, 2, { automatico: true }),                              // saludo de la app: no es humano
            m('b', 'outbound', false, 30),                                                   // humano a los 30 min
            m('c', 'inbound', false, 0), m('c', 'outbound', false, 10),                      // humano a los 10 min
            m('d', 'outbound', true, 0),                                                     // solo saliente: no cuenta
        ], kinds);
        expect(r).toEqual({
            conversaciones: 3, familias: 2, resueltasSinHumano: 1, pctSinHumano: 50,
            escaladas: 1, medianaPrimeraRespuestaMin: 20,
        });
    });

    it('idempotente por semana en la base', async () => {
        await Promise.all([semanal.runBotResumenSemanal(), semanal.runBotResumenSemanal()]);
        await semanal.runBotResumenSemanal();
        expect(llamadas).toHaveLength(1);
        expect(llamadas[0].batch[0]).toMatchObject({ type: 'bot_resumen_semanal', to: 'contacto@sportmaps.co' });
        expect(JSON.parse(llamadas[0].batch[0].data.escuelasJson)[0].nombre).toBe('Dynasty');
    });
});
