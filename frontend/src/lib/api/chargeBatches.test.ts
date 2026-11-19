import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

import { BFFError } from './bffClient';
import {
    CHARGE_BATCH_ERROR_MESSAGE,
    normalizeBatchDetail,
    normalizeOpenCharges,
    normalizePreview,
    normalizeSearch,
    normalizeSuggestions,
    normalizeTargets,
    toChargeBatchError,
} from './chargeBatches';

describe('toChargeBatchError', () => {
    it('usa el código del cuerpo y el mensaje del servidor', () => {
        const e = toChargeBatchError(new BFFError(409, 'Tiene comprobante en revisión', { code: 'EN_REVISION', error: 'Tiene comprobante en revisión' }));
        expect(e.code).toBe('EN_REVISION');
        expect(e.message).toBe('Tiene comprobante en revisión');
        expect(e.needsReload).toBe(true);
    });
    it('sin código: 429 → RATE_LIMIT, 403 → FORBIDDEN, 422 → VALIDATION', () => {
        expect(toChargeBatchError(new BFFError(429, 'Error 429')).code).toBe('RATE_LIMIT');
        expect(toChargeBatchError(new BFFError(403, 'Error 403')).message).toBe(CHARGE_BATCH_ERROR_MESSAGE.FORBIDDEN);
        expect(toChargeBatchError(new BFFError(422, 'Error 422')).code).toBe('VALIDATION');
    });
    it('códigos del BFF de F2', () => {
        expect(toChargeBatchError(new BFFError(422, 'x', { code: 'VALIDACION' })).code).toBe('VALIDATION');
        expect(toChargeBatchError(new BFFError(403, 'x', { code: 'SIN_PERMISO' })).code).toBe('FORBIDDEN');
        expect(toChargeBatchError(new BFFError(429, 'x', { code: 'RATE_LIMITED' })).code).toBe('RATE_LIMIT');
        expect(toChargeBatchError(new BFFError(503, 'x', { code: 'COBROS_NO_DISPONIBLE' })).code).toBe('NO_DISPONIBLE');
        expect(toChargeBatchError(new BFFError(404, 'x', { code: 'ATLETA_AJENO' })).code).toBe('NOT_FOUND');
        expect(toChargeBatchError(new BFFError(409, 'x', { code: 'YA_REVERTIDO' })).code).toBe('YA_REVERTIDO');
    });
    it('404 sin código = la ruta no existe todavía (BFF sin F2)', () => {
        expect(toChargeBatchError(new BFFError(404, 'Error 404')).code).toBe('NO_DISPONIBLE');
    });
    it('sin red → NO_DISPONIBLE', () => {
        expect(toChargeBatchError(new TypeError('Failed to fetch')).code).toBe('NO_DISPONIBLE');
    });
    it('SOBREPAGO y DESCUENTO_EXCEDE no piden recargar', () => {
        expect(toChargeBatchError(new BFFError(422, 'x', { code: 'SOBREPAGO' })).needsReload).toBe(false);
        expect(toChargeBatchError(new BFFError(422, 'x', { code: 'DESCUENTO_EXCEDE' })).needsReload).toBe(false);
    });
});

