/**
 * Pantallas V2 del deportista: el menor NUNCA ve pagar; convocatoria del mayor
 * vs del menor; racha por asistencia; RPC que aún no existe = sección oculta.
 * Nada sale a la red: los hooks de datos van simulados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transaction } from '@/components/parent/v2/pagosModel';

const s = vi.hoisted(() => ({
  deportista: {} as Record<string, unknown>,
  callups: { data: { oculto: true, data: [] } } as Record<string, unknown>,
  kudos: { data: { oculto: true, data: [] } } as Record<string, unknown>,
  attendance: { data: [], isLoading: false, isError: false } as Record<string, unknown>,
  pagar: vi.fn(),
  responder: vi.fn(() => Promise.resolve()),
  informeEntreno: vi.fn(() => Promise.resolve({ data: { team_snapshot: {}, child_metrics: [], child_name: '', coach_note: 'Trabajamos recepción.' }, error: null, noDisponible: false })),
  teams: {} as Record<string, unknown>,
  torneos: { data: [] } as Record<string, unknown>,
  ptHoy: { data: { pt_sessions: [] } } as Record<string, unknown>,
}));

const EQUIPOS_OK = () => ({
  data: [{ teamId: 't1', nombre: 'Golf Adultos', deporte: 'golf', lugar: 'la cancha 2', profe: 'Andrés Gil', franjas: [{ day: 0, time: '18:30' }], schoolId: 'sc', escuela: 'Club Campestre Demo' }],
  isLoading: false, isError: false, refetch: vi.fn(),
});

vi.mock('./useDeportista', () => ({ useDeportista: () => s.deportista }));
vi.mock('./useAthleteCheckout', () => ({
  useAthleteCheckout: () => ({ pagar: s.pagar, subirComprobante: vi.fn(), verRecibo: vi.fn(), nuevoPago: vi.fn(), modal: null }),
}));
vi.mock('./useAthleteV2Data', () => ({
  useAthleteTeams: () => s.teams,
  useTorneosAbiertos: () => s.torneos,
  usePlanDelMes: () => ({ data: [] }),
  useMyCallups: () => s.callups,
  useMyKudos: () => s.kudos,
  useAthleteAttendance: () => s.attendance,
  useMisInformes: () => ({ data: { oculto: false, data: [] } }),
  useAutoevalPendiente: () => ({ data: null }),
  responderConvocatoria: s.responder,
  enviarRpeRapido: vi.fn(),
  callupsKey: (id: string) => ['c', id],
  autoevalKey: (id: string) => ['a', id],
  formularioAutoeval: (p: { sessionId: string }) => `/post-entreno/${p.sessionId}`,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
const authState = vi.hoisted(() => ({ roleContexts: [] as unknown[] }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ signOut: vi.fn(), user: { id: 'yo' }, profile: null, roleContexts: authState.roleContexts }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ schoolId: null, schoolName: 'Club Campestre Demo' }) }));
vi.mock('@/hooks/useMySchoolStore', () => ({ useMySchoolStore: () => ({ showStore: false, showMyPurchases: false }) }));
vi.mock('@/components/billing/MiFacturaElectronicaCard', () => ({ MiFacturaElectronicaCard: () => null }));
vi.mock('@/lib/school/performanceQueries', () => ({
  getAthletePerformanceEntries: vi.fn(() => Promise.resolve([])),
  getAthletePerformanceEvolution: vi.fn(() => Promise.resolve({ metrics: [], evolution: [] })),
}));
vi.mock('@/lib/school/reportsQueries', () => ({
  downloadAthleteReportPdf: vi.fn(), getAthleteReportDetail: vi.fn(), markReportViewed: vi.fn(),
}));
vi.mock('@/lib/api/v2Contratos', () => ({ informeEntrenoDeportista: s.informeEntreno }));
vi.mock('@/hooks/useAthleteData', () => ({ useAthleteTrainingToday: () => s.ptHoy }));
vi.mock('@/components/athlete/AthleteVisibleRoutines', () => ({ AthleteVisibleRoutines: () => null }));

import { AthleteHomeV2 } from './AthleteHomeV2';
import { AthleteTrainingV2 } from './AthleteTrainingV2';
import { AthleteProgressV2 } from './AthleteProgressV2';
import { AthleteMorePage } from './AthleteMorePage';
import { AthletePaymentsV2 } from './AthletePaymentsV2';

const HOY = new Date(2026, 9, 25, 10, 0); // domingo

const DEUDA: Transaction = {
  id: 'p1', amount: 157_500, status: 'overdue', reference: 'r', transaction_date: '2026-10-01',
  due_date: '2026-10-10', payment_category: 'mensualidad', period_month: 10, concept: 'Mensualidad 10/2026',
};

function cobros(transacciones: Transaction[]) {
  return { data: { filas: [], transacciones, facturas: {} }, isLoading: false, isError: false, refetch: vi.fn() };
}

const MAYOR = () => ({ userId: 'yo', nombre: 'Valentina Cruz', edad: 'mayor', paga: true, cobros: cobros([DEUDA]) });
// Un menor con cuenta, aunque los datos trajeran cobros (no debería ni consultarlos).
const MENOR = () => ({ userId: 'yo', nombre: 'Juan Pablo Ríos', edad: 'menor', paga: false, cobros: cobros([DEUDA]) });

function pintar(ui: React.ReactElement, ruta = '/') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[ruta]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  s.teams = EQUIPOS_OK();
  s.torneos = { data: [] };
  s.ptHoy = { data: { pt_sessions: [] } };
  s.callups = { data: { oculto: true, data: [] } };
  s.kudos = { data: { oculto: true, data: [] } };
  s.attendance = { data: [], isLoading: false, isError: false };
  s.pagar.mockClear();
  s.responder.mockClear();
});

describe('el menor nunca ve pagar', () => {
  it('Hoy del adulto que debe: frase y «Pagar $X» con el checkout del deportista', () => {
    s.deportista = MAYOR();
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByText('Falta tu mensualidad de octubre.')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Pagar \$/ });
    fireEvent.click(btn);
    expect(s.pagar).toHaveBeenCalledWith([DEUDA]);
  });

  it('una sola campana: el Inicio no dibuja la suya (queda la de la cabecera de la app)', () => {
    s.deportista = MAYOR();
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.queryByRole('link', { name: /Avisos/ })).toBeNull();
    expect(document.querySelector('a[href="/notifications"]')).toBeNull();
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('Hoy del menor: sin plata ni «Pagar», con su entreno y el carnet', () => {
    s.deportista = MENOR();
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.queryByRole('button', { name: /Pagar/ })).toBeNull();
    expect(screen.queryByText(/mensualidad/i)).toBeNull();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.getByRole('link', { name: /Mostrar mi carnet/ })).toBeInTheDocument();
  });

  it('Más del menor no tiene Pagos; Más del mayor sí, con lo que debe', () => {
    s.deportista = MENOR();
    const { unmount } = pintar(<AthleteMorePage />);
    expect(screen.queryByText('Pagos')).toBeNull();
    expect(screen.queryByText('Mi plata')).toBeNull();
    unmount();
    s.deportista = MAYOR();
    pintar(<AthleteMorePage />);
    expect(screen.getByText('Pagos')).toBeInTheDocument();
    expect(screen.getByText(/Debes \$/)).toBeInTheDocument();
  });

  it('Pagos abierto por un menor: no muestra cobros ni botón de pagar', () => {
    s.deportista = MENOR();
    pintar(<AthletePaymentsV2 />);
    expect(screen.getByText('Tus pagos los maneja tu acudiente')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pagar/ })).toBeNull();
    expect(screen.queryByText(/Mensualidad/)).toBeNull();
  });

  it('Más no pierde entradas y no muestra Explorar', () => {
    s.deportista = MAYOR();
    pintar(<AthleteMorePage />);
    for (const l of ['Inscripciones y planes', 'Calendario del mes', 'Torneos y eventos', 'Mis documentos', 'Mi salud', 'Mis citas', 'Mis medidas', 'Centro de ayuda', 'Notificaciones', 'Mis datos', 'Configuración', 'Cerrar sesión', 'Mis objetivos']) {
      expect(screen.getByText(l)).toBeInTheDocument();
    }
    expect(screen.queryByText(/Explorar/)).toBeNull();
  });

  it('«Cambiar de rol» solo aparece si la persona es deportista Y acudiente (dos roles)', () => {
    s.deportista = MAYOR();
    authState.roleContexts = [];
    const { unmount } = pintar(<AthleteMorePage />);
    expect(screen.queryByText('Cambiar de rol')).toBeNull();
    unmount();
    authState.roleContexts = [{ key: 'athlete:a' }, { key: 'parent:a' }];
    pintar(<AthleteMorePage />);
    expect(screen.getByText('Cambiar de rol')).toBeInTheDocument();
    authState.roleContexts = [];
  });
});

describe('convocatoria: mayor responde, menor solo la ve', () => {
  const CONV = { lineupId: 'l1', subjectType: 'profile', subjectId: 'yo', rival: 'Club Arrayanes', fecha: '2026-10-31', hora: '10:30', lugar: 'Coliseo', nota: null, respuesta: null };

  it('el mayor tiene «Voy / No puedo ir»', () => {
    s.deportista = MAYOR();
    s.callups = { data: { oculto: false, data: [CONV] } };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByText(/contra Club Arrayanes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Voy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No puedo ir' }));
    expect(screen.getByText('Avisaste que no puedes ir')).toBeInTheDocument();
  });

  it('sin fecha de nacimiento responde él (se trata como mayor)', () => {
    s.deportista = { userId: 'yo', nombre: 'Sin Fecha', edad: 'desconocida', paga: false, cobros: cobros([]) };
    s.callups = { data: { oculto: false, data: [CONV] } };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByRole('button', { name: 'Voy' })).toBeInTheDocument();
    expect(screen.queryByText('Tu acudiente responde por ti desde su app.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Voy' }));
    expect(screen.getByText('Vas al partido')).toBeInTheDocument();
  });

  it('el menor la ve sin botones: responde su acudiente', () => {
    s.deportista = MENOR();
    s.callups = { data: { oculto: false, data: [CONV] } };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByText(/contra Club Arrayanes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Voy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'No puedo ir' })).toBeNull();
    expect(screen.getByText('Tu acudiente responde por ti desde su app.')).toBeInTheDocument();
  });

  it('si la RPC aún no existe, la convocatoria no aparece', () => {
    s.deportista = MAYOR();
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.queryByText('Convocatoria')).toBeNull();
  });
});

describe('Progreso › Informes: el informe del entreno se pide solo al abrirlo (b8)', () => {
  it('no llama al BFF al cargar; sí al abrir la sección, y muestra la nota del profe', async () => {
    s.deportista = MAYOR();
    s.informeEntreno.mockClear();
    pintar(<AthleteProgressV2 inicial="informes" hoy={HOY} />);
    const boton = screen.getByRole('button', { name: /Lo que trabajó Golf Adultos en octubre/ });
    expect(boton).toHaveAttribute('aria-expanded', 'false');
    expect(s.informeEntreno).not.toHaveBeenCalled();
    fireEvent.click(boton);
    await waitFor(() => expect(screen.getByText('«Trabajamos recepción.»')).toBeInTheDocument());
    expect(s.informeEntreno).toHaveBeenCalledTimes(1);
    expect(s.informeEntreno).toHaveBeenCalledWith('t1', 2026, 10);
  });
});

describe('racha y felicitación en Hoy', () => {
  it('muestra la racha de entrenos asistidos y la asistencia del mes', () => {
    s.deportista = MENOR();
    s.attendance = {
      isLoading: false, isError: false,
      data: [
        { attendance_date: '2026-10-23', status: 'present' },
        { attendance_date: '2026-10-21', status: 'late' },
        { attendance_date: '2026-10-19', status: 'absent' },
      ],
    };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByText('2 de 3')).toBeInTheDocument();
    expect(screen.getByText('2 seguidos')).toBeInTheDocument();
  });

  it('la hora de Hoy avanza sola (tic por minuto), sin quedarse congelada al montar', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 23, 59, 30));
    try {
      s.deportista = MENOR();
      pintar(<AthleteHomeV2 />);
      expect(screen.getByText('Domingo 25 de octubre')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(screen.getByText('Lunes 26 de octubre')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('la felicitación del profe la ve también el menor (decisión 9)', () => {
    s.deportista = MENOR();
    s.kudos = { data: { oculto: false, data: [{ id: 'k1', mensaje: 'Gran recepción el martes.', profe: 'Andrés Gil', fecha: '2026-10-20' }] } };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByText('Profe Andrés te felicitó')).toBeInTheDocument();
  });
});

describe('segunda ronda (QA en navegador)', () => {
  const CONV = { lineupId: 'l1', subjectType: 'profile', subjectId: 'yo', rival: 'Club Arrayanes', fecha: '2026-10-31', hora: '10:30', lugar: 'Coliseo', nota: null, respuesta: null };

  it('D1: Entrenos enlaza a /training/todo arriba, y avisa si hoy hay sesión con entrenador personal', () => {
    s.deportista = MAYOR();
    s.ptHoy = { data: { pt_sessions: [{ id: 'pt1', name: 'Fuerza tren inferior', status: 'scheduled' }] } };
    pintar(<AthleteTrainingV2 hoy={HOY} />);
    expect(screen.getByRole('link', { name: /Ver todos mis entrenamientos/ })).toHaveAttribute('href', '/training/todo');
    expect(screen.getByText(/Hoy tienes una sesión con tu entrenador personal: Fuerza tren inferior/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a mi sesión' })).toHaveAttribute('href', '/training/todo');
  });

  it('D1: sin sesiones PT hoy no sale el aviso, pero el enlace sí', () => {
    s.deportista = MAYOR();
    pintar(<AthleteTrainingV2 hoy={HOY} />);
    expect(screen.queryByLabelText('Sesiones con entrenador personal hoy')).toBeNull();
    expect(screen.getByRole('link', { name: /Ver todos mis entrenamientos/ })).toBeInTheDocument();
  });

  it('D2: «Ver todas mis estadísticas» lleva a /stats/todo', async () => {
    s.deportista = MAYOR();
    pintar(<AthleteProgressV2 hoy={HOY} />);
    expect(await screen.findByRole('link', { name: /Ver todas mis estadísticas/ })).toHaveAttribute('href', '/stats/todo');
  });

  it('D3: si falla la lectura de equipos, Hoy dice que no pudo cargar (no «Aún no tienes equipo»)', () => {
    s.deportista = MENOR();
    const refetch = vi.fn();
    s.teams = { data: undefined, isLoading: false, isError: true, refetch };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.queryByText(/Aún no tienes un equipo/)).toBeNull();
    expect(screen.getByText('No pudimos cargar tu entreno')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('D3: el adulto que debe y con error de equipos ve «No pudimos cargar tu entreno · Reintentar»', () => {
    s.deportista = MAYOR();
    s.teams = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByRole('button', { name: /Pagar \$/ })).toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar tu entreno ·')).toBeInTheDocument();
  });

  it('D4: error en my_callups → aviso con Reintentar en Hoy y en Entrenos (no desaparece)', () => {
    s.deportista = MAYOR();
    const refetch = vi.fn();
    s.callups = { data: undefined, isError: true, refetch };
    const { unmount } = pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByText('No pudimos revisar tus convocatorias.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(refetch).toHaveBeenCalled();
    unmount();
    pintar(<AthleteTrainingV2 hoy={HOY} />);
    expect(screen.getByText('No pudimos revisar tus partidos.')).toBeInTheDocument();
  });

  it('D4: si la RPC no existe (oculto), no se muestra error', () => {
    s.deportista = MAYOR();
    s.callups = { data: { oculto: true, data: [] }, isError: false };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.queryByText(/No pudimos revisar tus convocatorias/)).toBeNull();
  });

  it('D4: error en list_kudos → la pestaña Felicitaciones sigue y dice que no cargó', () => {
    s.deportista = MAYOR();
    s.kudos = { data: undefined, isError: true, refetch: vi.fn() };
    pintar(<AthleteProgressV2 hoy={HOY} />, '/stats?tab=felicitaciones');
    expect(screen.getByRole('tab', { name: 'Felicitaciones' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('No pudimos cargar tus felicitaciones.')).toBeInTheDocument();
  });

  it('D6: el enlace «Pagar otro concepto» hace wrap y Pagos/Más dejan aire para el botón flotante', () => {
    s.deportista = MAYOR();
    // (la barra fija «Pagar / Ya transferí» esconde sola el botón flotante: ver AcuPagosV2 / supportFab)
    const { unmount } = pintar(<AthletePaymentsV2 />);
    const enlace = screen.getByRole('button', { name: /Pagar otro concepto/ });
    expect(enlace.className).toMatch(/whitespace-normal/);
    expect(enlace.className).toMatch(/h-auto/);
    expect(screen.getByTestId('espacio-boton-flotante').className).toMatch(/h-24/);
    unmount();
    pintar(<AthleteMorePage />);
    expect(screen.getByTestId('espacio-boton-flotante').className).toMatch(/h-24/);
  });

  it('D7: torneos abiertos en Hoy con nombre completo, fecha legible y botón de 44 px', () => {
    s.deportista = MAYOR();
    s.torneos = { data: [{ id: 'ev1', title: 'Copa Interna Demo de Fútbol Sala Categoría Libre 2026', sport: 'Fútbol', city: 'Bogotá', event_date: '2026-11-21', school: null }] };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByText('Copa Interna Demo de Fútbol Sala Categoría Libre 2026').className).toMatch(/break-words/);
    expect(screen.getByText('Fútbol · Bogotá · sáb 21 nov')).toBeInTheDocument();
    const btn = screen.getByRole('link', { name: /Inscribirme/ });
    expect(btn).toHaveAttribute('href', '/tournaments/ev1/register');
    expect(btn.className).toMatch(/min-h-touch/);
  });

  it('D7: sin torneos no se pinta nada', () => {
    s.deportista = MAYOR();
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.queryByLabelText('Torneos abiertos')).toBeNull();
  });

  it('D8: «Ver mis felicitaciones» va a /stats?tab=felicitaciones y Progreso abre en esa pestaña', () => {
    s.deportista = MAYOR();
    s.kudos = { data: { oculto: false, data: [{ id: 'k1', mensaje: 'Gran recepción.', profe: 'Andrés Gil', fecha: '2026-10-20' }] } };
    const { unmount } = pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByRole('link', { name: /Ver mis felicitaciones/ })).toHaveAttribute('href', '/stats?tab=felicitaciones');
    unmount();
    pintar(<AthleteProgressV2 hoy={HOY} />, '/stats?tab=felicitaciones');
    expect(screen.getByRole('tab', { name: 'Felicitaciones' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('«Gran recepción.»')).toBeInTheDocument();
  });

  it('D8: un ?tab= desconocido abre «Cómo me fue»', () => {
    s.deportista = MAYOR();
    pintar(<AthleteProgressV2 hoy={HOY} />, '/stats?tab=otra');
    expect(screen.getByRole('tab', { name: 'Cómo me fue' })).toHaveAttribute('aria-selected', 'true');
  });

  it('D9: las pestañas de Progreso no tienen ancho mínimo y pueden pasar de fila', () => {
    s.deportista = MAYOR();
    const { container } = pintar(<AthleteProgressV2 hoy={HOY} />);
    expect(container.querySelector('[class*="min-w-[22rem]"]')).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Progreso' }).className).toMatch(/flex-wrap/);
    expect(screen.getByRole('tab', { name: 'En qué mejoro' }).className).toMatch(/min-w-0/);
  });

  it('la convocatoria de su ficha (unregistered) también se responde', () => {
    s.deportista = MAYOR();
    s.callups = { data: { oculto: false, data: [{ ...CONV, subjectType: 'unregistered', subjectId: 'ficha' }] } };
    pintar(<AthleteHomeV2 hoy={HOY} />);
    expect(screen.getByRole('button', { name: 'Voy' })).toBeInTheDocument();
  });
});
