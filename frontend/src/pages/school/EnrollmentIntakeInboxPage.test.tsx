/**
 * Bandeja de hojas de matrícula V2 (EnrollmentIntakeInboxPage): pruebas de render.
 *
 * Nada sale a la red: el BFF, la escuela, la sesión, los permisos y los toasts
 * van simulados. Crear, descartar y completar la ficha existente se mandan a los
 * 8 s (useEnvioConDeshacer), así que se usan timers falsos con `shouldAdvanceTime`
 * (los `findBy*` siguen andando) y se avanza el reloj dentro de `act`.
 *
 * Datos: tres fichas que llegan juntas —
 *   i-a  menor sin documento ni correo del acudiente («Faltan 2 datos»)
 *   i-b  menor con todo («Lista»)
 *   i-c  la hoja de alguien que ya está en la escuela («Ya existe»)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { EnrollmentFormResult, IntakeItem } from './enrollmentIntakeModel';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastHook: vi.fn(),
  role: 'school' as string,
  coachPuedeSubir: true,
  /** Lo que el BFF devuelve en GET /api/v1/enrollment-intake (las pendientes). */
  servidor: [] as IntakeItem[],
}));

vi.mock('@/lib/api/bffClient', () => {
  // Misma firma que el BFFError real (status, message, body): la página distingue
  // con `instanceof BFFError` el mensaje del servidor del texto por defecto.
  class BFFError extends Error {
    status: number;
    body?: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.name = 'BFFError';
      this.status = status;
      this.body = body;
    }
  }
  return { bffClient: { get: h.get, post: h.post }, BFFError };
});
vi.mock('@/hooks/useSchoolContext', () => ({
  useSchoolContext: () => ({ schoolId: 'school-1', schoolName: 'Dynasty', loading: false }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, profile: { id: 'u-1', full_name: 'Milena Admin', role: h.role } }),
}));
vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ coachCanUploadEnrollmentForms: h.coachPuedeSubir, isLoading: false }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: h.toastHook }) }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(() => 'toast-deshacer'),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import EnrollmentIntakeInboxPage from './EnrollmentIntakeInboxPage';
import { BFFError } from '@/lib/api/bffClient';

// ── Datos ───────────────────────────────────────────────────────────────────

function leido(o: Partial<EnrollmentFormResult> = {}): EnrollmentFormResult {
  return {
    athleteFullName: null, docType: null, docNumber: null, dateOfBirth: null, dateOfBirthRaw: null,
    ageOnForm: null, category: null, guardianFullName: null, guardianDocNumber: null, guardianPhone: null,
    guardianEmail: null, athleteEmail: null, athletePhone: null, epsName: null, bloodType: null,
    isEnrollmentForm: true, missingFields: [], provider: 'test',
    ...o,
  };
}

function ficha(id: string, extracted: EnrollmentFormResult, o: Partial<IntakeItem> = {}): IntakeItem {
  return {
    id, source: 'whatsapp', status: 'pending', extracted, photoUrl: null,
    duplicateOfChildId: null, duplicateOfChildName: null, duplicateOfIntakeId: null,
    rejectionReason: null, createdAt: '2026-10-28T15:00:00Z',
    ...o,
  };
}

/** Menor de 11 años: la hoja no trae tipo ni número de documento, ni correo del acudiente. */
const INCOMPLETA = ficha('i-a', leido({
  athleteFullName: 'Sofía Rojas Pérez',
  dateOfBirth: '2015-03-10',
  guardianFullName: 'Carolina Pérez',
  guardianPhone: '300 123 4567',
}));

const COMPLETA = ficha('i-b', leido({
  athleteFullName: 'Mateo Gómez Ruiz',
  docType: 'TI',
  docNumber: '1032456789',
  dateOfBirth: '2014-06-01',
  guardianFullName: 'Andrea Ruiz',
  guardianPhone: '3109876543',
  guardianEmail: 'andrea.ruiz@correo.com',
}), { source: 'app' });

