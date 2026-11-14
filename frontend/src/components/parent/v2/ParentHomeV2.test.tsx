import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ParentHomeV2 } from './ParentHomeV2';
import { usaInicioAcudienteV2, proximoEntreno, resumenFamilia, fraseEntrenoDeAgenda, type Cobro, type Hijo } from './parentHomeLogic';
import type { AgendaItem } from './parentCalendarModel';

describe('fraseEntrenoDeAgenda (Inicio = misma agenda que el Calendario)', () => {
  const ahora = new Date(2026, 9, 8, 10, 0); // jueves 8
  const item = (start: Date, kind: AgendaItem['kind'] = 'training'): AgendaItem => ({
    key: `k-${start.getTime()}`, start, allDay: false, kind, title: 'Entreno · Sofía', subtitle: null, tag: null, note: null,
  });
  it('toma el próximo entreno de la agenda', () => {
    const r = fraseEntrenoDeAgenda([item(new Date(2026, 9, 10, 9, 0)), item(new Date(2026, 9, 8, 16, 0))], ahora);
    expect(r?.frase).toEqual({ quien: 'Sofía', cuando: 'hoy a las 4:00 p. m.', donde: null });
  });
  it('si la agenda no tiene entrenos (festivo, cancelado) no hay franja', () => {
    expect(fraseEntrenoDeAgenda([item(new Date(2026, 9, 12, 0, 0), 'notice')], ahora)).toBeNull();
  });
  it('mañana y otro día de la semana', () => {
    expect(fraseEntrenoDeAgenda([item(new Date(2026, 9, 9, 17, 30))], ahora)?.frase.cuando).toBe('mañana a las 5:30 p. m.');
    expect(fraseEntrenoDeAgenda([item(new Date(2026, 9, 10, 9, 0))], ahora)?.frase.cuando).toBe('el sábado a las 9:00 a. m.');
  });
});

