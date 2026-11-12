/**
 * «Enviar al acudiente»: primero simula (no manda nada), la escuela confirma, y
 * cada motivo por el que no se puede enviar se muestra tal como lo dice el servidor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EnviarAlAcudiente } from './EnviarAlAcudiente';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api/estadoCuentaEnlace', () => ({ enviarEstadoCuenta: vi.fn() }));
import { enviarEstadoCuenta } from '@/lib/api/estadoCuentaEnlace';

const ATLETA = { tipo: 'hijo' as const, id: 'h1' };
const PREVIA = { ok: true as const, simulado: true, canal: 'correo' as const, destino: 'c••••••@correo.co', atletas: ['Isabella A.', 'Juan A.'], vigenciaDias: 60 };
const mock = vi.mocked(enviarEstadoCuenta);

describe('EnviarAlAcudiente', () => {
  beforeEach(() => { mock.mockReset(); toast.mockReset(); });

  it('al tocar solo SIMULA: no manda nada y muestra a quién llegaría', async () => {
    mock.mockResolvedValue(PREVIA);
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    expect(await screen.findByText('c••••••@correo.co')).toBeTruthy();
    expect(screen.getByText('Isabella A., Juan A.')).toBeTruthy();
    expect(screen.getByText(/funciona 60 días/)).toBeTruthy();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith({ atleta: ATLETA, aplicar: false, reenviar: false });
  });

  it('solo al confirmar manda de verdad, y lo dice', async () => {
    mock.mockResolvedValueOnce(PREVIA).mockResolvedValueOnce({ ...PREVIA, simulado: false });
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Enviado a c••••••@correo.co.')).toBeTruthy();
    expect(mock).toHaveBeenLastCalledWith({ atleta: ATLETA, aplicar: true, reenviar: false });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Estado de cuenta enviado' }));
  });

  it('cancelar no manda nada', async () => {
    mock.mockResolvedValue(PREVIA);
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    expect(screen.getByRole('button', { name: /Enviar al acudiente/ })).toBeTruthy();
    expect(mock).toHaveBeenCalledTimes(1); // solo la simulación
  });

  it('sin correo: muestra el mensaje del servidor y no ofrece enviar', async () => {
    mock.mockResolvedValue({ ok: false, motivo: 'sin_correo', mensaje: 'Esta familia no tiene un correo registrado.' });
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('no tiene un correo registrado');
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reenviar' })).toBeNull();
  });

  it('fuera de horario y familia ya contactada hoy: solo el mensaje, sin «Reenviar»', async () => {
    for (const motivo of ['fuera_de_horario', 'contactada_hoy'] as const) {
      mock.mockResolvedValueOnce({ ok: false, motivo, mensaje: `Mensaje ${motivo}` });
      const { unmount } = render(<EnviarAlAcudiente atleta={ATLETA} />);
      fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
      expect((await screen.findByRole('alert')).textContent).toBe(`Mensaje ${motivo}`);
      expect(screen.queryByRole('button', { name: 'Reenviar' })).toBeNull();
      unmount();
    }
  });

  it('ya enviado hoy: ofrece «Reenviar» como acción aparte y consciente, con su propia confirmación', async () => {
    mock.mockResolvedValueOnce({ ok: false, motivo: 'ya_enviado_hoy', mensaje: 'Ya se le envió hoy.' })
      .mockResolvedValueOnce(PREVIA)
      .mockResolvedValueOnce({ ...PREVIA, simulado: false });
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reenviar' }));
    expect(mock).toHaveBeenLastCalledWith({ atleta: ATLETA, aplicar: false, reenviar: true });
    // La confirmación del reenvío vuelve a decir a dónde llega y exige otro clic.
    expect(await screen.findByText('c••••••@correo.co')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar' }));
    await waitFor(() => expect(mock).toHaveBeenLastCalledWith({ atleta: ATLETA, aplicar: true, reenviar: true }));
  });

  it('un error de red lo dice y deja volver a intentar', async () => {
    mock.mockRejectedValue(new Error('network'));
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo completar');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.getByRole('button', { name: /Enviar al acudiente/ })).toBeTruthy();
  });

  it('si el envío real falla en el servidor, muestra el motivo y no dice «enviado»', async () => {
    mock.mockResolvedValueOnce(PREVIA).mockResolvedValueOnce({ ok: false, motivo: 'fallo_envio', mensaje: 'No se pudo enviar el correo.' });
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo enviar el correo');
    expect(screen.queryByText(/^Enviado a/)).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  // ── Revisión antes de enviar ──
  it('«Enviarme una prueba»: pide la prueba (no una simulación ni un envío) y dice que a la familia no le llegó nada', async () => {
    mock.mockResolvedValue({ ...PREVIA, simulado: false, prueba: true, destino: 'a••••@club.co' });
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviarme una prueba/ }));
    expect(await screen.findByText(/Prueba enviada a a••••@club.co/)).toBeTruthy();
    expect(screen.getByText(/A la familia no le llegó nada/)).toBeTruthy();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith({ atleta: ATLETA, prueba: true });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Prueba enviada' }));
  });

  it('después de la prueba se puede pasar a enviar a la familia (con su simulación y su confirmación)', async () => {
    mock.mockResolvedValueOnce({ ...PREVIA, simulado: false, prueba: true }).mockResolvedValueOnce(PREVIA);
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviarme una prueba/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Enviar al acudiente/ }));
    expect(await screen.findByText(/Se enviará por correo a/)).toBeTruthy();
    expect(mock).toHaveBeenLastCalledWith({ atleta: ATLETA, aplicar: false, reenviar: false });
  });

  it('si la prueba no se puede enviar, dice por qué', async () => {
    mock.mockResolvedValue({ ok: false, motivo: 'no_disponible', mensaje: 'El envío del estado de cuenta todavía no está disponible.' });
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviarme una prueba/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('todavía no está disponible');
    expect(toast).not.toHaveBeenCalled();
  });

  it('«Ver el documento» solo aparece si hay documento que mostrar, y lo abre sin enviar nada', async () => {
    const ver = vi.fn();
    mock.mockResolvedValue(PREVIA);
    const { unmount } = render(<EnviarAlAcudiente atleta={ATLETA} onVerDocumento={ver} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Ver el documento/ }));
    expect(ver).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledTimes(1); // solo la simulación
    unmount();
    render(<EnviarAlAcudiente atleta={ATLETA} />);
    fireEvent.click(screen.getByRole('button', { name: /Enviar al acudiente/ }));
    await screen.findByText(/Se enviará por correo a/);
    expect(screen.queryByRole('button', { name: /Ver el documento/ })).toBeNull();
  });
});
