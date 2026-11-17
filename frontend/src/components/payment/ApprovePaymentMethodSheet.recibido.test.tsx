import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const st = vi.hoisted(() => ({ approve: vi.fn(), toast: vi.fn() }));

vi.mock('@/lib/approvePayment', () => ({
  approvePayment: (...a: unknown[]) => st.approve(...a),
  notifyGroupApproved: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'admin-1' } }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ schoolId: 'esc-1', schoolName: 'Escuela' }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: st.toast }) }));
vi.mock('@/lib/normalizeReceiptUrl', () => ({ getSignedReceiptUrl: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => {
  const q: any = {
    select: () => q, eq: () => q,
    maybeSingle: () => Promise.resolve({ data: { allow_installments: false, receipt_amount_editable: false }, error: null }),
  };
  return { supabase: { from: () => q } };
});

const { ApprovePaymentMethodSheet } = await import('./ApprovePaymentMethodSheet');

const SIN_COMPROBANTE = { id: 'p1', amount: 100000, amount_paid: 0, concept: 'Mensualidad Noviembre', athlete_name: 'Sofía', receipt_url: null, status: 'awaiting_approval' };
const CON_COMPROBANTE = { ...SIN_COMPROBANTE, id: 'p2', receipt_url: 'u1/soporte.png', ocr_amount: 100000 };

const abrir = (payment: typeof SIN_COMPROBANTE) =>
  render(<ApprovePaymentMethodSheet payment={payment} open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);

beforeEach(() => {
  st.approve.mockReset();
  st.approve.mockResolvedValue({ ok: true, isAbono: false, abono: 100000, saldoPendiente: 0 });
  st.toast.mockReset();
});

describe('ApprovePaymentMethodSheet — aprobar sin comprobante', () => {
  it('pide cómo, cuándo y quién, y no aprueba mientras falte algo', async () => {
    abrir(SIN_COMPROBANTE);
    expect(await screen.findByTestId('recibido-sin-comprobante')).toBeInTheDocument();
    const boton = await screen.findByRole('button', { name: /Aprobar/ });
    await waitFor(() => expect(boton).toBeEnabled());
    fireEvent.click(boton);
    expect(st.approve).not.toHaveBeenCalled();
    expect(st.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Falta la constancia del pago', variant: 'destructive' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cómo recibiste el pago');
  });

  it('con medio, fecha y persona aprueba con la constancia', async () => {
    abrir(SIN_COMPROBANTE);
    fireEvent.change(await screen.findByLabelText('¿Cómo lo recibiste?'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('¿Cuándo lo recibiste?'), { target: { value: '2026-11-11' } });
    fireEvent.change(screen.getByLabelText('¿Quién lo recibió?'), { target: { value: 'Alejandra L.' } });
    const boton = await screen.findByRole('button', { name: /Aprobar/ });
    await waitFor(() => expect(boton).toBeEnabled());
    fireEvent.click(boton);
    await waitFor(() => expect(st.approve).toHaveBeenCalledTimes(1));
    expect(st.approve.mock.calls[0][1]).toMatchObject({ recibido: { metodo: 'cash', fecha: '2026-11-11', por: 'Alejandra L.' } });
  });

  it('con comprobante no pide nada y aprueba como siempre', async () => {
    abrir(CON_COMPROBANTE as unknown as typeof SIN_COMPROBANTE);
    const boton = await screen.findByRole('button', { name: /Aprobar/ });
    expect(screen.queryByTestId('recibido-sin-comprobante')).toBeNull();
    await waitFor(() => expect(boton).toBeEnabled());
    fireEvent.click(boton);
    await waitFor(() => expect(st.approve).toHaveBeenCalledTimes(1));
    expect(st.approve.mock.calls[0][1].recibido).toBeUndefined();
  });
});