describe('normalización de las respuestas reales del BFF (F2)', () => {
    it('open-charges: items/saldo/discount_tags/suggested_discount', () => {
        const r = normalizeOpenCharges({
            items: [{
                id: 'p1', concept: 'Mensualidad Octubre 2026', payment_category: 'mensualidad', status: 'pending',
                amount: 723000, list_amount: 803333, discount_amount: 80333, late_fee_amount: 0, amount_paid: 0,
                early_payment_discount_applied: 0, saldo: 723000, en_revision: false, pago_en_curso: true, pago_en_curso_monto: 723000,
                discount_tags: ['Hermanos −10 %'], warnings: [], suggested_discount: { basis: 'porcentaje', value: 10, reason_code: 'pronto_pago' },
            }],
            suggestions: { varios_meses: { min_mensualidades: 3, disponible: false } },
        });
        expect(r.charges[0]).toMatchObject({
            balance: 723000, pago_en_curso: true, pago_en_curso_amount: 723000,
            adjustments: [{ label: 'Hermanos −10 %' }], suggestions: { pronto_pago: { pct: 10 } },
        });
        expect(r.suggestions?.varios_meses?.min_months).toBe(3);
    });
    it('charge-suggestions: plan/team anidados, next_free_period, overage_charges', () => {
        const r = normalizeSuggestions({
            enrollments: [{ enrollment_id: 'e1', status: 'active', is_primary: true, plan: { id: 'pl', name: 'PGP8x3' }, team: { id: 't', name: 'Sub-12' }, suggested_monthly_amount: 723000, amount_source: 'plan' }],
            next_free_period: { year: 2026, month: 11 },
            overage_charges: [{ id: 'o1', amount: 52000, billable_hours: 2 }],
        });
        expect(r.enrollments[0]).toMatchObject({ plan_name: 'PGP8x3', team_name: 'Sub-12', monthly_amount: 723000 });
        expect(r.suggested_monthly).toEqual({ amount: 723000, source: 'plan' });
        expect(r.next_period).toEqual({ year: 2026, month: 11 });
        expect(r.overages?.[0]).toMatchObject({ id: 'o1', amount: 52000 });
    });
    it('targets: has_guardian → payer_linked', () => {
        expect(normalizeTargets({ athletes: [{ type: 'child', id: 'a', name: 'Ana', has_guardian: false, paused: false }] }).athletes[0].payer_linked).toBe(false);
    });
    it('athlete-search: items con table/es_duplicado', () => {
        const r = normalizeSearch({ items: [{ table: 'children', athlete_type: 'child', id: 'c', full_name: 'Samuel', matched_by: ['nombre', 'telefono'], es_duplicado: true }] });
        expect(r.matches[0]).toMatchObject({ table_name: 'children', id: 'c', matched_by: ['nombre', 'telefono'] });
    });
    it('detalle: batch + payments + annul_preview', () => {
        const d = normalizeBatchDetail({
            batch: { id: 'b', mode: 'multi', target: { kind: 'team', ids: ['t'] }, status: 'created', rows_created: 2, total_amount: 160000, created_at: '2026-10-10T10:00:00Z' },
            payments: [{ id: 'p', concept: 'Torneo', amount: 80000, status: 'pending' }],
            annul_preview: { annullable_count: 1, annullable_total: 80000, kept_count: 1 },
        });
        expect(d.rows[0]).toMatchObject({ payment_id: 'p', concept: 'Torneo' });
        expect(d.annul_preview?.annullable_count).toBe(1);
        expect(d.target_label).toBe('Un equipo');
    });
    it('vista previa: items + pending → lines; exonerated objeto; errores con mensaje', () => {
        const p = normalizePreview({
            preview_hash: 'h', rows_to_create: 1, total_amount: 80000,
            to_create: { n: 1, total: 80000 }, to_pay: { n: 1, total: 80000 },
            exonerated: { n: 0, total: 0 },
            items: [{ ref: 'new:0', amount: 72300, list: 80333, adjustments: [{ kind: 'descuento', origin: 'hermanos', pct: 10, amount: 8033 }], status: 'pending', pay_amount: 0 }],
            pending: [{ ref: 'pending:x', amount: 723000, status: 'paid', pay_amount: 723000 }],
            skipped: [{ athlete: 'child:a', athlete_name: 'Ana', line_idx: 0, reason: 'seguro_en_12_meses' }],
            errors: [{ ref: 'new:0', code: 'SOBREPAGO', max: 72300 }],
        });
        expect(p.exonerated).toBe(0);
        expect(p.lines?.map((l) => l.ref)).toEqual(['new:0', 'pending:x']);
        expect(p.lines?.[0].adjustments?.[0]).toMatchObject({ origin: 'hermanos', amount: 8033 });
        expect(p.skipped?.[0]).toMatchObject({ athlete: { id: 'child:a', name: 'Ana' }, overridable: true });
        expect(p.errors?.[0].message).toMatch(/saldo/);
    });
    it('vista previa: saldo_a_favor (informativo) se normaliza y descarta lo vacío', () => {
        const p = normalizePreview({
            preview_hash: 'h', rows_to_create: 1, total_amount: 50000,
            saldo_a_favor: [{ dueno: 'c:abc', disponible: '30000' }, { dueno: 'c:def', disponible: 0 }, { dueno: '', disponible: 5 }],
        });
        expect(p.saldo_a_favor).toEqual([{ dueno: 'c:abc', disponible: 30000 }]);
        expect(normalizePreview({ preview_hash: 'h', rows_to_create: 0, total_amount: 0 }).saldo_a_favor).toBeUndefined();
    });
});
