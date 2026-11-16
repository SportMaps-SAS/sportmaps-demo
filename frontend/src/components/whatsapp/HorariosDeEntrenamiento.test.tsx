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
  post: vi.fn(),
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
vi.mock('@/lib/api/bffClient', () => ({ bffClient: { post: (...a: unknown[]) => st.post(...a) } }));

import { HorariosDeEntrenamiento, textoSinHorario } from './HorariosDeEntrenamiento';

beforeEach(() => {
  st.conColumna = true; st.updates = []; st.toast.mockClear();
  st.post.mockReset();
  st.post.mockResolvedValue({ ok: true, franjas: { creadas: 0, cerradas: 0, errores: 0, sinHorarioConReserva: [] } });
});

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

describe('HorariosDeEntrenamiento · cupos de clase de prueba al guardar', () => {
  const guardar = async () => {
    render(<HorariosDeEntrenamiento schoolId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Guardar/ }));
    await waitFor(() => expect(st.toast).toHaveBeenCalled());
    return st.toast.mock.calls[0][0] as { title: string; description: string; variant?: string };
  };

  it('después de guardar pide sincronizar los cupos de ESE grupo y lo dice en una línea', async () => {
    const aviso = await guardar();
    expect(st.updates).toHaveLength(1);
    expect(st.post).toHaveBeenCalledWith('/api/v1/whatsapp/s1/cortesias/sincronizar-franjas', { teamId: 't1' });
    expect(aviso.title).toBe('U9 y U11 Mixto actualizado');
    expect(aviso.description).toMatch(/los cupos de clase de prueba ya quedaron con el horario nuevo/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('si la sincronización falla, el horario queda guardado y se avisa que los cupos se actualizan en la madrugada', async () => {
    st.post.mockRejectedValue(new Error('504'));
    const aviso = await guardar();
    expect(st.updates).toHaveLength(1);
    expect(aviso.variant).toBeUndefined();
    expect(aviso.title).toBe('U9 y U11 Mixto actualizado');
    expect(aviso.description).toMatch(/se actualizan en la madrugada/);
  });

  it('si el generador reporta errores, también se avisa que quedan para la madrugada', async () => {
    st.post.mockResolvedValue({ ok: true, franjas: { creadas: 0, cerradas: 0, errores: 1, sinHorarioConReserva: [] } });
    expect((await guardar()).description).toMatch(/se actualizan en la madrugada/);
  });

  it('la escuela no saca los cupos de sus entrenamientos: el aviso de siempre, sin hablar de cupos', async () => {
    st.post.mockResolvedValue({ ok: true, franjas: null, motivo: 'franjas_desde_entrenamientos_apagadas' });
    expect((await guardar()).description).toBe('El bot ya responde con este horario.');
  });

  it('con reservas en un horario que ya no existe: lo dice claro y enlaza a las clases agendadas', async () => {
    st.post.mockResolvedValue({
      ok: true,
      franjas: {
        creadas: 3, cerradas: 2, errores: 0,
        sinHorarioConReserva: [
          { id: 'f1', grupo: 'U9 y U11 Mixto', fecha: '2026-11-22', hora: '07:00', reservas: 2,
            personas: [{ nombre: 'Ana Pérez', estado: 'agendada' }, { nombre: 'Luis Gómez', estado: 'separada' }] },
          { id: 'f2', grupo: 'U9 y U11 Mixto', fecha: '2026-11-28', hora: '15:30', reservas: 1, personas: [] },
        ],
      },
    });
    await guardar();
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent(
      'Hay 2 personas con clase de prueba el domingo 22 de noviembre a las 7:00 a. m. en U9 y U11 Mixto (Ana Pérez, Luis Gómez); ese horario ya no existe. Avísales la hora nueva.');
    expect(alerta).toHaveTextContent(
      'Hay 1 persona con clase de prueba el sábado 28 de noviembre a las 3:30 p. m. en U9 y U11 Mixto; ese horario ya no existe. Avísale la hora nueva.');
    expect(screen.getByRole('link', { name: 'Ver las clases de prueba agendadas' })).toHaveAttribute('href', '/whatsapp?tab=cortesias');
  });

  it('textoSinHorario: sin grupo en la franja usa el nombre del equipo', () => {
    expect(textoSinHorario({ id: 'f', grupo: '', fecha: '2026-11-22', hora: '12:00', reservas: 3 }, 'Proyección'))
      .toBe('Hay 3 personas con clase de prueba el domingo 22 de noviembre a las 12:00 p. m. en Proyección; ese horario ya no existe. Avísales la hora nueva.');
  });
});
