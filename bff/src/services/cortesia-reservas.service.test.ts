/**
 * cortesia-reservas.service — dónde quedó agendada cada clase de cortesía y el
 * aviso inmediato a la escuela (in-app + push + correo), idempotente entre los
 * tres BFF por id determinístico.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, any>;

const estado = vi.hoisted(() => ({
    tablas: {} as Record<string, Record<string, any>[]>,
    pushes: [] as { uid: string; title: string; body: string }[],
    correos: [] as any[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        const filtros: ((f: Fila) => boolean)[] = [];
        let cambio: Fila | null = null;
        let nueva: Fila | null = null;
        let ignorar = false;
        const resolver = () => {
            const filas = estado.tablas[tabla] ?? (estado.tablas[tabla] = []);
            if (nueva) {
                // upsert + ignoreDuplicates = ON CONFLICT DO NOTHING: sin error, sin fila devuelta.
                if (ignorar && filas.some((f) => f.id === nueva!.id)) return { data: [], error: null };
                if (filas.some((f) => f.id === nueva!.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
                filas.push({ ...nueva });
                return { data: [{ ...nueva }], error: null };
            }
            const sel = filas.filter((f) => filtros.every((p) => p(f)));
            if (cambio) for (const f of sel) Object.assign(f, cambio);
            return { data: sel.map((f) => ({ ...f })), error: null };
        };
        const campo = (f: Fila, col: string) => col.split('.').reduce((v: any, k) => v?.[k], f);
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filtros.push((f) => campo(f, c) === v); return api; },
            neq: (c: string, v: any) => { filtros.push((f) => campo(f, c) !== v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((f) => vs.includes(campo(f, c))); return api; },
            is: (c: string, v: any) => { filtros.push((f) => (campo(f, c) ?? null) === v); return api; },
            not: (c: string, _op: string, v: any) => { filtros.push((f) => (campo(f, c) ?? null) !== v); return api; },
            gte: (c: string, v: any) => { filtros.push((f) => String(campo(f, c)) >= String(v)); return api; },
            lte: (c: string, v: any) => { filtros.push((f) => String(campo(f, c)) <= String(v)); return api; },
            order: () => api, limit: () => api,
            update: (c: Fila) => { cambio = c; return api; },
            insert: (r: Fila) => { nueva = r; return api; },
            upsert: (r: Fila, o?: { ignoreDuplicates?: boolean }) => { nueva = r; ignorar = o?.ignoreDuplicates === true; return api; },
            maybeSingle: async () => { const r = resolver(); return { data: r.data?.[0] ?? null, error: r.error }; },
            then: (ok: any, err: any) => Promise.resolve(resolver()).then(ok, err),
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t) } };
});

vi.mock('./push.service', () => ({
    sendToUser: vi.fn(async (uid: string, p: any) => {
        estado.pushes.push({ uid, title: p.title, body: p.body });
        return { enabled: true, sent: 1, failed: 0, revoked: 0 };
    }),
}));

vi.mock('./avisos-correo.service', async (orig) => {
    const real: any = await orig();
    return {
        ...real,
        destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'DYNASTY', correos: ['milena@x.co'] })),
        enviarConReserva: vi.fn(async (p: any) => {
            if (estado.correos.some((c) => c.clave === p.clave)) return 'duplicado';
            estado.correos.push(p);
            return 'enviado';
        }),
    };
});

import {
    avisarCortesia, contenidoAviso, edadDeLead, enlaceWaMe, listarCortesias, marcarAsistencia, paraQuien,
} from './cortesia-reservas.service';

const ESCUELA = '2d509571-3238-4c04-ac3f-6dfe20539226';
const OTRA = '11111111-1111-1111-1111-111111111111';
const AHORA = Date.parse('2026-10-06T15:00:00Z'); // 10 a. m. en Bogotá

const franja = { id: 'slot-1', grupo: 'Menores Masculino', fecha: '2026-10-07', horaInicio: '17:00', horaFin: '19:00', sede: 'Coliseo Dynasty DC', cupos: 999 };

function lead(p: Partial<Fila>): Fila {
    return {
        id: 'lead-x', school_id: ESCUELA, full_name: 'Ana Pérez', guardian_name: null, phone: '3001112233',
        birth_date: null, notes: null, status: 'new', how_heard: null, source_detail: null,
        created_at: '2026-10-05T12:00:00Z', trial_slot_id: null, school_trial_slots: null, ...p,
    };
}

beforeEach(() => {
    estado.tablas = {
        schools: [{ id: ESCUELA, owner_id: 'milena' }],
        school_members: [
            { school_id: ESCUELA, profile_id: 'milena', role: 'owner', status: 'active' },
            { school_id: ESCUELA, profile_id: 'admin-2', role: 'admin', status: 'active' },
            { school_id: ESCUELA, profile_id: 'coach-1', role: 'coach', status: 'active' },
        ],
        whatsapp_conversations: [{ id: 'conv-1', school_id: ESCUELA, contact_wa_id: '573001112233', contact_name: 'Mamá de Ana' }],
        notifications: [],
        school_signup_leads: [],
    };
    estado.pushes = [];
    estado.correos = [];
});

describe('formato', () => {
    it('edad por fecha de nacimiento o por la nota del bot', () => {
        expect(edadDeLead('2014-03-15', null, '2026-10-06')).toBe(12);
        expect(edadDeLead(null, 'Agendada por el asistente de WhatsApp. Edad informada: 9 años.', '2026-10-06')).toBe(9);
        expect(edadDeLead(null, null, '2026-10-06')).toBeNull();
    });
    it('para quién: menor con acudiente o adulto', () => {
        expect(paraQuien(12, 'Laura')).toBe('Menor de 12 años (acudiente: Laura)');
        expect(paraQuien(25, null)).toBe('Adulto (25 años)');
    });
    it('wa.me agrega 57 al celular de 10 dígitos', () => {
        expect(enlaceWaMe('3001112233')).toBe('https://wa.me/573001112233');
        expect(enlaceWaMe('+57 300 111 2233')).toBe('https://wa.me/573001112233');
        expect(enlaceWaMe('')).toBeNull();
    });
    it('el aviso trae nombre, wa.me, para quién, grupo, día, sede y el chat', () => {
        const c = contenidoAviso({
            tipo: 'reservada', schoolId: ESCUELA, conversationId: 'conv-1', contactWaId: '573001112233',
            leadId: 'lead-1', nombre: 'Ana Pérez', edad: 12, acudiente: 'Laura Pérez', franja,
        }, 'Mamá de Ana');
        const t = c.lineas.join('\n');
        expect(t).toContain('Nombre: Ana Pérez');
        expect(t).toContain('Quien escribe: Mamá de Ana');
        expect(t).toContain('Menor de 12 años (acudiente: Laura Pérez)');
        expect(t).toContain('https://wa.me/573001112233');
        expect(t).toContain('Grupo: Menores Masculino');
        expect(t).toContain('miércoles 7 de octubre, 5:00 p. m. a 7:00 p. m.');
        expect(t).toContain('Sede: Coliseo Dynasty DC');
        expect(c.urlChat).toContain('conversacion=conv-1');
    });
});

describe('listarCortesias', () => {
    it('reservas con franja, de ESA escuela, con origen y chat; leads sin agendar aparte', async () => {
        estado.tablas.school_signup_leads = [
            lead({ id: 'l-wa', trial_slot_id: 'slot-1', how_heard: 'whatsapp', notes: 'Edad informada: 12 años.',
                guardian_name: 'Laura', source_detail: { canal: 'whatsapp', conversation_id: 'conv-1' },
                school_trial_slots: { id: 'slot-1', label: 'Menores Masculino', slot_date: '2026-10-07', start_time: '17:00:00', end_time: '19:00:00', location: 'Coliseo' } }),
            lead({ id: 'l-web', phone: '3001112233', trial_slot_id: 'slot-2',
                school_trial_slots: { id: 'slot-2', label: 'Sub-15', slot_date: '2026-10-06', start_time: '16:00:00', end_time: null, location: null } }),
            lead({ id: 'l-otra', school_id: OTRA, trial_slot_id: 'slot-9',
                school_trial_slots: { id: 'slot-9', label: 'X', slot_date: '2026-10-07', start_time: '08:00:00', end_time: null, location: null } }),
            lead({ id: 'l-desc', status: 'discarded', trial_slot_id: 'slot-1',
                school_trial_slots: { id: 'slot-1', label: 'Menores Masculino', slot_date: '2026-10-07', start_time: '17:00:00', end_time: null, location: null } }),
            lead({ id: 'l-sin', created_at: '2026-10-05T00:00:00Z' }),
        ];
        const r = await listarCortesias(ESCUELA, {}, AHORA);
        expect(r.reservas.map((x) => x.leadId)).toEqual(['l-web', 'l-wa']); // por fecha de la clase
        const wa = r.reservas.find((x) => x.leadId === 'l-wa')!;
        expect(wa).toMatchObject({ origen: 'whatsapp', edad: 12, grupo: 'Menores Masculino', horaInicio: '17:00', conversationId: 'conv-1' });
        // El de la web no trae conversación, pero se cruza por teléfono.
        expect(r.reservas.find((x) => x.leadId === 'l-web')).toMatchObject({ origen: 'web', conversationId: 'conv-1' });
        expect(r.sinAgendar.map((x) => x.leadId)).toEqual(['l-sin']);
    });
});

describe('marcarAsistencia', () => {
    it('guarda en source_detail conservando lo demás; otra escuela = no encontrado', async () => {
        estado.tablas.school_signup_leads = [lead({ id: 'l1', trial_slot_id: 's', source_detail: { canal: 'whatsapp' } })];
        expect(await marcarAsistencia(OTRA, 'l1', 'asistio', 'u')).toBe('no_encontrado');
        expect(await marcarAsistencia(ESCUELA, 'l1', 'asistio', 'u')).toBe('ok');
        expect(estado.tablas.school_signup_leads[0].source_detail).toMatchObject({ canal: 'whatsapp', asistencia: 'asistio', asistencia_por: 'u' });
        expect(await marcarAsistencia(ESCUELA, 'l1', null, 'u')).toBe('ok');
        expect(estado.tablas.school_signup_leads[0].source_detail.asistencia).toBeUndefined();
    });
    it('sin franja no se marca asistencia', async () => {
        estado.tablas.school_signup_leads = [lead({ id: 'l2' })];
        expect(await marcarAsistencia(ESCUELA, 'l2', 'no_vino', 'u')).toBe('sin_reserva');
    });
});

describe('avisarCortesia', () => {
    const aviso = {
        tipo: 'reservada' as const, schoolId: ESCUELA, conversationId: 'conv-1', contactWaId: '573001112233',
        leadId: 'lead-1', nombre: 'Ana Pérez', edad: 12, acudiente: 'Laura', franja,
    };

    it('in-app + push a owner y admins (no al coach) + un correo', async () => {
        const r = await avisarCortesia(aviso);
        expect(r.inApp).toBe(2);
        expect(estado.pushes.map((p) => p.uid).sort()).toEqual(['admin-2', 'milena']);
        expect(estado.tablas.notifications[0]).toMatchObject({ link: '/whatsapp?tab=cortesias', category: 'enrollment' });
        expect(estado.tablas.notifications[0].message).toContain('Grupo: Menores Masculino');
        expect(estado.correos).toHaveLength(1);
        expect(estado.correos[0].respaldo.lineas.join('\n')).toContain('wa.me/573001112233');
    });

    it('idempotente: el segundo BFF con el mismo evento no repite in-app, push ni correo', async () => {
        await avisarCortesia(aviso);
        const r2 = await avisarCortesia(aviso);
        expect(r2.inApp).toBe(0);
        expect(estado.pushes).toHaveLength(2);
        expect(estado.tablas.notifications).toHaveLength(2);
        expect(r2.correo).toBe('duplicado');
    });

    it('la cancelación es otro evento: sí avisa', async () => {
        await avisarCortesia(aviso);
        await avisarCortesia({ ...aviso, tipo: 'cancelada' });
        expect(estado.tablas.notifications).toHaveLength(4);
        expect(estado.correos).toHaveLength(2);
    });
});
