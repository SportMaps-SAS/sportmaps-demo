import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ mode: 'ok' as 'ok' | 'error' | 'throw', inserted: [] as any[] }));
vi.mock('../config/supabase', () => ({
    supabase: {
        from: () => ({
            insert: async (row: any) => {
                st.inserted.push(row);
                if (st.mode === 'throw') throw new Error('red caída');
                return st.mode === 'error' ? { data: null, error: { code: '42P01', message: 'relation "security_audit_log" does not exist' } } : { data: null, error: null };
            },
        }),
    },
}));

import { writeAudit, normalizeIp, normalizeAction, boundJson, getAuditFailureStats, resetAuditFailureStats } from './auditWrite';

const log = { error: vi.fn() };
beforeEach(() => { st.mode = 'ok'; st.inserted.length = 0; log.error.mockClear(); resetAuditFailureStats(); });

describe('writeAudit nunca falla en silencio ni lanza', () => {
    it('insert OK -> true y sin logs de error', async () => {
        expect(await writeAudit({ userId: 'u', schoolId: 's', log }, 'facility_reservation_approve', 't', 'id')).toBe(true);
        expect(log.error).not.toHaveBeenCalled();
    });
    it('el insert devuelve {error} (supabase-js no lanza): log ERROR con acción, escuela y código; AUDIT_WRITE_FAILED si es crítica', async () => {
        st.mode = 'error';
        const ok = await writeAudit({ userId: 'u', schoolId: 'esc-1', log }, 'facility_reservation_delete', 'facility_reservations', 'r1');
        expect(ok).toBe(false);
        expect(log.error).toHaveBeenCalledTimes(1);
        const [payload, msg] = log.error.mock.calls[0];
        expect(msg).toContain('AUDIT_WRITE_FAILED');
        expect(payload).toMatchObject({ action: 'facility_reservation_delete', schoolId: 'esc-1', errCode: '42P01', critical: true, audit_failures_critical: 1 });
        expect(getAuditFailureStats()).toMatchObject({ failures: 1, criticalFailures: 1 });
    });
    it('acción no crítica: también log a nivel error pero sin prefijo AUDIT_WRITE_FAILED', async () => {
        st.mode = 'error';
        await writeAudit({ log }, 'otra_accion', 't', 'id');
        expect(log.error.mock.calls[0][1]).not.toContain('AUDIT_WRITE_FAILED');
        expect(getAuditFailureStats()).toMatchObject({ failures: 1, criticalFailures: 0 });
    });
    it('el insert lanza: no propaga', async () => {
        st.mode = 'throw';
        await expect(writeAudit({ log }, 'reservation_payment_confirmed', 't', 'id')).resolves.toBe(false);
        expect(log.error.mock.calls[0][0].errCode).toBe('THROWN');
    });
    it('sin logger usa console.error con el prefijo', async () => {
        st.mode = 'error';
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await writeAudit({}, 'facility_blackout_create', 't', 'id');
        expect(String(spy.mock.calls[0][0])).toContain('AUDIT_WRITE_FAILED');
        spy.mockRestore();
    });
});

describe('normalización previa al insert', () => {
    it('ip: UNA sola IP válida (primer elemento de x-forwarded-for), nunca una lista', () => {
        expect(normalizeIp('203.0.113.5, 10.0.0.1, 10.0.0.2')).toBe('203.0.113.5');
        expect(normalizeIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
        expect(normalizeIp('203.0.113.5:4433')).toBe('203.0.113.5');
        expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
        expect(normalizeIp(['1.2.3.4', '5.6.7.8'])).toBe('1.2.3.4');
        expect(normalizeIp('999.1.1.1')).toBeNull();
        expect(normalizeIp('no-es-ip; drop table')).toBeNull();
        expect(normalizeIp(undefined)).toBeNull();
    });
    it('action cumple [a-z0-9_:.-]{1,120}', () => {
        expect(normalizeAction('Facility Reservation/Delete!')).toBe('facility_reservation_delete_');
        expect(normalizeAction('x'.repeat(300))).toHaveLength(120);
        expect(normalizeAction('')).toBe('unknown');
    });
    it('metadata > ~8 KB se reduce a un resumen; user_agent a 300', async () => {
        expect(boundJson({ a: 'x'.repeat(9000), b: 1 })).toMatchObject({ truncated: true, keys: ['a', 'b'] });
        expect(boundJson({ a: 1 })).toEqual({ a: 1 });
        await writeAudit({ userAgent: 'u'.repeat(900), ip: '1.1.1.1, 2.2.2.2' }, 'a', 't', 'id', null, { big: 'x'.repeat(20000) }, { metadata: { m: 'y'.repeat(20000) } });
        const row = st.inserted[0];
        expect(row.user_agent).toHaveLength(300);
        expect(row.ip_address).toBe('1.1.1.1');
        expect(row.new_value.truncated).toBe(true);
        expect(row.metadata.truncated).toBe(true);
    });
});