const DUPLICADA = ficha('i-c', leido({
  athleteFullName: 'Valentina Ruiz',
  docType: 'TI',
  docNumber: '1030111222',
  dateOfBirth: '2013-01-20',
  guardianFullName: 'Jorge Ruiz',
  guardianPhone: '3201112233',
  guardianEmail: 'jorge.ruiz@correo.com',
}), { duplicateOfChildId: 'child-77', duplicateOfChildName: 'Valentina Ruiz Díaz' });

const NUEVO_CHILD_ID = 'child-nuevo-1';

// ── Utilidades ──────────────────────────────────────────────────────────────

async function abrirBandeja() {
  render(<EnrollmentIntakeInboxPage />);
  await screen.findByRole('tablist', { name: 'Filtrar fichas' });
}

/** El botón de la fila (nombre + subtítulo + píldora); lleva aria-expanded. */
const filaBoton = (nombre: RegExp) => screen.getByRole('button', { name: nombre });
const filaBotonOpcional = (nombre: RegExp) => screen.queryByRole('button', { name: nombre });
/** La ficha entera (fila + detalle si está abierta). */
const ficha$ = (nombre: RegExp) => filaBoton(nombre).closest('li') as HTMLElement;

const SOFIA = /Sofía Rojas Pérez/;
const MATEO = /Mateo Gómez Ruiz/;
const VALENTINA = /Valentina Ruiz/;
const LAURA = /Laura Martínez Ríos/;

function completarSofia() {
  const a = ficha$(SOFIA);
  fireEvent.change(within(a).getByLabelText('Documento del deportista'), { target: { value: '1032111222' } });
  fireEvent.change(within(a).getByLabelText('Correo del acudiente'), { target: { value: 'carolina.perez@correo.com' } });
}

/** Avanza el reloj falso y deja correr las promesas que eso dispara. */
async function avanzar(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
}

/** Opciones del último toast de éxito (el que trae «Deshacer»). */
function ultimoToastExito() {
  const llamadas = vi.mocked(toast.success).mock.calls;
  const [mensaje, opciones] = llamadas[llamadas.length - 1] as unknown as [
    string,
    { duration?: number; action: { label: string; onClick: (e?: unknown) => void } },
  ];
  return { mensaje, opciones };
}

const llamadasPost = (ruta: string) => h.post.mock.calls.filter(([p]) => p === ruta);
/** Ruta y cuerpo de la llamada n al BFF, sin el tercer argumento (encabezados). */
const rutaYCuerpo = (n: number) => h.post.mock.calls[n].slice(0, 2);
/** Las llamadas diferidas fijan la escuela del momento del toque. */
const ENCABEZADOS_ESCUELA = expect.objectContaining({ 'x-school-id': 'school-1' });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.role = 'school';
  h.coachPuedeSubir = true;
  h.servidor = [INCOMPLETA, COMPLETA, DUPLICADA];
  h.get.mockReset();
  h.get.mockImplementation(async () => ({ items: [...h.servidor] }));
  h.post.mockReset();
  // BFF de mentira: create-one devuelve el id; aprobar / descartar / vincular sacan la ficha de la bandeja.
  h.post.mockImplementation(async (ruta: string) => {
    if (ruta === '/api/v1/students/create-one') return { child_id: NUEVO_CHILD_ID };
    const m = ruta.match(/^\/api\/v1\/enrollment-intake\/([^/]+)\/(mark-approved|reject|link)$/);
    if (m) {
      h.servidor = h.servidor.filter((i) => i.id !== m[1]);
      return { ok: true };
    }
    throw new Error(`POST inesperado: ${ruta}`);
  });
  h.toastHook.mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.dismiss).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── 1. Lista ────────────────────────────────────────────────────────────────

