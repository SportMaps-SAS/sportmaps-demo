/**
 * Clase de prueba → Configurar → «Cómo agenda el bot»: días (0 = domingo),
 * nombre, horas para separar, cupos y aviso al profe. Sin las columnas no aparece.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Res = { data: unknown; error: { code: string; message: string } | null; status?: number };
const st = vi.hoisted(() => ({
  fila: null as Res,
  rpc: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const b: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq']) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve(st.fila);
  b.rpc = (...a: unknown[]) => st.rpc(...a);
  return { supabase: b };
});
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: st.toast }) }));

import { AjustesAgendaClasePrueba } from './AjustesAgendaClasePrueba';
import { agendaDe, borradorDe, hayCambios } from './agendaClasePruebaModel';
import { AGENDA_POR_DEFECTO, leerAgenda } from '@/hooks/useClasePrueba';

const pintar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AjustesAgendaClasePrueba schoolId="s-monster" /></QueryClientProvider>);
};

beforeEach(() => {
  st.fila = { data: null, error: null };
  st.rpc.mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  st.toast.mockClear();
});

describe('agenda (puro)', () => {
  it('leerAgenda: lo que no se entiende queda como hoy', () => {
    expect(leerAgenda(null)).toEqual(AGENDA_POR_DEFECTO);
    expect(leerAgenda({ nombre_clase: 'prueba', dias_semana: [6, 0, 6, 9], separar_horas: 24, cupos_por_sesion: 0, avisar_entrenador: true }))
      .toEqual({ nombre_clase: 'prueba', dias_semana: [0, 6], separar_horas: 24, cupos_por_sesion: null, avisar_entrenador: true });
    // Los siete días = todos = NULL.
    expect(leerAgenda({ dias_semana: [0, 1, 2, 3, 4, 5, 6] }).dias_semana).toBeNull();
  });

  it('agendaDe: siete días = NULL, rangos, y el nombre por defecto no se escribe si nunca se eligió', () => {
    const b = borradorDe(AGENDA_POR_DEFECTO);
    expect(b.dias).toHaveLength(7);
    expect(agendaDe(b, AGENDA_POR_DEFECTO)).toEqual({ agenda: AGENDA_POR_DEFECTO });
    expect(agendaDe({ ...b, dias: [6, 0], nombre: 'prueba', separar: '24', cupos: '8', avisar: true }, AGENDA_POR_DEFECTO)).toEqual({
      agenda: { dias_semana: [0, 6], nombre_clase: 'prueba', separar_horas: 24, cupos_por_sesion: 8, avisar_entrenador: true },
    });
    expect(agendaDe({ ...b, dias: [] }, AGENDA_POR_DEFECTO)).toEqual({ error: 'Elige al menos un día.' });
    expect(agendaDe({ ...b, separar: '100' }, AGENDA_POR_DEFECTO)).toEqual({ error: 'Las horas para separar el cupo van de 1 a 72.' });
    expect(agendaDe({ ...b, cupos: '0' }, AGENDA_POR_DEFECTO)).toEqual({ error: 'Los cupos por clase van de 1 a 500.' });
    expect(hayCambios(b, AGENDA_POR_DEFECTO)).toBe(false);
    expect(hayCambios({ ...b, avisar: true }, AGENDA_POR_DEFECTO)).toBe(true);
  });
});

describe('AjustesAgendaClasePrueba', () => {
  it('sin las columnas (42703) no aparece', async () => {
    st.fila = { data: null, error: { code: '42703', message: 'column school_trial_class_settings.nombre_clase does not exist' }, status: 400 };
    const { container } = pintar();
    await waitFor(() => expect(container.querySelector('[data-testid="agenda-clase-prueba"]')).toBeNull());
    expect(screen.queryByText('Cómo agenda el bot')).not.toBeInTheDocument();
  });

  it('Monster: solo sábado y domingo, «clase de prueba», 24 h, aviso al profe → guardar_ajustes_clase_prueba con las cinco claves', async () => {
    pintar();
    expect(await screen.findByText('Cómo agenda el bot')).toBeInTheDocument();
    for (const d of ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes']) fireEvent.click(screen.getByRole('button', { name: d }));
    expect(screen.getByRole('button', { name: 'Sábado' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Clase de prueba' }));
    fireEvent.change(screen.getByPlaceholderText('Sin separar'), { target: { value: '24' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Avisar al entrenador' }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar cómo agenda el bot/ }));
    await waitFor(() => expect(st.rpc).toHaveBeenCalled());
    expect(st.rpc).toHaveBeenCalledWith('guardar_ajustes_clase_prueba', {
      p_school_id: 's-monster',
      p_ajustes: { nombre_clase: 'prueba', dias_semana: [0, 6], separar_horas: 24, cupos_por_sesion: null, avisar_entrenador: true },
    });
    await waitFor(() => expect(st.toast).toHaveBeenCalled());
  });

  it('sin días elegidos no guarda y dice por qué', async () => {
    pintar();
    await screen.findByText('Cómo agenda el bot');
    for (const d of ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']) fireEvent.click(screen.getByRole('button', { name: d }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar cómo agenda el bot/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Elige al menos un día.');
    expect(st.rpc).not.toHaveBeenCalled();
  });

  it('si la RPC todavía no existe, lo dice sin romper', async () => {
    st.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
    pintar();
    await screen.findByText('Cómo agenda el bot');
    fireEvent.click(screen.getByRole('switch', { name: 'Avisar al entrenador' }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar cómo agenda el bot/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Esta opción todavía no está activa.');
  });
});
