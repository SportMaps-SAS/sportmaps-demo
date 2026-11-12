import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EstadoCuentaAcudienteView } from './EstadoCuentaAcudiente';
import { buildStatementPrintHtml, type StatementData } from './statementPrint';
import type { CobroCuenta } from './estadoCuentaModel';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

const HOY = new Date(2026, 9, 24, 10, 0);

const STATEMENT: StatementData = {
  athlete_name: 'Sofía Herrera',
  summary: { count_expected: 9, total_expected: 1_495_000, count_settled: 4, total_settled: 730_000, count_open: 5, total_open: 765_000, total_late_fees: 20_000 },
  meses: [{ periodo: '10/2026', status: 'overdue' }],
  events: [],
};

const c = (over: Partial<CobroCuenta>): CobroCuenta => ({
  id: 'p', status: 'overdue', amount: 210_000, amount_paid: null, concept: 'Mensualidad 10/2026 - Sofía Herrera',
  due_date: '2026-10-10', payment_date: null, period_year: 2026, period_month: 10, created_at: '2026-10-01T06:30:00Z', ...over,
});

function pintar(props: Partial<Parameters<typeof EstadoCuentaAcudienteView>[0]> = {}) {
  const onPrint = vi.fn();
  const onRetry = vi.fn();
  render(
    <MemoryRouter>
      <EstadoCuentaAcudienteView state="ready" statement={STATEMENT} cobros={[]} months={12} onRetry={onRetry} onPrint={onPrint} now={HOY} {...props} />
    </MemoryRouter>,
  );
  return { onPrint, onRetry };
}

