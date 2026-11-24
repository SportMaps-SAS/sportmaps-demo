/**
 * enviar_recordatorio_pago (plan §4, §10, §13.2, §16.7): vista previa, exclusiones,
 * tope de 300, una acción igual por día, plantilla por escalón con registro
 * 'recordatorio_manual' y resultado parcial. Corre el planDeEscuela REAL de la
 * cadencia sobre el supabase falso: las exclusiones salen de la misma lógica del cron.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    responder: (_c: any): any => undefined,
    enviar: vi.fn(),
    duplicados: new Set<string>(),
    noAprobadas: new Set<string>(),
}));

vi.mock('../../config/supabase', async () => {
    const { crearSupabaseFalso } = await import('./supabase-falso.test-helper');
    const falso = crearSupabaseFalso((c) => h.responder(c));
    (globalThis as any).__consultas = falso.consultas;
    return { supabase: falso.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' };
});
vi.mock('../whatsapp-plantillas.service', async (orig) => {
    const real: any = await orig();
    return {
        ...real,
        enviarCobroPorPlantilla: h.enviar,
        plantillaAprobada: vi.fn(async (_integ: string, concepto: string) => (h.noAprobadas.has(concepto)
            ? { aprobada: false, motivo: 'plantilla_no_aprobada' } : { aprobada: true })),
    };
});
vi.mock('../cobro-enlace-publico.service', () => ({ emitirTokenCobro: vi.fn(async () => 'tok') }));
vi.mock('../duplicatePayerGuard.service', () => ({ findDuplicatePaymentIds: vi.fn(async () => h.duplicados) }));
vi.mock('../../utils/emailClient', () => ({ emailClient: { send: vi.fn(async () => ({ success: true })) } }));
vi.mock('../../utils/emailTemplates', () => ({
    BrandedEmailTemplates: { recordatorioCobro: vi.fn(async () => ({ subject: 's', html: 'h' })) },
}));

import { enviarRecordatorioPago, NOMBRE, lineasDeExclusion, resumenFallos } from './herramientas/recordatorio';
import { herramientasPara } from './registro';
import { RechazoHerramienta, type Alcance } from './tipos';

const ESCUELA = '11111111-1111-1111-1111-111111111111';
const SUB12 = '22222222-2222-2222-2222-222222222222';
const SUB14 = '33333333-3333-3333-3333-333333333333';
const admin: Alcance = {
    schoolId: ESCUELA, userId: 'u-admin', rol: 'admin', teamIds: [],
    ajustes: { coachMapiAttendance: true, coachMapiNotices: true, coachHideFinancialInfo: false }, hoy: '2026-11-24',
};
const coach: Alcance = { ...admin, rol: 'coach', userId: 'u-coach', teamIds: [SUB12] };
const MARTES_10AM = new Date('2026-11-24T15:00:00Z'); // martes 24 de noviembre, 10:00 de Bogotá
const consultas = () => (globalThis as any).__consultas as any[];
const de = (tabla: string, op = 'select') => consultas().filter((c) => c.tabla === tabla && c.op === op);
const filtro = (c: any, tipo: string, col: string) => c.filtros.find((f: any[]) => f[0] === tipo && f[1] === col)?.[2];

// ─── Escenario: la base que ve el supabase falso ────────────────────────────

let esc: {
    pagos: any[]; perfiles: any[]; hijos: any[]; optin: string[]; leadsHoy: string[]; manuales: any[];
    borradoresHoy: any[]; lotes: { pagos: any[]; batches: any[] }; equipos: any[]; atletas: any[];
    correo: boolean; choque: Set<string>; integracion: boolean;
};

const pago = (id: string, extra: Record<string, unknown> = {}) => ({
    id, school_id: ESCUELA, parent_id: null, user_id: null, child_id: null, unregistered_athlete_id: null,
    concept: 'Mensualidad noviembre', amount: 150000, amount_paid: 0, early_payment_discount_applied: 0, late_fee_amount: 0,
    status: 'pending', due_date: '2026-11-30', payment_type: 'subscription', payment_category: 'mensualidad',
    period_year: 2026, period_month: 11, charge_notice_sent_at: '2026-11-01T13:00:00Z', overdue_notice_sent_at: null,
    requires_review: false, ...extra,
});

/** Acudiente con sus hijos y un cobro por hijo. `tel` de 10 dígitos; con opt-in salvo que se diga. */
function familia(clave: string, nombre: string, tel: string | null, hijos: { nombre: string; pago?: Record<string, unknown>; activo?: boolean }[], o: { optin?: boolean; email?: string | null } = {}) {
    const perfil = `perfil-${clave}`;
    esc.perfiles.push({ id: perfil, full_name: nombre, email: o.email ?? null, phone: tel });
    if (tel && o.optin !== false) esc.optin.push(`57${tel}`);
    hijos.forEach((hj, i) => {
        const hijo = `hijo-${clave}${i + 1}`;
        esc.hijos.push({ id: hijo, is_active: hj.activo ?? true, full_name: hj.nombre });
        esc.pagos.push(pago(`p${clave}${i + 1}`, { parent_id: perfil, child_id: hijo, ...hj.pago }));
    });
}

