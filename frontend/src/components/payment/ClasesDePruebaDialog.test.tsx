import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const datos = vi.hoisted(() => ({
  cobros: [] as any[],
  detalle: [] as any[],
  navegar: vi.fn(),
}));

vi.mock('@/hooks/useCobrosClasePrueba', () => ({
  METODOS_PAGO_CLASE_PRUEBA: [{ value: 'transfer', label: 'Transferencia' }, { value: 'cash', label: 'Efectivo' }],
  useCobrosClasePrueba: () => ({ valor: 15000, prospectos: datos.cobros, isLoading: false, error: null, registrar: { mutate: vi.fn(), isPending: false } }),
}));
vi.mock('@/hooks/useClasePrueba', () => ({
  useConfigClasePrueba: () => ({ config: { enabled: true, presencial_enabled: true, es_admin: true } }),
  useProspectosClasePrueba: () => ({ prospectos: datos.detalle, registrar: { mutate: vi.fn(), isPending: false } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/students/ClasePruebaPanel', () => ({ RegistroRapidoDialog: () => null }));
vi.mock('@/components/school/TrialClassSettingsModal', () => ({ TrialClassSettingsModal: () => null }));
vi.mock('@/lib/normalizeReceiptUrl', () => ({ normalizeReceiptUrl: (x: string) => x }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => datos.navegar }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ select: () => ({ in: async () => ({ data: [{ id: 'p1', receipt_url: 'https://x/recibo.png', payment_date: null, created_at: '2026-11-25T15:00:00Z' }], error: null }) }) }),
    storage: { from: () => ({ createSignedUrl: vi.fn() }) },
  },
}));

import { ClasesDePruebaDialog } from './ClasesDePruebaDialog';

const montar = () => render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter><ClasesDePruebaDialog open onOpenChange={vi.fn()} schoolId="s1" /></MemoryRouter>
  </QueryClientProvider>);

describe('ClasesDePruebaDialog — todo de la clase de prueba en un solo modal', () => {
  datos.cobros = [
    { id: 'l1', full_name: 'Ana Pagó', guardian_name: null, phone: '300', status: 'contacted', created_at: '2026-11-01', canal: 'whatsapp',
      asistencia: null, fecha_clase: '2026-11-28', pago: { id: 'p1', monto: 15000, metodo: 'transfer', fecha: '2026-11-25', estado: 'paid' } },
    { id: 'l2', full_name: 'Beto Sin Pagar', guardian_name: null, phone: '301', status: 'new', created_at: '2026-11-02', canal: 'formulario',
      asistencia: null, fecha_clase: null, pago: null },
  ];
  datos.detalle = [{ id: 'l1', fecha_clase: '2026-11-28', cupo_hora: '07:30:00', cupo_label: 'MIXTO MAYORES', sede: 'Suba' }];

  it('junta en la fila la clase (día, hora, grupo), el pago y el comprobante', async () => {
    montar();
    expect(screen.getByText(/Clase 28 de nov\.? 07:30 · MIXTO MAYORES/)).toBeTruthy();
    expect(screen.getByText(/Pagó \$15\.000 · Transferencia · 25 de nov/)).toBeTruthy(); // fecha del pago, aunque el pago no traiga payment_date
    expect(screen.getAllByText(/Se registró/).length).toBe(2);
    expect(await screen.findByLabelText('Ver comprobante')).toBeTruthy();
    expect(screen.getAllByText('Sin agendar')).toHaveLength(2); // el filtro y la insignia de Beto
  });
  it('los filtros separan quién pagó y quién no', () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Sin pagar' }));
    expect(screen.queryByText('Ana Pagó')).toBeNull();
    expect(screen.getByText('Beto Sin Pagar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pagaron' }));
    expect(screen.getByText('Ana Pagó')).toBeTruthy();
    expect(screen.queryByText('Beto Sin Pagar')).toBeNull();
  });
  it('«Completar datos» lleva a Deportistas → Clase de prueba', () => {
    montar();
    fireEvent.click(screen.getAllByRole('button', { name: /Completar datos/ })[0]);
    expect(datos.navegar).toHaveBeenCalledWith('/students?tab=prueba');
  });
});
