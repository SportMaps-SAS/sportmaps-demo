import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PagoOrigenInsignia } from './PagoOrigenInsignia';

describe('PagoOrigenInsignia', () => {
  it('«Migrado del Excel» con su tooltip', () => {
    render(<PagoOrigenInsignia payment={{ reference: 'XLS-NOV-7', status: 'paid' }} />);
    const b = screen.getByText('Migrado del Excel');
    expect(b).toHaveAttribute('title', 'Este pago se cargó desde el Excel de la escuela. No tiene comprobante en la app.');
  });
  it('«Sin comprobante» para un pago manual sin soporte', () => {
    render(<PagoOrigenInsignia payment={{ reference: 'CASH-1', status: 'paid', payment_method: 'cash' }} />);
    expect(screen.getByText('Sin comprobante')).toBeInTheDocument();
  });
  it('nada para pagos con comprobante, abiertos o por pasarela', () => {
    const { container, rerender } = render(<PagoOrigenInsignia payment={{ status: 'paid', receipt_url: 'x/y.png' }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PagoOrigenInsignia payment={{ status: 'pending' }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PagoOrigenInsignia payment={{ status: 'paid', payment_channel: 'online', wompi_reference: 'w' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
