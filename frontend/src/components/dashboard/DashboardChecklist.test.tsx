import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardChecklist } from './DashboardChecklist';

const pasos = [
  { id: 'a', title: 'Paso A', description: 'da', completed: true, href: '/a' },
  { id: 'b', title: 'Paso B', description: 'db', completed: false, href: '/b' },
  { id: 'c', title: 'Paso C', description: 'dc', completed: false, href: '/c' },
];

describe('DashboardChecklist colapsable', () => {
  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* sin storage */ }
  });

  it('sin collapsibleId no ofrece ocultar (los demás roles no cambian)', () => {
    render(<DashboardChecklist steps={pasos as never} onStepClick={() => {}} />);
    expect(screen.queryByRole('button', { name: /ocultar/i })).toBeNull();
  });

  it('con collapsibleId muestra el avance y un botón principal con el siguiente paso', () => {
    const onStepClick = vi.fn();
    render(<DashboardChecklist steps={pasos as never} onStepClick={onStepClick} collapsibleId="t1" />);
    expect(screen.getByText('1 de 3 completados')).toBeTruthy();
    // El botón principal es el del encabezado: lleva al primer paso pendiente.
    fireEvent.click(screen.getAllByRole('button', { name: /Paso B/ })[0]);
    expect(onStepClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('se colapsa a una píldora «1/3» y se reabre', () => {
    render(<DashboardChecklist steps={pasos as never} onStepClick={() => {}} collapsibleId="t2" title="Mi lista" />);
    fireEvent.click(screen.getByRole('button', { name: /ocultar/i }));
    expect(screen.queryByText('1 de 3 completados')).toBeNull();
    const pildora = screen.getByRole('button', { name: /Mostrar Mi lista: 1 de 3/ });
    expect(pildora.textContent).toContain('1/3');
    fireEvent.click(pildora);
    expect(screen.getByText('1 de 3 completados')).toBeTruthy();
  });

  it('recuerda el estado colapsado al volver a montar', () => {
    const { unmount } = render(<DashboardChecklist steps={pasos as never} onStepClick={() => {}} collapsibleId="t3" />);
    fireEvent.click(screen.getByRole('button', { name: /ocultar/i }));
    unmount();
    render(<DashboardChecklist steps={pasos as never} onStepClick={() => {}} collapsibleId="t3" />);
    expect(screen.queryByText('1 de 3 completados')).toBeNull();
    expect(screen.getByRole('button', { name: /Mostrar/ })).toBeTruthy();
  });
});
