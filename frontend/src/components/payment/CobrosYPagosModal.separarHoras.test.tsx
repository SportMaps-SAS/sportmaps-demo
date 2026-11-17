import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { OpenCharge } from '@/lib/api/chargeBatches';

// «Separar las horas» de punta a punta en el modal: comprobante que no cubre el total con horas →
// bloqueo → separar → primera operación sin horas → segunda operación con las horas.

vi.mock('@/lib/cobrosYPagosFlag', () => ({ isCobrosYPagosEnabled: () => true }));
vi.mock('@/hooks/useSchoolContext', () => ({
    useSchoolContext: () => ({ schoolId: 'school-1', schoolName: 'Dreamers', currentUserRole: 'owner', teams: [] }),
}));
vi.mock('@/hooks/useEntitlements', () => ({ useEntitlements: () => ({ hasAddon: () => false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('./RegisterCashPaymentModal', () => ({ RegisterCashPaymentModal: () => null }));
vi.mock('@/components/billing/BillingDetailsForm', () => ({ BillingDetailsForm: () => <div /> }));

const ocr = vi.hoisted(() => ({ monto: 387_000 }));
// El uploader real trae Supabase y OCR: aquí solo importa el monto que «lee».
vi.mock('@/components/common/FileUpload', () => ({
    FileUpload: ({ onUploadComplete, onValidationResult }: any) => (
        <button
            type="button" data-testid="subir"
            onClick={() => { onValidationResult({ extractedAmount: ocr.monto, verdict: 'verde' }); onUploadComplete('uid/comprobante.png'); }}
        >
            subir
        </button>
    ),
}));

const ATHLETES = [{
    id: 'ath-1', athlete_type: 'child', full_name: 'Carolina Fonseca', parent_id: 'par-1', parent_name: 'Mamá',
    parent_email: null, parent_phone: '3105550101', team_id: null, team_name: null, plan_name: 'PGR6x2',
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
    due_date: '2026-11-01', amount: 387_000, list_amount: null, discount_amount: 0, late_fee_amount: 0,
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

type Cuerpo = { pending?: { pay_amount: number }[]; lines: { pay_amount?: number; extra_hours?: number }[] };

beforeEach(() => {
    ocr.monto = 387_000;
    Object.values(api).forEach((f) => f.mockReset());
    api.openCharges.mockResolvedValue({ charges: [MENSUALIDAD] });
    api.suggestions.mockResolvedValue({
        enrollments: [{
            enrollment_id: 'enr-1', offering_plan_id: 'plan-1', plan_name: 'PGR6x2', team_name: null, is_primary: true,
            monthly_amount: 387_000, active: true, hours_plan: true, hourly_rate: 32_250, included_minutes: 720,
        }],
        overages: [],
    });
    api.preview.mockImplementation(async (b: Cuerpo) => {
        const total = (b.pending ?? []).reduce((a, p) => a + p.pay_amount, 0) + b.lines.reduce((a, l) => a + (l.pay_amount ?? 0), 0);
        return { preview_hash: 'h1', rows_to_create: b.lines.length, total_amount: total, to_create: { n: b.lines.length, total }, to_pay: { n: 1, total } };
    });
    api.create.mockResolvedValue({ batch_id: 'b1', duplicated: false, rows_created: 0, total_amount: 0, payments_registered: 1, paid_total: 387_000 });
});

/** Mensualidad marcada + 2 horas por adelantado, por transferencia con el comprobante cargado. */
async function armarOperacion() {
    render(<CobrosYPagosModal open onOpenChange={vi.fn()} onSuccess={vi.fn()} initialAthleteId="ath-1" />);
    await screen.findByText('Mensualidad Noviembre 2026');
    fireEvent.click(await screen.findByTestId('cyp-add-horas'));
    fireEvent.click(await screen.findByText(/Por adelantado/));
    fireEvent.click(await screen.findByLabelText('Una hora más')); // 1 → 2 h = $64.500
    fireEvent.click(screen.getByRole('radio', { name: /Transferencia/ }));
    fireEvent.click(await screen.findByTestId('subir'));
}

describe('CobrosYPagosModal — separar las horas', () => {
    it('comprobante igual a lo principal: bloquea con el aviso y ofrece «Separar las horas»', async () => {
        await armarOperacion();
        const aviso = await screen.findByTestId('cyp-comprobante-horas');
        expect(aviso.textContent).toContain('387.000');
        expect(aviso.textContent).toContain('64.500');
        expect(screen.getByTestId('cyp-separar-horas')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeDisabled());
        expect(api.create).not.toHaveBeenCalled();
    });

    it('un comprobante que cubre el total NO bloquea: las horas van en la misma operación', async () => {
        ocr.monto = 451_500;
        await armarOperacion();
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled(), { timeout: 3000 });
        expect(screen.queryByTestId('cyp-comprobante-horas')).toBeNull();
        fireEvent.click(screen.getByTestId('cyp-primary'));
        await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
        expect(api.create.mock.calls[0][0].lines).toEqual([expect.objectContaining({ extra_hours: 2, pay_amount: 64_500 })]);
    });

    it('en efectivo no aplica el bloqueo', async () => {
        await armarOperacion();
        await screen.findByTestId('cyp-comprobante-horas');
        fireEvent.click(screen.getByRole('radio', { name: /Efectivo/ }));
        await waitFor(() => expect(screen.queryByTestId('cyp-comprobante-horas')).toBeNull());
    });

    it('separar: la primera operación va SIN horas y la segunda las registra con su propio pago', async () => {
        await armarOperacion();
        fireEvent.click(await screen.findByTestId('cyp-separar-horas'));

        // Sale el bloqueo; las horas quedan anotadas aparte.
        expect(screen.queryByTestId('cyp-comprobante-horas')).toBeNull();
        expect(screen.getByTestId('cyp-horas-aparte').textContent).toContain('2 h');
        expect(screen.getByTestId('cyp-horas-aparte').textContent).toContain('64.500');
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled(), { timeout: 3000 });

        fireEvent.click(screen.getByTestId('cyp-primary'));
        await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
        const primera = api.create.mock.calls[0][0];
        expect(primera.lines).toHaveLength(0);
        expect(primera.pending).toEqual([expect.objectContaining({ payment_id: 'p-nov', pay_amount: 387_000 })]);
        expect(primera.payment).toMatchObject({ method: 'transfer', receipt_url: 'uid/comprobante.png' });

        // Resultado: ofrece registrar las horas.
        expect(await screen.findByTestId('cyp-result-horas-pendientes')).toHaveTextContent('64.500');
        fireEvent.click(screen.getByTestId('cyp-result-registrar-horas'));

        // Segunda operación: solo las horas, pago nuevo (sin el comprobante de la primera), otro client_request_id.
        await waitFor(() => expect(screen.getByLabelText('Horas vendidas')).toHaveValue(2));
        expect(screen.queryByTestId('cyp-result')).toBeNull();
        expect(screen.queryByTestId('cyp-horas-aparte')).toBeNull();
        expect(screen.getByRole('radio', { name: /Efectivo/ })).toHaveAttribute('aria-checked', 'true');
        fireEvent.change(await screen.findByLabelText('¿Quién lo recibió?'), { target: { value: 'Alejandra L.' } });
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled(), { timeout: 3000 });
        fireEvent.click(screen.getByTestId('cyp-primary'));
        await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
        const segunda = api.create.mock.calls[1][0];
        expect(segunda.lines).toEqual([expect.objectContaining({ extra_hours: 2, enrollment_id: 'enr-1', pay_amount: 64_500 })]);
        expect(segunda.pending ?? []).toHaveLength(0);
        expect(segunda.payment).toMatchObject({ method: 'cash', received_by: 'Alejandra L.' });
        // La primera (con comprobante) no lleva received_by.
        expect(primera.payment.received_by).toBeUndefined();
        expect(segunda.payment.receipt_url).toBeUndefined();
        expect(segunda.client_request_id).not.toBe(primera.client_request_id);
    }, 20_000);

    it('«Volver a incluirlas aquí» devuelve la línea de horas y el bloqueo', async () => {
        await armarOperacion();
        fireEvent.click(await screen.findByTestId('cyp-separar-horas'));
        fireEvent.click(await screen.findByText('Volver a incluirlas aquí'));
        expect(await screen.findByTestId('cyp-comprobante-horas')).toBeInTheDocument();
        expect(screen.queryByTestId('cyp-horas-aparte')).toBeNull();
    });
});
