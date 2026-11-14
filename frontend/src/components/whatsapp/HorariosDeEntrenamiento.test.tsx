/**
 * «Recibe clases de prueba» por equipo (teams.recibe_clase_prueba): aparece solo
 * si la base tiene la columna; sin ella, la pantalla y lo que guarda son los de siempre.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type Res = { data: unknown; error: { code: string; message: string } | null; status?: number };
const st = vi.hoisted(() => ({
  conColumna: true,
  updates: [] as unknown[],
  toast: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (tabla: string) => {
    let cols = '';
    let esUpdate = false;
    const b: Record<string, unknown> = {};
    b.select = (c: string) => { cols = c; return b; };
    b.eq = () => b;
    b.order = () => b;
    b.update = (p: unknown) => { esUpdate = true; st.updates.push(p); return b; };
    b.then = (ok: (r: Res) => unknown) => {
      if (tabla === 'school_branches') return Promise.resolve({ data: [{ name: 'Suba' }], error: null }).then(ok);
      if (esUpdate) return Promise.resolve({ data: null, error: null }).then(ok);
      if (cols.includes('recibe_clase_prueba') && !st.conColumna) {
        return Promise.resolve({ data: null, error: { code: '42703', message: 'column teams.recibe_clase_prueba does not exist' }, status: 400 }).then(ok);
      }
      const fila: Record<string, unknown> = {
        id: 't1', name: 'U9 y U11 Mixto', schedule: [{ day: 6, time: '11:00', end: '13:00', place: 'Pinar 2' }],
        student_count: 12, admite_nuevos: true, nota_admision: null,
      };
      if (cols.includes('recibe_clase_prueba')) fila.recibe_clase_prueba = true;
      return Promise.resolve({ data: [fila], error: null }).then(ok);
    };
    return b;
  };
  return { supabase: { from: (t: string) => builder(t) } };
});
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: st.toast }) }));

import { HorariosDeEntrenamiento } from './HorariosDeEntrenamiento';

beforeEach(() => { st.conColumna = true; st.updates = []; st.toast.mockClear(); });

describe('HorariosDeEntrenamiento · recibe clases de prueba', () => {
  it('con la columna: el interruptor aparece prendido y apagarlo se guarda', async () => {
    render(<HorariosDeEntrenamiento schoolId="s1" />);
    const sw = await screen.findByRole('switch', { name: 'Recibe clases de prueba' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(screen.getByText(/sin clases de prueba/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Guardar/ }));
    await waitFor(() => expect(st.updates).toHaveLength(1));
    expect(st.updates[0]).toMatchObject({ admite_nuevos: true, recibe_clase_prueba: false });
  });

  it('sin la columna: no aparece, la lista carga igual y el guardado es el de siempre', async () => {
    st.conColumna = false;
    render(<HorariosDeEntrenamiento schoolId="s1" />);
    expect(await screen.findByText('U9 y U11 Mixto')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Recibe clases de prueba' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Recibe atletas nuevos' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Guardar/ }));
    await waitFor(() => expect(st.updates).toHaveLength(1));
    expect(st.updates[0]).not.toHaveProperty('recibe_clase_prueba');
  });
});
