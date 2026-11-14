/**
 * Soportes: apagados no pintan nada; activos muestran la insignia, el informe,
 * la lista de la ficha y el bloqueo SP001 de «Por asignar» con lo que falta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { SoportesFicha } from './SoportesFicha';
import { SoportesInsignia } from './SoportesInsignia';
import { SoportesPendientesInforme } from './SoportesPendientesInforme';
import { SoportesBloqueoDialog, bloqueoDesdeError } from './SoportesBloqueoDialog';
import { TIPOS_SOPORTE, type EstadoSoportes } from '@/lib/api/soportes';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';

const conCliente = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

const estado = (activo: boolean): EstadoSoportes => ({
  activo,
  requeridos: [...TIPOS_SOPORTE],
  resumen: { total: 2, completos: 1, incompletos: 1, sin_cuenta_incompletos: 1 },
  deportistas: [
    { subject_type: 'child', subject_id: 'c1', full_name: 'Ana Pérez', notify_profile_id: null, has_account: false,
      required_total: 7, present_total: 5, missing: ['eps_certificate', 'athlete_photo'], complete: false },
    { subject_type: 'child', subject_id: 'c2', full_name: 'Luis Gómez', notify_profile_id: 'p', has_account: true,
      required_total: 7, present_total: 7, missing: [], complete: true },
  ],
});

beforeEach(() => vi.clearAllMocks());

describe('SoportesInsignia', () => {
  it('muestra «Soportes X/7»', () => {
    render(<SoportesInsignia d={estado(true).deportistas[0]} />);
    expect(screen.getByText('Soportes 5/7')).toBeTruthy();
  });
  it('sin dato (función apagada) no pinta nada', () => {
    const { container } = render(<SoportesInsignia d={undefined} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('SoportesPendientesInforme', () => {
  it('apagado: no pinta nada', async () => {
    bff.get.mockResolvedValue({ ...estado(false), deportistas: [] });
    const { container } = conCliente(<SoportesPendientesInforme schoolId={ESCUELA} />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('soportes-informe')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/Soportes pendientes/);
  });

  it('error del BFF (sin permiso o sin migración): no pinta nada', async () => {
    bff.get.mockRejectedValue({ status: 403, message: 'no' });
    conCliente(<SoportesPendientesInforme schoolId={ESCUELA} />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('soportes-informe')).toBeNull();
  });

  it('activo: lista lo que falta a cada deportista, sin lenguaje de cobro', async () => {
    bff.get.mockResolvedValue(estado(true));
    conCliente(<SoportesPendientesInforme schoolId={ESCUELA} />);
    fireEvent.click(await screen.findByText('Soportes pendientes'));
    expect(await screen.findByText('Ana Pérez')).toBeTruthy();
    expect(screen.getByText(/Falta: Certificado de la EPS, Foto del deportista/)).toBeTruthy();
    expect(screen.queryByText('Luis Gómez')).toBeNull();
    expect(screen.getByText(/por WhatsApp/)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/mora|cobro|deuda|pagar/i);
  });
});

describe('SoportesFicha', () => {
  it('apagado: no pinta nada', async () => {
    bff.get.mockResolvedValue({ activo: false, completo: true, requeridos: [], faltan: [] });
    conCliente(<SoportesFicha schoolId={ESCUELA} tipoSujeto="child" sujetoId="c1" />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('soportes-ficha')).toBeNull();
  });

  it('activo: marca lo que falta y ofrece subir o reemplazar', async () => {
    bff.get.mockResolvedValue({
      activo: true, completo: false, requeridos: [...TIPOS_SOPORTE], faltan: ['eps_certificate'],
    });
    conCliente(<SoportesFicha schoolId={ESCUELA} tipoSujeto="child" sujetoId="c1" />);
    expect(await screen.findByRole('button', { name: 'Subir Certificado de la EPS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reemplazar Foto del deportista' })).toBeTruthy();
    expect(screen.getByText('6/7')).toBeTruthy();
  });

  it('rechaza en el cliente un PDF para una firma, sin llamar al BFF', async () => {
    bff.get.mockResolvedValue({
      activo: true, completo: false, requeridos: [...TIPOS_SOPORTE], faltan: ['guardian_signature'],
    });
    conCliente(<SoportesFicha schoolId={ESCUELA} tipoSujeto="child" sujetoId="c1" />);
    await screen.findByRole('button', { name: 'Subir Firma del acudiente' });
    const input = screen.getByLabelText('Elegir archivo para Firma del acudiente') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'f.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(toastEstable.toast).toHaveBeenCalled());
    expect(toastEstable.toast.mock.calls[0][0].description).toMatch(/solo admite imagen/);
    expect(bff.post).not.toHaveBeenCalled();
  });
});

describe('SoportesBloqueoDialog (SP001 en «Por asignar»)', () => {
  const error = Object.assign(new Error('SOPORTES_INCOMPLETOS: faltan 2 soporte(s): eps_certificate, athlete_signature'), { code: 'SP001' });

  it('bloqueoDesdeError solo reconoce el error de soportes', () => {
    expect(bloqueoDesdeError(new Error('otro'), 'Ana', null)).toBeNull();
    const b = bloqueoDesdeError(error, 'Ana', { tipo: 'child', id: 'c1' });
    expect(b?.faltan).toEqual(['eps_certificate', 'athlete_signature']);
  });

  it('muestra la lista de lo que falta y el acceso a subirlos', async () => {
    bff.get.mockResolvedValue({
      activo: true, completo: false, requeridos: [...TIPOS_SOPORTE], faltan: ['eps_certificate', 'athlete_signature'],
    });
    const info = bloqueoDesdeError(error, 'Ana Pérez', { tipo: 'child', id: 'c1' })!;
    conCliente(
      <SoportesBloqueoDialog schoolId={ESCUELA} info={info} onClose={vi.fn()} onReintentar={vi.fn()} onConfirmado={vi.fn()} />,
    );
    expect(await screen.findByText(/Falta confirmar a Ana Pérez/)).toBeTruthy();
    expect(screen.getByText('Faltan 2 soportes:')).toBeTruthy();
    expect(screen.getAllByText('Certificado de la EPS').length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Subir Firma del deportista' })).toBeTruthy();
    expect(document.body.textContent ?? '').toMatch(/La inscripción ya quedó creada/);
  });

  it('reintentar: si ya están, confirma; si faltan, se queda y avisa', async () => {
    bff.get.mockResolvedValue({ activo: true, completo: false, requeridos: [...TIPOS_SOPORTE], faltan: ['eps_certificate'] });
    const info = bloqueoDesdeError(error, 'Ana', { tipo: 'child', id: 'c1' })!;
    const onConfirmado = vi.fn();
    const onReintentar = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({});
    conCliente(
      <SoportesBloqueoDialog schoolId={ESCUELA} info={info} onClose={vi.fn()} onReintentar={onReintentar} onConfirmado={onConfirmado} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar ahora' }));
    expect(await screen.findByText('Todavía faltan soportes.')).toBeTruthy();
    expect(onConfirmado).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar ahora' }));
    await waitFor(() => expect(onConfirmado).toHaveBeenCalledTimes(1));
  });
});
