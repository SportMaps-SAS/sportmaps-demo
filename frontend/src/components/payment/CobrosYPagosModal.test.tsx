import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { OpenCharge } from '@/lib/api/chargeBatches';

// ── Mocks ────────────────────────────────────────────────────────────────────

const flag = { on: true };
vi.mock('@/lib/cobrosYPagosFlag', () => ({ isCobrosYPagosEnabled: () => flag.on }));

const ctx = { role: 'owner' as string };
vi.mock('@/hooks/useSchoolContext', () => ({
    useSchoolContext: () => ({
        schoolId: 'school-1',
        schoolName: 'Club Campestre Demo',
        currentUserRole: ctx.role,
        teams: [{ id: 'team-1', name: 'Sub-12' }],
    }),
}));
vi.mock('@/hooks/useEntitlements', () => ({ useEntitlements: () => ({ hasAddon: () => false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('./RegisterCashPaymentModal', () => ({
    RegisterCashPaymentModal: ({ open }: { open: boolean }) => (open ? <div data-testid="legacy-modal">Registrar pago manual</div> : null),
}));
vi.mock('@/components/common/FileUpload', () => ({ FileUpload: () => <div /> }));
vi.mock('@/components/billing/BillingDetailsForm', () => ({ BillingDetailsForm: () => <div /> }));

const ATHLETES = [{
    id: 'ath-1', athlete_type: 'child', full_name: 'Sofía Ramírez', parent_id: 'par-1', parent_name: 'María R.',
    parent_email: null, parent_phone: '3105550101', team_id: 'team-1', team_name: 'Sub-12', plan_name: 'PGP8x3',
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

const SEP: OpenCharge = {
    id: 'p-sep', concept: 'Mensualidad Septiembre 2026', payment_category: 'mensualidad', status: 'overdue',
    due_date: '2026-09-05', amount: 759_150, list_amount: null, discount_amount: 0, late_fee_amount: 36_150,
    amount_paid: 0, early_payment_discount_applied: null, en_revision: false, pago_en_curso: false,
};
const REVIEW: OpenCharge = {
    ...SEP, id: 'p-ins', concept: 'Inscripción', payment_category: 'inscripcion', status: 'awaiting_approval',
    due_date: '2026-10-10', amount: 120_000, late_fee_amount: 0, en_revision: true,
};

const api = vi.hoisted(() => ({
    preview: vi.fn(),
    create: vi.fn(),
    openCharges: vi.fn(),
    suggestions: vi.fn(),
    targets: vi.fn(),
    searchAthletes: vi.fn(),
    get: vi.fn(),
    annul: vi.fn(),
}));
vi.mock('@/lib/api/chargeBatches', async (orig) => {
    const real = await orig<typeof import('@/lib/api/chargeBatches')>();
    return { ...real, chargeBatchesApi: api };
});

import { CobrosYPagosModal } from './CobrosYPagosModal';

/** Pago en efectivo = sin comprobante: el botón espera a que se diga quién recibió la plata. */
async function llenarRecibio(por = 'Alejandra L.') {
    fireEvent.change(await screen.findByLabelText('¿Quién lo recibió?'), { target: { value: por } });
}

function renderModal(props: Partial<React.ComponentProps<typeof CobrosYPagosModal>> = {}) {
    return render(
        <CobrosYPagosModal open onOpenChange={vi.fn()} onSuccess={vi.fn()} initialAthleteId="ath-1" {...props} />,
    );
}

beforeEach(() => {
    flag.on = true;
    ctx.role = 'owner';
    Object.values(api).forEach((f) => f.mockReset());
    api.openCharges.mockResolvedValue({ charges: [SEP, REVIEW] });
    api.suggestions.mockResolvedValue({ enrollments: [], suggested_monthly: { amount: 723_000, source: 'plan' }, next_period: { year: 2026, month: 11 } });
    api.preview.mockImplementation(async (body: { pending?: { pay_amount: number }[] }) => ({
        preview_hash: 'h1',
        rows_to_create: 0,
        total_amount: 0,
        to_create: { n: 0, total: 0 },
        to_pay: { n: (body.pending ?? []).filter((p) => p.pay_amount > 0).length, total: (body.pending ?? []).reduce((a, p) => a + p.pay_amount, 0) },
    }));
    api.create.mockResolvedValue({ batch_id: 'b1', duplicated: false, rows_created: 0, total_amount: 0, payments_registered: 1, paid_total: 759_150 });
});

describe('CobrosYPagosModal — interruptor y permisos', () => {
    it('con el interruptor apagado abre el «Registrar pago» de siempre', () => {
        flag.on = false;
        renderModal();
        expect(screen.getByTestId('legacy-modal')).toBeInTheDocument();
        expect(screen.queryByTestId('cobros-y-pagos-modal')).not.toBeInTheDocument();
    });

    it('apagado y en modo varios no muestra nada (el modal viejo no tiene modo varios)', () => {
        flag.on = false;
        const { container } = renderModal({ initialMode: 'multi', initialAthleteId: undefined });
        expect(container).toBeEmptyDOMElement();
    });

    it('el coach no ve el modal', () => {
        ctx.role = 'coach';
        renderModal();
        expect(screen.queryByTestId('cobros-y-pagos-modal')).not.toBeInTheDocument();
        expect(screen.queryByTestId('legacy-modal')).not.toBeInTheDocument();
    });

    it.each(['owner', 'admin', 'school_admin'])('%s sí lo ve', async (role) => {
        ctx.role = role;
        renderModal();
        expect(await screen.findByTestId('cobros-y-pagos-modal')).toBeInTheDocument();
    });
});

describe('CobrosYPagosModal — un atleta', () => {
    it('preelige el pendiente más antiguo, deshabilita el que está en revisión y registra el pago', async () => {
        renderModal();
        await llenarRecibio();
        await waitFor(() => expect(api.openCharges).toHaveBeenCalledWith({ type: 'child', id: 'ath-1' }));
        expect(await screen.findByText('Mensualidad Septiembre 2026')).toBeInTheDocument();

        const sepBox = screen.getByRole('checkbox', { name: 'Incluir Mensualidad Septiembre 2026' });
        expect(sepBox).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Incluir Inscripción' })).toBeDisabled();
        expect(screen.getByText(/comprobante en revisión: apruébalo/i)).toBeInTheDocument();

        const btn = screen.getByTestId('cyp-primary');
        await waitFor(() => expect(btn).toHaveTextContent('Registrar pago'));
        await waitFor(() => expect(btn).toBeEnabled(), { timeout: 3000 });

        fireEvent.click(btn);
        await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
        const body = api.create.mock.calls[0][0];
        expect(body).toMatchObject({
            mode: 'single',
            athletes: [{ type: 'child', id: 'ath-1' }],
            preview_hash: 'h1',
            pending: [{ payment_id: 'p-sep', pay_amount: 759_150, close_mode: 'abono', seen: { amount: 759_150, amount_paid: 0 } }],
            payment: { method: 'cash', received_by: 'Alejandra L.' },
        });
        expect(body.client_request_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(await screen.findByTestId('cyp-result')).toHaveTextContent('1 pago registrado');
    });

    it('en efectivo (sin comprobante) el botón espera a «¿Quién lo recibió?» y lo dice', async () => {
        renderModal();
        await screen.findByLabelText('¿Quién lo recibió?');
        await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1), { timeout: 3000 });
        // La vista previa se ve igual; lo que falta frena solo el botón.
        expect(screen.getByTestId('cyp-primary')).toBeDisabled();
        expect(screen.getByTestId('cyp-button-reason')).toHaveTextContent('Escribe quién recibió el pago');
        await llenarRecibio();
        // El cuerpo cambió (lleva received_by): se pide la vista previa de nuevo tras el debounce.
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled(), { timeout: 4000 });
    });

    it('condonar el recargo cambia el saldo y el monto a pagar', async () => {
        renderModal();
        const waive = await screen.findByRole('button', { name: /Condonar recargo/ });
        fireEvent.click(waive);
        await waitFor(() => expect(screen.getByLabelText('Pagar')).toHaveValue(723_000));
    });

    it('al quitar «Ya lo pagaron» y sin ajustes el botón queda deshabilitado con su motivo', async () => {
        renderModal();
        await screen.findByText('Mensualidad Septiembre 2026');
        fireEvent.click(screen.getByRole('switch', { name: 'Ya lo pagaron' }));
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeDisabled());
        expect(screen.getByTestId('cyp-button-reason')).toHaveTextContent(/Marca un cobro pendiente/);
    });

    it('si la vista previa quedó vieja (409 PREVIEW_STALE) recarga y no pierde lo escrito', async () => {
        const { ChargeBatchError } = await import('@/lib/api/chargeBatches');
        api.create.mockRejectedValueOnce(new ChargeBatchError('PREVIEW_STALE', 'Algo cambió mientras revisabas.', 409));
        renderModal();
        await llenarRecibio();
        const btn = screen.getByTestId('cyp-primary');
        await waitFor(() => expect(btn).toBeEnabled(), { timeout: 3000 });
        fireEvent.click(btn);
        expect(await screen.findByRole('alert')).toHaveTextContent('Algo cambió');
        await waitFor(() => expect(api.openCharges).toHaveBeenCalledTimes(2));
        expect(screen.getByRole('checkbox', { name: 'Incluir Mensualidad Septiembre 2026' })).toBeChecked();
    });
});

describe('CobrosYPagosModal — vista previa sin pedidos de más', () => {
    const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('un re-render con el mismo cuerpo, o editar y deshacer, no vuelven a pedir la vista previa', async () => {
        renderModal();
        await llenarRecibio();
        await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1), { timeout: 3000 });
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled());
        const pagar = screen.getByLabelText('Pagar');
        // Editar y deshacer antes de que venza el debounce: el cuerpo vuelve a ser el vigente.
        fireEvent.change(pagar, { target: { value: '500000' } });
        fireEvent.change(pagar, { target: { value: '759150' } });
        await espera(1900);
        expect(api.preview).toHaveBeenCalledTimes(1);
        // Un cambio real sí la pide (una sola vez).
        fireEvent.change(pagar, { target: { value: '500000' } });
        await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2), { timeout: 3000 });
        await espera(300);
        expect(api.preview).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('429: muestra «Espera un momento…» y reintenta UNA vez tras el Retry-After', async () => {
        const { ChargeBatchError } = await import('@/lib/api/chargeBatches');
        const ok = api.preview.getMockImplementation()!;
        api.preview
            .mockRejectedValueOnce(new ChargeBatchError('RATE_LIMIT', 'Demasiadas', 429, undefined, 1))
            .mockImplementation(ok);
        renderModal();
        await llenarRecibio();
        expect(await screen.findByText(/Espera un momento/, undefined, { timeout: 3000 })).toBeInTheDocument();
        await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2), { timeout: 3000 });
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled());
        expect(screen.queryByText(/Espera un momento/)).not.toBeInTheDocument();
    }, 10_000);

    it('si el reintento también da 429, no insiste: muestra el error', async () => {
        const { ChargeBatchError } = await import('@/lib/api/chargeBatches');
        api.preview.mockRejectedValue(new ChargeBatchError('RATE_LIMIT', 'Hiciste muchas solicitudes seguidas.', 429, undefined, 1));
        renderModal();
        await llenarRecibio();
        expect(await screen.findByText('Hiciste muchas solicitudes seguidas.', undefined, { timeout: 5000 })).toBeInTheDocument();
        expect(api.preview).toHaveBeenCalledTimes(2);
        await espera(1300);
        expect(api.preview).toHaveBeenCalledTimes(2);
    }, 10_000);
});