describe('Lista de fichas', () => {
  it('píldoras «Faltan 2 datos», «Lista» y «Ya existe», conteos de las pestañas y una sola ficha abierta', async () => {
    await abrirBandeja();
    expect(h.get).toHaveBeenCalledWith('/api/v1/enrollment-intake');

    expect(screen.getByRole('tab', { name: /Por completar/ })).toHaveTextContent(/Por completar\s*2/);
    expect(screen.getByRole('tab', { name: /Listas/ })).toHaveTextContent(/Listas\s*1/);
    expect(screen.getByRole('tab', { name: /Todas/ })).toHaveTextContent(/Todas\s*3/);
    expect(screen.getByRole('tab', { name: /Por completar/ })).toHaveAttribute('aria-selected', 'true');

    // «Por completar»: la incompleta y la duplicada; la lista no se ve.
    expect(filaBoton(SOFIA)).toHaveTextContent('Faltan 2 datos');
    expect(filaBoton(VALENTINA)).toHaveTextContent('Ya existe');
    expect(filaBotonOpcional(MATEO)).toBeNull();

    // Abre sola la primera de la pestaña, y solo esa.
    expect(screen.getAllByRole('button', { expanded: true })).toEqual([filaBoton(SOFIA)]);
    expect(filaBoton(VALENTINA)).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('tab', { name: /Todas/ }));
    expect(filaBoton(SOFIA)).toHaveTextContent('Faltan 2 datos');
    expect(filaBoton(MATEO)).toHaveTextContent('Lista');
    expect(filaBoton(VALENTINA)).toHaveTextContent('Ya existe');
    expect(screen.getAllByRole('button', { expanded: true })).toEqual([filaBoton(SOFIA)]);

    // Abrir otra cierra la anterior.
    fireEvent.click(filaBoton(MATEO));
    expect(screen.getAllByRole('button', { expanded: true })).toEqual([filaBoton(MATEO)]);
  });
});

// ── 2 y 3. Completar la ficha ───────────────────────────────────────────────

