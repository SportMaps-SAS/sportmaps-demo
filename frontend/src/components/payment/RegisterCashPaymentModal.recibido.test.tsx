import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const st = vi.hoisted(() => ({
  toast: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
}));

const ATLETA = { id: 'a1', full_name: 'Sofía Pérez', athlete_type: 'child', parent_id: 'par-1', parent_name: 'Ana', parent_email: null, is_active: true };
const PENDIENTE = {
  id: 'p1', concept: 'Mensualidad Noviembre', amount: 100000, amount_paid: 0, late_fee_amount: 0,
  early_payment_discount_applied: 0, due_date: '2026-11-05', status: 'pending', notes: 'Hermano de Sofía',
  payment_category: 'mensualidad', payment_type: 'recurring', requires_review: false,
};

vi.mock('@/integrations/supabase/client', () => {
  function from(tabla: string) {
    let esUpdate = false;
    const api: any = {
      select: () => api,
      eq: () => api,
      in: () => api,
      order: () => api,
      update: (c: Record<string, unknown>) => { esUpdate = true; st.updates.push(c); return api; },
      maybeSingle: () => Promise.resolve({ data: { ...PENDIENTE }, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (ok: any, ko: any) => {
        let data: unknown[] = [];
        if (tabla === 'school_athletes') data = [ATLETA];
        else if (tabla === 'payments' && esUpdate) data = [{ id: 'p1' }];
        else if (tabla === 'payments') data = [PENDIENTE];
        return Promise.resolve({ data, error: null }).then(ok, ko);
      },
    };
    return api;
  }
  return { supabase: { from, rpc: () => Promise.resolve({ data: null, error: null }) } };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'admin-1' } }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ schoolId: 'esc-1', schoolName: 'Escuela' }) }));
vi.mock('@/hooks/useEntitlements', () => ({ useEntitlements: () => ({ hasAddon: () => false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: st.toast }) }));
vi.mock('@/lib/email-client', () => ({ emailClient: { send: () => Promise.resolve() } }));
vi.mock('@/components/common/FileUpload', () => ({ FileUpload: () => <div data-testid="file-upload" /> }));

const { RegisterCashPaymentModal } = await import('./RegisterCashPaymentModal');

const abrir = () =>
  render(<RegisterCashPaymentModal open onOpenChange={vi.fn()} onSuccess={vi.fn()} initialAthleteId="a1" />);

beforeEach(() => { st.toast.mockReset(); st.updates = []; });

describe('RegisterCashPaymentModal — pago manual sin comprobante', () => {
  it('en efectivo pide quién lo recibió y no registra mientras falte', async () => {
    abrir();
    expect(await screen.findByLabelText('¿Quién lo recibió?')).toBeInTheDocument();
    const boton = await screen.findByRole('button', { name: /Confirmar Registro/ });
    await waitFor(() => expect(screen.getAllByText(/Mensualidad Noviembre/).length).toBeGreaterThan(0));
    fireEvent.click(boton);
    await waitFor(() => expect(st.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Falta la constancia del pago' })));
    expect(st.updates).toHaveLength(0);
  });

  it('con «quién lo recibió» guarda la línea en notes, delante de las notas del cobro', async () => {
    abrir();
    fireEvent.change(await screen.findByLabelText('¿Quién lo recibió?'), { target: { value: 'Alejandra L.' } });
    await waitFor(() => expect(screen.getAllByText(/Mensualidad Noviembre/).length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar Registro/ }));
    await waitFor(() => expect(st.updates).toHaveLength(1));
    const hoy = new Date();
    const dia = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
    expect(st.updates[0]).toMatchObject({
      status: 'paid',
      payment_method: 'cash',
      notes: `[Recibido: efectivo · ${dia} · por Alejandra L.]\nHermano de Sofía`,
    });
  });

  it('transferencia sin soporte también lo pide', async () => {
    abrir();
    fireEvent.click(await screen.findByRole('button', { name: /Transferencia/ }));
    expect(await screen.findByLabelText('¿Quién lo recibió?')).toBeInTheDocument();
  });
});
