import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CoachTeamsV2 } from './CoachTeamsV2';
import { CoachEvaluateV2 } from './CoachEvaluateV2';
import { CoachHomeV2 } from './CoachHomeV2';
import type { Deportista, EstadoPago } from './coachV2Logic';
import { toast } from 'sonner';

// ── Estado de los hooks de datos, controlado por cada prueba ────────────────
const q = <T,>(data: T, extra: Record<string, unknown> = {}) => ({
  data, isLoading: false, isError: false, isFetching: false, refetch: vi.fn(), ...extra,
});

const st = vi.hoisted(() => ({
  hide: false,
  /** coach_can_create_athletes / coach_can_create_teams (Carmel). */
  altas: false,
  crearEquipos: false,
  equipos: null as unknown,
  deportistas: null as unknown,
  pago: null as unknown,
  felicitar: null as unknown,
  sesion: null as unknown,
  presentes: null as unknown,
  sesiones: null as unknown,
  conv: null as unknown,
  buscar: null as unknown,
  partidos: null as unknown,
  informes: null as unknown,
  escuela: { schoolId: 'school-1' as string | null, loading: false },
  ultimaJugada: { data: null } as unknown,
  rpc: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('./useCoachV2Data', () => ({
  useEquiposCoach: () => st.equipos,
  useDeportistasEquipo: () => st.deportistas,
  useEstadoPagoEquipo: (_t: string, habilitado: boolean) => (habilitado ? st.pago : { data: undefined, isLoading: false }),
  useFelicitarDisponible: () => st.felicitar,
  useSesionDetalle: () => st.sesion,
  usePresentesSesion: () => st.presentes,
  useSesionesRecientes: () => st.sesiones,
  usePlanesDeHoy: () => ({ data: [], isLoading: false }),
  useInformesDelMes: () => st.informes,
  usePartidosProximos: () => ({ data: [], isLoading: false }),
  useCitasDeHoy: () => ({ data: [] }),
  usePartidosEquipo: () => st.partidos,
  useConvocatoria: (matchId: string | null) => (matchId === 'm1' ? st.conv : { data: null, isLoading: false }),
  useRespuestasConvocatoria: () => ({ data: undefined }),
  useNombresConvocados: () => ({ data: new Map([['child:r9', 'Juan Refuerzo'], ['profile:u7', 'Pedro Inactivo']]) }),
  useBuscarRefuerzos: (_s: string, _t: string, texto: string) => (texto.trim().length >= 2 ? st.buscar : { data: [], isLoading: false }),
  useUltimaJugada: () => st.ultimaJugada,
}));
vi.mock('@/components/support/SupportChatModal', () => ({ SupportChatModal: () => null }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ ...st.escuela, schoolName: 'Club Campestre Demo' }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-coach' }, profile: { full_name: 'Laura Gómez' } }) }));
vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ coachHideFinancialInfo: st.hide, coachCanCreateAthletes: st.altas, coachCanCreateTeams: st.crearEquipos }),
}));
// Los modales de alta son los de la pantalla clásica (se prueban aparte): aquí solo que se abran con el equipo correcto.
vi.mock('@/components/teams/EnrollTeamStudentModal', () => ({
  EnrollTeamStudentModal: (p: { team: { id: string; name: string } | null }) => <div data-testid="modal-inscribir">{p.team?.id}:{p.team?.name}</div>,
}));
vi.mock('@/components/students/CreateChildModal', () => ({
  CreateChildModal: (p: { defaultTeamId?: string; canWaiveFees?: boolean }) => <div data-testid="modal-nuevo">{p.defaultTeamId}:{String(p.canWaiveFees)}</div>,
}));
vi.mock('@/components/teams/CreateTeamModal', () => ({
  CreateTeamModal: (p: { schoolId: string }) => <div data-testid="modal-crear-equipo">{p.schoolId}</div>,
}));
vi.mock('@/hooks/useSchoolAthleteAvailability', () => ({
  useSchoolAthleteAvailability: () => ({ byChildId: new Map(), byProfileId: new Map(), list: [] }),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: st.rpc } }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: { get: vi.fn(), post: st.post, patch: st.patch } }));