describe('Ficha incompleta', () => {
  it('«Crear deportista» espera documento y un correo válido; el pie dice qué falta y la píldora pasa a «Lista»', async () => {
    await abrirBandeja();
    const a = ficha$(SOFIA);
    expect(within(a).getByRole('button', { name: 'Crear deportista' })).toBeDisabled();
    expect(within(a).getByText('Falta: documento y correo del acudiente.')).toBeInTheDocument();

    fireEvent.change(within(a).getByLabelText('Documento del deportista'), { target: { value: '1032111222' } });
    expect(filaBoton(SOFIA)).toHaveTextContent('Falta 1 dato');
    expect(within(a).getByText('Falta: correo del acudiente.')).toBeInTheDocument();

    // Un correo a medias no sirve.
    fireEvent.change(within(a).getByLabelText('Correo del acudiente'), { target: { value: 'carolina@correo' } });
    expect(within(a).getByRole('button', { name: 'Crear deportista' })).toBeDisabled();
    expect(filaBoton(SOFIA)).toHaveTextContent('Falta 1 dato');

    fireEvent.change(within(a).getByLabelText('Correo del acudiente'), { target: { value: 'carolina.perez@correo.com' } });
    expect(within(a).getByRole('button', { name: 'Crear deportista' })).toBeEnabled();
    expect(filaBoton(SOFIA)).toHaveTextContent('Lista');
    expect(within(a).getByText('Todo listo. Le llega la invitación a Carolina Pérez.')).toBeInTheDocument();

    // Pasó a «Lista» mientras se escribía, pero sigue a la vista y abierta en «Por completar».
    expect(filaBoton(SOFIA)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tab', { name: /Por completar/ })).toHaveTextContent(/Por completar\s*1/);
    expect(screen.getByRole('tab', { name: /Listas/ })).toHaveTextContent(/Listas\s*2/);
  });

  it('un menor sin tipo leído arranca en TI y el payload sale con doc_type TI y el celular solo en dígitos', async () => {
    await abrirBandeja();
    const a = ficha$(SOFIA);
    const tipos = within(a).getByRole('group', { name: 'Tipo de documento' });
    const chips = within(tipos).getAllByRole('button');
    // Solo los que acepta create-one para un menor (RC y PA daban 400).
    expect(chips.map((c) => c.textContent)).toEqual(['TI', 'RC', 'CC', 'CE', 'PP']);
    expect(chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent)).toEqual(['TI']);

    completarSofia();
    fireEvent.click(within(a).getByRole('button', { name: 'Crear deportista' }));
    await avanzar(8000);

    await waitFor(() => expect(llamadasPost('/api/v1/students/create-one')).toHaveLength(1));
    const [, cuerpo] = llamadasPost('/api/v1/students/create-one')[0];
    expect(cuerpo).toMatchObject({
      type: 'child',
      doc_type: 'TI',
      doc_number: '1032111222',
      full_name: 'Sofía Rojas Pérez',
      date_of_birth: '2015-03-10',
      parent_name: 'Carolina Pérez',
      parent_email: 'carolina.perez@correo.com',
      parent_phone: '3001234567',
      send_invite: true,
    });
    expect((cuerpo as { parent_phone: string }).parent_phone).toMatch(/^\d+$/);
    expect((cuerpo as { start_date: string }).start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Una ficha sin «Ya existe» no se salta la revisión de duplicados de create-one.
    expect(cuerpo).not.toHaveProperty('allow_duplicate');
  });

  it('el celular del acudiente necesita 10 dígitos (lo que exige create-one)', async () => {
    h.servidor = [ficha('i-d', leido({
      athleteFullName: 'Juan Pérez Gil', docType: 'TI', docNumber: '1030999888', dateOfBirth: '2014-02-02',
      guardianFullName: 'Marta Gil', guardianEmail: 'marta.gil@correo.com',
    }))];
    await abrirBandeja();
    const d = ficha$(/Juan Pérez Gil/);
    expect(filaBoton(/Juan Pérez Gil/)).toHaveTextContent('Falta 1 dato');

    fireEvent.change(within(d).getByLabelText('Celular del acudiente'), { target: { value: '312 456 7' } });
    expect(within(d).getByRole('button', { name: 'Crear deportista' })).toBeDisabled();
    expect(filaBoton(/Juan Pérez Gil/)).toHaveTextContent('Falta 1 dato');
    expect(within(d).getByText('Falta: celular del acudiente.')).toBeInTheDocument();

    fireEvent.change(within(d).getByLabelText('Celular del acudiente'), { target: { value: '312 456 7890' } });
    expect(within(d).getByRole('button', { name: 'Crear deportista' })).toBeEnabled();
    expect(filaBoton(/Juan Pérez Gil/)).toHaveTextContent('Lista');
  });
});

// ── 4, 5 y 6. Crear con Deshacer ────────────────────────────────────────────

describe('Crear deportista (envío a los 8 s)', () => {
  it('no llama al BFF al tocar; a los 8 s crea y aprueba la ficha con el childId devuelto', async () => {
    await abrirBandeja();
    completarSofia();
    fireEvent.click(within(ficha$(SOFIA)).getByRole('button', { name: 'Crear deportista' }));

    expect(h.post).not.toHaveBeenCalled();
    // La ficha se oculta ya y se abre la siguiente de la pestaña.
    expect(filaBotonOpcional(SOFIA)).toBeNull();
    expect(filaBoton(VALENTINA)).toHaveAttribute('aria-expanded', 'true');
    const { mensaje, opciones } = ultimoToastExito();
    expect(mensaje).toBe('Sofía Rojas Pérez quedó creado.');
    expect(opciones.action.label).toBe('Deshacer');
    expect(opciones.duration).toBe(8000);

    await avanzar(7000);
    expect(h.post).not.toHaveBeenCalled();

    await avanzar(1000);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    expect(h.post.mock.calls[0][0]).toBe('/api/v1/students/create-one');
    expect(rutaYCuerpo(1)).toEqual([
      '/api/v1/enrollment-intake/i-a/mark-approved',
      { childId: NUEVO_CHILD_ID, epsName: undefined, bloodType: undefined },
    ]);
    // Las dos llamadas van a la escuela en la que se tocó «Crear», no a la que esté activa a los 8 s.
    expect(h.post.mock.calls[0][2]).toEqual(ENCABEZADOS_ESCUELA);
    expect(h.post.mock.calls[1][2]).toEqual(ENCABEZADOS_ESCUELA);

    // Recarga la bandeja: la ficha aprobada ya no vuelve.
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Todas/ })).toHaveTextContent(/Todas\s*2/));
    expect(filaBotonOpcional(SOFIA)).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('«Deshacer» antes de los 8 s no toca el BFF y la ficha vuelve abierta con lo escrito', async () => {
    await abrirBandeja();
    completarSofia();
    fireEvent.click(within(ficha$(SOFIA)).getByRole('button', { name: 'Crear deportista' }));
    expect(filaBotonOpcional(SOFIA)).toBeNull();
    expect(screen.getByRole('tab', { name: /Todas/ })).toHaveTextContent(/Todas\s*2/);

    await avanzar(3000);
    const { opciones } = ultimoToastExito();
    act(() => { opciones.action.onClick(); });

    expect(filaBoton(SOFIA)).toHaveAttribute('aria-expanded', 'true');
    expect(within(ficha$(SOFIA)).getByLabelText('Documento del deportista')).toHaveValue('1032111222');
    expect(filaBoton(SOFIA)).toHaveTextContent('Lista');
    expect(screen.getByRole('tab', { name: /Todas/ })).toHaveTextContent(/Todas\s*3/);

    await avanzar(10_000);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('«Deshacer» cuando ya salió no hace creer que se canceló: cierra el aviso y lo dice', async () => {
    await abrirBandeja();
    completarSofia();
    fireEvent.click(within(ficha$(SOFIA)).getByRole('button', { name: 'Crear deportista' }));
    const { opciones } = ultimoToastExito();

    await avanzar(8000);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    // Al mandarse se cierra el aviso (sonner lo deja vivo si el puntero está encima).
    expect(toast.dismiss).toHaveBeenCalledWith('toast-deshacer');

    act(() => { opciones.action.onClick(); });
    expect(toast.info).toHaveBeenCalledWith('Ya se había enviado: no alcanzó a deshacerse.');
    expect(filaBotonOpcional(SOFIA)).toBeNull();
  });

  it('si create-one responde 409, la ficha reaparece abierta con el motivo y no se aprueba', async () => {
    const motivo = 'Ya existe un deportista con el documento TI 1032111222 en la escuela.';
    h.post.mockImplementation(async (ruta: string) => {
      if (ruta === '/api/v1/students/create-one') throw new BFFError(409, motivo);
      throw new Error(`POST inesperado: ${ruta}`);
    });
    const consola = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await abrirBandeja();
    completarSofia();
    fireEvent.click(within(ficha$(SOFIA)).getByRole('button', { name: 'Crear deportista' }));
    expect(filaBotonOpcional(SOFIA)).toBeNull();

    await avanzar(8000);
    await waitFor(() => expect(filaBoton(SOFIA)).toHaveAttribute('aria-expanded', 'true'));
    expect(within(ficha$(SOFIA)).getByText(motivo)).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('No se pudo terminar la ficha de Sofía Rojas Pérez', { description: motivo });
    expect(h.post).toHaveBeenCalledTimes(1); // nada de mark-approved
    expect(llamadasPost('/api/v1/enrollment-intake/i-a/mark-approved')).toHaveLength(0);
    // No reintenta solo y lo escrito sigue ahí.
    expect(within(ficha$(SOFIA)).getByLabelText('Documento del deportista')).toHaveValue('1032111222');
    await avanzar(10_000);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(consola).toHaveBeenCalled();
  });

  it('si create-one sale bien y falla marcar la hoja, reintentar NO crea un segundo deportista', async () => {
    let fallaAprobar = true;
    h.post.mockImplementation(async (ruta: string) => {
      if (ruta === '/api/v1/students/create-one') return { child_id: NUEVO_CHILD_ID };
      if (ruta === '/api/v1/enrollment-intake/i-a/mark-approved') {
        if (fallaAprobar) throw new BFFError(500, 'Error interno.');
        h.servidor = h.servidor.filter((i) => i.id !== 'i-a');
        return { ok: true };
      }
      throw new Error(`POST inesperado: ${ruta}`);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await abrirBandeja();
    completarSofia();
    fireEvent.click(within(ficha$(SOFIA)).getByRole('button', { name: 'Crear deportista' }));
    await avanzar(8000);
    await waitFor(() => expect(filaBoton(SOFIA)).toHaveAttribute('aria-expanded', 'true'));
    expect(within(ficha$(SOFIA)).getByText(/ya quedó creado, pero no se pudo marcar la hoja/)).toBeInTheDocument();

    fallaAprobar = false;
    fireEvent.click(within(ficha$(SOFIA)).getByRole('button', { name: 'Crear deportista' }));
    await avanzar(8000);
    await waitFor(() => expect(llamadasPost('/api/v1/enrollment-intake/i-a/mark-approved')).toHaveLength(2));
    expect(llamadasPost('/api/v1/students/create-one')).toHaveLength(1);
    expect(llamadasPost('/api/v1/enrollment-intake/i-a/mark-approved')[1][1]).toMatchObject({ childId: NUEVO_CHILD_ID });
    await waitFor(() => expect(filaBotonOpcional(SOFIA)).toBeNull());
  });
});

describe('Corregir lo leído de la hoja', () => {
  it('un correo leído con forma válida pero equivocado se corrige desde «Leído de la hoja» y sale corregido', async () => {
    await abrirBandeja();
    fireEvent.click(screen.getByRole('tab', { name: /Listas/ }));
    const b = ficha$(MATEO);
    expect(within(b).getByText('andrea.ruiz@correo.com')).toBeInTheDocument();

    fireEvent.click(within(b).getByRole('button', { name: 'Editar correo' }));
    fireEvent.change(within(b).getByLabelText('Correo del acudiente'), { target: { value: 'andrea.ruiz@gmail.com' } });
    fireEvent.click(within(b).getByRole('button', { name: 'Listo' }));
    expect(within(b).getByText('andrea.ruiz@gmail.com')).toBeInTheDocument();

    // Borrarlo al corregir no hace desaparecer la fila: queda abierta y el pie lo pide.
    fireEvent.click(within(b).getByRole('button', { name: 'Editar documento' }));
    fireEvent.change(within(b).getByLabelText('Documento del deportista'), { target: { value: '' } });
    expect(within(b).getByLabelText('Documento del deportista')).toBeInTheDocument();
    expect(within(b).getByText('Falta: documento.')).toBeInTheDocument();
    fireEvent.change(within(b).getByLabelText('Documento del deportista'), { target: { value: '1032456798' } });

    fireEvent.click(within(b).getByRole('button', { name: 'Crear deportista' }));
    await avanzar(8000);
    await waitFor(() => expect(llamadasPost('/api/v1/students/create-one')).toHaveLength(1));
    expect(llamadasPost('/api/v1/students/create-one')[0][1]).toMatchObject({
      parent_email: 'andrea.ruiz@gmail.com',
      doc_number: '1032456798',
    });
  });

  it('si todas las fichas llegan listas, la bandeja abre en «Listas» y no en una pestaña vacía', async () => {
    h.servidor = [COMPLETA];
    await abrirBandeja();
    await waitFor(() => expect(screen.getByRole('tab', { name: /Listas/ })).toHaveAttribute('aria-selected', 'true'));
    expect(filaBoton(MATEO)).toHaveAttribute('aria-expanded', 'true');
  });
});

// ── 7. Descartar ────────────────────────────────────────────────────────────

describe('Descartar', () => {
  it('sin window.prompt: se elige el motivo en la ficha y a los 8 s va a /reject con ese texto', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => null);
    await abrirBandeja();
    const a = ficha$(SOFIA);

    fireEvent.click(within(a).getByRole('button', { name: 'Descartar' }));
    const motivos = within(a).getByRole('group', { name: '¿Por qué descartas esta ficha?' });
    fireEvent.click(within(motivos).getByRole('button', { name: 'Foto ilegible' }));
    expect(within(motivos).getByRole('button', { name: 'Foto ilegible' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(a).getByRole('button', { name: 'Descartar ficha' }));

    expect(prompt).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(filaBotonOpcional(SOFIA)).toBeNull();
    expect(ultimoToastExito().mensaje).toBe('Descartaste la ficha de Sofía Rojas Pérez.');

    await avanzar(8000);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    expect(rutaYCuerpo(0)).toEqual(['/api/v1/enrollment-intake/i-a/reject', { reason: 'Foto ilegible' }]);
    expect(h.post.mock.calls[0][2]).toEqual(ENCABEZADOS_ESCUELA);
    expect(prompt).not.toHaveBeenCalled();
  });
});

// ── 8. Duplicado ────────────────────────────────────────────────────────────

describe('Ficha de alguien que ya existe', () => {
  it('«Completar su ficha» vincula la hoja al deportista existente (/link con su childId), sin crear a nadie', async () => {
    await abrirBandeja();
    fireEvent.click(filaBoton(VALENTINA));
    const c = ficha$(VALENTINA);
    expect(filaBoton(VALENTINA)).toHaveAttribute('aria-expanded', 'true');
    expect(within(c).getByText('Valentina Ruiz Díaz')).toBeInTheDocument();
    expect(within(c).getByText(/ya está en la escuela/)).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Crear deportista' })).toBeNull();

    fireEvent.click(within(c).getByRole('button', { name: 'Completar su ficha' }));
    expect(h.post).not.toHaveBeenCalled();
    expect(ultimoToastExito().mensaje).toBe('Completamos la ficha de Valentina Ruiz Díaz.');

    await avanzar(8000);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
    expect(rutaYCuerpo(0)).toEqual(['/api/v1/enrollment-intake/i-c/link', { childId: 'child-77' }]);
    expect(h.post.mock.calls[0][2]).toEqual(ENCABEZADOS_ESCUELA);
    expect(llamadasPost('/api/v1/students/create-one')).toHaveLength(0);
  });

  it('«Es otra persona» oculta el aviso y deja crearla como deportista nuevo (con allow_duplicate)', async () => {
    await abrirBandeja();
    fireEvent.click(filaBoton(VALENTINA));
    const c = ficha$(VALENTINA);
    fireEvent.click(within(c).getByRole('button', { name: 'Es otra persona' }));

    expect(within(c).queryByText(/ya está en la escuela/)).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Completar su ficha' })).toBeNull();
    expect(filaBoton(VALENTINA)).toHaveTextContent('Lista');
    expect(filaBoton(VALENTINA)).toHaveAttribute('aria-expanded', 'true');
    const crear = within(c).getByRole('button', { name: 'Crear deportista' });
    expect(crear).toBeEnabled();

    fireEvent.click(crear);
    await avanzar(8000);
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2));
    // «Es otra persona» es la confirmación explícita del staff: sin allow_duplicate, create-one
    // vuelve a encontrar el mismo documento y responde 409 (students-create-one.route.ts:785-790).
    expect(rutaYCuerpo(0)).toEqual([
      '/api/v1/students/create-one',
      expect.objectContaining({
        type: 'child', full_name: 'Valentina Ruiz', doc_number: '1030111222', allow_duplicate: true,
      }),
    ]);
    expect(rutaYCuerpo(1)).toEqual([
      '/api/v1/enrollment-intake/i-c/mark-approved',
      expect.objectContaining({ childId: NUEVO_CHILD_ID }),
    ]);
    expect(llamadasPost('/api/v1/enrollment-intake/i-c/link')).toHaveLength(0);
  });
});

// ── Mayor de edad ───────────────────────────────────────────────────────────

describe('Ficha de un mayor de edad', () => {
  it('un correo opcional mal escrito impide crear; vacío deja crear sin invitación', async () => {
    // Antes salía igual a create-one con send_invite y el BFF respondía 400 «Datos inválidos.»
    // mientras el pie decía «Sin correo, no le llega invitación».
    h.servidor = [ficha('i-e', leido({
      athleteFullName: 'Laura Martínez Ríos', docType: 'CC', docNumber: '1020304050', dateOfBirth: '1998-05-05',
    }))];
    await abrirBandeja();
    fireEvent.click(screen.getByRole('tab', { name: /Listas/ })); // ya llega «Lista»
    const e = ficha$(LAURA);
    expect(filaBoton(LAURA)).toHaveAttribute('aria-expanded', 'true');
    expect(filaBoton(LAURA)).toHaveTextContent('Lista');
    expect(within(e).getByText('Todo listo. Sin correo, no le llega invitación a la app.')).toBeInTheDocument();

    fireEvent.change(within(e).getByLabelText(/Correo del deportista/), { target: { value: 'laura@gmail' } });
    expect(within(e).getByRole('button', { name: 'Crear deportista' })).toBeDisabled();
    expect(filaBoton(LAURA)).toHaveTextContent('Falta 1 dato');
    expect(filaBoton(LAURA)).toHaveAttribute('aria-expanded', 'true'); // no se va de la vista

    fireEvent.change(within(e).getByLabelText(/Correo del deportista/), { target: { value: '' } });
    expect(within(e).getByRole('button', { name: 'Crear deportista' })).toBeEnabled();
    fireEvent.click(within(e).getByRole('button', { name: 'Crear deportista' }));
    await avanzar(8000);
    await waitFor(() => expect(llamadasPost('/api/v1/students/create-one')).toHaveLength(1));
    expect(llamadasPost('/api/v1/students/create-one')[0][1]).toMatchObject({
      type: 'unregistered_adult', doc_type: 'CC', doc_number: '1020304050', email: null, send_invite: false,
    });
  });
});

// ── 9. Coach ────────────────────────────────────────────────────────────────

describe('Vista del coach', () => {
  it('solo ve el botón de subir; no pide la bandeja al BFF', async () => {
    h.role = 'coach';
    render(<EnrollmentIntakeInboxPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Subir hoja de matrícula' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subir hoja de matrícula' })).toBeEnabled();
    await avanzar(500);
    expect(h.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Matrículas por revisar')).toBeNull();
  });

  it('si la escuela no le dio el permiso, lo dice y no ofrece subir', async () => {
    h.role = 'coach';
    h.coachPuedeSubir = false;
    render(<EnrollmentIntakeInboxPage />);
    expect(screen.getByText(/Tu escuela no tiene habilitado/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Subir hoja de matrícula' })).toBeNull();
    await avanzar(500);
    expect(h.get).not.toHaveBeenCalled();
  });
});

// ── 10. Error al cargar ─────────────────────────────────────────────────────

describe('Error al cargar la bandeja', () => {
  it('muestra el mensaje con «Intentar de nuevo» (sin el error crudo) y al reintentar pinta la lista', async () => {
    h.get.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<EnrollmentIntakeInboxPage />);

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos cargar las matrículas. Revisa tu conexión.');
    expect(alerta).not.toHaveTextContent('Failed to fetch');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Todo al día.')).toBeNull();

    fireEvent.click(within(alerta).getByRole('button', { name: 'Intentar de nuevo' }));
    await screen.findByRole('tablist', { name: 'Filtrar fichas' });
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(filaBoton(SOFIA)).toBeInTheDocument();
  });

  it('si el BFF explica el motivo, se muestra ese', async () => {
    h.get.mockRejectedValueOnce(new BFFError(403, 'Solo la administración de la escuela ve las matrículas.'));
    render(<EnrollmentIntakeInboxPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Solo la administración de la escuela ve las matrículas.');
  });
});
