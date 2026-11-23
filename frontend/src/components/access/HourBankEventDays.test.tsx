import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), delete: (...a: unknown[]) => del(...a) },
  BFFError: class BFFError extends Error {},
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

import { HourBankEventDays, hoyEnBogota, mensajeAlGuardar } from './HourBankEventDays';
import { StudentReportPanel } from './StudentReportPanel';

const DIAS = [{ id: 'd1', exempt_date: '2026-12-12', time_from: null, time_to: null, reason: 'Competencia interna' }];
const SIN_AJUSTE = { duplicated: false, visits_waived: 0, minutes_returned: 0, athletes: [], overage_confirmed: 0 };

function montar(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

let conBancoDeHoras = true;
beforeEach(() => {
  get.mockReset(); post.mockReset(); del.mockReset(); toast.mockReset();
  conBancoDeHoras = true;
  get.mockImplementation((url: string) => Promise.resolve(
    url.includes('overage-settings') ? { hours_plan_enabled: conBancoDeHoras } : { days: DIAS }));
  post.mockResolvedValue(SIN_AJUSTE);
  del.mockResolvedValue({ success: true });
});

describe('mensajeAlGuardar', () => {
  it('día sin visitas todavía: nadie pierde horas ese día', () => {
    expect(mensajeAlGuardar('2026-12-12', SIN_AJUSTE)).toBe('El sábado, 12 de diciembre no se descuentan horas a nadie.');
  });
  it('día que ya pasó: dice cuánto devolvió y a quién', () => {
    expect(mensajeAlGuardar('2026-10-31', { ...SIN_AJUSTE, visits_waived: 1, minutes_returned: 120, athletes: ['Zoe Pérez'] }))
      .toBe('Se devolvieron 2h a Zoe Pérez.');
    expect(mensajeAlGuardar('2026-10-31', { ...SIN_AJUSTE, visits_waived: 4, minutes_returned: 360, athletes: ['A', 'B', 'C', 'D'] }))
      .toBe('Se devolvieron 6h a 4 deportistas.');
  });
  it('avisa si ya había un cobro de horas de más generado', () => {
    expect(mensajeAlGuardar('2026-10-31', { ...SIN_AJUSTE, visits_waived: 1, minutes_returned: 60, athletes: ['Ana'], overage_confirmed: 1 }))
      .toContain('hay un cobro de horas de más ya generado');
  });
});

describe('<HourBankEventDays />', () => {
  it('no aparece en una escuela sin banco de horas', async () => {
    conBancoDeHoras = false;
    montar(<HourBankEventDays />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('hb-eventos')).toBeNull();
    expect(get).not.toHaveBeenCalledWith('/api/v1/access/hour-bank-exempt-days');
  });

  it('lista los eventos guardados', async () => {
    montar(<HourBankEventDays />);
    expect(await screen.findByText(/Competencia interna/)).toBeTruthy();
    expect(screen.getByText(/sábado, 12 de diciembre/i)).toBeTruthy();
  });

  it('tres toques: abre con HOY puesto, pide el motivo y guarda el día completo', async () => {
    montar(<HourBankEventDays />);
    fireEvent.click(await screen.findByRole('button', { name: 'Evento: no descontar horas' }));
    expect((screen.getByLabelText('Día') as HTMLInputElement).value).toBe(hoyEnBogota());

    const guardar = screen.getByRole('button', { name: 'Guardar' });
    expect(guardar).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Falta: Escribe el motivo');

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Halloween' } });
    expect(guardar).toBeEnabled();
    fireEvent.click(guardar);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith('/api/v1/access/hour-bank-exempt-days',
      { date: hoyEnBogota(), reason: 'Halloween', time_from: null, time_to: null });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Evento guardado' })));
  });

  it('la franja está escondida y, si se usa, exige las dos horas en orden', async () => {
    montar(<HourBankEventDays />);
    fireEvent.click(await screen.findByRole('button', { name: 'Evento: no descontar horas' }));
    expect(screen.queryByLabelText('Desde')).toBeNull();
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Competencia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Solo unas horas del día' }));
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '14:00' } });
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '13:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent('La hora de fin debe ser posterior');
    fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/v1/access/hour-bank-exempt-days',
      expect.objectContaining({ time_from: '14:00', time_to: '18:00' })));
  });

  it('«Quitar» cancela el evento', async () => {
    montar(<HourBankEventDays />);
    fireEvent.click(await screen.findByRole('button', { name: /Quitar el evento del sábado, 12 de diciembre/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/v1/access/hour-bank-exempt-days/d1'));
  });
});

describe('<StudentReportPanel /> «No descontar»', () => {
  const reporte = (can_waive: boolean) => ({
    athlete_name: 'Zoe', range: { from: '2026-10-24', to: '2026-11-23' }, no_turnstile_data: false, events: [],
    hour_bank: {
      has_hours_plan: true, can_waive,
      visits: [
        { id: 'v1', status: 'closed', started_at: '2026-10-31T20:00:00Z', ended_at: '2026-10-31T22:00:00Z', billed_minutes: 120, auto_closed: false },
        { id: 'v2', status: 'closed', started_at: '2026-10-30T20:00:00Z', ended_at: '2026-10-30T21:00:00Z', billed_minutes: 0, auto_closed: false, waived_minutes: 60, waive_reason: 'Competencia interna' },
        { id: 'v3', status: 'pending_review', started_at: '2026-10-29T20:00:00Z', ended_at: null, billed_minutes: null, auto_closed: true },
      ],
    },
  });

  it('la dueña devuelve las horas de una visita con su motivo', async () => {
    get.mockResolvedValue(reporte(true));
    post.mockResolvedValue({ success: true, minutes: 120, overage_confirmed: false });
    montar(<StudentReportPanel enrollmentId="e1" />);

    // Solo la visita que descontó tiene el botón; la ya devuelta muestra su motivo.
    const botones = await screen.findAllByRole('button', { name: 'No descontar' });
    expect(botones).toHaveLength(1);
    expect(screen.getByText('No descontó horas')).toBeTruthy();
    expect(screen.getByText('Motivo: Competencia interna')).toBeTruthy();

    fireEvent.click(botones[0]);
    const devolver = screen.getByRole('button', { name: 'Devolver 2h' });
    expect(devolver).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Motivo para no descontar'), { target: { value: 'Halloween' } });
    fireEvent.click(devolver);

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/v1/access/hour-bank-visits/v1/waive', { reason: 'Halloween' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Horas devueltas' })));
  });

  it('quien no es dueña (familia, entrenador) no ve el botón', async () => {
    get.mockResolvedValue(reporte(false));
    montar(<StudentReportPanel enrollmentId="e1" />);
    expect(await screen.findByText('No descontó horas')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'No descontar' })).toBeNull();
  });
});
