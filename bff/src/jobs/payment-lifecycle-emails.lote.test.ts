/**
 * Cobros creados por un lote del modal «Cobros y pagos» SIN «Avisar a las
 * familias» no mandan el correo de «cobro generado» (spec cobros-multiples
 * I21, Q9). Con la F1 sin aplicar (sin columna/tabla) el job sigue igual.
 *
 * Cero red: Supabase en memoria, correo y WhatsApp moqueados. Datos inventados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, any>;
const estado = vi.hoisted(() => ({
    tablas: {} as Record<string, Fila[]>,
    whatsapp: [] as any[],
    plantillasVencido: [] as any[],
    correos: [] as any[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas: Fila[] = [...(estado.tablas[tabla] ?? [])];
        let cambios: Fila | null = null;
        const b: any = {
            select: () => b,
            update: (c: Fila) => { cambios = c; return b; },
            eq: (col: string, v: any) => { filas = filas.filter((f) => f[col] === v); return b; },
            is: (col: string, v: any) => { filas = filas.filter((f) => (f[col] ?? null) === v); return b; },
            in: (col: string, vs: any[]) => { filas = filas.filter((f) => vs.includes(f[col])); return b; },
            not: (col: string, op: string, v: any) => { if (op === 'is' && v === null) filas = filas.filter((f) => (f[col] ?? null) !== null); return b; },
            insert: (fila: Fila | Fila[]) => {
                const nuevas = Array.isArray(fila) ? fila : [fila];
                estado.tablas[tabla] = [...(estado.tablas[tabla] ?? []), ...nuevas];
                return { then: (ok: any, ko: any) => Promise.resolve({ data: nuevas, error: null }).then(ok, ko) };
            },
            then: (ok: any, ko: any) => {
                if (cambios) for (const f of filas) Object.assign(f, cambios);
                return Promise.resolve({ data: filas, error: null }).then(ok, ko);
            },
        };
        return b;
    }
    return { supabase: { from: (t: string) => builder(t) } };
});
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn(async (m: any) => { estado.correos.push(m); return { success: true, data: { id: 'msg-test' } }; }) } }));
vi.mock('../utils/emailTemplates', () => ({
    BrandedEmailTemplates: {
        paymentOverdue: vi.fn(async (p: any) => { estado.plantillasVencido.push(p); return { subject: 'Pago vencido', html: '<p/>' }; }),
        chargeCreated: vi.fn(async () => ({ subject: 's', html: 'h' })),
    },
}));
vi.mock('../services/duplicatePayerGuard.service', () => ({ findDuplicatePaymentIds: vi.fn(async () => []) }));
vi.mock('../services/cobro-enlace-publico.service', () => ({ emitirTokenCobro: vi.fn(async () => 'tok') }));
vi.mock('../services/estado-de-cuenta.service', () => ({
    contactosConEstadoDeCuentaHoy: vi.fn(async () => new Set<string>()),
    escuelasConEstadoPendiente: vi.fn(async () => new Set<string>()),
}));
vi.mock('../services/recordatorios-cobro.service', () => ({ contactosConRecordatorioHoy: vi.fn(async () => new Set<string>()) }));
vi.mock('../services/whatsapp-plantillas.service', () => ({
    dentroDeHorarioDeCobranza: () => true,
    aWaId: (t: string | null) => (t ? `57${String(t).replace(/\D/g, '')}` : null),
    enviarCobroPorPlantilla: vi.fn(async (p: any) => { estado.whatsapp.push(p); return { enviado: false, motivo: 'sin_optin' }; }),
}));

import { idsDeLotesSinAviso, sendChargeCreatedEmails } from './payment-lifecycle-emails.job';

const AHORA = new Date('2026-10-13T15:00:00Z'); // martes 10:00 COT
const pendiente = (id: string, extra: Fila = {}): Fila => ({
    id, school_id: 'sch-1', amount: 150000, due_date: '2026-10-20', concept: 'Mensualidad Noviembre 2026',
    parent_id: null, child_id: 'c1', user_id: null, unregistered_athlete_id: null,
    period_year: 2026, period_month: 11, payment_category: 'mensualidad', payment_type: 'subscription',
    status: 'pending', charge_notice_sent_at: null, ...extra,
});

beforeEach(() => {
    estado.whatsapp = [];
    estado.plantillasVencido = [];
    estado.correos = [];
    estado.tablas = {
        school_settings: [{ school_id: 'sch-1', charge_notifications_enabled: true }],
        schools: [{ id: 'sch-1', name: 'Escuela de Prueba' }],
        profiles: [],
        unregistered_athletes: [],
        children: [{ id: 'c1', full_name: 'Atleta Prueba', parent_name_temp: 'Acudiente Prueba', parent_email_temp: 'acudiente@ejemplo.com', parent_phone_temp: '3000000000' }],
        payments: [],
        email_sends: [],
        charge_batches: [
            { id: 'lote-silencioso', notify_families: false },
            { id: 'lote-con-aviso', notify_families: true },
        ],
    };
});

describe('idsDeLotesSinAviso', () => {
    it('solo las filas de un lote con notify_families = false', async () => {
        estado.tablas.payments = [
            pendiente('a', { charge_batch_id: 'lote-silencioso' }),
            pendiente('b', { charge_batch_id: 'lote-con-aviso' }),
            pendiente('c'),
        ];
        expect([...(await idsDeLotesSinAviso(['a', 'b', 'c']))]).toEqual(['a']);
    });

    it('sin ids no consulta nada', async () => {
        expect((await idsDeLotesSinAviso([])).size).toBe(0);
    });
});

describe('sendChargeCreatedEmails con cobros de un lote', () => {
    it('la mensualidad del lote silencioso no avisa ni se reclama; la normal sí', async () => {
        estado.tablas.payments = [
            pendiente('lote', { charge_batch_id: 'lote-silencioso' }),
        ];
        await sendChargeCreatedEmails(AHORA);
        expect(estado.whatsapp).toHaveLength(0);
        expect(estado.correos).toHaveLength(0);
        expect(estado.tablas.payments[0].charge_notice_sent_at).toBeNull();

        estado.tablas.payments = [pendiente('normal')];
        await sendChargeCreatedEmails(AHORA);
        expect(estado.correos).toHaveLength(1);
    });

    it('lote con «Avisar a las familias»: sigue el camino de siempre (el agrupado es F5)', async () => {
        estado.tablas.payments = [pendiente('avisa', { charge_batch_id: 'lote-con-aviso' })];
        await sendChargeCreatedEmails(AHORA);
        expect(estado.correos).toHaveLength(1);
    });
});