describe('CobrosYPagosModal — varios atletas', () => {
    it('solo genera: sin pendientes ni «Ya lo pagaron», y espera la vista previa', async () => {
        api.targets.mockResolvedValue({ athletes: [{ type: 'child', id: 'a1', name: 'Juan', payer_linked: true }, { type: 'child', id: 'a2', name: 'Ana', payer_linked: false }] });
        api.preview.mockResolvedValue({ preview_hash: 'h2', rows_to_create: 2, total_amount: 160_000, warnings_count: { sin_acudiente: 1 } });
        renderModal({ initialMode: 'multi', initialTeamId: 'team-1', initialAthleteId: undefined, lockAthlete: false });
        await waitFor(() => expect(api.targets).toHaveBeenCalledWith({ kind: 'team', id: 'team-1', include_paused: false }));
        expect(screen.queryByTestId('cyp-payment-block')).not.toBeInTheDocument();
        expect(screen.queryByTestId('cyp-pending')).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Valor'), { target: { value: '80000' } });
        const btn = screen.getByTestId('cyp-primary');
        await waitFor(() => expect(btn).toHaveTextContent('Generar 2'), { timeout: 3000 });
        // La vista previa sale 1,5 s después de la última edición (PREVIEW_DEBOUNCE_MS).
        await waitFor(() => expect(btn).toBeEnabled(), { timeout: 3000 });
        const body = api.preview.mock.calls.at(-1)![0];
        expect(body).toMatchObject({ mode: 'multi', target: { kind: 'team', ids: ['team-1'] }, lines: [{ category: 'torneo', amount: 80_000 }] });
        expect(body).not.toHaveProperty('payment');
    });
});
