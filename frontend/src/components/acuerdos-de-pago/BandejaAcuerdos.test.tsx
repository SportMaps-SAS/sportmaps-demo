/**
 * Bandeja de acuerdos: apagada = nada; vacía = explicación; con datos = solicitudes
 * primero con insignia y calendario; aprobar manda la decisión. BFF moqueado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
vi.mock('@/integrations/supabase/client', () => ({
    supabase: { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [{ id: 'P1', full_name: 'Marta Pérez' }] }) }) }) },
}));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { BandejaAcuerdos } from './BandejaAcuerdos';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const AJ = { habilitado: true, max_cuotas: 3, max_dias: 60, auto_aprobar: true };

const acuerdo = (id: string, status: string, created_at: string, extra = {}) => ({
    id, school_id: ESCUELA, payer_profile_id: 'P1', requested_by: 'P1', status, source: 'whatsapp', installments: 2, total_amount: 150000,
    first_due_date: '2026-11-15', last_due_date: '2026-12-15', auto_approved: false, approved_at: null, resolution_note: null, created_at,
    items: [
        { seq: 2, due_date: '2026-12-15', amount: 75000, status: 'pendiente' },
        { seq: 1, due_date: '2026-11-15', amount: 75000, status: 'pagado' },
    ],
    ...extra,
});

function montar() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><BandejaAcuerdos schoolId={ESCUELA} /></QueryClientProvider>);
}
function rutas(ajustes: unknown, lista: unknown) {
    bff.get.mockImplementation((p: string) => (p.includes('/settings/') ? Promise.resolve(ajustes) : Promise.resolve(lista)));
}

beforeEach(() => vi.clearAllMocks());

describe('BandejaAcuerdos', () => {
    it('con la función apagada no pinta nada ni pide la lista', async () => {
        rutas({ ...AJ, habilitado: false }, { acuerdos: [], puede_resolver: true });
        const { container } = montar();
        await waitFor(() => expect(bff.get).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 20));
        expect(container.textContent).toBe('');
        expect(bff.get.mock.calls.some((c) => String(c[0]).includes('/school/'))).toBe(false);
    });

    it('prendida y sin acuerdos: el vacío explica qué va a aparecer', async () => {
        rutas(AJ, { acuerdos: [], puede_resolver: true });
        montar();
        expect(await screen.findByText(/Aún no hay acuerdos de pago/)).toBeTruthy();
    });

    it('error de la lista: aviso con reintentar', async () => {
        bff.get.mockImplementation((p: string) => (p.includes('/settings/') ? Promise.resolve(AJ) : Promise.reject(new Error('boom'))));
        montar();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    });

    it('solicitudes primero, insignia con la cuenta, calendario y canal', async () => {
        rutas(AJ, { puede_resolver: true, acuerdos: [acuerdo('A', 'activo', '2026-11-05T10:00:00Z'), acuerdo('B', 'solicitado', '2026-11-04T10:00:00Z')] });
        montar();
        const tarjetas = await screen.findAllByTestId('acuerdo');
        expect(tarjetas.map((t) => t.getAttribute('data-estado'))).toEqual(['solicitado', 'activo']);
        expect(screen.getByLabelText('1 por resolver')).toBeTruthy();
        const primera = tarjetas[0];
        expect(await within(primera).findByText('Marta Pérez')).toBeTruthy();
        expect(within(primera).getByText(/por WhatsApp/)).toBeTruthy();
        const cuotas = within(primera).getAllByRole('listitem').map((li) => li.textContent);
        expect(cuotas[0]).toContain('Cuota 1 · 15 nov 2026');
        expect(cuotas[1]).toContain('Cuota 2 · 15 dic 2026');
        // Lenguaje sin mora.
        expect(document.body.textContent?.toLowerCase()).not.toContain('mora');
    });

    it('filtra por estado', async () => {
        rutas(AJ, { puede_resolver: true, acuerdos: [acuerdo('A', 'activo', '2026-11-05T10:00:00Z'), acuerdo('B', 'solicitado', '2026-11-04T10:00:00Z')] });
        montar();
        await screen.findAllByTestId('acuerdo');
        await userEvent.click(screen.getByRole('button', { name: 'Activo' }));
        expect(screen.getAllByTestId('acuerdo')).toHaveLength(1);
        expect(screen.getByTestId('acuerdo').getAttribute('data-estado')).toBe('activo');
    });

    it('sin permiso de resolver no ofrece aprobar ni rechazar', async () => {
        rutas(AJ, { puede_resolver: false, acuerdos: [acuerdo('B', 'solicitado', '2026-11-04T10:00:00Z')] });
        montar();
        await screen.findByTestId('acuerdo');
        expect(screen.queryByRole('button', { name: /^Aprobar el acuerdo/ })).toBeNull();
        expect(screen.getByText(/Solo la administración/)).toBeTruthy();
    });

    it('aprobar con nota manda decision y nota a /resolve', async () => {
        rutas(AJ, { puede_resolver: true, acuerdos: [acuerdo('B', 'solicitado', '2026-11-04T10:00:00Z')] });
        bff.post.mockResolvedValue({ agreement_id: 'B', status: 'activo' });
        montar();
        await userEvent.click(await screen.findByRole('button', { name: /^Aprobar el acuerdo/ }));
        await userEvent.type(await screen.findByLabelText(/Nota para la familia/), 'Listo');
        await userEvent.click(screen.getByRole('button', { name: 'Aprobar acuerdo' }));
        await waitFor(() => expect(bff.post).toHaveBeenCalledWith('/api/v1/payment-agreements/B/resolve', { decision: 'aprobar', nota: 'Listo' }));
    });
});
