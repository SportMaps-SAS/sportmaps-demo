/** Hoja «⋯» de un entreno: Cancelar este día (por lluvia) · Mover · Entreno extra · Deshacer. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { AjustarEntrenoSheet, type AbrirAjuste } from './AjustarEntrenoSheet';
import { entrenosDelDia, type AjusteSemana, type EquipoSemana } from './semanaAjustesModel';

const SAB = '2026-10-31';
const EQUIPOS: EquipoSemana[] = [
  { id: 't-inf', name: 'Infantil F', franjas: [{ day: 6, time: '08:00', end: '10:00', place: 'Pinar 2' }] },
  { id: 't-u17', name: 'U17 M', franjas: [] },
];
const LISTA = EQUIPOS.map((e) => ({ id: e.id, name: e.name }));

const abrir = (ajustes: AjusteSemana[] = []): AbrirAjuste => ({ entreno: entrenosDelDia(SAB, EQUIPOS, ajustes)[0], fecha: SAB });

beforeEach(() => { toast.success.mockClear(); });

describe('AjustarEntrenoSheet', () => {
  it('Cancelar este día, por lluvia: manda la hora del horario y el motivo', async () => {
    const onAplicar = vi.fn().mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(<AjustarEntrenoSheet abierto={abrir()} equipos={LISTA} guardando={false} onAplicar={onAplicar} onClose={onClose} />);
    expect(screen.getByText('Infantil F')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancelar este día/ }));
    fireEvent.click(screen.getByRole('button', { name: /Por lluvia/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancelar el entreno de este día/ }));
    expect(onAplicar).toHaveBeenCalledWith({ tipo: 'cancelar', teamId: 't-inf', fecha: SAB, horaOriginal: '08:00', motivo: 'lluvia' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Infantil F: entreno cancelado.');
  });

  it('Mover: la hora de fin corre sola y se guarda con la hora del horario', async () => {
    const onAplicar = vi.fn().mockResolvedValue({ ok: true });
    const { container } = render(<AjustarEntrenoSheet abierto={abrir()} equipos={LISTA} guardando={false} onAplicar={onAplicar} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Mover hora o lugar/ }));
    const horas = container.ownerDocument.querySelectorAll('input[type="time"]');
    fireEvent.change(horas[0], { target: { value: '09:00' } });
    expect((horas[1] as HTMLInputElement).value).toBe('11:00');
    fireEvent.change(screen.getByPlaceholderText('Ej.: Cancha 2'), { target: { value: 'Liceo Fesan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar el cambio' }));
    expect(onAplicar).toHaveBeenCalledWith({
      tipo: 'mover', teamId: 't-inf', fecha: SAB, horaOriginal: '08:00', ajusteId: undefined, horaInicio: '09:00', horaFin: '11:00', lugar: 'Liceo Fesan',
    });
  });

  it('un entreno cancelado solo ofrece deshacer (borra ese ajuste)', () => {
    const onAplicar = vi.fn().mockResolvedValue({ ok: true });
    const c: AjusteSemana = { id: 'c1', team_id: 't-inf', fecha: SAB, tipo: 'cancelada', hora_original: '08:00', hora_inicio: null, hora_fin: null, lugar: null };
    render(<AjustarEntrenoSheet abierto={abrir([c])} equipos={LISTA} guardando={false} onAplicar={onAplicar} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Mover hora o lugar/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Deshacer la cancelación/ }));
    expect(onAplicar).toHaveBeenCalledWith({ tipo: 'deshacer', teamId: 't-inf', ajusteIds: ['c1'] });
  });

  it('un entreno movido: cambiar otra vez actualiza el mismo ajuste, o deshacer vuelve al de siempre', () => {
    const onAplicar = vi.fn().mockResolvedValue({ ok: true });
    const m: AjusteSemana = { id: 'm1', team_id: 't-inf', fecha: SAB, tipo: 'movida', hora_original: '08:00', hora_inicio: '09:00', hora_fin: '11:00', lugar: null };
    render(<AjustarEntrenoSheet abierto={abrir([m])} equipos={LISTA} guardando={false} onAplicar={onAplicar} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Deshacer el cambio/ }));
    expect(onAplicar).toHaveBeenLastCalledWith({ tipo: 'deshacer', teamId: 't-inf', ajusteIds: ['m1'] });
    fireEvent.click(screen.getByRole('button', { name: /Cambiar otra vez/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar el cambio' }));
    expect(onAplicar).toHaveBeenLastCalledWith(expect.objectContaining({ tipo: 'mover', ajusteId: 'm1', horaOriginal: '08:00', horaInicio: '09:00' }));
  });

  it('Entreno extra sin partir de un entreno: elige día, equipo y horas', () => {
    const onAplicar = vi.fn().mockResolvedValue({ ok: true });
    const { container } = render(<AjustarEntrenoSheet abierto={{ entreno: null, fecha: SAB }} equipos={LISTA} guardando={false} onAplicar={onAplicar} onClose={vi.fn()} />);
    expect(screen.getByText('Entreno extra')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Equipo'), { target: { value: 't-u17' } });
    const horas = container.ownerDocument.querySelectorAll('input[type="time"]');
    fireEvent.change(horas[0], { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar el entreno' }));
    expect(onAplicar).toHaveBeenCalledWith({ tipo: 'extra', teamId: 't-u17', fecha: SAB, horaInicio: '18:00', horaFin: null, lugar: null });
  });

  it('si la base no deja, el error se queda en la hoja (no se cierra)', async () => {
    const onAplicar = vi.fn().mockResolvedValue({ ok: false, error: 'No tienes permiso para cambiar este equipo. Pídeselo a la administración.' });
    const onClose = vi.fn();
    render(<AjustarEntrenoSheet abierto={abrir()} equipos={LISTA} guardando={false} onAplicar={onAplicar} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Cancelar este día/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancelar el entreno de este día/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No tienes permiso');
    expect(onClose).not.toHaveBeenCalled();
  });
});
