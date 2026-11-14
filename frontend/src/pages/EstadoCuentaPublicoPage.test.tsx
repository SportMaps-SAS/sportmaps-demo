/**
 * /e/:token — la página que abre la familia desde el correo, sin login.
 * Se prueba lo que ve (y lo que no) en cada estado del enlace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { textoSobre } from '@/lib/colorContraste';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/api/bffClient', () => {
  class BFFError extends Error { constructor(public status: number, message: string, public body?: unknown) { super(message); } }
  return { BFFError, bffClient: {} };
});
vi.mock('@/lib/api/estadoCuentaEnlace', () => ({ obtenerEstadoCuentaPublico: vi.fn() }));
import { obtenerEstadoCuentaPublico, type VistaEstadoCuentaPublica } from '@/lib/api/estadoCuentaEnlace';
import { BFFError } from '@/lib/api/bffClient';
import EstadoCuentaPublicoPage from './EstadoCuentaPublicoPage';

const mock = vi.mocked(obtenerEstadoCuentaPublico);

const VISTA: VistaEstadoCuentaPublica = {
  escuela: { nombre: 'CLUB DEPORTIVO BESSER', logoUrl: 'https://x/logo.jpg', colorPrimario: '#E3000F', mostrarMarcaSportmaps: true },
  generadoEn: '2026-11-12T15:00:00Z',
  periodo: { desde: '2025-12-01', hasta: '2026-11-12', meses: 12 },
  enlaceVenceEn: '2027-01-11T00:00:00Z',
  pagarUrl: 'https://app.sportmaps.co/p/CobroTokenCobroToken123',
  atletas: [
    {
      nombre: 'Isabella A.',
      resumen: { count_expected: 3, total_expected: 1140000, count_settled: 1, total_settled: 380000, count_open: 2, total_open: 760000, total_late_fees: 0 },
      cobros: [
        { id: 'c1', status: 'paid', amount: 380000, amount_paid: 380000, concept: 'Mensualidad 09/2026', due_date: '2026-09-10', payment_date: '2026-09-08', period_year: 2026, period_month: 9, created_at: '2026-09-01T00:00:00Z', payment_method: 'transfer', payment_channel: 'transfer', payment_provider: 'wompi', receipt_url: 'recibido', wompi_reference: null },
        { id: 'c2', status: 'overdue', amount: 380000, amount_paid: null, concept: 'Mensualidad 11/2026', due_date: '2026-11-10', payment_date: null, period_year: 2026, period_month: 11, created_at: '2026-11-01T00:00:00Z', payment_method: null, payment_channel: null, payment_provider: 'wompi', receipt_url: null, wompi_reference: null },
      ],
      asistencia: { '2026-11': { asistio: 3, tarde: 0, excusada: 0, falto: 2, total: 5 } },
    },
    {
      nombre: 'Juan A.',
      resumen: { count_expected: 1, total_expected: 380000, count_settled: 1, total_settled: 380000, count_open: 0, total_open: 0, total_late_fees: 0 },
      cobros: [],
      asistencia: {},
    },
  ],
};

const pintar = () => render(
  <MemoryRouter initialEntries={['/e/TokenFamiliaTokenFamil12']}>
    <Routes><Route path="/e/:token" element={<EstadoCuentaPublicoPage />} /></Routes>
  </MemoryRouter>,
);

describe('EstadoCuentaPublicoPage', () => {
  beforeEach(() => { mock.mockReset(); });

  it('pide el estado con el token de la URL', async () => {
    mock.mockResolvedValue(VISTA);
    pintar();
    await screen.findByText('CLUB DEPORTIVO BESSER');
    expect(mock).toHaveBeenCalledWith('TokenFamiliaTokenFamil12');
  });

  it('muestra la escuela con su color, un bloque por hijo con su frase, y la marca de SportMaps', async () => {
    mock.mockResolvedValue(VISTA);
    pintar();
    expect(await screen.findByText('CLUB DEPORTIVO BESSER')).toBeTruthy();
    const encabezado = screen.getByText('CLUB DEPORTIVO BESSER').closest('header') as HTMLElement;
    expect(encabezado.style.backgroundColor).toBe('rgb(227, 0, 15)');
    expect(screen.getByRole('heading', { level: 1, name: /Isabella debe/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Juan está al día' })).toBeTruthy();
    expect(screen.getByText('Powered by SportMaps')).toBeTruthy();
  });

  it('el botón «Pagar» lleva al enlace de cobro y solo aparece si debe algo', async () => {
    mock.mockResolvedValue(VISTA);
    const { unmount } = pintar();
    const pagar = await screen.findByRole('link', { name: 'Pagar lo que está pendiente' });
    expect(pagar.getAttribute('href')).toBe('https://app.sportmaps.co/p/CobroTokenCobroToken123');
    unmount();
    mock.mockResolvedValue({ ...VISTA, atletas: [VISTA.atletas[1]] });
    pintar();
    await screen.findByRole('heading', { level: 1, name: 'Juan está al día' });
    expect(screen.queryByRole('link', { name: /Pagar/ })).toBeNull();
  });

  it('es solo lectura: no ofrece pagar dentro del detalle, ni «Ver comprobante», ni «Enviar»', async () => {
    mock.mockResolvedValue(VISTA);
    pintar();
    fireEvent.click(await screen.findByRole('button', { name: /Septiembre de 2026/ }));
    expect(screen.getByText('Pagó a tiempo')).toBeTruthy();
    expect(screen.getByText('Recibido por la escuela')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ver comprobante' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Pagar este cobro|Pagar el saldo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Enviar/ })).toBeNull();
  });

  it('muestra la asistencia resumida del mes', async () => {
    mock.mockResolvedValue(VISTA);
    pintar();
    fireEvent.click(await screen.findByRole('button', { name: /Noviembre de 2026/ }));
    expect(screen.getByText(/Asistió a 3 de 5 clases · 2 faltas/)).toBeTruthy();
  });

  it('dice que el enlace es personal y hasta cuándo funciona', async () => {
    mock.mockResolvedValue(VISTA);
    pintar();
    expect((await screen.findByText(/Este enlace es personal/)).textContent).toContain('2027');
  });

  it('no deja salir datos personales en pantalla', async () => {
    mock.mockResolvedValue(VISTA);
    const { container } = pintar();
    await screen.findByText('CLUB DEPORTIVO BESSER');
    expect(container.textContent).not.toMatch(/@|\b3\d{9}\b|comprobante-privado/);
  });

  it('404 → «Este enlace no es válido»; 410 → «ya no está disponible»', async () => {
    mock.mockRejectedValue(new BFFError(404, 'no_existe'));
    const a = pintar();
    expect((await screen.findByRole('alert')).textContent).toContain('Este enlace no es válido');
    a.unmount();
    mock.mockRejectedValue(new BFFError(410, 'vencido'));
    pintar();
    expect((await screen.findByRole('alert')).textContent).toContain('Este enlace ya no está disponible');
  });

  it('un error de red nunca se ve como «al día» y deja reintentar', async () => {
    mock.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(VISTA);
    pintar();
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('No pudimos cargar tu estado de cuenta');
    expect(alerta.textContent).toContain('no quiere decir que estés al día');
    expect(screen.queryByText(/está al día/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    await waitFor(() => expect(screen.getByText('CLUB DEPORTIVO BESSER')).toBeTruthy());
  });

  it('pide a los buscadores que no lo indexen', async () => {
    mock.mockResolvedValue(VISTA);
    pintar();
    await screen.findByText('CLUB DEPORTIVO BESSER');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
  });
});

describe('textoSobre: contraste del encabezado con el color de la escuela', () => {
  it('rojo y negro de Besser llevan texto blanco; amarillo y blanco, texto oscuro', () => {
    expect(textoSobre('#E3000F')).toBe('#ffffff');
    expect(textoSobre('#030303')).toBe('#ffffff');
    expect(textoSobre('#FFCC00')).toBe('#111111');
    expect(textoSobre('#ffffff')).toBe('#111111');
  });
  it('un valor que no es hex no rompe', () => {
    expect(textoSobre('rojo')).toBe('#ffffff');
    expect(textoSobre('')).toBe('#ffffff');
  });
});
