import { describe, it, expect, vi } from 'vitest';
import {
  ETIQUETA, ROTACION, construirRegistros, estadoInicial, faltanMucho, fechaMinimaCorregible, fechasCorregibles, opcionDeFecha,
  opcionesDeDia, resumir, sePuedeCorregir, siguienteEstado, textoAyuda, textoListaGuardada, textoVentanaCorreccion,
  type DeportistaLista,
} from './asistenciaModel';
import { ColaAsistencia, claveLista, fusionarRegistros, type ResultadoEnvio, type ListaEnCola } from './colaAsistencia';
import type { QueueStorage } from '@/lib/tournamentActionQueue';

const roster: DeportistaLista[] = [
  { id: 'a', full_name: 'Sofía Rojas', athlete_type: 'child', enrollment_id: 'e1' },
  { id: 'b', full_name: 'Martín Torres', athlete_type: 'child', aviso_ausencia: { motivo: 'enfermedad', nota: null, fuente: 'whatsapp' } },
  { id: 'c', full_name: 'Laura Gómez', athlete_type: 'adult' },
  { id: 'd', full_name: 'Invitado', athlete_type: 'unregistered' },
];

describe('rotación de los 4 estados (decisión 2)', () => {
  it('Vino → Faltó → Excusa → Tarde → Vino', () => {
    expect(ROTACION.map((s) => ETIQUETA[s])).toEqual(['Vino', 'Faltó', 'Excusa', 'Tarde']);
    let s = siguienteEstado('present');
    const vistos = [s];
    for (let i = 0; i < 3; i++) { s = siguienteEstado(s); vistos.push(s); }
    expect(vistos).toEqual(['absent', 'excused', 'late', 'present']);
  });
  it('sin estado se trata como «Vino»: el primer toque es «Faltó»', () => {
    expect(siguienteEstado(undefined)).toBe('absent');
  });
});

describe('estado inicial de la lista', () => {
  it('todos arrancan en Vino y quien avisó por WhatsApp en Excusa', () => {
    expect(estadoInicial(roster, [])).toEqual({ a: 'present', b: 'excused', c: 'present', d: 'present' });
  });
  it('respeta lo que ya guardó la base', () => {
    const e = estadoInicial(roster, [{ child_id: 'a', status: 'absent' }, { user_id: 'c', status: 'late' }]);
    expect(e).toMatchObject({ a: 'absent', b: 'excused', c: 'late', d: 'present' });
  });
  it('lo guardado en el teléfono (cola sin señal) manda sobre la base', () => {
    const e = estadoInicial(roster, [{ child_id: 'a', status: 'absent' }], { a: 'present', d: 'absent' });
    expect(e.a).toBe('present');
    expect(e.d).toBe('absent');
  });
  it('resumen y ayuda: vinieron cuenta a los que llegaron tarde', () => {
    const r = resumir({ a: 'present', b: 'excused', c: 'late', d: 'absent' }, ['a', 'b', 'c', 'd']);
    expect(r).toEqual({ vinieron: 2, faltaron: 1, excusas: 1, tarde: 1, total: 4 });
    expect(textoAyuda(resumir({ a: 'present', b: 'excused' }, ['a', 'b']), 'Martín')).toMatch(/Martín avisó que no viene/);
    expect(textoAyuda(resumir({ a: 'present' }, ['a']))).toBe('Todos vinieron. Toca solo al que faltó.');
  });
  it('construye los registros del BFF por tipo de deportista, con la inscripción vista', () => {
    const recs = construirRegistros(roster, { a: 'present', b: 'excused', c: 'absent', d: 'late' }, true);
    expect(recs[0]).toMatchObject({ childId: 'a', status: 'present', enrollmentId: 'e1', isSecondary: true });
    expect(recs[2]).toMatchObject({ userId: 'c', status: 'absent' });
    expect(recs[3]).toMatchObject({ unregisteredAthleteId: 'd', status: 'late' });
  });
});

