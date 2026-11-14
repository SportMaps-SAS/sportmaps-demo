import { describe, it, expect, vi, beforeEach } from 'vitest';

// Base simulada: cada tabla devuelve filas fijas; update/insert se registran.
const tablas: Record<string, any> = {};
const updates: { tabla: string; valores: any; filtros: any[] }[] = [];
const inserts: { tabla: string; valores: any }[] = [];
let errorEnAjustes: any = null;
let reclamoExitoso = true;

function cadena(tabla: string, op: 'select' | 'update' | 'insert', valores?: any) {
    const filtros: any[] = [];
    const c: any = new Proxy({}, {
        get(_t, prop: string) {
            if (prop === 'then') {
                return (res: any) => {
                    if (op === 'insert') { inserts.push({ tabla, valores }); return res({ data: null, error: null }); }
                    if (op === 'update') {
                        updates.push({ tabla, valores, filtros });
                        return res({ data: reclamoExitoso ? [{ id: 'x' }] : [], error: null });
                    }
                    if (tabla === 'school_settings' && errorEnAjustes) return res({ data: null, error: errorEnAjustes });
                    return res({ data: tablas[tabla] ?? [], error: null });
                };
            }
            if (prop === 'maybeSingle' || prop === 'single') {
                return () => Promise.resolve({ data: (tablas[tabla] ?? [])[0] ?? null, error: null });
            }
            return (...args: any[]) => { filtros.push([prop, ...args]); return c; };
        },
    });
    return c;
}

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (tabla: string) => ({
            select: () => cadena(tabla, 'select'),
            update: (v: any) => cadena(tabla, 'update', v),
            insert: (v: any) => cadena(tabla, 'insert', v),
        }),
    },
}));
const enviarCorreo = vi.fn().mockResolvedValue({ success: true });
vi.mock('../utils/emailClient', () => ({ emailClient: { send: (...a: any[]) => enviarCorreo(...a) } }));
vi.mock('../utils/emailTemplates', () => ({
    BrandedEmailTemplates: { hourBankBalance: vi.fn(async (p: any) => ({ subject: 'S ' + p.items.length, html: '<p>x</p>' })) },
}));
vi.mock('../utils/businessDate', () => ({ todayInZone: () => '2026-10-20' }));

import { runHourBankBalanceNotices } from './hour-bank-balance-notices.service';

const MEDIODIA = new Date('2026-10-20T17:00:00Z'); // 12:00 Colombia
const MADRUGADA = new Date('2026-10-20T08:00:00Z'); // 03:00 Colombia

function preparar(over: Record<string, any> = {}) {
    for (const k of Object.keys(tablas)) delete tablas[k];
    updates.length = 0; inserts.length = 0; errorEnAjustes = null; reclamoExitoso = true; enviarCorreo.mockClear();
    tablas.school_settings = [{ school_id: 'S1', hour_bank_balance_notice_steps: [50, 20, 0], hour_bank_balance_notice_email_enabled: true, hours_session_block_minutes: 120 }];
    tablas.hour_bank_periods = [{ id: 'P1', enrollment_id: 'E1', included_minutes: 2160, consumed_minutes: 29 * 60, period_end: '2026-10-31', balance_notices: {} }];
    tablas.enrollments = [{ id: 'E1', child_id: 'C1', user_id: null, offering_plan_id: 'PL1' }];
    tablas.offering_plans = [{ id: 'PL1', session_block_minutes: 180 }];
    tablas.children = [{ id: 'C1', full_name: 'Camila', parent_id: 'PA1' }];
    tablas.profiles = [{ id: 'PA1', full_name: 'Familia Pérez', email: 'familia@correo.com' }];
    tablas.schools = [{ owner_id: 'OWNER' }];
    Object.assign(tablas, over);
}

