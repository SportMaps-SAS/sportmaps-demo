// @vitest-environment jsdom
/**
 * Modo offline · Fase 1 (docs/specs/modo-offline-y-sincronizacion.md).
 * Sin IndexedDB real: jsdom no lo trae, así que `idbStore` cae a su respaldo en memoria
 * (el mismo camino que un navegador en modo privado). Lo que se prueba es la LÓGICA:
 * lista blanca, aislamiento por usuario, vencimiento, borrado al salir y arranque con red caída.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { esConsultaOffline, OFFLINE_CACHE_VERSION, OFFLINE_MAX_AGE_MS } from './offlineConfig';
import { __reiniciarIdbParaPruebas, idbGet, idbSet } from './idbStore';
import {
  borrarCopiaLocal, configurarRetencionOffline, estadoParaGuardar, iniciarGuardado, restaurarConsultas,
} from './queryPersistence';
import {
  COPIA_ARRANQUE_MAX_EDAD_MS, guardarCopiaArranque, leerCopiaArranque, leerSesionGuardada, limpiarDatosOffline,
} from './arranqueSinRed';
import { etiquetaFrescura } from './frescura';
import { configurarReconexionEscalonada } from './reconexion';
import { precargarDiaDelEntrenador, MAX_EQUIPOS_PRECARGA } from './precargaDelDia';

const nuevoQC = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { __reiniciarIdbParaPruebas(); localStorage.clear(); });
afterEach(() => { __reiniciarIdbParaPruebas(); localStorage.clear(); });

describe('lista blanca de consultas', () => {
  it('entra lo del flujo del entrenador, por prefijo exacto', () => {
    expect(esConsultaOffline(['v2-asis-roster', 'team', 'abc'])).toBe(true);
    expect(esConsultaOffline(['coach-v2', 'equipos', 's1'])).toBe(true);
    expect(esConsultaOffline(['v2-asis-sesion', 'team:abc', '2026-11-23'])).toBe(true);
  });

  it('NO entra pagos, informes, buscador ni nada que no esté listado', () => {
    expect(esConsultaOffline(['coach-v2', 'pago', 'team1'])).toBe(false);
    expect(esConsultaOffline(['coach-v2', 'informes', 's1', 2026, 11])).toBe(false);
    expect(esConsultaOffline(['coach-v2', 'buscar-refuerzos', 's1', 't1', 'ana'])).toBe(false);
    expect(esConsultaOffline(['payments', 's1'])).toBe(false);
    expect(esConsultaOffline(['coach-v2'])).toBe(false); // el prefijo solo no basta
    expect(esConsultaOffline([])).toBe(false);
  });

  it('Fase 4: entra el Inicio del deportista, pero NO cobros, informes ni lo que traga errores', () => {
    expect(esConsultaOffline(['athlete-v2-teams', 'u1'])).toBe(true);
    expect(esConsultaOffline(['athlete-v2-attendance', 'u1'])).toBe(true);
    expect(esConsultaOffline(['athlete-v2-callups', 'u1'])).toBe(true);
    expect(esConsultaOffline(['athlete-v2-autoeval', 'u1'])).toBe(true);
    expect(esConsultaOffline(['athlete-v2-kudos', 'u1', 20])).toBe(true);
    for (const k of ['athlete-v2-cobros', 'athlete-v2-informes', 'athlete-v2-fichas', 'athlete-v2-plan', 'athlete-v2-torneos-abiertos', 'athlete-performance-entries']) {
      expect(esConsultaOffline([k, 'u1'])).toBe(false);
    }
  });

  it('un prefijo parecido no cuenta (v2-asis-roster-x ≠ v2-asis-roster)', () => {
    expect(esConsultaOffline(['v2-asis-roster-x'])).toBe(false);
  });
});

describe('persistencia de lecturas', () => {
  it('guarda solo la lista blanca y solo consultas con éxito', () => {
    const qc = nuevoQC();
    qc.setQueryData(['v2-asis-roster', 'team', 't1'], { athletes: [{ id: 'a' }] });
    qc.setQueryData(['payments', 's1'], [{ monto: 100 }]);
    qc.setQueryData(['coach-v2', 'pago', 't1'], { saldo: 1 });
    const claves = estadoParaGuardar(qc).queries.map((q) => q.queryKey[0]);
    expect(claves).toEqual(['v2-asis-roster']);
  });

  it('guarda tras un cambio y restaura en un cliente nuevo (cierre y reapertura de la app)', async () => {
    const qc = nuevoQC();
    const parar = iniciarGuardado(qc, 'u1');
    qc.setQueryData(['v2-asis-roster', 'team', 't1'], { athletes: [{ id: 'a', full_name: 'Ana' }] });
    await esperar(1700);
    parar();

    const otro = nuevoQC();
    const n = await restaurarConsultas(otro, 'u1');
    expect(n).toBe(1);
    expect(otro.getQueryData(['v2-asis-roster', 'team', 't1'])).toEqual({ athletes: [{ id: 'a', full_name: 'Ana' }] });
  });

  it('restaura también un Map (las listas del historial lo usan) — clon estructurado, no JSON', async () => {
    const qc = nuevoQC();
    const parar = iniciarGuardado(qc, 'u1');
    qc.setQueryData(['v2-ses-listas', 'a,b', '2026-11-01', '2026-11-30'], new Map([['k', { vino: 1, total: 2 }]]));
    await esperar(1700);
    parar();
    const otro = nuevoQC();
    await restaurarConsultas(otro, 'u1');
    const v = otro.getQueryData(['v2-ses-listas', 'a,b', '2026-11-01', '2026-11-30']);
    expect(v instanceof Map).toBe(true);
  });

  it('AISLAMIENTO: otra cuenta del mismo celular no lee la copia', async () => {
    const qc = nuevoQC();
    const parar = iniciarGuardado(qc, 'u1');
    qc.setQueryData(['v2-asis-roster', 'team', 't1'], { athletes: [{ id: 'a' }] });
    await esperar(1700);
    parar();

    const delOtro = nuevoQC();
    expect(await restaurarConsultas(delOtro, 'u2')).toBe(0);
    expect(delOtro.getQueryData(['v2-asis-roster', 'team', 't1'])).toBeUndefined();
  });

  it('una copia cuyo userId no coincide con su clave se descarta (archivo manipulado)', async () => {
    await idbSet('rq:u2', { v: OFFLINE_CACHE_VERSION, userId: 'u1', savedAt: Date.now(), state: { mutations: [], queries: [] } });
    expect(await restaurarConsultas(nuevoQC(), 'u2')).toBe(0);
  });

  it('VENCIMIENTO: pasadas 36 h no se usa', async () => {
    const qc = nuevoQC();
    const parar = iniciarGuardado(qc, 'u1');
    qc.setQueryData(['v2-asis-roster', 'team', 't1'], { athletes: [] });
    await esperar(1700);
    parar();
    const dentro = await restaurarConsultas(nuevoQC(), 'u1', Date.now() + OFFLINE_MAX_AGE_MS - 60_000);
    const fuera = await restaurarConsultas(nuevoQC(), 'u1', Date.now() + OFFLINE_MAX_AGE_MS + 60_000);
    expect(dentro).toBe(1);
    expect(fuera).toBe(0);
  });

  it('una versión distinta de la copia se descarta (cambió la forma de los datos)', async () => {
    await idbSet('rq:u1', { v: OFFLINE_CACHE_VERSION + 1, userId: 'u1', savedAt: Date.now(), state: { mutations: [], queries: [] } });
    expect(await restaurarConsultas(nuevoQC(), 'u1')).toBe(0);
  });

  it('CIERRE DE SESIÓN: borrarCopiaLocal quita la copia de TODOS los usuarios del celular', async () => {
    await idbSet('rq:u1', { v: 1 });
    await idbSet('rq:u2', { v: 1 });
    await idbSet('otra-cosa', { v: 1 });
    await borrarCopiaLocal();
    expect(await idbGet('rq:u1')).toBeUndefined();
    expect(await idbGet('rq:u2')).toBeUndefined();
    expect(await idbGet('otra-cosa')).toEqual({ v: 1 }); // solo lo de este módulo
  });

  it('no restaura nada si no hay copia (primer uso) y nunca lanza', async () => {
    expect(await restaurarConsultas(nuevoQC(), 'nadie')).toBe(0);
  });

  it('las consultas de la lista blanca se retienen en memoria 36 h y se intentan aunque no haya red', () => {
    const qc = nuevoQC();
    configurarRetencionOffline(qc);
    const d = qc.getQueryDefaults(['v2-asis-roster', 'team', 't1']);
    expect(d.gcTime).toBe(OFFLINE_MAX_AGE_MS);
    expect(d.networkMode).toBe('offlineFirst');
    expect(qc.getQueryDefaults(['payments', 's1']).gcTime).toBeUndefined();
  });
});

describe('arranque sin señal', () => {
  const sesionSupabase = (extra: object = {}) =>
    JSON.stringify({ access_token: 'x', refresh_token: 'r', user: { id: 'u1', email: 'a@b.co' }, ...extra });

  it('reconoce la sesión que supabase-js dejó guardada', () => {
    localStorage.setItem('sb-proyecto-auth-token', sesionSupabase());
    expect(leerSesionGuardada()?.user.id).toBe('u1');
  });

  it('sin refresh_token o con JSON roto NO hay sesión guardada', () => {
    localStorage.setItem('sb-proyecto-auth-token', JSON.stringify({ user: { id: 'u1' } }));
    expect(leerSesionGuardada()).toBeNull();
    localStorage.setItem('sb-proyecto-auth-token', '{no es json');
    expect(leerSesionGuardada()).toBeNull();
    localStorage.clear();
    expect(leerSesionGuardada()).toBeNull();
  });

  it('copia de arranque: solo para ese usuario y con vencimiento', () => {
    guardarCopiaArranque('escuelas', 'u1', [{ schoolId: 's1' }]);
    expect(leerCopiaArranque('escuelas', 'u1')).toEqual([{ schoolId: 's1' }]);
    expect(leerCopiaArranque('escuelas', 'u2')).toBeNull();
    expect(leerCopiaArranque('escuelas', 'u1', localStorage, Date.now() + COPIA_ARRANQUE_MAX_EDAD_MS + 1000)).toBeNull();
  });

  it('copia de arranque con la clave de otro usuario manipulada se descarta', () => {
    guardarCopiaArranque('auth', 'u1', { profile: { id: 'u1' } });
    const raw = localStorage.getItem('sm_offline_boot:auth:u1')!;
    localStorage.setItem('sm_offline_boot:auth:u2', raw); // copia de u1 puesta bajo la clave de u2
    expect(leerCopiaArranque('auth', 'u2')).toBeNull();
  });

  it('CIERRE DE SESIÓN: limpiarDatosOffline borra copias de arranque y lecturas del entrenador, y deja lo demás', async () => {
    guardarCopiaArranque('auth', 'u1', { x: 1 });
    localStorage.setItem('sm_coach_v2_cache:roster:team:t1', '{"athletes":[]}');
    localStorage.setItem('sm_coach_v2_listas:u1', '[]'); // cola de listas SIN subir: no se toca
    localStorage.setItem('sportmaps_theme', 'dark');
    await idbSet('rq:u1', { v: 1 });
    await limpiarDatosOffline();
    expect(localStorage.getItem('sm_offline_boot:auth:u1')).toBeNull();
    expect(localStorage.getItem('sm_coach_v2_cache:roster:team:t1')).toBeNull();
    expect(localStorage.getItem('sm_coach_v2_listas:u1')).toBe('[]');
    expect(localStorage.getItem('sportmaps_theme')).toBe('dark');
    expect(await idbGet('rq:u1')).toBeUndefined();
  });
});

describe('etiqueta de frescura', () => {
  const ahora = new Date(2026, 10, 23, 15, 0).getTime(); // lunes 23-nov-2026 15:00
  it('hoy / ayer / día de la semana', () => {
    expect(etiquetaFrescura(new Date(2026, 10, 23, 14, 5).getTime(), ahora)).toBe('hoy 14:05');
    expect(etiquetaFrescura(new Date(2026, 10, 22, 18, 30).getTime(), ahora)).toBe('ayer 18:30');
    expect(etiquetaFrescura(new Date(2026, 10, 20, 7, 9).getTime(), ahora)).toBe('vie 7:09');
  });
  it('sin marca de tiempo no inventa nada', () => {
    expect(etiquetaFrescura(0, ahora)).toBeNull();
    expect(etiquetaFrescura(undefined, ahora)).toBeNull();
  });
});

describe('reconexión escalonada', () => {
  afterEach(() => { onlineManager.setEventListener((setOnline) => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }); });

  it('al volver la red React Query se entera con retraso; al irse, al instante', async () => {
    configurarReconexionEscalonada(300);
    window.dispatchEvent(new Event('offline'));
    expect(onlineManager.isOnline()).toBe(false);
    window.dispatchEvent(new Event('online'));
    expect(onlineManager.isOnline()).toBe(false); // aún no: espera su turno aleatorio
    await esperar(450);
    expect(onlineManager.isOnline()).toBe(true);
  });
});

describe('precarga del día', () => {
  const equipo = (n: number) => ({ id: `t${n}`, nombre: `Equipo ${n}` });

  it('con tope de equipos y sin repetir lo fresco', async () => {
    const qc = nuevoQC();
    const llamadas: string[] = [];
    qc.setQueryDefaults(['v2-asis-roster'], { queryFn: () => { llamadas.push('roster'); return Promise.resolve({ athletes: [] }); } });
    // Las opciones reales traen su propia queryFn (red); se sustituyen interceptando prefetchQuery.
    const original = qc.prefetchQuery.bind(qc);
    qc.prefetchQuery = ((o: { queryKey: readonly unknown[] }) => {
      llamadas.push(String(o.queryKey[0]));
      qc.setQueryData(o.queryKey, { athletes: [] });
      return Promise.resolve();
    }) as typeof qc.prefetchQuery;
    const hechos = await precargarDiaDelEntrenador(qc, Array.from({ length: 12 }, (_, i) => equipo(i)), '2026-11-23');
    expect(hechos).toBe(MAX_EQUIPOS_PRECARGA);
    expect(llamadas.filter((x) => x === 'v2-asis-roster')).toHaveLength(MAX_EQUIPOS_PRECARGA);
    expect(llamadas.filter((x) => x === 'v2-asis-sesion')).toHaveLength(MAX_EQUIPOS_PRECARGA);
    qc.prefetchQuery = original;
  });

  it('sin red no pide nada', async () => {
    const qc = nuevoQC();
    let llamado = false;
    qc.prefetchQuery = (() => { llamado = true; return Promise.resolve(); }) as typeof qc.prefetchQuery;
    const spy = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      expect(await precargarDiaDelEntrenador(qc, [equipo(1)], '2026-11-23')).toBe(0);
      expect(llamado).toBe(false);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).onLine;
      if (spy) Object.defineProperty(Navigator.prototype, 'onLine', spy);
    }
  });

  it('se detiene cuando `seguir` devuelve false (se desmontó la pantalla)', async () => {
    const qc = nuevoQC();
    qc.prefetchQuery = (() => Promise.resolve()) as typeof qc.prefetchQuery;
    expect(await precargarDiaDelEntrenador(qc, [equipo(1), equipo(2)], '2026-11-23', { seguir: () => false })).toBe(0);
  });
});