vi.mock('@/components/school/LineupModal', () => ({ LineupModal: () => null }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

function pintar(ui: ReactNode, ruta = '/') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[ruta]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const HOY = new Date(2026, 9, 8, 10, 0);
const EQUIPO = {
  id: 't11', nombre: 'Fútbol Sub 11', lugar: 'Cancha 2', deportistas: 3, deporte: 'futbol', imagen: null,
  franjas: [{ day: 4, time: '16:00', end: '17:30' }],
};
const dep = (id: string, nombre: string, extra: Partial<Deportista> = {}): Deportista => ({
  id, tipo: 'child', userId: null, nombre, avatarUrl: null, acudiente: 'Carolina Pérez', telefonoAcudiente: '3001234567', ...extra,
});
const DEPORTISTAS = [dep('c1', 'Sofía Rojas'), dep('c2', 'Mateo Gómez'), dep('c3', 'Valentina Ruiz')];

beforeEach(() => {
  st.hide = false;
  st.altas = false;
  st.crearEquipos = false;
  st.equipos = q([EQUIPO]);
  st.deportistas = q(DEPORTISTAS);
  st.pago = q({ disponible: true, mapa: new Map<string, EstadoPago>([['c1', 'al_dia'], ['c2', 'pendiente'], ['c3', 'vencido']]) });
  st.felicitar = q(true);
  st.sesiones = q([]);
  st.conv = q(null);
  st.partidos = q([]);
  st.informes = q({ puedePublicar: false, equipos: [] });
  st.escuela = { schoolId: 'school-1', loading: false };
  st.ultimaJugada = { data: null };
  st.post.mockReset();
  st.patch.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  st.rpc.mockReset();
  st.rpc.mockResolvedValue({ data: { saved: 3, pending: 0 }, error: null });
});

describe('Equipos › Deportistas: el profe nunca ve montos', () => {
  it('muestra solo Al día · Pendiente · Vencido y ningún valor de plata', () => {
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=deportistas');
    const chips = screen.getAllByTestId('chip-pago').map((c) => c.textContent);
    expect(chips).toEqual(['Al día', 'Pendiente', 'Vencido']);
    const texto = document.body.textContent ?? '';
    expect(texto).not.toMatch(/\$/);
    expect(texto).not.toMatch(/\d{1,3}(\.\d{3})+/); // 180.000
    expect(texto).not.toMatch(/mensualidad|inscripci[oó]n|cobro|COP/i);
  });

  it('aunque la RPC mande montos o estados raros, no se pintan', () => {
    st.pago = q({ disponible: true, mapa: new Map([['c1', '$180.000' as unknown as EstadoPago], ['c2', 'vencido']]) });
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    expect(screen.getAllByTestId('chip-pago').map((c) => c.textContent)).toEqual(['Vencido']);
    expect(document.body.textContent).not.toMatch(/\$|180/);
  });

  it('si la escuela oculta lo financiero al profe, no hay chip', () => {
    st.hide = true;
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    expect(screen.queryAllByTestId('chip-pago')).toHaveLength(0);
    expect(screen.getAllByTestId('fila-deportista')).toHaveLength(3);
  });

  it('sin la RPC team_payment_status, la lista sale igual y sin chip', () => {
    st.pago = q({ disponible: false, mapa: new Map() });
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    expect(screen.queryAllByTestId('chip-pago')).toHaveLength(0);
    expect(screen.getByText('Sofía Rojas')).toBeInTheDocument();
  });

  it('al tocar a alguien: Escribir al acudiente (WhatsApp), Felicitar y Ver ficha', () => {
    pintar(<CoachTeamsV2 hoy={HOY} nombreProfe="Laura Gómez" />, '/teams?equipo=t11');
    fireEvent.click(screen.getByText('Sofía Rojas'));
    const wa = screen.getByRole('link', { name: /Escribir al acudiente/ });
    expect(wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/573001234567\?text=/);
    expect(screen.getByRole('button', { name: /Felicitar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ver ficha/ })).toBeInTheDocument();
  });

  it('si team_payment_status falla, una línea discreta y sin montos', () => {
    st.pago = q(undefined, { isError: true });
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    expect(screen.queryAllByTestId('chip-pago')).toHaveLength(0);
    expect(screen.getByTestId('aviso-pago')).toHaveTextContent('No pudimos cargar el estado de pago.');
    expect(document.body.textContent).not.toMatch(/\$/);
  });

  it('sin give_kudos no aparece Felicitar', () => {
    st.felicitar = q(false);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    fireEvent.click(screen.getByText('Sofía Rojas'));
    expect(screen.queryByRole('button', { name: /Felicitar/ })).not.toBeInTheDocument();
  });

  it('lista de equipos: carga, error y vacío son distintos', () => {
    st.equipos = q([]);
    const { unmount } = pintar(<CoachTeamsV2 hoy={HOY} />, '/teams');
    expect(screen.getByText('Todavía no tienes equipos asignados.')).toBeInTheDocument();
    unmount();
    st.equipos = q(undefined, { isError: true });
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams');
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos traer tus equipos');
    expect(screen.queryByText('Todavía no tienes equipos asignados.')).not.toBeInTheDocument();
  });
});

describe('Equipos › altas del profe (Carmel 11-07: la V2 había quitado Inscribir, Nuevo deportista y Crear equipo)', () => {
  it('sin los permisos de la escuela no aparece ningún botón de alta (como siempre en la V2)', () => {
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    expect(screen.queryByRole('button', { name: /Inscribir deportistas/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Nuevo deportista/ })).not.toBeInTheDocument();
  });

  it('sin permisos, el equipo vacío sigue diciendo que la escuela inscribe', () => {
    st.deportistas = q([]);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    expect(screen.getByText(/La escuela los inscribe/)).toBeInTheDocument();
    expect(screen.queryByTestId('altas-deportista')).not.toBeInTheDocument();
  });

  it('con coach_can_create_athletes: «Inscribir deportistas» abre el modal de ESTE equipo', async () => {
    st.altas = true;
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    fireEvent.click(screen.getByRole('button', { name: /Inscribir deportistas/ }));
    expect(await screen.findByTestId('modal-inscribir')).toHaveTextContent('t11:Fútbol Sub 11');
  });

  it('«Nuevo deportista» abre la ficha con el equipo ya elegido y sin exonerar cobros', async () => {
    st.altas = true;
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    fireEvent.click(screen.getByRole('button', { name: /Nuevo deportista/ }));
    expect(await screen.findByTestId('modal-nuevo')).toHaveTextContent('t11:false');
  });

  it('equipo vacío con permiso: invita a inscribir y trae los dos botones', () => {
    st.altas = true;
    st.deportistas = q([]);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11');
    expect(screen.queryByText(/La escuela los inscribe/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inscribir deportistas/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Nuevo deportista/ })).toBeInTheDocument();
  });

  it('«Crear equipo» solo con coach_can_create_teams, también con la lista vacía', async () => {
    const { unmount } = pintar(<CoachTeamsV2 hoy={HOY} />, '/teams');
    expect(screen.queryByTestId('crear-equipo')).not.toBeInTheDocument();
    unmount();
    st.crearEquipos = true;
    st.equipos = q([]);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams');
    expect(screen.getByText(/Crea tu primer equipo/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('crear-equipo'));
    expect(await screen.findByTestId('modal-crear-equipo')).toHaveTextContent('school-1');
  });
});

describe('Evaluar al equipo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    st.sesion = q({ id: 's1', teamId: 't11', schoolId: 'school-1', fecha: '2026-10-06', cerrada: true, nota: null, equipo: 'Sub 11', previas: {} });
    st.presentes = q([
      { clave: 'c1', childId: 'c1', userId: null, sinCuenta: false, nombre: 'Sofía Rojas', avatarUrl: null },
      { clave: 'u2', childId: null, userId: 'u2', sinCuenta: false, nombre: 'Mateo Gómez', avatarUrl: null },
      { clave: 'x3', childId: null, userId: null, sinCuenta: true, nombre: 'Ana Moyano', avatarUrl: null },
    ]);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('solo los que vinieron, todos arrancan en Normal; sin cuenta no se califica', () => {
    pintar(<CoachEvaluateV2 sessionId="s1" />);
    expect(screen.getAllByTestId('fila-evaluar')).toHaveLength(3);
    const grupos = screen.getAllByRole('radiogroup');
    expect(grupos).toHaveLength(2);
    for (const g of grupos) expect(within(g).getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Sin cuenta todavía/)).toBeInTheDocument();
  });

  it('«A todos: Bien» y guardar con Deshacer: escribe a los 8 s con la escala 90/70/60', async () => {
    pintar(<CoachEvaluateV2 sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'A todos: Bien' }));
    fireEvent.click(within(screen.getAllByRole('radiogroup')[1]).getByRole('radio', { name: 'Le costó' }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar evaluación \(1 bien · 1 le costó\)/ }));
    expect(st.rpc).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(st.rpc).toHaveBeenCalledWith('submit_post_training_coach_rating', {
      p_session_id: 's1',
      p_ratings: [{ child_id: 'c1', effort_pct: 90 }, { user_id: 'u2', effort_pct: 60 }],
      p_coach_notes: null,
    });
    expect(vi.mocked(toast.success).mock.calls.some(([m]) => /Evaluación guardada/.test(String(m)))).toBe(true);
    expect(screen.getByRole('button', { name: 'Guardado' })).toBeInTheDocument();
  });

  it('B3: no dice «Guardado» antes de la RPC, y si la base rechaza muestra el motivo de verdad', async () => {
    st.rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'La escuela no tiene configurada la métrica de rating del coach.' } });
    pintar(<CoachEvaluateV2 sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /Guardar evaluación/ }));
    expect(screen.queryByRole('button', { name: 'Guardado' })).toBeNull();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(screen.getByTestId('error-evaluar')).toHaveTextContent('No se guardó: La escuela no tiene configurada la métrica de rating del coach.');
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toMatch(/conexión/);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Guardar evaluación/ })).toBeInTheDocument();
  });

  it('Felicitar se oculta si la RPC no existe', () => {
    st.felicitar = q(false);
    pintar(<CoachEvaluateV2 sessionId="s1" />);
    expect(screen.queryByRole('button', { name: /Felicitar/ })).not.toBeInTheDocument();
  });

  describe('con la lista abierta (Besser 10-24→29: «Evaluar» sin cerrar no tenía salida)', () => {
    const abierta = () => q({ id: 's1', teamId: 't11', schoolId: 'school-1', fecha: '2026-10-06', cerrada: false, nota: null, equipo: 'Sub 11', previas: {} });

    it('la cierra aquí mismo con «Cerrar la lista y evaluar»', async () => {
      st.sesion = abierta();
      st.patch.mockResolvedValue({ success: true });
      pintar(<CoachEvaluateV2 sessionId="s1" />);
      expect(screen.getByText('La lista de este entreno sigue abierta.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Revisar la lista' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cerrar la lista y evaluar' })); });
      expect(st.patch).toHaveBeenCalledWith('/api/v1/attendance/session/s1/finalize', {});
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it('si ya la había cerrado la escuela (409), no es un error', async () => {
      st.sesion = abierta();
      st.patch.mockRejectedValue(Object.assign(new Error('La sesión ya estaba finalizada.'), { status: 409 }));
      pintar(<CoachEvaluateV2 sessionId="s1" />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cerrar la lista y evaluar' })); });
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it('si el cierre falla de verdad, dice por qué y deja reintentar', async () => {
      st.sesion = abierta();
      st.patch.mockRejectedValue(Object.assign(new Error('No tienes acceso a este equipo.'), { status: 403 }));
      pintar(<CoachEvaluateV2 sessionId="s1" />);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cerrar la lista y evaluar' })); });
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('No se pudo cerrar la lista: No tienes acceso a este equipo.');
      expect(screen.getByRole('button', { name: 'Cerrar la lista y evaluar' })).toBeEnabled();
    });
  });
});

describe('Hoy', () => {
  it('antes del entreno: frase y «Tomar lista»', () => {
    pintar(<CoachHomeV2 hoy={new Date(2026, 9, 8, 15, 20)} nombreProfe="Laura Gómez" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('En 40 minutos entrenas a Fútbol Sub 11.');
    expect(screen.getByRole('link', { name: /Tomar lista/ })).toHaveAttribute('href', '/coach-attendance');
    expect(screen.getByText('Nada pendiente. Buen trabajo, profe.')).toBeInTheDocument();
  });

  it('después, con lista cerrada sin evaluar: «Evaluar al equipo» y el pendiente', () => {
    st.sesiones = q([{ id: 's1', teamId: 't11', fecha: '2026-10-08', cerrada: true, evaluada: false }]);
    st.presentes = q([{ clave: 'c1' }, { clave: 'c2' }]);
    pintar(<CoachHomeV2 hoy={new Date(2026, 9, 8, 18, 0)} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Vinieron 2 de 3. ¿Cómo le fue a Fútbol Sub 11?');
    expect(screen.getByRole('link', { name: 'Evaluar al equipo' })).toHaveAttribute('href', '/coach/evaluar/s1');
    expect(screen.getAllByTestId('pendiente')[0]).toHaveTextContent('Falta evaluar el entreno de hoy');
  });

  it('una sola campana: el Inicio no dibuja la suya (queda la de la cabecera de la app)', () => {
    pintar(<CoachHomeV2 hoy={HOY} />);
    expect(screen.queryByRole('link', { name: /Avisos/ })).toBeNull();
    expect(document.querySelector('a[href="/notifications"]')).toBeNull();
    expect(screen.getByRole('banner')).toHaveTextContent('Club Campestre Demo');
  });

  it('botón grande «Pizarra» que abre /pizarra', () => {
    pintar(<CoachHomeV2 hoy={new Date(2026, 9, 8, 15, 20)} />);
    expect(screen.getByTestId('boton-pizarra')).toHaveAttribute('href', '/pizarra');
    expect(screen.queryByTestId('dia-libre')).toBeNull();
  });

  it('«Hoy no entrenas» no deja la pantalla vacía: semana, última jugada y pizarra', () => {
    // Martes 6-oct: Fútbol Sub 11 entrena los jueves.
    st.sesiones = q([{ id: 's0', teamId: 't11', fecha: '2026-10-05', cerrada: true, evaluada: false }]);
    st.ultimaJugada = { data: { id: 'j1', teamId: 't11', fuente: 'training_session', fecha: '2026-10-04T15:00:00Z' } };
    pintar(<CoachHomeV2 hoy={new Date(2026, 9, 6, 10, 0)} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Hoy no entrenas.');
    const libre = screen.getByTestId('dia-libre');
    expect(libre).toHaveTextContent('sin evaluar');
    expect(screen.getByTestId('ultima-jugada')).toHaveAttribute('href', '/pizarra?jugada=j1');
    expect(within(libre).getByRole('link', { name: /Abrir la pizarra/ })).toHaveAttribute('href', '/pizarra');
    expect(screen.queryByTestId('sin-horario')).toBeNull();
  });

  it('equipo sin horario fijo: ofrece «Agregar horario»', () => {
    st.equipos = q([{ ...EQUIPO, franjas: [] }]);
    pintar(<CoachHomeV2 hoy={HOY} />);
    expect(screen.getByTestId('sin-horario')).toHaveTextContent('Fútbol Sub 11 no tiene horario fijo.');
    expect(screen.getByTestId('agregar-horario')).toBeInTheDocument();
  });

  it('un error al cargar NO dice «Hoy no entrenas»', () => {
    st.equipos = q(undefined, { isError: true });
    pintar(<CoachHomeV2 hoy={HOY} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Hoy no entrenas.')).not.toBeInTheDocument();
  });
});

describe('Partidos › entradas a la pantalla del partido', () => {
  it('«+ Partido» abre el flujo nuevo del equipo; un partido sin resultado ya pasado ofrece cerrarlo', () => {
    st.partidos = q([
      { id: 'm9', rival: 'Tigres', fecha: '2026-10-04', kickoffAt: null, lugar: null, enCasa: true, golesLocal: null, golesVisita: null, estado: 'scheduled', tipo: null, nota: null },
      { id: 'm8', rival: 'Leones', fecha: '2026-10-01', kickoffAt: null, lugar: null, enCasa: true, golesLocal: 2, golesVisita: 1, estado: 'played', tipo: null, nota: null },
    ]);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=partidos');
    expect(screen.getByRole('link', { name: /Partido/ })).toHaveAttribute('href', '/partidos/nuevo?equipo=t11');
    const porCerrar = screen.getByTestId('partidos-por-cerrar');
    expect(within(porCerrar).getByRole('link')).toHaveAttribute('href', '/partidos/m9');
    expect(screen.getByRole('link', { name: /Ganamos a Leones/ })).toHaveAttribute('href', '/partidos/m8');
  });
});

describe('Partidos › convocatoria con refuerzos', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    st.partidos = q([{
      id: 'm1', rival: 'Halcones', fecha: '2026-10-10', kickoffAt: null, lugar: null, enCasa: null,
      golesLocal: null, golesVisita: null, estado: null, tipo: null, nota: null,
    }]);
    st.conv = q({
      id: 'l1',
      players: [
        { id: 'p1', subject_type: 'child', subject_id: 'c1', role: 'starter', position_code: 'GK', jersey_number: 1, minutes_played: null },
        { id: 'p2', subject_type: 'child', subject_id: 'r9', role: 'bench', position_code: null, jersey_number: 14, minutes_played: null },
        { id: 'p3', subject_type: 'profile', subject_id: 'u7', role: 'starter', position_code: null, jersey_number: null, minutes_played: null },
      ],
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('cambiar la convocatoria conserva a los refuerzos (otra categoría o inactivos) y se pueden quitar a propósito', async () => {
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=partidos');
    fireEvent.click(screen.getByRole('button', { name: /Cambiar convocatoria/ }));
    const refuerzos = screen.getAllByTestId('convocado-refuerzo');
    expect(refuerzos).toHaveLength(2);
    expect(refuerzos[0]).toHaveTextContent(/Juan.*Refuerzo/);
    expect(refuerzos[1]).toHaveTextContent(/Pedro.*Refuerzo/);
    for (const r of refuerzos) expect(r).toHaveAttribute('aria-checked', 'true');
    // Se suma a Mateo (roster) y se quita a propósito a Pedro (refuerzo).
    fireEvent.click(screen.getByRole('checkbox', { name: /Mateo/ }));
    fireEvent.click(refuerzos[1]);
    fireEvent.click(screen.getByRole('button', { name: /Convocar a 3/ }));
    expect(st.rpc).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(st.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = st.rpc.mock.calls[0];
    expect(fn).toBe('save_match_roster');
    const jugadores = (args as { p_players: Array<Record<string, unknown>> }).p_players;
    expect(jugadores.map((j) => `${j.subject_type}:${j.subject_id}`).sort()).toEqual(['child:c1', 'child:c2', 'child:r9']);
    // El refuerzo conserva su rol y dorsal; el de siempre, su posición.
    expect(jugadores.find((j) => j.subject_id === 'r9')).toMatchObject({ role: 'bench', jersey_number: 14 });
    expect(jugadores.find((j) => j.subject_id === 'c1')).toMatchObject({ position_code: 'GK', jersey_number: 1 });
  });

  it('buscar y convocar a un deportista de otra categoría lo suma a la convocatoria', async () => {
    st.buscar = q([{ subject_type: 'child', subject_id: 'c5', nombre: 'Camila Otra Categoría', equipo: '2012' }]);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=partidos');
    fireEvent.click(screen.getByRole('button', { name: /Cambiar convocatoria/ }));
    fireEvent.click(screen.getByRole('button', { name: /Convocar de otra categoría/ }));
    fireEvent.change(screen.getByPlaceholderText(/Buscar por nombre/), { target: { value: 'Camila' } });
    await act(async () => { vi.advanceTimersByTime(350); });
    fireEvent.click(screen.getByRole('button', { name: /Camila.*2012/ }));
    // Queda convocada como refuerzo nuevo, ya marcada.
    const refuerzosTras = screen.getAllByTestId('convocado-refuerzo');
    expect(refuerzosTras).toHaveLength(3);
    const nuevoRefuerzo = refuerzosTras.find((el) => /Camila/.test(el.textContent ?? ''));
    expect(nuevoRefuerzo).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Convocar a 4/ }));
    await act(async () => { vi.advanceTimersByTime(8000); });
    const [, args] = st.rpc.mock.calls[0];
    const jugadores = (args as { p_players: Array<Record<string, unknown>> }).p_players;
    expect(jugadores.map((j) => `${j.subject_type}:${j.subject_id}`)).toContain('child:c5');
  });

  it('si falla, el aviso es en español y sin el mensaje crudo del servidor', async () => {
    st.rpc.mockResolvedValue({ data: null, error: { message: 'duplicate key value violates unique constraint "x"' } });
    const consola = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=partidos');
    fireEvent.click(screen.getByRole('button', { name: /Cambiar convocatoria/ }));
    fireEvent.click(screen.getByRole('button', { name: /Convocar a 3/ }));
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(toast.error).toHaveBeenCalledWith('No pudimos guardar la convocatoria. Revisa tu conexión e inténtalo de nuevo.');
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toMatch(/duplicate key/);
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/^Convocaste/));
    consola.mockRestore();
  });
});

describe('Evaluar › publicar informes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    st.informes = q({ puedePublicar: true, equipos: [{ teamId: 't11', total: 3, publicados: 0, listos: 3, faltanNota: 0 }] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('«Publicamos N informes» sale SOLO cuando el servidor confirma', async () => {
    let resolver: (v: unknown) => void = () => {};
    st.post.mockImplementation(() => new Promise((r) => { resolver = r; }));
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=evaluar');
    fireEvent.click(screen.getByRole('button', { name: 'Publicar los 3' }));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/^Publicamos/), expect.anything());
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(st.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success).mock.calls.some(([m]) => /^Publicamos/.test(String(m)))).toBe(false);
    await act(async () => { resolver({ results: [{ resultado: 'ok', detalle: null }, { resultado: 'ok', detalle: null }, { resultado: 'ok', detalle: null }] }); });
    expect(toast.success).toHaveBeenCalledWith('Publicamos 3 informes. Las familias ya pueden verlos.');
  });

  it('si falla, no hay toast de éxito ni error.message crudo', async () => {
    st.post.mockRejectedValue(new Error('TypeError: Failed to fetch at bffClient.ts:88'));
    const consola = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=evaluar');
    fireEvent.click(screen.getByRole('button', { name: 'Publicar los 3' }));
    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(toast.error).toHaveBeenCalledWith('No pudimos publicar los informes. Revisa tu conexión e inténtalo de nuevo.');
    expect(vi.mocked(toast.success).mock.calls.some(([m]) => /^Publicamos/.test(String(m)))).toBe(false);
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toMatch(/Failed to fetch/);
    expect(consola).toHaveBeenCalled();
    consola.mockRestore();
  });
});

