/**
 * Cadencia de recordatorios de cobro por WhatsApp: escalera, Ley 2300 (horario,
 * 1 contacto por familia y día), opt-in, idempotencia y estampado anti-duplicado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    llamadas: [] as { tabla: string; op: string; args: any[] }[],
    insertError: null as any,
    enviar: vi.fn(),
    correo: vi.fn(),
}));

vi.mock('../config/supabase', () => {
    const builder = (tabla: string) => {
        const b: any = {};
        const reg = (op: string) => (...args: any[]) => { h.llamadas.push({ tabla, op, args }); return b; };
        for (const op of ['select', 'eq', 'in', 'is', 'not', 'gte', 'lte', 'limit', 'update', 'delete', 'upsert']) b[op] = reg(op);
        b.insert = (...args: any[]) => { h.llamadas.push({ tabla, op: 'insert', args }); return b; };
        b.maybeSingle = async () => (tabla === 'collection_notices' && h.insertError ? { data: null, error: h.insertError } : { data: { id: 'x' }, error: null });
        b.then = (res: any) => res({ data: [], error: null });
        return b;
    };
    return { supabase: { from: vi.fn((t: string) => builder(t)), rpc: vi.fn() } };
});
vi.mock('./whatsapp-plantillas.service', async (orig) => {
    const real: any = await orig();
    return { ...real, enviarCobroPorPlantilla: h.enviar, plantillaAprobada: vi.fn(async () => ({ aprobada: true })) };
});
vi.mock('./cobro-enlace-publico.service', () => ({ emitirTokenCobro: vi.fn(async () => 'tok') }));
vi.mock('./duplicatePayerGuard.service', () => ({ findDuplicatePaymentIds: vi.fn(async () => new Set()) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: h.correo } }));
vi.mock('../utils/emailTemplates', () => ({
    BrandedEmailTemplates: { recordatorioCobro: vi.fn(async (p: any) => ({ subject: `s:${p.concepto}`, html: p.paymentLink })) },
}));

import {
    ESCALONES, diasDesdeVencimiento, escalonDelDia, unirNombres, planificar, esHoraDeRecordatorios,
    enviarContacto, runRecordatoriosCobro, cobrosDeAtletaDadoDeBaja, type EntradaPlan, type ContactoPlaneado,
} from './recordatorios-cobro.service';
import type { Familia, PagoEstado } from './estado-de-cuenta.service';

beforeEach(() => {
    h.llamadas.length = 0;
    h.insertError = null;
    h.enviar.mockReset();
    h.correo.mockReset();
    delete process.env.DISABLE_RECORDATORIOS_COBRO_WHATSAPP;
});

describe('escalera', () => {
    it('días respecto al vencimiento', () => {
        expect(diasDesdeVencimiento('2026-10-10', '2026-10-07')).toBe(-3);
        expect(diasDesdeVencimiento('2026-09-30', '2026-10-20')).toBe(20);
    });

    it('cada día cae en a lo sumo un escalón y "mañana"/"hoy" no tienen ventana', () => {
        const m = (d: number) => escalonDelDia(d)?.concepto ?? null;
        expect([m(-4), m(-3), m(-2), m(-1), m(0), m(1), m(2)]).toEqual(
            [null, 'recordatorio_previo', 'recordatorio_previo', 'vence_manana', 'vence_hoy', null, null]);
        expect([m(3), m(9), m(10), m(19), m(20), m(23), m(24), m(26)]).toEqual(
            ['pendiente_suave', 'pendiente_suave', 'pendiente_directo', 'pendiente_directo', 'aviso_final', 'aviso_final', null, null]);
        // Ventanas sin solaparse.
        for (let i = 1; i < ESCALONES.length; i++) expect(ESCALONES[i].desde).toBeGreaterThan(ESCALONES[i - 1].hasta);
    });

    it('nombres agrupados', () => {
        expect(unirNombres(['Samuel Rodríguez'])).toBe('Samuel');
        expect(unirNombres(['Samuel R', 'Sofía P', 'Samuel R'])).toBe('Samuel y Sofía');
        expect(unirNombres(['Ana', 'Beto', 'Caro'])).toBe('Ana, Beto y Caro');
    });
});

describe('horario (Ley 2300)', () => {
    it('solo L-V hábil desde las 8:00 COT', () => {
        expect(esHoraDeRecordatorios(new Date('2026-10-07T13:00:00Z'))).toBe(true);  // mié 8:00
        expect(esHoraDeRecordatorios(new Date('2026-10-07T12:59:00Z'))).toBe(false); // mié 7:59
        expect(esHoraDeRecordatorios(new Date('2026-10-10T13:00:00Z'))).toBe(false); // sábado
        expect(esHoraDeRecordatorios(new Date('2026-10-12T13:00:00Z'))).toBe(false); // lunes festivo
    });
});

// ─── planificar ──────────────────────────────────────────────────────────────

const pago = (id: string, due: string, extra: Partial<PagoEstado> = {}): PagoEstado => ({
    id, school_id: 's', parent_id: null, user_id: null, child_id: null, unregistered_athlete_id: null,
    concept: 'Mensualidad', amount: 150000, status: 'pending', due_date: due, period_year: 2026, period_month: 10, ...extra,
});

const familia = (clave: string, waId: string | null, filas: { id: string; atleta: string; vence: string; saldo?: number }[], extra: Partial<Familia> = {}): Familia => ({
    clave, email: clave.includes('@') ? clave : null, waId, nombre: 'Carolina Pérez', perfilId: 'perfil-1',
    filas: filas.map((f) => ({ paymentId: f.id, atleta: f.atleta, concepto: 'Mensualidad', vence: f.vence, saldo: f.saldo ?? 150000, vencido: false, delMes: true, status: 'pending' })),
    avisadaHoy: false, ...extra,
});

function entrada(familias: Familia[], pagos: PagoEstado[], extra: Partial<EntradaPlan> = {}): EntradaPlan {
    return {
        hoy: '2026-10-09', escuela: 'Dynasty', familias,
        pagos: new Map(pagos.map((p) => [p.id, p])),
        enviados: new Set(), optin: new Set(['573001112233', '573009998877']), contactadosHoy: new Set(), ...extra,
    };
}

describe('planificar', () => {
    it('dos hijos en el mismo escalón = UN mensaje con los dos nombres y el total', () => {
        const f = familia('caro@x.co', '573001112233', [
            { id: 'p1', atleta: 'Samuel R', vence: '2026-10-10' },
            { id: 'p2', atleta: 'Sofía R', vence: '2026-10-10', saldo: 100000 },
        ]);
        const plan = planificar(entrada([f], [pago('p1', '2026-10-10'), pago('p2', '2026-10-10')]));
        expect(plan.contactos).toHaveLength(1);
        const c = plan.contactos[0];
        expect(c.concepto).toBe('vence_manana');
        expect(c.paymentIds).toEqual(['p1', 'p2']);
        expect(c.datos.nombreAtleta).toBe('Samuel y Sofía');
        expect(c.datos.monto).toBe('$250.000');
        expect(c.datos.nombreContacto).toBe('Carolina');
        expect(c.familyKey).toBe('wa:573001112233');
    });

    it('cada familia de avisos tiene su interruptor: sin «antes de vencer» no sale el previo; sin «mora» no sale la mora', () => {
        const f = () => familia('caro@x.co', '573001112233', [
            { id: 'p1', atleta: 'Samuel R', vence: '2026-10-10' },
        ]);
        const previo = [pago('p1', '2026-10-10')];
        const mora = [pago('p1', '2026-09-29', { status: 'overdue' })];
        const moraFam = () => familia('caro@x.co', '573001112233', [{ id: 'p1', atleta: 'Samuel R', vence: '2026-09-29' }]);
        expect(planificar(entrada([f()], previo)).contactos).toHaveLength(1);
        expect(planificar({ ...entrada([f()], previo), tipos: { previo: false, mora: true } }).contactos).toHaveLength(0);
        expect(planificar({ ...entrada([moraFam()], mora), tipos: { previo: true, mora: false } }).contactos).toHaveLength(0);
        expect(planificar({ ...entrada([moraFam()], mora), tipos: { previo: false, mora: true } }).contactos).toHaveLength(1);
    });

    it('escalones distintos: sale solo el más severo (1 contacto/día)', () => {
        const f = familia('caro@x.co', '573001112233', [
            { id: 'p1', atleta: 'Samuel', vence: '2026-10-10' },  // -1
            { id: 'p2', atleta: 'Sofía', vence: '2026-09-29' },   // +10
        ]);
        const plan = planificar(entrada([f], [pago('p1', '2026-10-10'), pago('p2', '2026-09-29', { status: 'overdue' })]));
        expect(plan.contactos).toHaveLength(1);
        expect(plan.contactos[0].concepto).toBe('pendiente_directo');
        expect(plan.contactos[0].paymentIds).toEqual(['p2']);
        expect(plan.contactos[0].datos.diasVencido).toBe(10);
    });

    it('sin opt-in, sin teléfono o ya contactada hoy: no sale', () => {
        const sinOptin = familia('a@x.co', '573111111111', [{ id: 'p1', atleta: 'A', vence: '2026-10-10' }]);
        const sinTel = familia('b@x.co', null, [{ id: 'p2', atleta: 'B', vence: '2026-10-10' }]);
        const estadoHoy = familia('c@x.co', '573001112233', [{ id: 'p3', atleta: 'C', vence: '2026-10-10' }]);
        const avisada = familia('d@x.co', '573009998877', [{ id: 'p4', atleta: 'D', vence: '2026-10-10' }], { avisadaHoy: true });
        const plan = planificar(entrada([sinOptin, sinTel, estadoHoy, avisada],
            ['p1', 'p2', 'p3', 'p4'].map((id) => pago(id, '2026-10-10')),
            { contactadosHoy: new Set(['c@x.co']) }));
        expect(plan.contactos).toHaveLength(0);
        expect(plan.descartes).toMatchObject({ sin_optin: 1, sin_telefono: 1, ya_contactada_hoy: 2 });
    });

    it('idempotente: el escalón ya registrado de un cobro no se repite', () => {
        const f = familia('caro@x.co', '573001112233', [{ id: 'p1', atleta: 'S', vence: '2026-10-10' }]);
        const plan = planificar(entrada([f], [pago('p1', '2026-10-10')], { enviados: new Set(['p1|vence_manana']) }));
        expect(plan.contactos).toHaveLength(0);
        expect(plan.descartes.ya_enviado).toBe(1);
    });

    it('el previo no se repite si el aviso de cobro / estado de cuenta salió hace menos de 5 días', () => {
        const f = familia('caro@x.co', '573001112233', [{ id: 'p1', atleta: 'S', vence: '2026-10-12' }]); // -3
        const reciente = planificar(entrada([f], [pago('p1', '2026-10-12', { charge_notice_sent_at: '2026-10-05T14:00:00Z' })]));
        expect(reciente.contactos).toHaveLength(0);
        expect(reciente.descartes.previo_ya_recibido).toBe(1);
        const viejo = planificar(entrada([f], [pago('p1', '2026-10-12', { charge_notice_sent_at: '2026-09-28T14:00:00Z' })]));
        expect(viejo.contactos[0]?.concepto).toBe('recordatorio_previo');
    });

    it('pendiente_suave no sale si el aviso de vencido ya salió', () => {
        const f = familia('caro@x.co', '573001112233', [{ id: 'p1', atleta: 'S', vence: '2026-10-05' }]); // +4
        const plan = planificar(entrada([f], [pago('p1', '2026-10-05', { overdue_notice_sent_at: '2026-10-06T12:00:00Z' })]));
        expect(plan.contactos).toHaveLength(0);
        expect(plan.descartes.vencido_ya_avisado).toBe(1);
    });

    it('dos "familias" (correos distintos) con el mismo celular = un contacto', () => {
        const a = familia('a@x.co', '573001112233', [{ id: 'p1', atleta: 'Ana', vence: '2026-10-10' }]);
        const b = familia('b@x.co', '573001112233', [{ id: 'p2', atleta: 'Beto', vence: '2026-10-10' }]);
        const plan = planificar(entrada([a, b], [pago('p1', '2026-10-10'), pago('p2', '2026-10-10')]));
        expect(plan.contactos).toHaveLength(1);
        expect(plan.contactos[0].paymentIds).toEqual(['p1', 'p2']);
    });

    it('deuda vieja (+26) no dispara nada al activar', () => {
        const f = familia('caro@x.co', '573001112233', [{ id: 'p1', atleta: 'S', vence: '2026-09-13' }]);
        const plan = planificar(entrada([f], [pago('p1', '2026-09-13', { status: 'overdue' })]));
        expect(plan.contactos).toHaveLength(0);
        expect(plan.descartes.sin_escalon_hoy).toBe(1);
    });
});

describe('planificar — canal correo', () => {
    it('sin WhatsApp con opt-in y la escuela con correo: sale por correo con el correo como clave', () => {
        const sinTel = familia('b@x.co', null, [{ id: 'p2', atleta: 'Beto', vence: '2026-10-09' }]);            // 0
        const sinOptin = familia('A@X.co', '573111111111', [{ id: 'p1', atleta: 'Ana', vence: '2026-10-06' }]); // +3
        const plan = planificar(entrada([sinTel, sinOptin], [pago('p1', '2026-10-06'), pago('p2', '2026-10-09')], { canalCorreo: true, diaCorte: 10, avisoPolitica: 'Sin servicio con más de un mes de retraso.' }));
        expect(plan.contactos.map((c) => [c.canal, c.familyKey, c.concepto])).toEqual([
            ['email', 'b@x.co', 'vence_hoy'],
            ['email', 'a@x.co', 'pendiente_suave'],
        ]);
        expect(plan.contactos[0].email).toBe('b@x.co');
        expect(plan.contactos[0].waId).toBeNull();
        expect(plan.contactos[0].diaCorte).toBe(10);
        expect(plan.contactos[0].avisoPolitica).toBe('Sin servicio con más de un mes de retraso.');
    });

    it('con opt-in de WhatsApp va SOLO por WhatsApp (un canal por familia)', () => {
        const f = familia('caro@x.co', '573001112233', [{ id: 'p1', atleta: 'S', vence: '2026-10-09' }]);
        const plan = planificar(entrada([f], [pago('p1', '2026-10-09')], { canalCorreo: true }));
        expect(plan.contactos).toHaveLength(1);
        expect(plan.contactos[0].canal).toBe('whatsapp');
    });

    it('«vence mañana» no sale por correo', () => {
        const f = familia('b@x.co', null, [{ id: 'p1', atleta: 'B', vence: '2026-10-10' }]); // -1
        const plan = planificar(entrada([f], [pago('p1', '2026-10-10')], { canalCorreo: true }));
        expect(plan.contactos).toHaveLength(0);
        expect(plan.descartes.sin_escalon_hoy).toBe(1);
    });

    it('ya contactada hoy por correo (estado de cuenta o aviso): no sale', () => {
        const f = familia('b@x.co', null, [{ id: 'p1', atleta: 'B', vence: '2026-10-09' }]);
        const plan = planificar(entrada([f], [pago('p1', '2026-10-09')], { canalCorreo: true, contactadosHoy: new Set(['b@x.co']) }));
        expect(plan.contactos).toHaveLength(0);
        expect(plan.descartes.ya_contactada_hoy).toBe(1);
    });

    it('sin el canal correo prendido, igual que antes: sin teléfono no sale', () => {
        const f = familia('b@x.co', null, [{ id: 'p1', atleta: 'B', vence: '2026-10-09' }]);
        expect(planificar(entrada([f], [pago('p1', '2026-10-09')])).contactos).toHaveLength(0);
    });
});

describe('atleta dado de baja', () => {
    it('hijo/ficha inactivos y adulto solo con membresía inactive no se recuerdan', () => {
        const pagos = [
            pago('h', '2026-10-10', { child_id: 'c1' }),
            pago('f', '2026-10-10', { unregistered_athlete_id: 'u1' }),
            pago('a', '2026-10-10', { user_id: 'ad1' }),
            pago('b', '2026-10-10', { user_id: 'ad2' }),
            pago('n', '2026-10-10', { child_id: 'c2' }),
        ];
        const out = cobrosDeAtletaDadoDeBaja(pagos, {
            hijos: new Map([['c1', { is_active: false }], ['c2', { is_active: null }]]),
            noRegistrados: new Map([['u1', { is_active: false }]]),
            estadosAdulto: new Map([['ad1', ['inactive']], ['ad2', ['inactive', 'active']]]),
        });
        expect([...out].sort()).toEqual(['a', 'f', 'h']);
    });
});

// ─── envío ───────────────────────────────────────────────────────────────────

const contacto = (concepto: ContactoPlaneado['concepto']): ContactoPlaneado => ({
    canal: 'whatsapp', familyKey: 'wa:573001112233', waId: '573001112233', email: null, perfilId: null, concepto, paymentIds: ['p1', 'p2'],
    datos: { nombreContacto: 'Caro', nombreAtleta: 'Samuel y Sofía', nombreEscuela: 'Dynasty', monto: '$300.000' },
});
const AHORA = new Date('2026-10-09T13:00:00Z');
const ops = (tabla: string, op: string) => h.llamadas.filter((l) => l.tabla === tabla && l.op === op);

describe('enviarContacto', () => {
    it('candado tomado por otro BFF (23505): no manda nada', async () => {
        h.insertError = { code: '23505', message: 'duplicate' };
        expect(await enviarContacto('s', contacto('vence_manana'), AHORA)).toBe('ya_reclamado');
        expect(h.enviar).not.toHaveBeenCalled();
    });

    it('sale: marca sent y estampa charge_notice_sent_at (pre-vencimiento)', async () => {
        h.enviar.mockResolvedValue({ enviado: true, waMessageId: 'wamid', plantilla: 'pago_vence_manana' });
        expect(await enviarContacto('s', contacto('vence_manana'), AHORA)).toBe('enviado');
        const lider = ops('collection_notices', 'insert')[0].args[0];
        expect(lider).toMatchObject({ payment_id: 'p1', is_lead: true, contact_day: '2026-10-09', notice_type: 'vence_manana' });
        expect(ops('collection_notices', 'upsert')[0].args[0]).toEqual([expect.objectContaining({ payment_id: 'p2', is_lead: false })]);
        expect(h.enviar.mock.calls[0][0]).toMatchObject({ concepto: 'vence_manana', tokenBoton: 'tok', paymentId: 'p1' });
        expect(ops('payments', 'update')[0].args[0]).toHaveProperty('charge_notice_sent_at');
    });

    it('escalón de mora estampa overdue_notice_sent_at (el job de vencido no repite)', async () => {
        h.enviar.mockResolvedValue({ enviado: true, waMessageId: 'wamid', plantilla: 'pago_pendiente_directo' });
        await enviarContacto('s', contacto('pendiente_directo'), AHORA);
        expect(ops('payments', 'update')[0].args[0]).toHaveProperty('overdue_notice_sent_at');
    });

    it('no sale: libera las filas y no estampa nada', async () => {
        h.enviar.mockResolvedValue({ enviado: false, motivo: 'sin_optin' });
        expect(await enviarContacto('s', contacto('vence_hoy'), AHORA)).toBe('no_enviado:sin_optin');
        expect(ops('collection_notices', 'delete')).toHaveLength(1);
        expect(ops('payments', 'update')).toHaveLength(0);
    });
});

describe('enviarContacto — correo', () => {
    const porCorreo = (concepto: ContactoPlaneado['concepto']): ContactoPlaneado => ({
        ...contacto(concepto), canal: 'email', familyKey: 'b@x.co', waId: null, email: 'b@x.co',
    });

    it('sale: candado con canal email, botón al enlace público y estampa como WhatsApp', async () => {
        h.correo.mockResolvedValue({ success: true });
        expect(await enviarContacto('s', porCorreo('pendiente_directo'), AHORA)).toBe('enviado');
        expect(h.enviar).not.toHaveBeenCalled();
        expect(ops('collection_notices', 'insert')[0].args[0]).toMatchObject({ channel: 'email', family_key: 'b@x.co', is_lead: true });
        expect(h.correo.mock.calls[0][0]).toMatchObject({ to: 'b@x.co', subject: 's:pendiente_directo' });
        expect(h.correo.mock.calls[0][0].html).toMatch(/\/p\/tok$/);
        expect(ops('payments', 'update')[0].args[0]).toHaveProperty('overdue_notice_sent_at');
    });

    it('el correo falla: libera el candado y no estampa', async () => {
        h.correo.mockResolvedValue({ success: false });
        expect(await enviarContacto('s', porCorreo('vence_hoy'), AHORA)).toBe('no_enviado:correo_fallo');
        expect(ops('collection_notices', 'delete')).toHaveLength(1);
        expect(ops('payments', 'update')).toHaveLength(0);
    });
});

describe('runRecordatoriosCobro', () => {
    it('kill-switch por env y días no hábiles: no toca la base', async () => {
        process.env.DISABLE_RECORDATORIOS_COBRO_WHATSAPP = 'true';
        expect(await runRecordatoriosCobro(AHORA)).toEqual({});
        delete process.env.DISABLE_RECORDATORIOS_COBRO_WHATSAPP;
        expect(await runRecordatoriosCobro(new Date('2026-10-12T13:00:00Z'))).toEqual({}); // festivo
        expect(await runRecordatoriosCobro(new Date('2026-10-11T13:00:00Z'))).toEqual({}); // domingo
        expect(h.llamadas).toHaveLength(0);
    });
});

// ─── Mora (2026-10-14): la familia ve el total CON mora y su desglose ────────

describe('mora en la cadencia', () => {
    const conMora = (clave: string, waId: string | null) => familia(clave, waId, [
        { id: 'p1', atleta: 'Samuel R', vence: '2026-09-29', saldo: 165000 },   // +10 con mora de 15.000
        { id: 'p2', atleta: 'Sofía R', vence: '2026-09-29', saldo: 150000 },    // +10 sin mora
    ]);
    const ponerMora = (f: Familia) => { f.filas[0].mora = 15000; return f; };

    it('WhatsApp: el monto suma la mora y lo dice en la variable de la plantilla', () => {
        const f = ponerMora(conMora('caro@x.co', '573001112233'));
        const plan = planificar(entrada([f], [pago('p1', '2026-09-29'), pago('p2', '2026-09-29')]));
        const c = plan.contactos[0];
        expect(c.concepto).toBe('pendiente_directo');
        expect(c.total).toBe(315000);
        expect(c.mora).toBe(15000);
        expect(c.datos.monto).toBe('$315.000, que incluye $15.000 de recargo por mora');
    });

    it('sin mora: el monto como siempre', () => {
        const plan = planificar(entrada([conMora('caro@x.co', '573001112233')], [pago('p1', '2026-09-29'), pago('p2', '2026-09-29')]));
        expect(plan.contactos[0].mora).toBe(0);
        expect(plan.contactos[0].datos.monto).toBe('$315.000');
    });

    it('correo: la plantilla recibe el desglose (mensualidad + recargo; amount = total)', async () => {
        const f = ponerMora(conMora('caro@x.co', null));
        const plan = planificar(entrada([f], [pago('p1', '2026-09-29'), pago('p2', '2026-09-29')], { canalCorreo: true }));
        const c = plan.contactos[0];
        expect(c.canal).toBe('email');
        h.correo.mockResolvedValue({ success: true });
        expect(await enviarContacto('s', c, AHORA)).toBe('enviado');
        const { BrandedEmailTemplates } = await import('../utils/emailTemplates');
        const params = (BrandedEmailTemplates.recordatorioCobro as any).mock.calls.at(-1)[0];
        expect(params.lateFee).toEqual({ base: '$300.000', fee: '$15.000' });
        expect(params.amount).toBe('$315.000');
    });
});