describe('runHourBankBalanceNotices', () => {
    beforeEach(() => preparar());

    it('de madrugada no evalúa nada (los avisos esperan a las 8 a. m.)', async () => {
        const r = await runHourBankBalanceNotices(MADRUGADA);
        expect(r.omitido).toBe('fuera_de_horario');
        expect(updates).toHaveLength(0);
        expect(inserts).toHaveLength(0);
    });

    it('sin las columnas de la migración no rompe y no manda nada', async () => {
        errorEnAjustes = { message: 'column school_settings.hour_bank_balance_notice_steps does not exist' };
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.omitido).toBe('sin_columnas');
        expect(inserts).toHaveLength(0);
    });

    it('escuela con escalones apagados (steps vacío) → nada', async () => {
        preparar({ school_settings: [{ school_id: 'S1', hour_bank_balance_notice_steps: [], hours_session_block_minutes: 120 }] });
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.omitido).toBe('sin_escuelas');
        expect(inserts).toHaveLength(0);
    });

    it('cruza el 20 %: reclama el escalón, avisa al acudiente (in-app) y manda un correo', async () => {
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.avisos).toBe(1);
        expect(r.correos).toBe(1);
        const upd = updates.find((u) => u.tabla === 'hour_bank_periods')!;
        expect(Object.keys(upd.valores.balance_notices).sort()).toEqual(['20', '50']); // 50 queda marcado en silencio
        expect(upd.filtros.some((f) => f[0] === 'is' && f[1] === 'balance_notices->>20' && f[2] === null)).toBe(true);
        const n = inserts.find((i) => i.tabla === 'notifications')!;
        expect(n.valores.user_id).toBe('PA1');
        expect(n.valores.type).toBe('hour_bank_balance');
        expect(n.valores.message).toContain('clases más');
        expect(enviarCorreo).toHaveBeenCalledTimes(1);
        expect(enviarCorreo.mock.calls[0][0].to).toBe('familia@correo.com');
    });

    it('quedan 2 clases (bloque del plan, 3 h): reclama «c2» y lo dice en horas, clases y %', async () => {
        preparar({ hour_bank_periods: [{ id: 'P1', enrollment_id: 'E1', included_minutes: 2160, consumed_minutes: 2160 - 360, period_end: '2026-10-31', balance_notices: { '50': 'a', '20': 'b' } }] });
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.avisos).toBe(1);
        const upd = updates.find((u) => u.tabla === 'hour_bank_periods')!;
        expect(upd.filtros.some((f) => f[0] === 'is' && f[1] === 'balance_notices->>c2' && f[2] === null)).toBe(true);
        const n = inserts.find((i) => i.tabla === 'notifications')!;
        expect(n.valores.title).toBe('A Camila le quedan 2 clases este mes');
        expect(n.valores.message).toContain('6 h de las 36 h de este mes (17 %)');
    });

    it('si otra instancia ya reclamó el escalón, no avisa dos veces', async () => {
        reclamoExitoso = false;
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.avisos).toBe(0);
        expect(inserts).toHaveLength(0);
        expect(enviarCorreo).not.toHaveBeenCalled();
    });

    it('escalón ya enviado y saldo igual → no reenvía', async () => {
        preparar({ hour_bank_periods: [{ id: 'P1', enrollment_id: 'E1', included_minutes: 2160, consumed_minutes: 29 * 60, period_end: '2026-10-31', balance_notices: { '50': 'a', '20': 'b' } }] });
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.avisos).toBe(0);
        expect(inserts).toHaveLength(0);
    });

    it('hermanas del mismo acudiente → un solo correo con las dos', async () => {
        preparar({
            hour_bank_periods: [
                { id: 'P1', enrollment_id: 'E1', included_minutes: 2160, consumed_minutes: 29 * 60, period_end: '2026-10-31', balance_notices: {} },
                { id: 'P2', enrollment_id: 'E2', included_minutes: 960, consumed_minutes: 960, period_end: '2026-10-31', balance_notices: {} },
            ],
            enrollments: [
                { id: 'E1', child_id: 'C1', user_id: null, offering_plan_id: 'PL1' },
                { id: 'E2', child_id: 'C2', user_id: null, offering_plan_id: 'PL1' },
            ],
            children: [
                { id: 'C1', full_name: 'Camila', parent_id: 'PA1' },
                { id: 'C2', full_name: 'Sofía', parent_id: 'PA1' },
            ],
        });
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.avisos).toBe(2);
        expect(enviarCorreo).toHaveBeenCalledTimes(1);
        expect(inserts.filter((i) => i.tabla === 'notifications')).toHaveLength(2);
    });

    it('sin acudiente vinculado el aviso va solo al dueño y lo dice', async () => {
        preparar({ children: [{ id: 'C1', full_name: 'Camila', parent_id: null }] });
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.avisos).toBe(1);
        const n = inserts.find((i) => i.tabla === 'notifications')!;
        expect(n.valores.user_id).toBe('OWNER');
        expect(n.valores.title).toContain('sin acudiente vinculado');
        expect(enviarCorreo).not.toHaveBeenCalled();
    });

    it('correo apagado en la escuela → solo in-app', async () => {
        preparar({ school_settings: [{ school_id: 'S1', hour_bank_balance_notice_steps: [50, 20, 0], hour_bank_balance_notice_email_enabled: false, hours_session_block_minutes: 120 }] });
        const r = await runHourBankBalanceNotices(MEDIODIA);
        expect(r.avisos).toBe(1);
        expect(enviarCorreo).not.toHaveBeenCalled();
    });
});