describe('Hoy sin escuela', () => {
  it('sin schoolId (ya resuelto) no se queda en el esqueleto: pide a la escuela que lo asigne', () => {
    st.escuela = { schoolId: null, loading: false };
    pintar(<CoachHomeV2 hoy={HOY} />);
    expect(screen.getByTestId('sin-escuela')).toHaveTextContent('Pídele a la escuela que te asigne');
    expect(screen.queryByLabelText('Cargando tu día')).not.toBeInTheDocument();
  });

  it('mientras el contexto carga, sí muestra el esqueleto', () => {
    st.escuela = { schoolId: null, loading: true };
    pintar(<CoachHomeV2 hoy={HOY} />);
    expect(screen.getByLabelText('Cargando tu día')).toBeInTheDocument();
  });
});

describe('Evaluar › entrenos caídos', () => {
  it('con attendance_sessions caído: solo el error, no «No hay entrenos con lista»', () => {
    st.sesiones = q(undefined, { isError: true });
    pintar(<CoachTeamsV2 hoy={HOY} />, '/teams?equipo=t11&tab=evaluar');
    expect(screen.getByText('No pudimos traer los entrenos recientes.')).toBeInTheDocument();
    expect(screen.queryByText(/No hay entrenos con lista/)).not.toBeInTheDocument();
  });
});
