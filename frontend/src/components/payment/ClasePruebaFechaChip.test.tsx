import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const prospectos = vi.hoisted(() => ({ value: [] as any[] }));
vi.mock('@/hooks/useCobrosClasePrueba', () => ({
  useCobrosClasePrueba: () => ({ prospectos: prospectos.value }),
}));

import { ClasePruebaFechaChip } from './ClasePruebaFechaChip';

describe('ClasePruebaFechaChip — el día de la clase junto al pago', () => {
  it('muestra el día de la clase del prospecto cuyo pago es el de la fila', () => {
    prospectos.value = [
      { id: 'l1', fecha_clase: '2026-11-14', pago: { id: 'p1' } },
      { id: 'l2', fecha_clase: '2026-11-28', pago: { id: 'p2' } },
    ];
    render(<ClasePruebaFechaChip paymentId="p2" schoolId="s1" />);
    expect(screen.getByTestId('clase-prueba-fecha').textContent).toMatch(/Clase 28 de nov/);
  });
  it('no pinta nada si pagó pero nunca se agendó, o si el pago no está en la lista', () => {
    prospectos.value = [{ id: 'l1', fecha_clase: null, pago: { id: 'p1' } }];
    const { container, rerender } = render(<ClasePruebaFechaChip paymentId="p1" schoolId="s1" />);
    expect(container.textContent).toBe('');
    rerender(<ClasePruebaFechaChip paymentId="otro" schoolId="s1" />);
    expect(container.textContent).toBe('');
  });
});