/** Carolina (dos hijos, vencidos, uno con mora) y Diana (por vencer). Más un cobro de octubre que no es del periodo. */
function escenarioBase() {
    familia('a', 'Carolina Pérez', '3001110001', [
        { nombre: 'Samuel Rodríguez', pago: { status: 'overdue', due_date: '2026-11-05' } },
        { nombre: 'Sofía Rodríguez', pago: { status: 'overdue', due_date: '2026-11-05', amount: 110000, late_fee_amount: 10000 } },
    ]);
    familia('b', 'Diana Gómez', '3001110002', [{ nombre: 'Tomás Gómez' }]);
    esc.pagos.push(pago('poct', { parent_id: 'perfil-b', child_id: 'hijo-b1', period_month: 10, due_date: '2026-10-05', status: 'overdue' }));
}

function responder(c: any) {
    const datos = c.datos as any;
    switch (c.tabla) {
        case 'schools': return { data: [{ name: 'Dynasty' }] };
        case 'school_whatsapp_integrations': return { data: esc.integracion ? [{ id: 'integ', waba_id: 'w', access_token_encrypted: 'x' }] : [] };
        case 'school_settings': return { data: [{ billing_cycle_type: 'fixed_calendar', payment_cutoff_day: 5, collection_policy_notice: null, email_collection_reminders_enabled: esc.correo }] };
        case 'payments':
            if (c.op !== 'select') return { data: null };
            return { data: String(c.columnas).includes('charge_batch_id') ? esc.lotes.pagos : esc.pagos };
        case 'charge_batches': return { data: esc.lotes.batches };
        case 'profiles': return { data: esc.perfiles };
        case 'children': return { data: esc.hijos };
        case 'whatsapp_optins': return { data: esc.optin.map((contact_wa_id) => ({ contact_wa_id })) };
        case 'mapi_action_drafts': return { data: esc.borradoresHoy };
        case 'teams': {
            const id = filtro(c, 'eq', 'id');
            return { data: id ? esc.equipos.filter((t) => t.id === id) : esc.equipos };
        }
        case 'school_athletes': {
            const col = c.filtros.find((f: any[]) => f[0] === 'eq' && (f[1] === 'team_id' || f[1] === 'enrolled_team_id'));
            return { data: esc.atletas.filter((x) => x[col[1]] === col[2]) };
        }
        case 'collection_notices':
            if (c.op === 'insert') {
                return datos.is_lead && esc.choque.has(datos.family_key)
                    ? { error: { code: '23505', message: 'duplicate key' } } : { data: [{ id: 'n' }] };
            }
            if (c.op !== 'select') return { data: null };
            if (c.columnas === 'payment_id, status') return { data: esc.manuales };
            if (c.columnas === 'family_key, status') return { data: esc.leadsHoy.map((family_key) => ({ family_key, status: 'sent' })) };
            return { data: [] };
        default: return { data: [] }; // unregistered_athletes, school_members, email_sends
    }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MARTES_10AM);
    consultas().length = 0;
    h.enviar.mockReset().mockImplementation(async (p: any) => ({ enviado: true, waMessageId: `wamid-${p.telefono}`, plantilla: `tpl:${p.concepto}` }));
    h.duplicados = new Set();
    h.noAprobadas = new Set();
    esc = {
        pagos: [], perfiles: [], hijos: [], optin: [], leadsHoy: [], manuales: [], borradoresHoy: [],
        lotes: { pagos: [], batches: [] }, equipos: [], atletas: [], correo: false, choque: new Set(), integracion: true,
    };
    h.responder = responder;
});
afterEach(() => {
    vi.useRealTimers();
    delete process.env.MAPI_RECORDATORIO_MANUAL;
});

