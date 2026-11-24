import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const st = vi.hoisted(() => ({
  toast: vi.fn(),
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: null as unknown, error: null as unknown },
}));

const ANA = { id: 'a1', full_name: 'Ana Pérez', athlete_type: 'child', parent_id: 'par-1', parent_name: 'Mamá', parent_email: null, is_active: true };
const BEA = { id: 'a2', full_name: 'Bea Pérez', athlete_type: 'child', parent_id: 'par-1', parent_name: 'Mamá', parent_email: null, is_active: true };
const COBRO_ANA = {
  id: 'p-ana', concept: 'Mensualidad Ana', amount: 100000, amount_paid: 0, late_fee_amount: 0,
  early_payment_discount_applied: 0, due_date: '2026-11-05', status: 'pending', notes: null,
  payment_category: 'mensualidad', payment_type: 'recurring', requires_review: false,
};
const COBRO_BEA = { ...COBRO_ANA, id: 'p-bea', concept: 'Mensualidad Bea', child_id: 'a2' };

vi.mock('@/integrations/supabase/client', () => {
  function from(tabla: string) {
    let esUpdate = false;
    let porHijos = false;
    const api: any = {
      select: () => api,
      eq: () => api,
      in: (col: string) => { if (col === 'child_id') porHijos = true; return api; },
      order: () => api,
      update: () => { esUpdate = true; return api; },
      maybeSingle: () => Promise.resolve({ data: { ...COBRO_ANA }, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (ok: any, ko: any) => {
        let data: unknown[] = [];
        if (tabla === 'school_athletes') data = [ANA, BEA];
        else if (tabla === 'payments' && esUpdate) data = [{ id: 'p-ana' }];
        else if (tabla === 'payments') data = porHijos ? [COBRO_BEA] : [COBRO_ANA];
        return Promise.resolve({ data, error: null }).then(ok, ko);
      },
    };
    return api;
  }
  const rpc = (fn: string, args: Record<string, unknown>) => {
    st.rpcs.push({ fn, args });
    if (fn === 'get_sibling_family') {
      return Promise.resolve({
        data: [
          { child_id: 'a1', full_name: 'Ana Pérez', via: 'self', active: true, rank: 1 },
          { child_id: 'a2', full_name: 'Bea Pérez', via: 'acudiente', active: true, rank: 2 },
        ],
        error: null,
      });
    }
    if (fn.startsWith('register_manual_payments')) return Promise.resolve(st.rpcResult);
    return Promise.resolve({ data: null, error: null });
  };
  return { supabase: { from, rpc } };
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

async function entrarAlModoMultiple() {
  fireEvent.click(await screen.findByRole('button', { name: /Pagar varios cobros a la vez/ }));
  await screen.findByTestId('cyp-hermanas');
  fireEvent.click(await screen.findByLabelText(/Mensualidad Ana/));
  fireEvent.click(await screen.findByTestId('cyp-hermana-cobro-p-bea'));
  fireEvent.change(await screen.findByLabelText('¿Quién lo recibió?'), { target: { value: 'Alejandra L.' } });
}

const llamadas = (fn: string) => st.rpcs.filter((r) => r.fn === fn);

beforeEach(() => {
  st.toast.mockReset();
  st.rpcs = [];
  st.rpcResult = { data: { total: 200000, excedente: 0 }, error: null };
});

describe('RegisterCashPaymentModal — hermanas con un comprobante', () => {
  it('ofrece los cobros de la hermana vinculada, sin marcar por defecto', async () => {
    abrir();
    fireEvent.click(await screen.findByRole('button', { name: /Pagar varios cobros a la vez/ }));
    const bloque = await screen.findByTestId('cyp-hermanas');
    expect(within(bloque).getByText('¿Este pago también es de sus hermanas?')).toBeInTheDocument();
    expect(within(bloque).getByText('Bea Pérez')).toBeInTheDocument();
    expect(screen.getByTestId('cyp-hermana-cobro-p-bea')).not.toBeChecked();
    expect(llamadas('get_sibling_family')[0].args).toEqual({ p_school_id: 'esc-1', p_child_id: 'a1' });
  });

  it('ofrece vincular una hermana que no aparece', async () => {
    abrir();
    expect(await screen.findByTestId('cyp-vincular-hermana')).toHaveTextContent('¿Falta una hermana? Vincúlala');
  });

  it('con las dos hermanas marcadas usa la RPC familiar, con monto recibido y ancla', async () => {
    abrir();
    await entrarAlModoMultiple();
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar Registro/ }));
    await waitFor(() => expect(llamadas('register_manual_payments_familia')).toHaveLength(1));
    const { args } = llamadas('register_manual_payments_familia')[0];
    expect((args.p_payment_ids as string[]).slice().sort()).toEqual(['p-ana', 'p-bea']);
    expect(args.p_monto_recibido).toBe(200000);
    expect(args.p_ancla_child).toBe('a1');
    expect(llamadas('register_manual_payments')).toHaveLength(0);
  });

  it('con $5.500 de más muestra el reparto antes de guardar', async () => {
    abrir();
    await entrarAlModoMultiple();
    const campo = within(await screen.findByTestId('cyp-monto-recibido')).getByRole('textbox');
    fireEvent.change(campo, { target: { value: '205500' } });
    const aviso = await screen.findByTestId('cyp-aviso-reparto');
    expect(aviso.textContent).toMatch(/Sobran/);
    expect(aviso.textContent).toMatch(/2\.750/);
    expect(aviso.textContent).toMatch(/a favor de cada una/);
  });

  it('con $5.501 de más, el residuo se nombra a la ancla', async () => {
    abrir();
    await entrarAlModoMultiple();
    fireEvent.change(within(await screen.findByTestId('cyp-monto-recibido')).getByRole('textbox'), { target: { value: '205501' } });
    const aviso = await screen.findByTestId('cyp-aviso-reparto');
    expect(aviso.textContent).toMatch(/2\.751/);
    expect(aviso.textContent).toMatch(/Ana Pérez/);
  });

  it('con un recibido menor que la suma bloquea el guardado y explica qué hacer', async () => {
    abrir();
    await entrarAlModoMultiple();
    fireEvent.change(within(await screen.findByTestId('cyp-monto-recibido')).getByRole('textbox'), { target: { value: '150000' } });
    expect(await screen.findByTestId('cyp-recibido-menor')).toHaveTextContent('Registra cada cobro con su abono');
    expect(await screen.findByRole('button', { name: /Confirmar Registro/ })).toBeDisabled();
    expect(llamadas('register_manual_payments_familia')).toHaveLength(0);
  });
});