const estado = vi.hoisted(() => ({
  value: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, refetch: () => {} },
}));
vi.mock('./useParentHomeData', () => ({
  useParentHomeData: () => estado.value,
  parentHomeQueryKey: (id: string) => ['parent-home-v2', id],
}));
// La agenda del Calendario: sin datos, Inicio cae al horario del equipo.
vi.mock('./useParentCalendarData', () => ({ useParentAgenda: () => ({ data: undefined }) }));
vi.mock('@/lib/api/parents', () => ({ parentsAPI: { updateChild: vi.fn() } }));
// Convocatorias (B1): my_callups / respond_callup simulados.
const callups = vi.hoisted(() => ({ rows: [] as unknown[], responder: vi.fn() }));
vi.mock('@/lib/api/v2Contratos', () => ({
  misConvocatorias: async () => ({ data: callups.rows, error: null, noDisponible: false }),
  responderConvocatoria: callups.responder,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// Jueves 8 de octubre de 2026, 10:00 a. m.
const HOY = new Date(2026, 9, 8, 10, 0);

const SOFIA: Hijo = {
  id: 'c-sofia', nombre: 'Sofía Ramírez', avatarUrl: null, equipo: 'Fútbol Sub 11', profe: 'Laura Gómez',
  lugar: 'la cancha 2', franjas: [{ day: 4, time: '16:00', end: '17:30' }], eps: 'Sura EPS',
  fraseProfe: 'Este mes vino a 7 de 8 entrenos.', escuela: 'Club Campestre Demo',
};
const TOMAS: Hijo = {
  ...SOFIA, id: 'c-tomas', nombre: 'Tomás Ramírez', equipo: 'Fútbol Sub 8', fraseProfe: null,
  franjas: [{ day: 6, time: '09:00' }], eps: null,
};
const OCTUBRE_SOFIA: Cobro = {
  id: 'p-1', amount: 180_000, amount_paid: 0, status: 'pending', child_id: 'c-sofia', parent_id: 'u-1',
  due_date: '2026-10-10', period_year: 2026, period_month: 10, concept: 'Mensualidad Octubre', payment_category: 'mensualidad',
};

function pintar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ParentHomeV2 userId="u-1" nombreAcudiente="Carolina Pérez" hoy={HOY} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const conDatos = (hijos: Hijo[], cobros: Cobro[]) => {
  estado.value = { data: { hijos, cobros }, isLoading: false, isError: false, isFetching: false, refetch: () => {} };
};

describe('ParentHomeV2', () => {
  beforeEach(() => conDatos([SOFIA, TOMAS], []));

  it('familia que debe: frase del cobro, vencimiento y botón Pagar al cobro directo', () => {
    conDatos([SOFIA, TOMAS], [OCTUBRE_SOFIA]);
    pintar();
    expect(screen.getByRole('heading', { name: 'Falta la mensualidad de octubre de Sofía.' })).toBeInTheDocument();
    expect(screen.getByText('Vence el sábado 10. Lo de Tomás está al día.')).toBeInTheDocument();
    const pagar = screen.getByRole('link', { name: /Pagar/ });
    expect(pagar).toHaveAttribute('href', '/my-payments?pay=p-1');
    expect(pagar.textContent).toMatch(/180\.000/);
    expect(screen.getByText('Debe octubre')).toBeInTheDocument();
    expect(screen.getAllByTestId('tarjeta-hijo')).toHaveLength(2);
  });

  it('una sola campana: el Inicio no dibuja la suya (queda la de la cabecera de la app)', () => {
    pintar();
    expect(screen.queryByRole('link', { name: /Avisos/ })).toBeNull();
    expect(document.querySelector('a[href="/notifications"]')).toBeNull();
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('familia al día: sin botón de pagar y chips «Al día»', () => {
    pintar();
    expect(screen.getByRole('heading', { name: 'Todo al día, Carolina.' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Pagar/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Al día')).toHaveLength(2);
    expect(screen.getByText(/entrena/)).toHaveTextContent('Sofía entrena hoy a las 4:00 p. m. en la cancha 2.');
    expect(screen.getByText('Falta un dato de Tomás')).toBeInTheDocument();
  });

  it('B1: el hijo convocado trae «¿Va …?» y el acudiente responde Va', async () => {
    callups.rows = [{
      lineup_id: 'l-1', match_id: 'm-1', team_id: 't-1', subject_type: 'child', subject_id: 'c-tomas',
      athlete_name: 'Tomás Ramírez', role: 'starter', opponent: 'Halcones FC', match_date: '2026-10-31',
      kickoff_at: null, location: null, notes: null, response: null,
    }];
    callups.responder.mockResolvedValue({ data: { response: 'va' }, error: null, noDisponible: false });
    pintar();
    expect(await screen.findByText('¿Va Tomás al partido contra Halcones FC?')).toBeInTheDocument();
    // Solo en la tarjeta de Tomás, no en la de Sofía.
    expect(screen.getAllByTestId('convocatoria-hijo')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Va' }));
    await waitFor(() => expect(callups.responder).toHaveBeenCalledWith('l-1', { childId: 'c-tomas' }, 'va'));
    expect(await screen.findByText('Tomás va al partido')).toBeInTheDocument();
    callups.rows = [];
  });

  it('B10: «p. m.» no termina en doble punto cuando no hay lugar', () => {
    conDatos([{ ...SOFIA, lugar: null }], []);
    pintar();
    expect(screen.getByText(/entrena/).textContent).toBe('Sofía entrena hoy a las 4:00 p. m.');
  });

  it('un error de red NO se ve como «todo al día» (UX-2)', () => {
    estado.value = { data: undefined, isLoading: false, isError: true, isFetching: false, refetch: () => {} };
    pintar();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos cargar tu información.');
    expect(screen.queryByText(/Todo al día/)).not.toBeInTheDocument();
  });

  it('cargando: ni deuda ni «al día»', () => {
    estado.value = { data: undefined, isLoading: true, isError: false, isFetching: true, refetch: () => {} };
    pintar();
    expect(screen.getByLabelText('Cargando tu inicio')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});

describe('lógica del Inicio V2', () => {
  it('solo el acudiente usa el Inicio V2', () => {
    expect(usaInicioAcudienteV2('parent')).toBe(true);
    for (const r of ['school', 'school_admin', 'coach', 'athlete', 'admin', 'wellness_professional', undefined, null]) {
      expect(usaInicioAcudienteV2(r)).toBe(false);
    }
  });

  it('varios cobros o un abono parcial van a la lista, no al pago directo', () => {
    const parcial = { ...OCTUBRE_SOFIA, status: 'partial', amount_paid: 80_000 };
    const r = resumenFamilia([parcial], [SOFIA], 'Carolina', HOY);
    expect(r.total).toBe(100_000);
    expect(r.pagarHref).toBe('/my-payments');
    const dos = resumenFamilia([OCTUBRE_SOFIA, { ...OCTUBRE_SOFIA, id: 'p-2', period_month: 9 }], [SOFIA], 'Carolina', HOY);
    expect(dos.titulo).toBe('Sofía tiene 2 cobros pendientes.');
  });

  it('si hoy ya terminó el entreno, muestra el siguiente', () => {
    const tarde = new Date(2026, 9, 8, 18, 0);
    expect(proximoEntreno([SOFIA, TOMAS], tarde)?.frase).toEqual({ quien: 'Tomás', cuando: 'el sábado a las 9:00 a. m.', donde: 'la cancha 2' });
  });
});
