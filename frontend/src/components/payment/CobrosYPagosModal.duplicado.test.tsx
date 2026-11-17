import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { OpenCharge } from '@/lib/api/chargeBatches';

// «Este mismo cobro ya se registró hace X min»: el 409 COBRO_DUPLICADO_RECIENTE es una PREGUNTA, no un error.
// Nada se crea hasta que el usuario confirma, y la confirmación reintenta con el MISMO client_request_id.

vi.mock('@/lib/cobrosYPagosFlag', () => ({ isCobrosYPagosEnabled: () => true }));
vi.mock('@/hooks/useSchoolContext', () => ({
    useSchoolContext: () => ({ schoolId: 'school-1', schoolName: 'Dreamers', currentUserRole: 'owner', teams: [] }),
}));
vi.mock('@/hooks/useEntitlements', () => ({ useEntitlements: () => ({ hasAddon: () => false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('./RegisterCashPaymentModal', () => ({ RegisterCashPaymentModal: () => null }));
vi.mock('@/components/billing/BillingDetailsForm', () => ({ BillingDetailsForm: () => <div /> }));
vi.mock('@/components/common/FileUpload', () => ({ FileUpload: () => null }));

const ATHLETES = [{
    id: 'ath-1', athlete_type: 'child', full_name: 'Zoe Barrera', parent_id: 'par-1', parent_name: 'Mamá',
    parent_email: null, parent_phone: '3105550101', team_id: null, team_name: null, plan_name: 'PGP8x1',
    offering_plan_id: 'plan-1', enrollment_status: 'active', is_active: true,
}];
vi.mock('@/integrations/supabase/client', () => {
    const chain = (data: unknown) => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'in', 'maybeSingle']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
        return q;
    };
    return { supabase: { from: (t: string) => chain(t === 'school_athletes' ? ATHLETES : []) } };
});

const MENSUALIDAD: OpenCharge = {
    id: 'p-nov', concept: 'Mensualidad Noviembre 2026', payment_category: 'mensualidad', status: 'pending',
    due_date: '2026-11-01', amount: 245_000, list_amount: null, discount_amount: 0, late_fee_amount: 0,
    amount_paid: 0, early_payment_discount_applied: null, en_revision: false, pago_en_curso: false,
};

const api = vi.hoisted(() => ({
    preview: vi.fn(), create: vi.fn(), openCharges: vi.fn(), suggestions: vi.fn(),
    targets: vi.fn(), searchAthletes: vi.fn(), get: vi.fn(), annul: vi.fn(), retryHourBankGrant: vi.fn(),
}));
vi.mock('@/lib/api/chargeBatches', async (orig) => {
    const real = await orig<typeof import('@/lib/api/chargeBatches')>();
    return { ...real, chargeBatchesApi: api };
});

import { CobrosYPagosModal } from './CobrosYPagosModal';
import { ChargeBatchError } from '@/lib/api/chargeBatches';

const DUPLICADO = { batch_id: 'b-ajeno', created_at: '2026-10-21T22:00:00Z', minutes_ago: 3, created_by_name: 'Edna', total_amount: 245_000 };
const error409 = () => new ChargeBatchError(
    'COBRO_DUPLICADO_RECIENTE', 'Este mismo cobro ya se registró hace 3 min por Edna.', 409, { code: 'COBRO_DUPLICADO_RECIENTE', duplicates: [DUPLICADO] },
);

type Cuerpo = { pending?: { pay_amount: number }[]; lines: { pay_amount?: number }[] };

beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    api.openCharges.mockResolvedValue({ charges: [MENSUALIDAD] });
    api.suggestions.mockResolvedValue({
        enrollments: [{
            enrollment_id: 'enr-1', offering_plan_id: 'plan-1', plan_name: 'PGP8x1', team_name: null, is_primary: true,
            monthly_amount: 245_000, active: true, hours_plan: true, hourly_rate: 30_625, included_minutes: 480,
        }],
        overages: [],
    });
    api.preview.mockImplementation(async (b: Cuerpo) => {
        const total = (b.pending ?? []).reduce((a, p) => a + p.pay_amount, 0) + b.lines.reduce((a, l) => a + (l.pay_amount ?? 0), 0);
        return { preview_hash: 'h1', rows_to_create: b.lines.length, total_amount: total, to_create: { n: b.lines.length, total }, to_pay: { n: 1, total } };
    });
    api.create.mockResolvedValue({ batch_id: 'b1', duplicated: false, rows_created: 0, total_amount: 0, payments_registered: 1, paid_total: 245_000 });
});

/** Una hora por adelantado pagada en efectivo (el pago viene activo por defecto): lo mínimo para tener el botón listo. */
async function armarOperacion() {
    render(<CobrosYPagosModal open onOpenChange={vi.fn()} onSuccess={vi.fn()} initialAthleteId="ath-1" />);
    await screen.findByText('Mensualidad Noviembre 2026');
    fireEvent.click(await screen.findByTestId('cyp-add-horas'));
    fireEvent.click(await screen.findByText(/Por adelantado/));
    fireEvent.change(await screen.findByLabelText('¿Quién lo recibió?'), { target: { value: 'Alejandra L.' } });
    await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled(), { timeout: 3000 });
}