const ARGS = { periodo: '2026-11' };

// ─── Vista previa ───────────────────────────────────────────────────────────

describe('enviar_recordatorio_pago — vista previa', () => {
    it('familias, total con mora, plantilla por escalón y detalle sin teléfonos ni correos; no escribe nada', async () => {
        escenarioBase();
        const p = await enviarRecordatorioPago.preparar(admin, ARGS);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Recordatorio de pago · Noviembre de 2026');
        expect(p.vista.lineas).toEqual([
            '2 familias · 3 mensualidades · $410.000 (incluye $10.000 de mora)',
            '1 familia con la mensualidad vencida (mensaje «quedó pendiente») · 1 familia por vencer (recordatorio con la fecha de pago)',
            'Por WhatsApp, con las plantillas aprobadas de la escuela. Un solo mensaje por familia con su total.',
        ]);
        expect(p.vista.detalle).toEqual({
            etiqueta: 'Ver las 2 familias',
            items: ['Samuel y Sofía (Carolina) · $260.000 · vencida', 'Tomás (Diana) · $150.000 · por vencer'],
        });
        expect(JSON.stringify(p.vista)).not.toMatch(/300111|573|@/);
        expect(p.vista.aviso).toBe('Los mensajes salen apenas confirmes y no se pueden deshacer.');
        expect(p.vista.botonConfirmar).toBe('Enviar a 2 familias');
        expect(p.targetKey).toBe('recordatorio:2026-11');
        expect(p.huella).toEqual({ periodo: '2026-11', equipo: null, cobros: [['pa1', 150000], ['pa2', 110000], ['pb1', 150000]] });
        expect(p.args).toEqual({ periodo: '2026-11' });
        expect(consultas().some((c) => c.op !== 'select')).toBe(false);
        expect(h.enviar).not.toHaveBeenCalled();
    });

    it('excluye y cuenta cada motivo (familia o cobro), y aun así arma el envío para las demás', async () => {
        escenarioBase();
        familia('c', 'Sin Optin', '3001110003', [{ nombre: 'Ceci' }], { optin: false });
        familia('d', 'Ya Avisada', '3001110004', [{ nombre: 'Dani' }]);
        esc.leadsHoy = ['wa:573001110004']; // el cron ya le escribió hoy: candado familia-día compartido
        familia('e', 'Manual Reciente', '3001110005', [{ nombre: 'Eli' }]);
        esc.manuales = [{ payment_id: 'pe1', status: 'sent' }];
        familia('f', 'Dado De Baja', '3001110006', [{ nombre: 'Fede', activo: false }]);
        familia('g', 'En Revision', '3001110007', [{ nombre: 'Gabi', pago: { requires_review: true } }]);
        familia('h', 'Lote Silencioso', '3001110008', [{ nombre: 'Hugo', pago: { charge_notice_sent_at: null } }]);
        esc.lotes = { pagos: [{ id: 'ph1', charge_batch_id: 'L1' }], batches: [{ id: 'L1', notify_families: false }] };
        familia('i', 'Torneo', '3001110009', [{ nombre: 'Iván', pago: { payment_category: 'torneo', concept: 'Copa Navidad' } }]);
        familia('j', 'Duplicado', '3001110010', [{ nombre: 'Juana' }]);
        h.duplicados = new Set(['pj1']);
        familia('k', 'Sin Contacto', null, [{ nombre: 'Kike' }]);

        const p = await enviarRecordatorioPago.preparar(admin, ARGS);
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.lineas[0]).toBe('2 familias · 3 mensualidades · $410.000 (incluye $10.000 de mora)');
        expect(p.vista.lineas.slice(3)).toEqual([
            'Se omite 1 familia sin WhatsApp autorizado.',
            'Se omite 1 familia con aviso de cobro hoy (máximo uno al día).',
            'Se omite 1 cobro con recordatorio manual hace menos de 7 días.',
            'Se omite 1 cobro con comprobante en revisión.',
            'Se omite 1 cobro de deportista dado de baja.',
            'Se omite 1 cobro de lotes creados sin «Avisar a las familias».',
            'Se omite 1 cobro por duplicado.',
            'Se omite 1 cobro sin teléfono ni correo de contacto.',
            'Se omite 1 cobro de otro concepto (torneo, uniforme…): este recordatorio es solo de mensualidades.',
        ]);
        expect(p.vista.botonConfirmar).toBe('Enviar a 2 familias');
        // El tope de 7 días: el manual de hace 6 días todavía cuenta (hoy incluido).
        const manual = de('collection_notices').find((c) => c.columnas === 'payment_id, status');
        expect(filtro(manual, 'eq', 'notice_type')).toBe('recordatorio_manual');
        expect(filtro(manual, 'eq', 'school_id')).toBe(ESCUELA);
        expect(filtro(manual, 'gte', 'contact_day')).toBe('2026-11-18');
        expect(consultas().some((c) => c.op !== 'select')).toBe(false);
    });

    it('si la plantilla del escalón no está aprobada en la WABA, esas familias se omiten y se dice', async () => {
        escenarioBase();
        h.noAprobadas = new Set(['pendiente_suave']);
        const p = await enviarRecordatorioPago.preparar(admin, ARGS);
        expect(p.ok && p.vista.lineas).toEqual([
            '1 familia · 1 mensualidad · $150.000',
            '1 familia por vencer (recordatorio con la fecha de pago)',
            'Por WhatsApp, con las plantillas aprobadas de la escuela. Un solo mensaje por familia con su total.',
            'Se omite 1 familia por plantilla de WhatsApp sin aprobar en la cuenta de la escuela.',
        ]);
    });

    it('sin nadie a quién enviar: no hay tarjeta y el motivo dice por qué', async () => {
        familia('c', 'Sin Optin', '3001110003', [{ nombre: 'Ceci' }], { optin: false });
        expect(await enviarRecordatorioPago.preparar(admin, ARGS)).toEqual({
            ok: false, motivo: 'No hay a quién enviarle el recordatorio de noviembre de 2026. Se omite 1 familia sin WhatsApp autorizado.',
        });
        expect(await enviarRecordatorioPago.preparar(admin, { periodo: '2027-03' })).toEqual({
            ok: false, motivo: 'No hay cobros pendientes de marzo de 2027.',
        });
    });

    it('tope de 300 familias por envío', async () => {
        for (let i = 0; i < 301; i++) familia(`x${i}`, `Acudiente ${i}`, `30022${String(i).padStart(5, '0')}`, [{ nombre: `Atleta${i}` }]);
        const p = await enviarRecordatorioPago.preparar(admin, ARGS);
        expect(p).toEqual({ ok: false, motivo: 'Son 301 familias y el tope por envío es 300. Pídelo por equipo para dividirlo.' });
    });

    it('la misma acción dos veces el mismo día: la segunda se rechaza sin leer cobros', async () => {
        escenarioBase();
        esc.borradoresHoy = [{ id: 'd0' }];
        const p = await enviarRecordatorioPago.preparar(admin, ARGS);
        expect(p).toEqual({ ok: false, motivo: 'El recordatorio de noviembre de 2026 ya se envió hoy. Se puede volver a pedir desde mañana.' });
        const q = de('mapi_action_drafts')[0];
        expect(filtro(q, 'eq', 'school_id')).toBe(ESCUELA);
        expect(filtro(q, 'eq', 'tool')).toBe(NOMBRE);
        expect(filtro(q, 'eq', 'target_key')).toBe('recordatorio:2026-11');
        expect(filtro(q, 'in', 'status')).toEqual(['executed', 'partial']); // 'executing' es el propio Confirmar
        expect(filtro(q, 'gte', 'executed_at')).toBe('2026-11-24T05:00:00.000Z');
        expect(de('payments')).toHaveLength(0);
    });

    it('fuera del horario de la Ley 2300 no prepara nada', async () => {
        escenarioBase();
        vi.setSystemTime(new Date('2026-11-22T15:00:00Z')); // domingo
        expect(await enviarRecordatorioPago.preparar(admin, ARGS)).toMatchObject({ ok: false, motivo: expect.stringMatching(/Ley 2300/) });
        vi.setSystemTime(new Date('2026-11-24T00:30:00Z')); // lunes 7:30 p. m.
        expect(await enviarRecordatorioPago.preparar(admin, ARGS)).toMatchObject({ ok: false });
        expect(consultas()).toHaveLength(0);
    });

    it('por equipo: resuelve el nombre, filtra a sus deportistas y guarda el id; al re-preparar sale igual', async () => {
        escenarioBase();
        esc.equipos = [{ id: SUB12, name: 'Sub-12' }, { id: SUB14, name: 'Sub-14' }];
        esc.atletas = [
            { id: 'hijo-a1', athlete_type: 'child', team_id: SUB12, enrolled_team_id: SUB12 },
            { id: 'hijo-a2', athlete_type: 'child', team_id: null, enrolled_team_id: SUB12 },
            { id: 'hijo-b1', athlete_type: 'child', team_id: SUB14, enrolled_team_id: SUB14 },
        ];
        const p = await enviarRecordatorioPago.preparar(admin, { periodo: '2026-11', equipo: 'sub 12' });
        expect(p.ok).toBe(true);
        if (!p.ok) return;
        expect(p.vista.titulo).toBe('Recordatorio de pago · Noviembre de 2026 · Sub-12');
        expect(p.vista.detalle?.items).toEqual(['Samuel y Sofía (Carolina) · $260.000 · vencida']);
        expect(p.targetKey).toBe(`recordatorio:2026-11:${SUB12}`);
        expect(p.args).toEqual({ periodo: '2026-11', equipo: SUB12 });
        const otra = await enviarRecordatorioPago.preparar(admin, enviarRecordatorioPago.validar(p.args));
        expect(otra.ok && [otra.vista, otra.huella]).toEqual([p.vista, p.huella]);

        await expect(enviarRecordatorioPago.preparar(admin, { periodo: '2026-11', equipo: 'sub' })).rejects.toThrow('Hay varios equipos que coinciden: Sub-12, Sub-14. ¿Cuál?');
        await expect(enviarRecordatorioPago.preparar(admin, { periodo: '2026-11', equipo: '44444444-4444-4444-4444-444444444444' })).rejects.toThrow(/No encontré ese equipo/);
    });
});

