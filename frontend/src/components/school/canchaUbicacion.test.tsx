/**
 * Cómo llegar a la cancha (dirección, Maps, indicaciones): solo aparece si la
 * base tiene las columnas; sin ellas el formulario guarda lo de siempre.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const st = vi.hoisted(() => ({ errorSonda: null as null | { code: string; message: string } }));
vi.mock('@/integrations/supabase/client', () => {
  const b: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq']) b[m] = () => b;
  b.limit = () => Promise.resolve({ data: [], error: st.errorSonda });
  return { supabase: b };
});
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ schoolId: 's-monster' }) }));

import { FacilityFormDialog } from './FacilityFormDialog';
import { camposUbicacion, errorEnlaceMaps } from './canchaUbicacion';

const CANCHA = {
  id: 'f1', name: 'Parque Pinar de Suba 2', type: 'Cancha de Voleibol', capacity: 40, description: null,
  min_booking_advance_hours: 0, min_cancellation_hours: 0,
  address: 'Calle 152 # 58-50', maps_url: null, indicaciones: null,
};

const pintar = (onSubmit = vi.fn()) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><FacilityFormDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} facility={CANCHA} /></QueryClientProvider>);
  return onSubmit;
};

beforeEach(() => { st.errorSonda = null; });

describe('canchaUbicacion (puro)', () => {
  it('el enlace de Maps: vacío vale; si hay, completo con https', () => {
    expect(errorEnlaceMaps('')).toBeNull();
    expect(errorEnlaceMaps('https://maps.app.goo.gl/abc123')).toBeNull();
    expect(errorEnlaceMaps('maps.app.goo.gl/abc')).toMatch(/https/);
  });

  it('solo manda las claves que vienen; el vacío es NULL', () => {
    expect(camposUbicacion({})).toEqual({});
    expect(camposUbicacion({ address: '  Calle 152  ', maps_url: '', indicaciones: undefined })).toEqual({ address: 'Calle 152', maps_url: null });
  });
});

describe('FacilityFormDialog · Cómo llegar', () => {
  it('con las columnas: muestra los tres campos y los guarda', async () => {
    const onSubmit = pintar();
    expect(await screen.findByTestId('cancha-como-llegar')).toBeInTheDocument();
    expect(screen.getByLabelText('Dirección')).toHaveValue('Calle 152 # 58-50');
    fireEvent.change(screen.getByLabelText('Enlace de Google Maps'), { target: { value: 'https://maps.app.goo.gl/pinar2' } });
    fireEvent.change(screen.getByLabelText(/Indicaciones \(por dónde se entra, qué pasa si llueve\)/), { target: { value: 'Entrada por la puerta 2.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar Instalación' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Parque Pinar de Suba 2', address: 'Calle 152 # 58-50', maps_url: 'https://maps.app.goo.gl/pinar2', indicaciones: 'Entrada por la puerta 2.',
    });
  });

  it('un enlace sin https no se guarda', async () => {
    const onSubmit = pintar();
    fireEvent.change(await screen.findByLabelText('Enlace de Google Maps'), { target: { value: 'pinar 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar Instalación' }));
    expect(await screen.findByText(/Pega el enlace completo/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sin las columnas (42703): sin campos, y guarda exactamente lo de siempre', async () => {
    st.errorSonda = { code: '42703', message: 'column facilities.address does not exist' };
    const onSubmit = pintar();
    fireEvent.click(await screen.findByRole('button', { name: 'Actualizar Instalación' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.queryByTestId('cancha-como-llegar')).not.toBeInTheDocument();
    const datos = onSubmit.mock.calls[0][0];
    expect(datos).not.toHaveProperty('address');
    expect(datos).not.toHaveProperty('maps_url');
    expect(datos).not.toHaveProperty('indicaciones');
  });
});