describe('CobrosYPagosModal — mismo cobro desde otra pantalla', () => {
    it('el 409 no es un error: pregunta con quién y cuándo, y no vuelve a llamar solo', async () => {
        api.create.mockRejectedValueOnce(error409());
        await armarOperacion();
        fireEvent.click(screen.getByTestId('cyp-primary'));

        const caja = await screen.findByTestId('cyp-duplicado-reciente');
        expect(caja.textContent).toContain('hace 3 min por Edna');
        expect(caja.textContent).toContain('No se creó nada todavía');
        expect(screen.getByTestId('cyp-primary')).toBeDisabled();
        expect(api.create).toHaveBeenCalledTimes(1);
    });

    it('«Sí, crear igual» reintenta con confirmar_duplicado y el MISMO client_request_id', async () => {
        api.create.mockRejectedValueOnce(error409());
        await armarOperacion();
        fireEvent.click(screen.getByTestId('cyp-primary'));
        fireEvent.click(await screen.findByTestId('cyp-duplicado-confirmar'));

        await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
        const [primera, segunda] = api.create.mock.calls.map((c) => c[0]);
        expect(primera.confirmar_duplicado).toBeUndefined();
        expect(segunda.confirmar_duplicado).toBe(true);
        expect(segunda.client_request_id).toBe(primera.client_request_id);
        expect(await screen.findByTestId('cyp-result')).toBeInTheDocument();
        expect(screen.queryByTestId('cyp-duplicado-reciente')).toBeNull();
    });

    it('«No, revisar» cierra la pregunta y no crea nada', async () => {
        api.create.mockRejectedValueOnce(error409());
        await armarOperacion();
        fireEvent.click(screen.getByTestId('cyp-primary'));
        fireEvent.click(await screen.findByTestId('cyp-duplicado-cancelar'));

        expect(screen.queryByTestId('cyp-duplicado-reciente')).toBeNull();
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled());
        expect(api.create).toHaveBeenCalledTimes(1);
    });

    it('un doble clic rápido manda UN solo envío', async () => {
        let soltar: (v: unknown) => void = () => undefined;
        api.create.mockReturnValueOnce(new Promise((r) => { soltar = r; }));
        await armarOperacion();
        const boton = screen.getByTestId('cyp-primary');
        fireEvent.click(boton);
        fireEvent.click(boton);
        expect(api.create).toHaveBeenCalledTimes(1);
        soltar({ batch_id: 'b1', duplicated: false, rows_created: 0, total_amount: 0, payments_registered: 1, paid_total: 245_000 });
        await screen.findByTestId('cyp-result');
        expect(api.create).toHaveBeenCalledTimes(1);
    });

    it('el aviso del preview (recent_duplicates) se ve antes de confirmar y no bloquea', async () => {
        api.preview.mockResolvedValue({
            preview_hash: 'h1', rows_to_create: 0, total_amount: 245_000, to_create: { n: 0, total: 0 }, to_pay: { n: 1, total: 245_000 },
            recent_duplicates: [DUPLICADO],
        });
        await armarOperacion();
        const aviso = await screen.findByTestId('cyp-aviso-duplicado');
        expect(aviso.textContent).toContain('hace 3 min por Edna');
        expect(screen.getByTestId('cyp-primary')).toBeEnabled();
    });
});
