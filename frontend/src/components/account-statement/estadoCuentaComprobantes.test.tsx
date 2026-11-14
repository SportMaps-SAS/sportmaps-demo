/**
 * Cómo se pagó y «Ver comprobante», con las combinaciones REALES de la base de
 * Besser (57 pagos pagados, corte 2026-11-12):
 *   cash/cash sin comprobante ........ 20     transfer/transfer con comprobante . 31
 *   transfer/transfer sin comprobante .  2     manual/transfer con comprobante ...  1
 *   manual/sin método con comprobante .  3  (antes salían como «Sin registrar»)
 * Más pasarela y el caso sin ningún dato, que no está en Besser pero sí en otras escuelas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { comoPago, type CobroCuenta } from './estadoCuentaModel';
import { EstadoCuentaAcudienteView } from './EstadoCuentaAcudiente';
import type { StatementData } from './statementPrint';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/normalizeReceiptUrl', () => ({ getSignedReceiptUrl: vi.fn(), normalizeReceiptUrl: (u: string) => u }));
import { getSignedReceiptUrl } from '@/lib/normalizeReceiptUrl';

const HOY = new Date(2026, 10, 12, 10, 0);

const pago = (over: Partial<CobroCuenta>): CobroCuenta => ({
  id: 'p', status: 'paid', amount: 380_000, amount_paid: 380_000, concept: 'Mensualidad 09/2026 - Valentina Ospina',
  due_date: '2026-09-10', payment_date: '2026-09-08', period_year: 2026, period_month: 9, created_at: '2026-09-01T06:30:00Z', ...over,
});

describe('comoPago con las combinaciones reales', () => {
  it('efectivo registrado por la escuela: sin comprobante', () => {
    expect(comoPago(pago({ payment_channel: 'cash', payment_method: 'cash' }))).toEqual({ label: 'Efectivo', nota: 'sin comprobante', soporte: 'ninguno', sinRegistrar: false });
  });
  it('transferencia con comprobante', () => {
    expect(comoPago(pago({ payment_channel: 'transfer', payment_method: 'transfer', receipt_url: 'a/b.png' }))).toEqual({ label: 'Transferencia', nota: 'con comprobante', soporte: 'comprobante', sinRegistrar: false });
  });
  it('transferencia sin comprobante: «sin comprobante», no inventa uno', () => {
    expect(comoPago(pago({ payment_channel: 'transfer', payment_method: 'transfer' }))).toEqual({ label: 'Transferencia', nota: 'sin comprobante', soporte: 'ninguno', sinRegistrar: false });
  });
  it('registrado a mano con medio y comprobante: es una transferencia con comprobante', () => {
    expect(comoPago(pago({ payment_channel: 'manual', payment_method: 'transfer', receipt_url: 'a/b.png' })).soporte).toBe('comprobante');
    expect(comoPago(pago({ payment_channel: 'manual', payment_method: 'transfer', receipt_url: 'a/b.png' })).label).toBe('Transferencia');
  });
  it('registrado a mano SIN medio pero CON comprobante (3 en Besser): ya no es «Sin registrar» a secas', () => {
    expect(comoPago(pago({ payment_channel: 'manual', payment_method: null, receipt_url: 'a/b.png' }))).toEqual({ label: 'Comprobante subido', nota: 'sin medio registrado', soporte: 'comprobante', sinRegistrar: true });
  });
  it('registrado a mano sin medio y sin comprobante', () => {
    expect(comoPago(pago({ payment_channel: 'manual', payment_method: null }))).toEqual({ label: 'Registrado por la escuela', nota: 'sin comprobante', soporte: 'ninguno', sinRegistrar: false });
  });
  it('pasarela: se confirma en línea', () => {
    const r = comoPago(pago({ payment_channel: 'online', wompi_reference: 'W-1', payment_provider: 'wompi', payment_method: 'card' }));
    expect(r.soporte).toBe('en-linea');
    expect(r.label).toBe('Wompi');
  });
  it('sin ningún dato: «Sin registrar» (solo le sirve a la escuela)', () => {
    expect(comoPago(pago({}))).toEqual({ label: 'Sin registrar', nota: null, soporte: 'ninguno', sinRegistrar: true });
  });
});

const STATEMENT: StatementData = {
  athlete_name: 'Valentina Ospina',
  summary: { count_expected: 1, total_expected: 380_000, count_settled: 1, total_settled: 380_000, count_open: 0, total_open: 0, total_late_fees: 0 },
  meses: [], events: [],
};

function pintar(cobro: CobroCuenta, modo: 'familia' | 'escuela') {
  render(
    <MemoryRouter>
      <EstadoCuentaAcudienteView state="ready" statement={STATEMENT} cobros={[cobro]} months={12} onRetry={vi.fn()} onPrint={vi.fn()} now={HOY} modo={modo} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Septiembre de 2026/ })); // abre el mes (ya estaba pagado: cerrado por defecto)
}

describe('«Ver comprobante» en la vista de la escuela', () => {
  beforeEach(() => { vi.mocked(getSignedReceiptUrl).mockReset(); });

  it('transferencia con comprobante: abre el modal con la imagen', async () => {
    vi.mocked(getSignedReceiptUrl).mockResolvedValue('https://almacen.test/firmada.png');
    pintar(pago({ payment_channel: 'transfer', payment_method: 'transfer', receipt_url: 'colegio/c1.png' }), 'escuela');
    fireEvent.click(screen.getByRole('button', { name: 'Ver comprobante' }));
    const img = await screen.findByRole('img', { name: /Comprobante de/ });
    expect(img.getAttribute('src')).toBe('https://almacen.test/firmada.png');
    expect(getSignedReceiptUrl).toHaveBeenCalledWith('colegio/c1.png');
  });

  it('si el archivo no se puede abrir, lo dice y no deja un botón mudo', async () => {
    vi.mocked(getSignedReceiptUrl).mockResolvedValue(null);
    pintar(pago({ payment_channel: 'transfer', payment_method: 'transfer', receipt_url: 'colegio/c1.png' }), 'escuela');
    fireEvent.click(screen.getByRole('button', { name: 'Ver comprobante' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No se pudo abrir el comprobante'));
    expect(screen.queryByRole('img', { name: /Comprobante de/ })).toBeNull();
  });

  it('un PDF se abre en otra pestaña, no como imagen rota', async () => {
    vi.mocked(getSignedReceiptUrl).mockResolvedValue('https://almacen.test/firmada.pdf?token=1');
    pintar(pago({ payment_channel: 'transfer', payment_method: 'transfer', receipt_url: 'colegio/c1.pdf' }), 'escuela');
    fireEvent.click(screen.getByRole('button', { name: 'Ver comprobante' }));
    expect(await screen.findByRole('link', { name: 'Abrir el PDF en otra pestaña' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Comprobante de/ })).toBeNull();
  });

  it('efectivo: dice «sin comprobante» y no ofrece un botón que no existe', () => {
    pintar(pago({ payment_channel: 'cash', payment_method: 'cash' }), 'escuela');
    expect(screen.getByText('Efectivo')).toBeTruthy();
    expect(screen.getByText(/sin comprobante/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ver comprobante' })).toBeNull();
  });

  it('registrado a mano con comprobante y sin medio: lo dice y se puede ver', () => {
    pintar(pago({ payment_channel: 'manual', payment_method: null, receipt_url: 'colegio/c2.png' }), 'escuela');
    expect(screen.getByText('Comprobante subido')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver comprobante' })).toBeTruthy();
  });

  it('transferencia sin comprobante: sin botón', () => {
    pintar(pago({ payment_channel: 'transfer', payment_method: 'transfer' }), 'escuela');
    expect(screen.queryByRole('button', { name: 'Ver comprobante' })).toBeNull();
  });
});

describe('la familia no abre comprobantes', () => {
  it('ve «Recibido por la escuela», sin botón y sin «Sin registrar»', () => {
    pintar(pago({ payment_channel: 'transfer', payment_method: 'transfer', receipt_url: 'colegio/c1.png' }), 'familia');
    expect(screen.getByText('Recibido por la escuela')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ver comprobante' })).toBeNull();
  });
  it('un pago sin medio registrado no le muestra «Sin registrar»', () => {
    pintar(pago({}), 'familia');
    expect(screen.queryByText('Sin registrar')).toBeNull();
  });
});
