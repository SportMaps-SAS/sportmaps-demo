/** Chip de clase de prueba en la Semana del profe: datos del interesado, [Asistió] [No vino] y grupo recomendado. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { ClasesPruebaDelDia } from './ClasesPruebaDelDia';
import { leerClasesPruebaSemana } from './semanaAjustesModel';

const HOY = '2026-10-31';
const clase = (fecha: string, extra: Record<string, unknown> = {}) => leerClasesPruebaSemana([{
  lead_id: 'l1', nombre: 'Mariana Gómez', anio: 2011, sexo: 'F', fecha, hora: '08:00', team_id: 't-inf', equipo: 'Infantil F',
  respuestas: { posicion: 'Punta', trayectoria: 'Club y torneos', trayectoria_detalle: 'Club Titanes' },
  estado_cupo: 'agendada', pago: { estado: 'paid' }, ...extra,
}]);
const EQUIPOS = [{ id: 't-inf', name: 'Infantil F' }, { id: 't-u15', name: 'U15 F Proyección' }];

beforeEach(() => { toast.success.mockClear(); toast.error.mockClear(); });

describe('ClasesPruebaDelDia', () => {
  it('sin clases no dibuja nada', () => {
    const { container } = render(<ClasesPruebaDelDia clases={[]} hoy={HOY} equiposEscuela={EQUIPOS} guardando={false} onMarcar={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('antes de la clase: quién viene, a qué hora y si pagó, sin botones de asistencia', () => {
    render(<ClasesPruebaDelDia clases={clase('2026-11-01')} hoy={HOY} equiposEscuela={EQUIPOS} guardando={false} onMarcar={vi.fn()} />);
    expect(screen.getByText(/Clase de prueba · 8:00 a\. m\. · Infantil F/)).toBeInTheDocument();
    expect(screen.getByText(/Mariana Gómez · 2011 · Punta · Club y torneos \(Club Titanes\)/)).toBeInTheDocument();
    expect(screen.getByText(/Pagó ✅/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Asistió' })).not.toBeInTheDocument();
    expect(screen.getByText(/Después de la clase marcas si vino/)).toBeInTheDocument();
  });

  it('después de la clase: [Asistió] marca con la RPC y avisa', async () => {
    const onMarcar = vi.fn().mockResolvedValue({ ok: true });
    render(<ClasesPruebaDelDia clases={clase(HOY)} hoy={HOY} equiposEscuela={EQUIPOS} guardando={false} onMarcar={onMarcar} />);
    fireEvent.click(screen.getByRole('button', { name: 'Asistió' }));
    expect(onMarcar).toHaveBeenCalledWith({ leadId: 'l1', asistencia: 'asistio', teamRecomendado: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mariana Gómez: asistió.'));
  });

  it('el grupo recomendado va solo (asistencia NULL = la RPC la deja como está)', async () => {
    const onMarcar = vi.fn().mockResolvedValue({ ok: true });
    render(<ClasesPruebaDelDia clases={clase(HOY, { asistencia: 'asistio', equipo_recomendado: { id: 't-inf', nombre: 'Infantil F' } })}
      hoy={HOY} equiposEscuela={EQUIPOS} guardando={false} onMarcar={onMarcar} />);
    expect(screen.getByRole('button', { name: 'Asistió' })).toHaveAttribute('aria-pressed', 'true');
    // Arranca en el grupo que eligió el bot (lead.team_id).
    expect(screen.getByLabelText('Grupo recomendado')).toHaveValue('t-inf');
    fireEvent.change(screen.getByLabelText('Grupo recomendado'), { target: { value: 't-u15' } });
    expect(onMarcar).toHaveBeenCalledWith({ leadId: 'l1', asistencia: null, teamRecomendado: 't-u15' });
  });

  it('[No vino] no toca el grupo (equipo NULL = solo marca)', () => {
    const onMarcar = vi.fn().mockResolvedValue({ ok: true });
    render(<ClasesPruebaDelDia clases={clase(HOY, { equipo_recomendado: { id: 't-inf', nombre: 'Infantil F' } })}
      hoy={HOY} equiposEscuela={EQUIPOS} guardando={false} onMarcar={onMarcar} />);
    fireEvent.click(screen.getByRole('button', { name: 'No vino' }));
    expect(onMarcar).toHaveBeenCalledWith({ leadId: 'l1', asistencia: 'no_vino', teamRecomendado: null });
  });

  it('si la base dice que no, muestra el error en palabras', async () => {
    const onMarcar = vi.fn().mockResolvedValue({ ok: false, error: 'Esta clase de prueba no es de tus equipos.' });
    render(<ClasesPruebaDelDia clases={clase(HOY)} hoy={HOY} equiposEscuela={[]} guardando={false} onMarcar={onMarcar} />);
    fireEvent.click(screen.getByRole('button', { name: 'No vino' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Esta clase de prueba no es de tus equipos.'));
    // Sin equipos de la escuela no se ofrece «Grupo recomendado».
    expect(screen.queryByLabelText('Grupo recomendado')).not.toBeInTheDocument();
  });

  it('cupo separado sin comprobante: se dice tal cual y no se marca asistencia (la RPC exige clase agendada)', () => {
    render(<ClasesPruebaDelDia clases={clase(HOY, { estado_cupo: 'separado', pago: null })} hoy={HOY} equiposEscuela={EQUIPOS} guardando={false} onMarcar={vi.fn()} />);
    expect(screen.getByText(/Cupo separado · sin comprobante/)).toBeInTheDocument();
    expect(screen.getByText(/Falta el comprobante: la clase todavía no está confirmada/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Asistió' })).not.toBeInTheDocument();
  });
});