describe('EstadoCuentaAcudienteView', () => {
  it('frase con el saldo de la RPC y un botón a pagar ese cobro', () => {
    pintar({ cobros: [c({ id: 'oct' }), c({ id: 'jul', status: 'paid', amount_paid: 200_000, period_month: 7, due_date: '2026-07-10', payment_date: '2026-07-06' })] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Sofía debe \$\s?765\.000$/);
    expect(screen.getByRole('link', { name: 'Pagar' }).getAttribute('href')).toBe('/my-payments?pay=oct');
  });

  it('cada mes se abre para ver sus cobros, con el estado en palabras', () => {
    pintar({ cobros: [c({ id: 'oct' }), c({ id: 'jul', status: 'paid', amount_paid: 200_000, period_month: 7, due_date: '2026-07-10', payment_date: '2026-07-06', concept: 'Mensualidad Julio' })] });
    const julio = screen.getByRole('button', { name: /Julio de 2026/ });
    expect(julio.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /Octubre de 2026/ }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(julio);
    expect(julio.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Pagado el 6 de julio')).toBeTruthy();
    expect(screen.queryByText(/overdue|paid|awaiting/)).toBeNull();
  });

  it('Imprimir es secundario y llama al callback', () => {
    const { onPrint } = pintar({ cobros: [c({})] });
    fireEvent.click(screen.getByRole('button', { name: /Imprimir/ }));
    expect(onPrint).toHaveBeenCalled();
  });

  it('al día: sin botón de pagar', () => {
    pintar({ statement: { ...STATEMENT, summary: { ...STATEMENT.summary, total_open: 0 } }, cobros: [c({ status: 'paid', amount_paid: 210_000 })] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sofía está al día');
    expect(screen.queryByRole('link', { name: /^Pagar/ })).toBeNull();
  });

  it('sin cobros: vacío propio', () => {
    pintar({ statement: { ...STATEMENT, summary: { ...STATEMENT.summary, total_open: 0 } }, cobros: [] });
    expect(screen.getByText('Aún no hay cobros')).toBeTruthy();
  });

  it('error: nunca se ve como «al día»', () => {
    const { onRetry } = pintar({ state: 'error', statement: undefined });
    expect(screen.getByRole('alert').textContent).toContain('No pudimos cargar el estado de cuenta');
    expect(screen.queryByText(/al día$/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('cargando: esqueleto, sin frase', () => {
    pintar({ state: 'loading', statement: undefined });
    expect(screen.getByLabelText('Cargando el estado de cuenta')).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

describe('EstadoCuentaAcudienteView: fechas, puntualidad y cómo pagó', () => {
  const PAGADO = c({ id: 'sep', status: 'paid', amount_paid: 210_000, period_month: 9, due_date: '2026-09-10', payment_date: '2026-09-08', payment_channel: 'transfer', receipt_url: 'x.jpg' });

  it('el mes dice cuándo era y cuándo se pagó en una línea', () => {
    pintar({ cobros: [PAGADO] });
    expect(screen.getByRole('button', { name: /Septiembre de 2026/ }).textContent).toContain('Límite 10 de septiembre · pagó 8 de septiembre');
  });

  it('abierto: puntualidad, valor cobrado y pagado, y cómo pagó', () => {
    pintar({ cobros: [PAGADO] });
    fireEvent.click(screen.getByRole('button', { name: /Septiembre de 2026/ }));
    expect(screen.getByText('Pagó a tiempo')).toBeTruthy();
    expect(screen.getByText('Valor cobrado')).toBeTruthy();
    expect(screen.getByText('Valor pagado')).toBeTruthy();
    expect(screen.getByText('Transferencia')).toBeTruthy();
  });

  it('vencido: cuántos días lleva', () => {
    pintar({ cobros: [c({ id: 'oct' })] });
    expect(screen.getByText('Lleva 14 días vencido')).toBeTruthy();
  });

  it('abono: dice cuánto abonó y cuánto falta', () => {
    pintar({ cobros: [c({ id: 'oct', status: 'partial', amount_paid: 100_000 })] });
    expect(screen.getByText(/Abonaste.*100\.000.*Falta.*110\.000/)).toBeTruthy();
  });

  it('la familia no ve «Sin registrar»; la escuela sí', () => {
    const sinMetodo = c({ id: 'sep', status: 'paid', amount_paid: 210_000, period_month: 9, due_date: '2026-09-10', payment_date: '2026-09-08' });
    const { unmount } = render(
      <MemoryRouter><EstadoCuentaAcudienteView state="ready" statement={STATEMENT} cobros={[sinMetodo]} months={12} onRetry={vi.fn()} onPrint={vi.fn()} now={HOY} /></MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Septiembre de 2026/ }));
    expect(screen.queryByText('Sin registrar')).toBeNull();
    unmount();
    render(
      <MemoryRouter><EstadoCuentaAcudienteView state="ready" statement={STATEMENT} cobros={[sinMetodo]} months={12} onRetry={vi.fn()} onPrint={vi.fn()} now={HOY} modo="escuela" /></MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Septiembre de 2026/ }));
    expect(screen.getByText('Sin registrar')).toBeTruthy();
  });
});

describe('EstadoCuentaAcudienteView modo escuela', () => {
  it('solo consulta: sin botones de pagar y sin «Ver todos los pagos»', () => {
    pintar({ modo: 'escuela', cobros: [c({ id: 'oct' })] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Sofía debe/);
    expect(screen.queryByRole('link', { name: /^Pagar/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Ver todos los pagos/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Imprimir/ })).toBeTruthy();
  });

  it('voz neutra: no le habla a la familia', () => {
    pintar({ modo: 'escuela', statement: { ...STATEMENT, summary: { ...STATEMENT.summary, total_open: 0 } }, cobros: [c({ status: 'awaiting_approval', payment_date: '2026-10-12' })] });
    expect(screen.queryByText(/Te avisamos/)).toBeNull();
    expect(screen.queryByText(/Enviaste/)).toBeNull();
  });
});

describe('buildStatementPrintHtml', () => {
  it('escapa el nombre (va a document.write)', () => {
    const html = buildStatementPrintHtml({ ...STATEMENT, athlete_name: '<img src=x onerror=alert(1)>' }, 12, 'hoy');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
