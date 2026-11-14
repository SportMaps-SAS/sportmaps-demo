/**
 * Resumen diario de «Pagos por validar» (2026-11-08): 07:30 a owner y admins de
 * cada escuela con comprobantes en `awaiting_approval`, recordatorio a las 17:00
 * si alguno lleva > 48 h, idempotente por escuela + día + tramo, sin N+1, sin
 * escuelas demo, y sin invitar a «Aprobar todos los verdes» a ciegas cuando la
 * escuela tiene la aprobación automática encendida.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { baseVacia, supabaseFalso, lecturas, type BaseFalsa } from './base-falsa.test-helpers';

const h = vi.hoisted(() => ({ db: null as any, envios: [] as any[] }));

vi.mock('../config/supabase', () => ({
    supabase: { from: (...a: any[]) => h.db.from(...a), rpc: (...a: any[]) => h.db.rpc(...a) },
}));
vi.mock('../services/avisos-correo.service', async (orig) => {
    const real = await orig<typeof import('../services/avisos-correo.service')>();
    return {
        ...real,
        enviarPlantilla: vi.fn(async (tipo: any, destinos: string[], _d: any, respaldo: any) => {
            h.envios.push({ tipo, destinos, respaldo });
            return { ok: true, messageId: 'm1' };
        }),
    };
});

import {
    runPagosPorValidar, armarResumen, exclusionVerde, lineaVerdes, textosDelAviso, debeAvisar, escuelaElegible,
    pagosPorValidarActivo, tramoPorHora, saldo, claveAviso, ETIQUETA_TIPO, ORDEN_TIPOS, tipoDeCobro, URL_PANEL,
    type PagoPorValidar,
} from './pagos-por-validar.job';

const MONSTER = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const OTRA = '11111111-1111-4111-8111-111111111111';
const DEMO = '22222222-2222-4222-8222-222222222222';
const HORA = 3600_000;
// 2026-11-09 07:30 COT = 12:30 UTC.
const AHORA = Date.parse('2026-11-09T12:30:00Z');
const hace = (ms: number) => new Date(AHORA - ms).toISOString();

function pagoBase(o: Partial<PagoPorValidar> & Record<string, any>): Record<string, any> {
    return {
        status: 'awaiting_approval', amount: 145000, amount_paid: 0, early_payment_discount_applied: null,
        concept: 'Mensualidad noviembre 2026', payment_category: 'mensualidad', receipt_verdict: 'verde',
        ocr_amount: 145000, requires_review: false, child_id: null, period_year: null, period_month: null,
        receipt_verdict_at: null, created_at: hace(100 * HORA), ...o,
    };
}

function escenario(): BaseFalsa {
    return baseVacia({
        payments: [
            // Pronto pago: $137.750 de $145.000 con $7.250 de descuento → está completo (verde de un clic).
            pagoBase({ id: 'p1', school_id: MONSTER, early_payment_discount_applied: 7250, ocr_amount: 137750, receipt_url: 'r/p1.jpg', receipt_submitted_at: hace(72 * HORA) }),
            pagoBase({ id: 'p2', school_id: MONSTER, receipt_url: 'r/p2.jpg', receipt_submitted_at: hace(1 * HORA) }),
            pagoBase({ id: 'p3', school_id: MONSTER, amount: 80000, ocr_amount: 70000, receipt_verdict: 'amarillo', concept: 'Torneo Copa', payment_category: 'torneo', receipt_url: 'r/p3.jpg', receipt_submitted_at: hace(50 * HORA) }),
            pagoBase({ id: 'p4', school_id: OTRA, amount: 100000, ocr_amount: 100000, receipt_url: 'r/p4.jpg', receipt_submitted_at: hace(2 * HORA) }),
            pagoBase({ id: 'p5', school_id: DEMO, receipt_url: 'r/p5.jpg', receipt_submitted_at: hace(90 * HORA) }),
            // Ni pagado ni sin comprobante entran.
            pagoBase({ id: 'p6', school_id: MONSTER, status: 'paid', receipt_url: 'r/p6.jpg', receipt_submitted_at: hace(1 * HORA) }),
            pagoBase({ id: 'p7', school_id: MONSTER, receipt_url: null, receipt_submitted_at: hace(1 * HORA) }),
        ],
        schools: [
            { id: MONSTER, name: 'Monster´s Volley Club', owner_id: 'own1', account_type: 'real', is_demo: false },
            { id: OTRA, name: 'Academia Tigres', owner_id: 'own2', account_type: 'real', is_demo: false },
            { id: DEMO, name: 'Club Campestre Demo', owner_id: 'own3', account_type: 'demo', is_demo: true },
        ],
        school_members: [
            { school_id: MONSTER, profile_id: 'adm1', role: 'admin', status: 'active' },
            { school_id: MONSTER, profile_id: 'own1', role: 'owner', status: 'active' },
            { school_id: MONSTER, profile_id: 'coach1', role: 'coach', status: 'active' },
            { school_id: MONSTER, profile_id: 'adm2', role: 'admin', status: 'inactive' },
        ],
        profiles: [
            { id: 'own1', email: 'Duena@Monster.co', is_demo: false },
            { id: 'adm1', email: 'admin@monster.co', is_demo: false },
            { id: 'coach1', email: 'coach@monster.co', is_demo: false },
            { id: 'adm2', email: 'viejo@monster.co', is_demo: false },
            { id: 'own2', email: 'tigres@x.co', is_demo: false },
            { id: 'own3', email: 'demo@x.co', is_demo: true },
        ],
        school_settings: [
            { school_id: MONSTER, auto_approve_enabled: true },
            { school_id: OTRA, auto_approve_enabled: false },
        ],
        email_sends: [],
        notifications: [],
    });
}

let base: BaseFalsa;
beforeEach(() => {
    base = escenario();
    h.db = supabaseFalso(base);
    h.envios = [];
});

describe('resumen de las 07:30', () => {
    it('avisa a owner + admins activos (sin coach) de cada escuela real, con correo branded e in-app', async () => {
        const r = await runPagosPorValidar({ tramo: 'manana', ahora: AHORA, log: { warn() {}, error() {} } as any });
        expect(r.escuelasConPendientes).toBe(3);
        expect(r.omitidas.noElegible).toBe(1); // la demo
        expect(r.avisadas).toBe(2);
        expect(h.envios).toHaveLength(2);

        const monster = r.plan.find((p) => p.schoolId === MONSTER)!;
        expect(monster.correos.sort()).toEqual(['admin@monster.co', 'duena@monster.co']);
        expect(monster.resumen.total).toBe(3);
        expect(monster.resumen.monto).toBe(137750 + 145000 + 80000);
        expect(monster.resumen.verdes).toBe(2);
        expect(monster.resumen.verdesUnClic).toBe(2);
        expect(monster.resumen.masDe48h).toBe(2);
        expect(monster.textos.asunto).toBe('Monster´s Volley Club: 3 pagos por validar ($362.750)');

        const notifs = base.tablas.notifications;
        expect(notifs.filter((n) => n.school_id === MONSTER).map((n) => n.user_id).sort()).toEqual(['adm1', 'own1']);
        expect(notifs.filter((n) => n.school_id === OTRA).map((n) => n.user_id)).toEqual(['own2']);
        expect(notifs.every((n) => n.link === '/payments-automation?tab=recurrent' && n.data?.amount === undefined)).toBe(true);
    });

    it('con aprobación automática encendida el correo NO invita a «Aprobar todos los verdes»: dice cuántos y pide revisarlos', async () => {
        await runPagosPorValidar({ tramo: 'manana', ahora: AHORA });
        const correoMonster = h.envios.find((e) => e.destinos.includes('duena@monster.co'))!;
        const html: string = correoMonster.respaldo.html;
        expect(html).not.toContain('Aprobar todos los verdes');
        expect(html).toContain('2 están en verde, pero no se aprobaron solos: revisa cada comprobante antes de aprobarlo.');
        expect(html).toContain('Revisar pagos por validar');
        expect(html).toContain(URL_PANEL);
        expect(html).not.toContain('localhost');

        const notif = base.tablas.notifications.find((n) => n.school_id === MONSTER)!;
        expect(notif.message).not.toContain('Aprobar todos los verdes');

        // Sin aprobación automática sí la menciona, pero después de revisarlos.
        const correoOtra = h.envios.find((e) => e.destinos.includes('tigres@x.co'))!;
        expect(correoOtra.respaldo.html).toContain('1 está en verde (el comprobante coincide con el cobro): revísalo y apruébalo desde su fila.');
    });

    it('idempotente por escuela + día + tramo: la segunda corrida (otro BFF, un reinicio) no repite nada', async () => {
        await runPagosPorValidar({ tramo: 'manana', ahora: AHORA });
        const notifs = base.tablas.notifications.length;
        const r2 = await runPagosPorValidar({ tramo: 'manana', ahora: AHORA + 60_000 });
        expect(r2.avisadas).toBe(0);
        expect(r2.duplicadas).toBe(2);
        expect(h.envios).toHaveLength(2);
        expect(base.tablas.notifications.length).toBe(notifs);
        expect(base.tablas.email_sends.map((e) => e.email_type)).toEqual(['pagos_por_validar', 'pagos_por_validar']);
    });

    it('si dos BFF reservan a la vez, solo uno manda (la reserva de email_sends es el candado)', async () => {
        const [a, b] = await Promise.all([
            runPagosPorValidar({ tramo: 'manana', ahora: AHORA }),
            runPagosPorValidar({ tramo: 'manana', ahora: AHORA }),
        ]);
        expect(a.avisadas + b.avisadas).toBe(2);
        expect(h.envios).toHaveLength(2);
    });

    it('sin N+1: las lecturas no crecen con el número de escuelas', async () => {
        await runPagosPorValidar({ tramo: 'manana', ahora: AHORA });
        const totales = Object.fromEntries(['payments', 'schools', 'school_members', 'profiles', 'school_settings', 'email_sends']
            .map((t) => [t, lecturas(base, t)]));
        expect(totales).toEqual({ payments: 1, schools: 1, school_members: 1, profiles: 1, school_settings: 1, email_sends: 1 });
    });

    it('simulacro (aplicar: false) no escribe nada', async () => {
        const r = await runPagosPorValidar({ tramo: 'manana', ahora: AHORA, aplicar: false });
        expect(r.plan).toHaveLength(2);
        expect(h.envios).toHaveLength(0);
        expect(base.tablas.notifications).toHaveLength(0);
        expect(base.tablas.email_sends).toHaveLength(0);
    });
});

describe('recordatorio de las 17:00', () => {
    it('solo a las escuelas con algo de más de 48 h, con su propia clave', async () => {
        const tarde = Date.parse('2026-11-09T22:00:00Z');
        const r = await runPagosPorValidar({ tramo: 'tarde', ahora: tarde });
        expect(r.plan.map((p) => p.schoolId)).toEqual([MONSTER]);
        expect(r.omitidas.nadaQueAvisar).toBe(1);
        const p = r.plan[0];
        expect(p.clave).toBe(claveAviso(MONSTER, '2026-11-09', 'tarde'));
        expect(p.textos.titulo).toBe('2 pagos llevan más de 48 h sin validar');
        expect(p.textos.mensaje).not.toContain('Aprobar todos los verdes');
    });
});

describe('reglas puras', () => {
    const p = (o: Partial<PagoPorValidar>): PagoPorValidar => ({
        id: 'x', school_id: 's', amount: 145000, amount_paid: 0, early_payment_discount_applied: 0, concept: 'Mensualidad',
        payment_category: null, receipt_verdict: 'verde', receipt_url: 'r/x', ocr_amount: 145000, requires_review: false,
        child_id: null, period_year: null, period_month: null, enviado_en: hace(HORA), ...o,
    });
    const ctx = { compartidos: new Set<string>(), periodosPagados: new Set<string>() };

    it('pronto pago: el saldo descuenta el descuento y el verde entra completo', () => {
        const pronto = p({ early_payment_discount_applied: 7250, ocr_amount: 137750 });
        expect(saldo(pronto)).toBe(137750);
        expect(exclusionVerde(pronto, ctx)).toBeNull();
        expect(exclusionVerde(p({ ocr_amount: 137750 }), ctx)).toBe('el monto leído no coincide');
    });

    it('líneas de verdes: con aprobación automática nunca «Aprobar todos los verdes»', () => {
        expect(lineaVerdes({ verdes: 0, verdesUnClic: 0 }, true)).toBeNull();
        expect(lineaVerdes({ verdes: 3, verdesUnClic: 3 }, true)).toBe('3 están en verde, pero no se aprobaron solos: revisa cada comprobante antes de aprobarlo.');
        expect(lineaVerdes({ verdes: 1, verdesUnClic: 1 }, true)).not.toContain('Aprobar todos');
        expect(lineaVerdes({ verdes: 3, verdesUnClic: 3 })).toContain('Después de revisarlos');
        expect(lineaVerdes({ verdes: 3, verdesUnClic: 1 })).toBe('3 están en verde: después de revisarlos, 1 se puede aprobar con «Aprobar todos los verdes» y 2 se aprueban desde su fila.');
    });

    it('cuándo avisa, quién es elegible, dónde corre y qué tramo es', () => {
        expect(debeAvisar({ total: 1, masDe48h: 0 }, 'manana')).toBe(true);
        expect(debeAvisar({ total: 0, masDe48h: 0 }, 'manana')).toBe(false);
        expect(debeAvisar({ total: 5, masDe48h: 0 }, 'tarde')).toBe(false);
        expect(escuelaElegible({ account_type: 'real', is_demo: false })).toBe(true);
        expect(escuelaElegible({ account_type: 'real', is_demo: true })).toBe(false);
        expect(escuelaElegible({ account_type: 'demo', is_demo: false })).toBe(false);
        expect(pagosPorValidarActivo({ NODE_ENV: 'production' } as any)).toBe(true);
        expect(pagosPorValidarActivo({ NODE_ENV: 'development' } as any)).toBe(false);
        expect(pagosPorValidarActivo({ NODE_ENV: 'staging' } as any)).toBe(false);
        expect(pagosPorValidarActivo({ NODE_ENV: 'production', DISABLE_PAGOS_POR_VALIDAR: 'true' } as any)).toBe(false);
        expect(tramoPorHora(Date.parse('2026-11-09T12:30:00Z'))).toBe('manana');
        expect(tramoPorHora(Date.parse('2026-11-09T22:00:00Z'))).toBe('tarde');
    });

    it('resumen: total, monto con pronto pago, más antiguo y desglose de más a menos', () => {
        const r = armarResumen('s', [
            p({ id: 'a', early_payment_discount_applied: 7250, ocr_amount: 137750, enviado_en: hace(80 * HORA) }),
            p({ id: 'b', payment_category: 'torneo', concept: 'Torneo', receipt_verdict: 'amarillo', amount: 50000 }),
            p({ id: 'c', payment_category: 'torneo', concept: 'Torneo', receipt_verdict: 'amarillo', amount: 50000 }),
        ], AHORA);
        expect(r.total).toBe(3);
        expect(r.monto).toBe(237750);
        expect(r.masDe48h).toBe(1);
        expect(r.desglose.map((l) => `${l.etiqueta} ${l.cantidad}`)).toEqual(['Torneo 2', 'Mensualidad 1']);
        expect(textosDelAviso(r, 'Club', 'manana', true).mensaje).toContain('Por tipo: Torneo 2 · Mensualidad 1.');
    });
});

describe('contrato con el filtro «Tipo» de Gestión de pagos (frontend/src/lib/tipoDeCobro.ts)', () => {
    const front = readFileSync(resolve(__dirname, '../../../frontend/src/lib/tipoDeCobro.ts'), 'utf8');

    it('mismas etiquetas y mismo orden', () => {
        const bloque = /ETIQUETA_TIPO_DE_COBRO[^=]*=\s*\{([\s\S]*?)\};/.exec(front)![1];
        const etiquetas = Object.fromEntries([...bloque.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
        expect(etiquetas).toEqual(ETIQUETA_TIPO);
        const orden = [.../ORDEN_TIPOS_DE_COBRO[^=]*=\s*\[([\s\S]*?)\];/.exec(front)![1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
        expect(orden).toEqual([...ORDEN_TIPOS]);
    });

    it('la clínica viaja como clase_extra y se reconoce por el concepto', () => {
        expect(tipoDeCobro({ payment_category: 'clase_extra', concept: 'Clínica de saque' })).toBe('clinica');
        expect(tipoDeCobro({ payment_category: 'clase_extra', concept: 'Clase extra' })).toBe('clase_extra');
        expect(tipoDeCobro({ payment_category: null, concept: 'Vacacional diciembre' })).toBe('vacacional');
        expect(tipoDeCobro({ payment_category: null, concept: null })).toBe('mensualidad');
    });
});
