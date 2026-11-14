import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { VolverAtras } from './VolverAtras';

const Donde = () => <span data-testid="donde">{useLocation().pathname + useLocation().search}</span>;

const pintar = (entradas: string[], index: number) =>
  render(
    <MemoryRouter initialEntries={entradas} initialIndex={index}>
      <Donde />
      <Routes>
        <Route path="/estado-cuenta" element={<VolverAtras destino="/payments-automation?tab=cierre" etiqueta="Volver a Pagos" />} />
        <Route path="*" element={<span>otra pantalla</span>} />
      </Routes>
    </MemoryRouter>,
  );

describe('VolverAtras', () => {
  it('con una pantalla anterior dentro de la app, vuelve a ella', () => {
    pintar(['/payments-automation?tab=cierre', '/otra', '/estado-cuenta?child_id=h1'], 2);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Pagos' }));
    expect(screen.getByTestId('donde').textContent).toBe('/otra');
  });

  it('si se llegó directo (primera entrada), va al destino y no se queda sin salida', () => {
    pintar(['/estado-cuenta?child_id=h1'], 0);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Pagos' }));
    expect(screen.getByTestId('donde').textContent).toBe('/payments-automation?tab=cierre');
  });

  it('la etiqueta por defecto es «Volver»', () => {
    render(<MemoryRouter><VolverAtras destino="/dashboard" /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Volver' })).toBeTruthy();
  });
});
