import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TransactionsCard } from './TransactionsCard';

const fila = (over: Record<string, unknown>) => ({
  id: 'p', status: 'paid', payment_date: '2026-11-05', created_at: '2026-11-01T10:00:00Z', due_date: '2026-11-05',
  concept: 'Mensualidad Noviembre', amount: 210000, amount_paid: 210000, student: { full_name: 'Sofía Herrera' }, parent: null,
  payment_method: 'cash', payment_channel: 'cash', ...over,
});

describe('TransactionsCard — procedencia del pago', () => {
  it('marca el pago migrado del Excel y el que no tiene comprobante; no el que sí lo tiene', () => {
    render(
      <TransactionsCard
        refreshing={false}
        onRefresh={() => {}}
        payments={[
          fila({ id: 'a', reference: 'XLS-NOV-3' }),
          fila({ id: 'b', reference: 'CASH-1' }),
          fila({ id: 'c', reference: 'TRF-1', payment_method: 'transfer', payment_channel: 'transfer', receipt_url: 'u/x.png' }),
        ]}
      />,
    );
    // Mobile y escritorio pintan la misma fila: cada insignia aparece una vez por vista.
    expect(screen.getAllByTestId('pago-origen-migrado_excel').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('pago-origen-manual_sin_comprobante').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId(/^pago-origen-/).length).toBe(
      screen.getAllByTestId('pago-origen-migrado_excel').length + screen.getAllByTestId('pago-origen-manual_sin_comprobante').length,
    );
    expect(screen.getAllByTitle('Este pago se cargó desde el Excel de la escuela. No tiene comprobante en la app.').length).toBeGreaterThan(0);
  });
});
