/**
 * Referidos: con la campaña apagada no se ve nada; activa muestra el campo, la
 * ficha con su estado y el informe con «dejado de cobrar». BFF moqueado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));
const alumnos = vi.hoisted(() => ({ searchAthletes: vi.fn() }));
vi.mock('@/lib/api/students', () => ({ studentsAPI: alumnos }));
const supa = vi.hoisted(() => ({ rows: [{ id: 'ENR-NUEVA' }] as any[] }));
vi.mock('@/integrations/supabase/client', () => {
  const cadena: any = {
    select: () => cadena, eq: () => cadena, order: () => cadena,
    limit: () => Promise.resolve({ data: supa.rows, error: null }),
    update: () => cadena,
  };
  return { supabase: { from: () => cadena } };
});

import { useReferidoAlta } from './ReferidoAlta';
import { ReferidoFicha } from './ReferidoFicha';
import { CampanaReferidosConfig } from './CampanaReferidosConfig';
import { InformeReferidos } from './InformeReferidos';
import { TRAMOS_POR_DEFECTO, type Campana } from '@/lib/api/referidos';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const conCliente = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};
const campana = (active: boolean): Campana => ({
  id: 'camp1', name: 'Referidos', active, tiers: TRAMOS_POR_DEFECTO, starts_on: null, ends_on: null,
  max_pending: 12, require_referrer_current: true,
});
const rutas = (c: Campana | null, extra: Record<string, unknown> = {}) =>
  bff.get.mockImplementation(async (path: string) => {
    if (path.includes('/campaign')) return { campaign: c, tramos_por_defecto: TRAMOS_POR_DEFECTO };
    if (path.includes('/report')) return extra.informe;
    if (path.includes('referred_enrollment_id')) return extra.porInscripcion ?? { rows: [], total: 0 };
    throw new Error(`ruta no esperada ${path}`);
  });

function Alta({ onListo }: { onListo?: (r: ReturnType<typeof useReferidoAlta>) => void }) {
  const r = useReferidoAlta(ESCUELA);
  useEffect(() => { onListo?.(r); });
  return <div>{r.campo}{r.dialogo}</div>;
}

beforeEach(() => { vi.clearAllMocks(); supa.rows = [{ id: 'ENR-NUEVA' }]; });

describe('campo «¿Quién lo refirió?»', () => {
  it('campaña apagada: no hay campo', async () => {
    rutas(campana(false));
    conCliente(<Alta />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('referido-campo')).toBeNull();
  });

  it('sin campaña o sin migración: no hay campo', async () => {
    bff.get.mockRejectedValue({ status: 503, body: { code: 'MIGRACION_PENDIENTE' } });
    conCliente(<Alta />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('referido-campo')).toBeNull();
  });

  it('campaña activa: aparece el campo y permite texto libre', async () => {
    rutas(campana(true));
    alumnos.searchAthletes.mockResolvedValue([]);
    conCliente(<Alta />);
    const input = await screen.findByLabelText(/¿Quién lo refirió\?/);
    fireEvent.change(input, { target: { value: 'María López' } });
    fireEvent.click(await screen.findByText(/Usar «María López» como texto/));
    expect(screen.getByTestId('referente-elegido').textContent).toMatch(/María López/);
    expect(screen.getByTestId('referente-elegido').textContent).toMatch(/sin confirmar/);
  });

  it('registra DESPUÉS de crear la inscripción y avisa si el menor de 4 no califica', async () => {
    rutas(campana(true));
    bff.post.mockResolvedValue({ ok: false, califica: false, motivo: 'edad_fuera_de_tramos', edad: 3 });
    alumnos.searchAthletes.mockResolvedValue([{ id: 'a1', full_name: 'Carla Ruiz', enrollment_id: 'ENR-CARLA' }]);
    let ctl!: ReturnType<typeof useReferidoAlta>;
    conCliente(<Alta onListo={(r) => { ctl = r; }} />);
    fireEvent.change(await screen.findByLabelText(/¿Quién lo refirió\?/), { target: { value: 'Carla' } });
    fireEvent.click(await screen.findByText('Carla Ruiz'));
    await waitFor(() => expect(ctl.referente?.enrollmentId).toBe('ENR-CARLA'));
    await ctl.registrarTras({ tipo: 'child', id: 'c9', nombre: 'Bebé' });
    expect(bff.post).toHaveBeenCalledWith(
      '/api/v1/referidos',
      { referred_enrollment_id: 'ENR-NUEVA', referrer_enrollment_id: 'ENR-CARLA' },
      { 'x-school-id': ESCUELA },
    );
    expect(toastEstable.toast.mock.calls.at(-1)![0].title).toMatch(/no califica/);
  });

  it('REF_SIN_FECHA_NACIMIENTO: pide la fecha antes de registrar', async () => {
    rutas(campana(true));
    bff.post.mockRejectedValueOnce({ status: 422, body: { code: 'REF_SIN_FECHA_NACIMIENTO' } });
    alumnos.searchAthletes.mockResolvedValue([]);
    let ctl!: ReturnType<typeof useReferidoAlta>;
    conCliente(<Alta onListo={(r) => { ctl = r; }} />);
    fireEvent.change(await screen.findByLabelText(/¿Quién lo refirió\?/), { target: { value: 'Pedro' } });
    fireEvent.click(await screen.findByText(/Usar «Pedro» como texto/));
    await waitFor(() => expect(ctl.referente).toBeTruthy());
    void ctl.registrarTras({ tipo: 'child', id: 'c9', nombre: 'Sofía' });
    expect(await screen.findByText('Falta la fecha de nacimiento')).toBeTruthy();
  });
});

describe('ReferidoFicha', () => {
  it('campaña apagada y sin renglón: nada', async () => {
    rutas(campana(false));
    conCliente(<ReferidoFicha schoolId={ESCUELA} enrollmentId="E1" puedeEditar />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('referido-ficha')).toBeNull();
  });

  it('con renglón: «Referido por» con estado y mes del descuento', async () => {
    rutas(campana(true), {
      porInscripcion: {
        total: 1,
        rows: [{
          id: 'R1', status: 'ganado', pct: 50, apply_year: 2026, apply_month: 12, referred_enrollment_id: 'E1',
          referrer_enrollment_id: 'E2', referrer_profile_id: null, referrer_name: 'Laura Díaz',
        }],
      },
    });
    conCliente(<ReferidoFicha schoolId={ESCUELA} enrollmentId="E1" puedeEditar />);
    expect(await screen.findByText('Laura Díaz')).toBeTruthy();
    expect(screen.getByText('Ganado')).toBeTruthy();
    expect(screen.getByText('50 %')).toBeTruthy();
    expect(screen.getByText('diciembre de 2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Anular' })).toBeTruthy();
  });

  it('un referido aplicado ya no se puede cambiar ni anular', async () => {
    rutas(campana(true), {
      porInscripcion: { total: 1, rows: [{ id: 'R1', status: 'aplicado', pct: 25, apply_year: 2026, apply_month: 11,
        referred_enrollment_id: 'E1', referrer_enrollment_id: 'E2', referrer_profile_id: null, referrer_name: 'Laura' }] },
    });
    conCliente(<ReferidoFicha schoolId={ESCUELA} enrollmentId="E1" puedeEditar />);
    await screen.findByText('Aplicado');
    expect(screen.queryByRole('button', { name: 'Anular' })).toBeNull();
  });
});

describe('Configuración de la campaña', () => {
  it('sin campaña y sin poder crearla: nada', async () => {
    rutas(null);
    conCliente(<CampanaReferidosConfig schoolId={ESCUELA} />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('campana-referidos-config')).toBeNull();
  });

  it('con campaña apagada se ve para poder prenderla, con los tramos 50 % y 25 %', async () => {
    rutas(campana(false));
    conCliente(<CampanaReferidosConfig schoolId={ESCUELA} />);
    expect(await screen.findByTestId('campana-referidos-config')).toBeTruthy();
    expect((screen.getByLabelText('Campaña activa') as HTMLElement).getAttribute('aria-checked')).toBe('false');
    expect((screen.getAllByLabelText('Descuento %') as HTMLInputElement[]).map((i) => i.value)).toEqual(['50', '25']);
  });

  it('no deja guardar tramos cruzados', async () => {
    rutas(campana(false));
    conCliente(<CampanaReferidosConfig schoolId={ESCUELA} />);
    const desde = (await screen.findAllByLabelText('Desde (años)')) as HTMLInputElement[];
    fireEvent.change(desde[1], { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar campaña' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cruzarse/);
    expect(bff.put).not.toHaveBeenCalled();
  });

  it('guarda con los tramos y prende la campaña', async () => {
    rutas(campana(false));
    bff.put.mockResolvedValue({ campaign: campana(true) });
    conCliente(<CampanaReferidosConfig schoolId={ESCUELA} />);
    fireEvent.click(await screen.findByLabelText('Campaña activa'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar campaña' }));
    await waitFor(() => expect(bff.put).toHaveBeenCalled());
    const [ruta, cuerpo] = bff.put.mock.calls[0];
    expect(ruta).toBe('/api/v1/referidos/campaign');
    expect(cuerpo.active).toBe(true);
    expect(cuerpo.tiers).toEqual(TRAMOS_POR_DEFECTO);
  });
});

describe('Informe «Referidos»', () => {
  it('sin campaña: nada', async () => {
    rutas(null);
    conCliente(<InformeReferidos schoolId={ESCUELA} />);
    await waitFor(() => expect(bff.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('informe-referidos')).toBeNull();
  });

  it('muestra quién refirió a quién y el total dejado de cobrar', async () => {
    rutas(campana(true), {
      informe: {
        school_id: ESCUELA, year: 2026, month: 11,
        rows: [{ id: 'R1', status: 'aplicado', pct: 50, apply_year: 2026, apply_month: 11, referred_enrollment_id: 'E1',
          referrer_enrollment_id: 'E2', referrer_profile_id: null, referrer_name: 'Laura Díaz', referred_name: 'Tomás Rey',
          discount_amount: 90000 }],
        totals: { total: 1, por_estado: { aplicado: 1 }, dejado_de_cobrar: 90000 },
        by_month: [{ year: 2026, month: 11, aplicados: 1, ganados_por_aplicar: 0, dejado_de_cobrar: 90000 }],
      },
    });
    conCliente(<InformeReferidos schoolId={ESCUELA} />);
    expect((await screen.findByTestId('dejado-de-cobrar')).textContent).toMatch(/90\.000/);
    expect(screen.getByText('Tomás Rey')).toBeTruthy();
    expect(screen.getByText('Laura Díaz')).toBeTruthy();
  });

  it('sin referidos en el mes: estado vacío explicado', async () => {
    rutas(campana(true), {
      informe: { school_id: ESCUELA, year: 2026, month: 11, rows: [], totals: { total: 0, por_estado: {}, dejado_de_cobrar: 0 }, by_month: [] },
    });
    conCliente(<InformeReferidos schoolId={ESCUELA} />);
    expect(await screen.findByText(/No hay referidos con descuento en ese mes/)).toBeTruthy();
  });
});
