/**
 * Mis pagos (acudiente, V2): el atajo `?motivo=<clave>` abre «Pagar otro concepto»
 * con ese motivo preseleccionado. Un hijo → directo; varios → primero «¿Para quién
 * es el pago?»; una clave fuera del catálogo se ignora. Datos de ejemplo inventados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({ hijos: [] as Record<string, unknown>[] }));

vi.mock('@/contexts/AuthContext', () => ({
    useAuth: () => ({ user: { id: 'parent-1' }, profile: { role: 'parent' } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// El checkout real tiene su propia prueba (PaymentCheckoutModal.motivo.test): acá solo
// importa con qué lo abre la página.
vi.mock('@/components/payment/PaymentCheckoutModal', () => ({
    PaymentCheckoutModal: (p: { open: boolean; mode: string; initialConceptType?: string; childName?: string }) =>
        p.open ? <div data-testid="checkout">{`${p.mode}|${p.initialConceptType ?? 'sin motivo'}|${p.childName}`}</div> : null,
}));
vi.mock('@/components/parent/v2/AcuPagosV2', () => ({ AcuPagosV2: () => <div>Por pagar</div> }));
vi.mock('@/components/autopay/useMiDebito', () => ({ useMiDebito: () => ({ data: null, reload: vi.fn() }) }));
vi.mock('@/components/autopay/DebitoAutomaticoCard', () => ({ DebitoAutomaticoCard: () => null, DebitoSugerenciaBanner: () => null }));
vi.mock('@/components/billing/MiFacturaElectronicaCard', () => ({ MiFacturaElectronicaCard: () => null }));
vi.mock('@/components/payment/GlosaRespondModal', () => ({ GlosaRespondModal: () => null }));
vi.mock('@/lib/api/glosas', () => ({ listMine: vi.fn(async () => []), OPEN_GLOSA_STATUSES: [] }));
vi.mock('@/lib/cobrosAbiertos', () => ({ fetchAjustesDeCobros: vi.fn(async () => new Map()) }));
vi.mock('@/integrations/supabase/client', () => {
    const from = (tabla: string) => {
        const resultado = () => (tabla === 'children' ? { data: h.hijos, error: null } : { data: [], error: null, count: 0 });
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'or', 'is', 'order', 'limit', 'not', 'neq', 'gte', 'lte']) b[m] = () => b;
        b.maybeSingle = async () => ({ data: null, error: null });
        b.then = (res: any, rej: any) => Promise.resolve(resultado()).then(res, rej);
        return b;
    };
    return { supabase: { from, storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) } } };
});

import MyPaymentsPage from './MyPaymentsPage';

const hijo = (id: string, nombre: string) => ({
    id, full_name: nombre, monthly_fee: 150000, parent_id: 'parent-1', school_id: 'school-1', team_id: `t-${id}`,
    teams: { name: 'Sub-12', price_monthly: 150000 },
});

function Url() {
    const l = useLocation();
    return <div data-testid="url">{l.search}</div>;
}

function abrir(url: string) {
    render(
        <MemoryRouter initialEntries={[url]}>
            <Routes><Route path="/my-payments" element={<><MyPaymentsPage /><Url /></>} /></Routes>
        </MemoryRouter>,
    );
}

beforeEach(() => {
    h.hijos = [hijo('c1', 'Mariana Gómez')];
});

describe('Mis pagos: ?motivo=', () => {
    it('un hijo: abre el checkout en modo crear con el motivo y limpia el parámetro', async () => {
        abrir('/my-payments?motivo=torneo');
        expect(await screen.findByTestId('checkout')).toHaveTextContent('create|torneo|Mariana Gómez');
        await waitFor(() => expect(screen.getByTestId('url').textContent).toBe(''));
    });

    it('varios hijos: primero «¿Para quién es el pago?» y el elegido abre con el motivo', async () => {
        h.hijos = [hijo('c1', 'Mariana Gómez'), hijo('c2', 'Tomás Gómez')];
        abrir('/my-payments?motivo=vacacional');
        expect(await screen.findByText('¿Para quién es el pago?')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Tomás Gómez'));
        expect(await screen.findByTestId('checkout')).toHaveTextContent('create|vacacional|Tomás Gómez');
    });

    it('una clave que no está en el catálogo se ignora (no abre nada)', async () => {
        abrir('/my-payments?motivo=lo-que-sea');
        await waitFor(() => expect(screen.getByTestId('url').textContent).toBe(''));
        expect(screen.queryByTestId('checkout')).toBeNull();
        expect(screen.queryByText('¿Para quién es el pago?')).toBeNull();
    });
});
