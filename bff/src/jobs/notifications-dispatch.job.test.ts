// Cola de notificaciones atascada (2026-07 → 2026-10-27).
//
// Reproduce el bloqueo con una tabla en memoria y el notification.service REAL
// (solo se mockean los emisores web/nativo):
//   · 50 filas 'failed' agotadas (5/5) al frente por next_attempt_at + 1 pending
//     → antes el lote de 50 traía solo las agotadas y la pending nunca salía;
//     ahora las agotadas se estacionan en 'infinity' y la pending se entrega
//     en la MISMA corrida.
//   · finalize() de un último intento fallido ya no reprograma la fila.
//   · un error del select se loguea (antes se tragaba en silencio).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Row = Record<string, any>;

const h = vi.hoisted(() => {
    const db: { tablas: Record<string, Row[]>; selectError: any } = { tablas: {}, selectError: null };

    /** Compara next_attempt_at como lo haría Postgres ('infinity' > todo). */
    const ts = (v: string) => (v === 'infinity' ? Number.POSITIVE_INFINITY : new Date(v).getTime());

    function builder(tabla: string) {
        const filtros: ((r: Row) => boolean)[] = [];
        let modo: 'select' | 'update' = 'select';
        let patch: Row = {};
        let orden: string | null = null;
        let limite = Infinity;
        let devolverFilas = false;

        const ejecutar = () => {
            if (modo === 'select' && tabla === 'notification_deliveries' && db.selectError) {
                return { data: null, error: db.selectError };
            }
            let filas = (db.tablas[tabla] ?? []).filter(r => filtros.every(f => f(r)));
            if (orden) filas = [...filas].sort((a, b) => ts(a[orden!]) - ts(b[orden!]));
            filas = filas.slice(0, limite);
            if (modo === 'update') {
                for (const f of filas) Object.assign(f, patch);
                return { data: devolverFilas ? filas.map(f => ({ ...f })) : null, error: null };
            }
            return { data: filas.map(f => ({ ...f })), error: null };
        };

        const api: any = {
            select: () => { if (modo === 'update') devolverFilas = true; return api; },
            eq: (c: string, v: any) => { filtros.push(r => r[c] === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push(r => vs.includes(r[c])); return api; },
            lte: (c: string, v: string) => { filtros.push(r => ts(r[c]) <= ts(v)); return api; },
            order: (c: string) => { orden = c; return api; },
            limit: (n: number) => { limite = n; return api; },
            update: (p: Row) => { modo = 'update'; patch = p; return api; },
            maybeSingle: async () => { const r = ejecutar(); return { data: r.data?.[0] ?? null, error: r.error }; },
            then: (ok: any, ko: any) => Promise.resolve(ejecutar()).then(ok, ko),
        };
        return api;
    }

    return {
        db,
        supabase: { from: (t: string) => builder(t) },
        sendToUser: vi.fn(),
        sendWebPushToUser: vi.fn(),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('../services/push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('../services/webpush.service', () => ({ sendWebPushToUser: h.sendWebPushToUser }));

import { runNotificationDispatch } from './notifications-dispatch.job';
import { dispatchDelivery } from '../services/notification.service';

const julio = (i: number) => new Date(Date.UTC(2026, 6, 24, 0, i)).toISOString();

function fila(over: Row): Row {
    return {
        id: 'x', notification_id: 'n-x', user_id: 'u1', status: 'pending',
        attempts: 0, max_attempts: 5, next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
        web_sent: 0, web_failed: 0, native_sent: 0, native_failed: 0, revoked: 0, last_error: null,
        ...over,
    };
}

function sembrarColaAtascada() {
    const agotadas = Array.from({ length: 50 }, (_, i) => fila({
        id: `agotada-${i}`, notification_id: `n-agotada-${i}`, status: 'failed',
        attempts: 5, max_attempts: 5, next_attempt_at: julio(i),
    }));
    const pendiente = fila({ id: 'nueva', notification_id: 'n-nueva' });
    h.db.tablas = {
        notification_deliveries: [...agotadas, pendiente],
        notifications: [
            { id: 'n-nueva', user_id: 'u1', category: 'payment', title: 'Pago', message: 'ok', link: '/', data: {} },
        ],
        profiles: [{ id: 'u1', preferences: {} }],
    };
    return pendiente;
}

const prevEnv = process.env.NOTIF_DISPATCH_ENABLED;

beforeEach(() => {
    process.env.NOTIF_DISPATCH_ENABLED = 'true';
    h.db.selectError = null;
    h.sendWebPushToUser.mockReset().mockResolvedValue({ sent: 1, failed: 0, revoked: 0 });
    h.sendToUser.mockReset().mockResolvedValue({ enabled: true, sent: 0, failed: 0, revoked: 0 });
});

afterEach(() => {
    process.env.NOTIF_DISPATCH_ENABLED = prevEnv;
    vi.restoreAllMocks();
});

describe('cola atascada por filas agotadas al frente', () => {
    it('50 agotadas + 1 pending → la pending se entrega en la misma corrida', async () => {
        sembrarColaAtascada();

        const r = await runNotificationDispatch();

        const nueva = h.db.tablas.notification_deliveries.find(f => f.id === 'nueva')!;
        expect(nueva.status).toBe('sent');
        expect(nueva.web_sent).toBe(1);
        expect(h.sendWebPushToUser).toHaveBeenCalledTimes(1);
        expect(r.claimed).toBe(1);
        expect(r.parked).toBe(50);
    });

    it('las agotadas quedan estacionadas (infinity) y no vuelven a encabezar el lote', async () => {
        sembrarColaAtascada();
        await runNotificationDispatch();

        const agotadas = h.db.tablas.notification_deliveries.filter(f => f.id.startsWith('agotada-'));
        expect(agotadas.every(f => f.next_attempt_at === 'infinity')).toBe(true);
        expect(agotadas.every(f => f.status === 'failed' && f.attempts === 5)).toBe(true);

        // Segunda corrida: nada que estacionar ni que reclamar.
        h.sendWebPushToUser.mockClear();
        const r2 = await runNotificationDispatch();
        expect(r2).toEqual({ claimed: 0, failed: 0, parked: 0 });
        expect(h.sendWebPushToUser).not.toHaveBeenCalled();
    });

    it('error del select → se loguea (no falla en silencio) y no despacha', async () => {
        sembrarColaAtascada();
        h.db.selectError = { message: 'permission denied for table notification_deliveries' };
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const r = await runNotificationDispatch();

        expect(r).toEqual({ claimed: 0, failed: 0, parked: 0 });
        expect(spy).toHaveBeenCalledWith('[notif-dispatch] no se pudo leer la cola:', 'permission denied for table notification_deliveries');
    });
});

describe('finalize() de un último intento fallido', () => {
    it('failed con attempts >= max_attempts → next_attempt_at = infinity (no se reprograma)', async () => {
        h.db.tablas = {
            notification_deliveries: [fila({ id: 'd', notification_id: 'n-d', status: 'failed', attempts: 5 })],
            notifications: [{ id: 'n-d', user_id: 'u1', category: 'payment', title: 't', message: 'm', link: '/', data: {} }],
            profiles: [{ id: 'u1', preferences: {} }],
        };
        h.sendWebPushToUser.mockResolvedValue({ sent: 0, failed: 1, revoked: 0, lastError: 'boom' });

        await dispatchDelivery({ ...h.db.tablas.notification_deliveries[0] } as any);

        const d = h.db.tablas.notification_deliveries[0];
        expect(d.status).toBe('failed');
        expect(d.next_attempt_at).toBe('infinity');
    });

    it('failed con intentos restantes → sigue con backoff (fecha futura finita)', async () => {
        h.db.tablas = {
            notification_deliveries: [fila({ id: 'd', notification_id: 'n-d', status: 'failed', attempts: 2 })],
            notifications: [{ id: 'n-d', user_id: 'u1', category: 'payment', title: 't', message: 'm', link: '/', data: {} }],
            profiles: [{ id: 'u1', preferences: {} }],
        };
        h.sendWebPushToUser.mockResolvedValue({ sent: 0, failed: 1, revoked: 0, lastError: 'boom' });

        await dispatchDelivery({ ...h.db.tablas.notification_deliveries[0] } as any);

        const d = h.db.tablas.notification_deliveries[0];
        expect(d.status).toBe('failed');
        expect(d.next_attempt_at).not.toBe('infinity');
        expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    });
});
