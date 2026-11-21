import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Caso Dreamers 2026-11-20: cobrar en efectivo un artículo del catálogo desde «Cobros y pagos».

vi.mock('@/lib/cobrosYPagosFlag', () => ({ isCobrosYPagosEnabled: () => true }));
vi.mock('@/hooks/useSchoolContext', () => ({
    useSchoolContext: () => ({ schoolId: 'school-1', schoolName: 'Dreamers Gymnastics', currentUserRole: 'owner', teams: [] }),
}));
vi.mock('@/hooks/useEntitlements', () => ({ useEntitlements: () => ({ hasAddon: () => false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('./RegisterCashPaymentModal', () => ({ RegisterCashPaymentModal: () => null }));
vi.mock('@/components/common/FileUpload', () => ({ FileUpload: () => <div /> }));
vi.mock('@/components/billing/BillingDetailsForm', () => ({ BillingDetailsForm: () => <div /> }));
// El Select de Radix no abre en jsdom: aquí es un <select> nativo con las mismas opciones.
vi.mock('@/components/ui/select', async (orig) => {
    const real = await orig<typeof import('@/components/ui/select')>();
    return {
        ...real,
        Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children?: React.ReactNode }) => (
            <select value={value ?? ''} onChange={(e) => onValueChange?.(e.target.value)}>{children}</select>
        ),
        SelectTrigger: () => null,
        SelectValue: () => null,
        SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
        SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
    };
});

const ATHLETES = [{
    id: 'ath-1', athlete_type: 'child', full_name: 'Sofía Ramírez', parent_id: 'par-1', parent_name: 'María R.',
    parent_email: null, parent_phone: '3105550101', team_id: null, team_name: null, plan_name: 'PGP4x1',
    offering_plan_id: 'plan-1', enrollment_status: 'active', is_active: true,
}];
const CATALOGO = [
    { id: 'a1', name: 'Guante Protector para piso y salto', price: '97700.00', size_options: null },
    { id: 'a2', name: 'Bloque Magnesio 20hz', price: '20000.00', size_options: null },
];

vi.mock('@/integrations/supabase/client', () => {
    const chain = (data: unknown) => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'in', 'maybeSingle']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
        return q;
    };
    // Las constantes se leen al consultar, no al armar el mock (vi.mock sube al tope del archivo).
    const datos = (t: string): unknown => (
        t === 'school_athletes' ? ATHLETES
            : t === 'school_settings' ? { merchandise_enabled: true }
                : t === 'school_merchandise_items' ? CATALOGO : []);
    return { supabase: { from: (t: string) => chain(datos(t)) } };
});

const api = vi.hoisted(() => ({
    preview: vi.fn(), create: vi.fn(), openCharges: vi.fn(), suggestions: vi.fn(),
    targets: vi.fn(), searchAthletes: vi.fn(), get: vi.fn(), annul: vi.fn(),
}));
vi.mock('@/lib/api/chargeBatches', async (orig) => {
    const real = await orig<typeof import('@/lib/api/chargeBatches')>();
    return { ...real, chargeBatchesApi: api };
});

import { CobrosYPagosModal } from './CobrosYPagosModal';

type Linea = { category: string; concept: string; amount: number; pay?: boolean };

beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    api.openCharges.mockResolvedValue({ charges: [] });
    api.suggestions.mockResolvedValue({ enrollments: [], overages: [] });
    api.preview.mockImplementation(async (body: { lines?: Linea[] }) => {
        const lineas = body.lines ?? [];
        const total = lineas.reduce((a, l) => a + l.amount, 0);
        return {
            preview_hash: 'h1', rows_to_create: lineas.length, total_amount: total,
            to_create: { n: lineas.length, total }, to_pay: { n: lineas.length, total },
        };
    });
    api.create.mockResolvedValue({ batch_id: 'b1', duplicated: false, rows_created: 1, total_amount: 97_700, payments_registered: 1, paid_total: 97_700 });
});

async function elegirGuante() {
    render(<CobrosYPagosModal open onOpenChange={vi.fn()} onSuccess={vi.fn()} initialAthleteId="ath-1" />);
    fireEvent.click(await screen.findByTestId('cyp-add-line'));
    // El tipo de cobro es un Select de Radix: se cambia por su <select> nativo oculto.
    const nativo = document.querySelector('[data-testid="cyp-line-0"] select') as HTMLSelectElement;
    fireEvent.change(nativo, { target: { value: 'articulos' } });
    fireEvent.click(await screen.findByRole('button', { name: /Guante Protector para piso y salto · / }));
}

describe('CobrosYPagosModal — artículo del catálogo pagado en efectivo', () => {
    it('con el ítem elegido y «¿Quién lo recibió?» lleno, el botón se habilita y genera el cobro', async () => {
        await elegirGuante();
        const btn = screen.getByTestId('cyp-primary');
        await waitFor(() => expect(btn).toHaveTextContent('Generar 1 · Pagar 1'), { timeout: 4000 });
        expect(btn).toBeDisabled();
        expect(screen.getByTestId('cyp-button-reason')).toHaveTextContent('Falta: Escribe quién recibió el pago');

        fireEvent.change(screen.getByLabelText('¿Quién lo recibió?'), { target: { value: 'Brayan' } });
        await waitFor(() => expect(btn).toBeEnabled(), { timeout: 4000 });
        expect(screen.queryByTestId('cyp-button-reason')).toBeNull();

        fireEvent.click(btn);
        await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
        expect(api.create.mock.calls[0][0]).toMatchObject({
            mode: 'single',
            lines: [{ category: 'articulos', concept: 'Guante Protector para piso y salto', amount: 97_700 }],
            payment: { method: 'cash', received_by: 'Brayan' },
        });
    }, 15_000);

    it('escribir el nombre ANTES de elegir el ítem tampoco lo pierde', async () => {
        render(<CobrosYPagosModal open onOpenChange={vi.fn()} onSuccess={vi.fn()} initialAthleteId="ath-1" />);
        fireEvent.change(await screen.findByLabelText('¿Quién lo recibió?'), { target: { value: 'Brayan' } });
        fireEvent.click(screen.getByTestId('cyp-add-line'));
        const nativo = document.querySelector('[data-testid="cyp-line-0"] select') as HTMLSelectElement;
        fireEvent.change(nativo, { target: { value: 'articulos' } });
        fireEvent.click(await screen.findByRole('button', { name: /Guante Protector para piso y salto · / }));
        expect((screen.getByLabelText('¿Quién lo recibió?') as HTMLInputElement).value).toBe('Brayan');
        await waitFor(() => expect(screen.getByTestId('cyp-primary')).toBeEnabled(), { timeout: 5000 });
    }, 15_000);
});
