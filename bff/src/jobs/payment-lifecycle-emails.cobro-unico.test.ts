/**
 * Aviso de VENCIDO de un cobro ÚNICO (inscripción, seguro… — 2026-10-10).
 *
 * Las plantillas de WhatsApp aprobadas dicen «la mensualidad de …»: a un seguro
 * vencido le llegaba «quedó pendiente la mensualidad». Ahora el cobro único no
 * intenta WhatsApp y el correo nombra el cobro. La mensualidad sigue igual.
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

import { avisoDeCobroUnico, sendOverdueNoticeEmails } from './payment-lifecycle-emails.job';

const AHORA = new Date('2026-10-13T15:00:00Z'); // martes 10:00 COT
const vencido = (id: string, extra: Fila = {}): Fila => ({
    id, school_id: 'sch-1', amount: 150000, due_date: '2026-10-05', concept: 'Mensualidad Octubre 2026',
    parent_id: null, child_id: 'c1', user_id: null, unregistered_athlete_id: null,
    period_year: 2026, period_month: 10, payment_category: null, payment_type: 'subscription',
    status: 'overdue', overdue_notice_sent_at: null, ...extra,
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
    };
});

describe('avisoDeCobroUnico', () => {
    it('solo con categoría explícita distinta de mensualidad', () => {
        expect(avisoDeCobroUnico({ payment_category: 'seguro', concept: 'Seguro — X' })).toBe('Seguro de accidentes');
        expect(avisoDeCobroUnico({ payment_category: 'viaje', concept: null })).toBe('Viaje');
        expect(avisoDeCobroUnico({ payment_category: null, concept: 'Inscripción anual' })).toBeNull();
        expect(avisoDeCobroUnico({ payment_category: 'mensualidad', concept: 'Mensualidad' })).toBeNull();
    });
});

describe('sendOverdueNoticeEmails con cobros únicos', () => {
    it('el seguro vencido NO va por la plantilla «mensualidad»: correo con su etiqueta', async () => {
        estado.tablas.payments = [vencido('seg', { payment_category: 'seguro', payment_type: 'one_time', concept: 'Seguro de accidentes — Plan X' })];
        await sendOverdueNoticeEmails(AHORA);
        expect(estado.whatsapp).toHaveLength(0);
        expect(estado.plantillasVencido).toHaveLength(1);
        expect(estado.plantillasVencido[0]).toMatchObject({ chargeLabel: 'Seguro de accidentes', concept: 'Seguro de accidentes — Plan X' });
        expect(estado.correos).toHaveLength(1);
    });

    it('la mensualidad vencida sigue intentando WhatsApp primero y su correo no lleva etiqueta', async () => {
        estado.tablas.payments = [vencido('mens')];
        await sendOverdueNoticeEmails(AHORA);
        expect(estado.whatsapp).toHaveLength(1);
        expect(estado.plantillasVencido[0]).toMatchObject({ chargeLabel: null, concept: null });
    });
});