// ─── Ejecutar ───────────────────────────────────────────────────────────────

describe('enviar_recordatorio_pago — ejecutar', () => {
    const insertsAvisos = () => de('collection_notices', 'insert').map((c) => c.datos);
    const envioA = (waId: string) => h.enviar.mock.calls.map((c) => c[0]).find((p) => p.telefono === waId);

    it('cada familia con la plantilla de SU escalón y registrada como recordatorio_manual', async () => {
        escenarioBase();
        const r = await enviarRecordatorioPago.ejecutar(admin, ARGS);
        expect(r.estado).toBe('executed');
        expect(r.resultado).toMatchObject({ periodo: '2026-11', equipo: null, familias: 2, enviadas: 2, no_enviadas: 0, por_motivo: {}, fallos: [] });
        expect(envioA('573001110001')).toMatchObject({
            concepto: 'pendiente_suave', paymentId: 'pa1',
            datos: { nombreAtleta: 'Samuel y Sofía', monto: '$260.000, que incluye $10.000 de recargo por mora' },
        });
        expect(envioA('573001110002')).toMatchObject({ concepto: 'recordatorio_previo', paymentId: 'pb1', datos: { periodo: 'noviembre 2026' } });
        const avisos = insertsAvisos();
        expect(avisos).toHaveLength(3);
        for (const a of avisos) expect(a).toMatchObject({ school_id: ESCUELA, notice_type: 'recordatorio_manual', contact_day: '2026-11-24' });
        expect(avisos.filter((a) => a.is_lead).map((a) => a.payment_id).sort()).toEqual(['pa1', 'pb1']);
        expect(enviarRecordatorioPago.mensajeResultado(r, ARGS)).toBe('Salió el recordatorio de noviembre de 2026 a 2 familias.');
    });

    it('parcial: cuenta por motivo, dice quién no recibió y libera solo sus filas', async () => {
        escenarioBase();
        h.enviar.mockImplementation(async (p: any) => (p.telefono === '573001110002'
            ? { enviado: false, motivo: 'sin_optin' }
            : { enviado: true, waMessageId: 'w', plantilla: `tpl:${p.concepto}` }));
        const r = await enviarRecordatorioPago.ejecutar(admin, ARGS);
        expect(r.estado).toBe('partial');
        expect(r.resultado).toMatchObject({
            familias: 2, enviadas: 1, no_enviadas: 1, por_motivo: { sin_optin: 1 },
            fallos: [{ familia: 'Tomás (Diana)', motivo: 'sin autorización de WhatsApp' }],
        });
        expect(r.resultado).not.toHaveProperty('motivo');
        const borrado = de('collection_notices', 'delete');
        expect(borrado).toHaveLength(1);
        expect(filtro(borrado[0], 'eq', 'notice_type')).toBe('recordatorio_manual');
        expect(filtro(borrado[0], 'eq', 'family_key')).toBe('wa:573001110002');
        expect(enviarRecordatorioPago.mensajeResultado(r, ARGS))
            .toBe('Salió el recordatorio de noviembre de 2026 a 1 familia. No salió para 1 (sin autorización de WhatsApp: 1).');
    });

    it('ninguna salió (candado tomado por el cron entre la vista y el clic, WhatsApp caído): failed', async () => {
        escenarioBase();
        esc.choque = new Set(['wa:573001110001']);
        h.enviar.mockResolvedValue({ enviado: false, motivo: 'error_graph' });
        const r = await enviarRecordatorioPago.ejecutar(admin, ARGS);
        expect(r.estado).toBe('failed');
        expect(r.resultado).toMatchObject({ enviadas: 0, por_motivo: { ya_contactada: 1, error_graph: 1 } });
        expect((r.resultado as any).motivo).toBe('Ninguna familia recibió el mensaje (WhatsApp rechazó el envío: 1 · ya con aviso de cobro hoy: 1).');
        expect(h.enviar).toHaveBeenCalledTimes(1); // a la del candado no se le intenta
        expect(enviarRecordatorioPago.mensajeResultado(r, ARGS))
            .toBe('No salió ningún recordatorio de noviembre de 2026 (WhatsApp rechazó el envío: 1 · ya con aviso de cobro hoy: 1).');
    });

    it('si al ejecutar ya no hay nada (o se cerró el horario), falla con el motivo y no envía', async () => {
        escenarioBase();
        vi.setSystemTime(new Date('2026-11-25T00:30:00Z')); // martes 7:30 p. m.
        const r = await enviarRecordatorioPago.ejecutar(admin, ARGS);
        expect(r.estado).toBe('failed');
        expect(enviarRecordatorioPago.mensajeResultado(r, ARGS)).toMatch(/^No salió ningún recordatorio de noviembre de 2026\. Por la Ley 2300/);
        expect(h.enviar).not.toHaveBeenCalled();
    });
});