describe('ventana de corrección = la de la escuela (B9)', () => {
  it('todos los días de la ventana, de hoy hacia atrás; solo hoy con ventana 0', () => {
    expect(fechasCorregibles('2026-10-08', 7)).toEqual([
      '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01',
    ]);
    expect(fechasCorregibles('2026-10-01', 1)).toEqual(['2026-10-01', '2026-09-30']);
    expect(fechasCorregibles('2026-10-08', 0)).toEqual(['2026-10-08']);
    expect(fechasCorregibles('2026-10-08', -3)).toEqual(['2026-10-08']);
  });

  it('se puede corregir dentro de la ventana, nunca el futuro', () => {
    expect(sePuedeCorregir('2026-10-06', '2026-10-08', 7)).toBe(true);
    expect(sePuedeCorregir('2026-10-01', '2026-10-08', 7)).toBe(true);
    expect(sePuedeCorregir('2026-09-30', '2026-10-08', 7)).toBe(false);
    expect(sePuedeCorregir('2026-10-09', '2026-10-08', 7)).toBe(false);
    expect(sePuedeCorregir('2026-10-07', '2026-10-08', 0)).toBe(false);
    // Carmel: 90 días.
    expect(sePuedeCorregir('2026-07-15', '2026-10-08', 90)).toBe(true);
    expect(fechaMinimaCorregible('2026-10-08', 90)).toBe('2026-07-10');
  });

  it('selector: Hoy / Ayer / Otro día según la ventana', () => {
    expect(opcionesDeDia(0)).toEqual(['hoy']);
    expect(opcionesDeDia(1)).toEqual(['hoy', 'ayer']);
    expect(opcionesDeDia(7)).toEqual(['hoy', 'ayer', 'otro']);
    expect(opcionDeFecha('2026-10-08', '2026-10-08')).toBe('hoy');
    expect(opcionDeFecha('2026-10-07', '2026-10-08')).toBe('ayer');
    expect(opcionDeFecha('2026-10-03', '2026-10-08')).toBe('otro');
  });

  it('el historial dice la ventana real', () => {
    expect(textoVentanaCorreccion(0)).toMatch(/solo .* del día/i);
    expect(textoVentanaCorreccion(1)).toBe('Se puede corregir hasta el día siguiente. Después, la corrige la escuela.');
    expect(textoVentanaCorreccion(7)).toBe('Se puede corregir hasta 7 días después. Después, la corrige la escuela.');
  });
});

describe('«Lista guardada» no suma las excusas a las faltas (B11)', () => {
  it('faltaron y con excusa por separado', () => {
    expect(textoListaGuardada({ vinieron: 2, faltaron: 1, excusas: 1 })).toBe('Lista guardada: vinieron 2, faltaron 1, con excusa 1.');
    expect(textoListaGuardada({ vinieron: 3, faltaron: 0, excusas: 1 })).toBe('Lista guardada: vinieron 3, con excusa 1.');
    expect(textoListaGuardada({ vinieron: 4, faltaron: 0, excusas: 0 })).toBe('Lista guardada: vinieron 4, faltaron 0.');
    expect(textoListaGuardada({ vinieron: 1, faltaron: 2, excusas: 0 })).toBe('Lista guardada: vinieron 1, faltaron 2.');
  });
});

describe('quién falta mucho', () => {
  it('menos del 70 % con al menos 3 entrenos, del que menos vino al que más', () => {
    const s = (id: string, recs: [string, string][]) => ({ id, session_date: '2026-10-01', finalized: true, records: recs.map(([k, st]) => ({ child_id: k, status: st })) });
    const sesiones = [
      s('1', [['a', 'present'], ['b', 'absent'], ['c', 'absent']]),
      s('2', [['a', 'present'], ['b', 'absent'], ['c', 'present']]),
      s('3', [['a', 'late'], ['b', 'present'], ['c', 'present']]),
      s('4', [['a', 'present'], ['b', 'excused'], ['c', 'absent']]),
    ];
    const r = faltanMucho(sesiones, new Map([['b', 'Martín'], ['c', 'Juan']]));
    expect(r.map((x) => [x.nombre, x.vino, x.de])).toEqual([['Martín', 1, 4], ['Juan', 2, 4]]);
  });
});

// ── Cola sin señal ───────────────────────────────────────────────────────────

function memoria(): QueueStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

const lista = (records: { childId: string; status: 'present' | 'absent' | 'excused' | 'late' }[]) => ({
  key: claveLista('s1', 'team:t1', '2026-10-08'),
  schoolId: 's1',
  etiqueta: 'Sub 11 · hoy',
  payload: { teamId: 't1', date: '2026-10-08', records },
});