// ─── Validación, registro y textos ──────────────────────────────────────────

describe('enviar_recordatorio_pago — validar y registro', () => {
    it('el mes tiene que ser AAAA-MM; el equipo vacío se ignora', () => {
        expect(enviarRecordatorioPago.validar({ periodo: '2026-11', equipo: '' })).toEqual({ periodo: '2026-11' });
        expect(enviarRecordatorioPago.validar({ periodo: '2026-11', equipo: ' Sub-12 ' })).toEqual({ periodo: '2026-11', equipo: 'Sub-12' });
        expect(() => enviarRecordatorioPago.validar({ periodo: 'noviembre' })).toThrow(RechazoHerramienta);
        expect(() => enviarRecordatorioPago.validar({ periodo: '2026-13' })).toThrow(/AAAA-MM/);
        expect(() => enviarRecordatorioPago.validar({})).toThrow(RechazoHerramienta);
    });

    it('solo administración y solo con MAPI_RECORDATORIO_MANUAL=true (apagada por defecto)', () => {
        const nombres = (a: Alcance) => herramientasPara(a).map((x) => x.nombre);
        expect(nombres(admin)).not.toContain(NOMBRE);
        process.env.MAPI_RECORDATORIO_MANUAL = 'true';
        expect(nombres(admin)).toContain(NOMBRE);
        expect(nombres(coach)).not.toContain(NOMBRE);
    });

    it('el coach no prepara aunque la llamara directo', async () => {
        await expect(enviarRecordatorioPago.preparar(coach, ARGS)).rejects.toThrow(/administración/);
    });

    it('textos puros', () => {
        expect(lineasDeExclusion({
            sinCanal: 2, yaAvisadaHoy: 0, plantillaSinAprobar: 0, manualReciente: 0, enRevision: 0,
            dadoDeBaja: 0, loteSilencioso: 0, duplicado: 3, sinContacto: 0, noMensualidad: 0,
        }, true)).toEqual(['Se omiten 2 familias sin WhatsApp autorizado ni correo.', 'Se omiten 3 cobros por duplicado.']);
        expect(resumenFallos({ telefono_invalido: 1, sin_optin: 2, raro: 1 }))
            .toBe('sin autorización de WhatsApp: 2 · error al armar el mensaje: 1 · número inválido: 1');
    });
});