describe('cola de listas sin señal', () => {
  it('guardar dos veces la misma lista deja UNA entrada (fusiona por deportista, gana lo último)', () => {
    let t = 1000;
    const cola = new ColaAsistencia({ key: 'k', storage: memoria(), now: () => t, send: vi.fn() });
    cola.guardar(lista([{ childId: 'a', status: 'present' }, { childId: 'b', status: 'absent' }]), 0);
    t += 10;
    cola.guardar(lista([{ childId: 'b', status: 'excused' }]), 0);
    expect(cola.size).toBe(1);
    const recs = cola.todas()[0].payload.records;
    expect(recs).toEqual([{ childId: 'a', status: 'present' }, { childId: 'b', status: 'excused' }]);
    expect(fusionarRegistros([{ childId: 'x', status: 'present' }], [{ childId: 'x', status: 'late' }])).toEqual([{ childId: 'x', status: 'late' }]);
  });

  it('no envía durante la ventana de Deshacer; Deshacer la saca sin tocar el servidor', async () => {
    let t = 0;
    const send = vi.fn(async (): Promise<ResultadoEnvio> => ({ kind: 'ok' }));
    const cola = new ColaAsistencia({ key: 'k', storage: memoria(), now: () => t, send });
    cola.guardar(lista([{ childId: 'a', status: 'absent' }]), 8000);
    await cola.flush(true);
    expect(send).not.toHaveBeenCalled();
    t = 7999;
    expect(cola.deshacer(claveLista('s1', 'team:t1', '2026-10-08'))).toBe(true);
    expect(cola.size).toBe(0);
    // Pasada la ventana ya no se puede deshacer.
    cola.guardar(lista([{ childId: 'a', status: 'absent' }]), 8000);
    t = 16000;
    expect(cola.deshacer(claveLista('s1', 'team:t1', '2026-10-08'))).toBe(false);
    await cola.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sin señal reintenta con espera; al volver sube UNA vez y no reenvía', async () => {
    let t = 0;
    let red = false;
    const enviados: ListaEnCola[] = [];
    const send = vi.fn(async (item: ListaEnCola): Promise<ResultadoEnvio> => {
      if (!red) return { kind: 'retry', message: 'Sin señal' };
      enviados.push(JSON.parse(JSON.stringify(item)));
      return { kind: 'ok' };
    });
    const storage = memoria();
    const cola = new ColaAsistencia({ key: 'k', storage, now: () => t, send });
    cola.guardar(lista([{ childId: 'a', status: 'present' }, { childId: 'b', status: 'absent' }]), 0);

    const ev1 = await cola.flush();
    expect(ev1[0]).toMatchObject({ type: 'retry', delayMs: 1000 });
    expect(cola.size).toBe(1);
    // Antes de que pase la espera no se insiste (sin force).
    t = 500;
    await cola.flush();
    expect(send).toHaveBeenCalledTimes(1);
    t = 1000;
    const ev2 = await cola.flush();
    expect(ev2[0]).toMatchObject({ type: 'retry', delayMs: 2000 });

    // La lista sobrevive a recargar la app (persistida).
    const recargada = new ColaAsistencia({ key: 'k', storage, now: () => t, send });
    expect(recargada.size).toBe(1);

    red = true;
    await recargada.flush(true); // «online»: fuerza
    expect(enviados).toHaveLength(1);
    expect(enviados[0].payload).toEqual({ teamId: 't1', date: '2026-10-08', records: [{ childId: 'a', status: 'present' }, { childId: 'b', status: 'absent' }] });
    expect(recargada.size).toBe(0);
    await recargada.flush(true);
    expect(enviados).toHaveLength(1);
  });

  it('si la vuelven a guardar mientras se enviaba, queda la versión nueva para el siguiente envío', async () => {
    const t = 0;
    let soltar: (r: ResultadoEnvio) => void = () => {};
    const send = vi.fn(() => new Promise<ResultadoEnvio>((res) => { soltar = res; }));
    const cola = new ColaAsistencia({ key: 'k', storage: memoria(), now: () => t, send });
    cola.guardar(lista([{ childId: 'a', status: 'present' }]), 0);
    const p = cola.flush(true);
    await Promise.resolve();
    cola.guardar(lista([{ childId: 'a', status: 'late' }]), 0);
    soltar({ kind: 'ok' });
    await p;
    expect(cola.size).toBe(1);
    expect(cola.todas()[0].payload.records[0].status).toBe('late');
  });

  it('un rechazo de regla no descarta la lista: queda con el error y no se reintenta sola', async () => {
    const send = vi.fn(async (): Promise<ResultadoEnvio> => ({ kind: 'rule', message: 'La sesión ya fue finalizada.' }));
    const cola = new ColaAsistencia({ key: 'k', storage: memoria(), now: () => 0, send });
    cola.guardar(lista([{ childId: 'a', status: 'present' }]), 0);
    await cola.flush(true);
    await cola.flush(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(cola.rechazadas()[0].error).toMatch(/finalizada/);
    expect(cola.pendientes()).toHaveLength(0);
  });

  it('sesión vencida (401): se detiene sin perder la lista', async () => {
    const send = vi.fn(async (): Promise<ResultadoEnvio> => ({ kind: 'auth', message: 'No hay sesión activa' }));
    const cola = new ColaAsistencia({ key: 'k', storage: memoria(), now: () => 0, send });
    cola.guardar(lista([{ childId: 'a', status: 'present' }]), 0);
    const ev = await cola.flush(true);
    expect(ev).toEqual([{ type: 'auth_error', message: 'No hay sesión activa', delayMs: 1000 }]);
    expect(cola.size).toBe(1);
  });

  it('dos listas distintas (otro equipo u otro día) son dos entradas y suben en orden', async () => {
    let t = 0;
    const orden: string[] = [];
    const send = vi.fn(async (i: ListaEnCola): Promise<ResultadoEnvio> => { orden.push(i.key); return { kind: 'ok' }; });
    const cola = new ColaAsistencia({ key: 'k', storage: memoria(), now: () => t, send });
    cola.guardar(lista([{ childId: 'a', status: 'present' }]), 0);
    t = 5;
    cola.guardar({ ...lista([{ childId: 'z', status: 'present' }]), key: claveLista('s1', 'team:t2', '2026-10-08') }, 0);
    await cola.flush(true);
    expect(orden).toEqual([claveLista('s1', 'team:t1', '2026-10-08'), claveLista('s1', 'team:t2', '2026-10-08')]);
  });
});
