/**
 * Arreglos de las pruebas del acudiente V2 (2026-10-26): lógica pura.
 * B1 convocatorias · B2 carpetas de documentos · B6 comentario del profe ·
 * B8 rótulo de cobros sin hijo · B10 doble punto · #26 «el más antiguo» · #29 avatar.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  convocatoriasDeHijos,
  convocatoriasDelEvento,
  fraseRespuesta,
  preguntaConvocatoria,
  proximaConvocatoriaDe,
} from './convocatoriasAcudiente';
import { conPuntoFinal, fotoDeVerdad, resumenFamilia, type Cobro } from './parentHomeLogic';
import { rotuloCobroSinHijo } from './pagosModel';
import {
  carpetaDocsFamilia,
  carpetasDocumentosDeportista,
  comentariosDelProfe,
  isSkillMetric,
  isTextMetric,
  skillRows,
  skillRowsFromSnapshot,
} from './hijos/hijosUtils';

// ── B1 ───────────────────────────────────────────────────────────────────────
const fila = (extra: Record<string, unknown> = {}) => ({
  lineup_id: 'l-1', match_id: 'm-1', school_id: 's-1', team_id: 't-sub15', team_name: 'Fútbol — Sub-15',
  subject_type: 'child', subject_id: 'c-tomas', athlete_name: 'Tomás Herrera', role: 'starter',
  opponent: 'Halcones FC', match_date: '2026-10-31', kickoff_at: '2026-10-31T15:00:00Z',
  location: 'Unidad Deportiva', is_home: true, notes: 'Uniforme blanco', response: null, responded_at: null,
  ...extra,
});

describe('convocatorias de los hijos (B1)', () => {
  it('solo las de los hijos: la propia del acudiente (profile) y la de su ficha no', () => {
    const r = convocatoriasDeHijos([
      fila(),
      fila({ lineup_id: 'l-2', subject_type: 'profile', subject_id: 'u-papa' }),
      fila({ lineup_id: 'l-3', subject_type: 'unregistered', subject_id: 'ua-1' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ lineupId: 'l-1', childId: 'c-tomas', nombre: 'Tomás', rival: 'Halcones FC', fecha: '2026-10-31', titular: true, respuesta: null });
  });

  it('filas raras no rompen: sin lineup o sin hijo se ignoran; respuesta inválida queda en null', () => {
    expect(convocatoriasDeHijos(null)).toEqual([]);
    expect(convocatoriasDeHijos([fila({ lineup_id: null }), fila({ subject_id: '' })])).toEqual([]);
    expect(convocatoriasDeHijos([fila({ response: 'tal_vez' })])[0].respuesta).toBeNull();
    expect(convocatoriasDeHijos([fila({ response: 'no_va' })])[0].respuesta).toBe('no_va');
  });

  it('ordena del partido más cercano al más lejano y la tarjeta de Inicio toma el próximo de cada hijo', () => {
    const r = convocatoriasDeHijos([fila({ lineup_id: 'tarde', match_date: '2026-11-07' }), fila({ lineup_id: 'pronto' })]);
    expect(r.map((c) => c.lineupId)).toEqual(['pronto', 'tarde']);
    expect(proximaConvocatoriaDe(r, 'c-tomas')?.lineupId).toBe('pronto');
    expect(proximaConvocatoriaDe(r, 'c-sofia')).toBeNull();
  });

  it('el partido del Calendario se cruza por equipo y día', () => {
    const r = convocatoriasDeHijos([fila()]);
    const partido = { kind: 'match', teamId: 't-sub15', start: new Date(2026, 9, 31, 10, 0) };
    expect(convocatoriasDelEvento(r, partido)).toHaveLength(1);
    expect(convocatoriasDelEvento(r, { ...partido, teamId: 't-otro' })).toHaveLength(0);
    expect(convocatoriasDelEvento(r, { ...partido, start: new Date(2026, 10, 1, 10, 0) })).toHaveLength(0);
    expect(convocatoriasDelEvento(r, { ...partido, kind: 'training' })).toHaveLength(0);
  });

  it('copy: «¿Va Tomás…?» y la confirmación', () => {
    const [c] = convocatoriasDeHijos([fila()]);
    expect(preguntaConvocatoria(c)).toBe('¿Va Tomás al partido contra Halcones FC?');
    expect(preguntaConvocatoria({ ...c, rival: null })).toBe('¿Va Tomás al próximo partido?');
    expect(fraseRespuesta(c, 'no_va')).toBe('Le avisaste al profe que Tomás no puede ir.');
  });
});

// ── #26 y B10 ────────────────────────────────────────────────────────────────
const HOY = new Date(2026, 9, 8, 10, 0);
const cobro = (extra: Partial<Cobro>): Cobro => ({
  id: 'p', amount: 180_000, amount_paid: 0, status: 'overdue', child_id: 'c-tomas', parent_id: 'u-1',
  due_date: '2026-08-13', period_year: 2026, period_month: 8, concept: 'Mensualidad', payment_category: 'mensualidad',
  ...extra,
});
const HIJOS = [{ id: 'c-tomas', nombre: 'Tomás Herrera' }, { id: 'c-brayan', nombre: 'Brayan Herrera' }];

describe('frase de lo que se debe (#26)', () => {
  it('con varios cobros dice cuál es el más antiguo, de qué hijo y de qué concepto', () => {
    const r = resumenFamilia([cobro({ id: 'a' }), cobro({ id: 'b', period_month: 9, due_date: '2026-09-10' })], HIJOS, 'Mauricio', HOY);
    expect(r.subtitulo).toBe('El más antiguo, la mensualidad de agosto de Tomás, venció el 13 de agosto. Lo de Brayan está al día.');
  });

  it('con varios cobros sin vencer dice cuál es el próximo', () => {
    const r = resumenFamilia(
      [cobro({ id: 'a', status: 'pending', due_date: '2026-10-10', period_month: 10 }), cobro({ id: 'b', status: 'pending', child_id: 'c-brayan', due_date: '2026-10-20', period_month: 10 })],
      HIJOS, 'Mauricio', HOY,
    );
    expect(r.subtitulo).toBe('El próximo, la mensualidad de octubre de Tomás, vence el sábado 10.');
  });

  it('con un solo cobro se queda como estaba', () => {
    const r = resumenFamilia([cobro({})], HIJOS, 'Mauricio', HOY);
    expect(r.subtitulo).toBe('Venció el 13 de agosto. Lo de Brayan está al día.');
  });
});

describe('punto final sin duplicar (B10 / #28)', () => {
  it('«8:00 p. m.» no recibe otro punto', () => {
    expect(conPuntoFinal('hoy a las 8:00 p. m.')).toBe('hoy a las 8:00 p. m.');
    expect(conPuntoFinal('la cancha 2')).toBe('la cancha 2.');
    expect(conPuntoFinal('mañana ')).toBe('mañana.');
  });
});

describe('avatar del hijo (#29)', () => {
  it('los avatares generados (dicebear, la mascota) se cambian por las iniciales', () => {
    expect(fotoDeVerdad('https://api.dicebear.com/7.x/avataaars/svg?seed=abc')).toBeNull();
    expect(fotoDeVerdad('/mapi/mapi-avatar-512.png')).toBeNull();
    expect(fotoDeVerdad('')).toBeNull();
    expect(fotoDeVerdad(null)).toBeNull();
    const real = 'https://x.supabase.co/storage/v1/object/public/avatars/c-1.jpg';
    expect(fotoDeVerdad(real)).toBe(real);
  });
});

// ── B8 ───────────────────────────────────────────────────────────────────────
describe('rótulo de un cobro sin hijo (B8)', () => {
  const hijos = [{ full_name: 'Tomás Herrera' }, { full_name: 'Sofía Herrera' }];
  it('si el concepto nombra a un solo hijo, es de ese hijo', () => {
    expect(rotuloCobroSinHijo({ concept: 'Mensualidad Julio 2026 — Tenis (Tomas)', parent_id: 'u-1' }, 'u-1', hijos, false)).toBe('Tomás');
  });
  it('«Tú (como atleta)» solo si el acudiente tiene inscripción propia', () => {
    expect(rotuloCobroSinHijo({ concept: 'Mensualidad', parent_id: 'u-1' }, 'u-1', hijos, true)).toBe('Tú (como atleta)');
    expect(rotuloCobroSinHijo({ concept: 'Mensualidad', parent_id: 'u-1' }, 'u-1', hijos, false)).toBe('Sin deportista asignado');
  });
  it('si nombra a dos hijos no adivina', () => {
    expect(rotuloCobroSinHijo({ concept: 'Uniformes Tomás y Sofía', parent_id: 'u-1' }, 'u-1', hijos, false)).toBe('Sin deportista asignado');
  });
  it('un nombre dentro de otra palabra no cuenta', () => {
    expect(rotuloCobroSinHijo({ concept: 'Tomasino FC', parent_id: 'u-1' }, 'u-1', hijos, false)).toBe('Sin deportista asignado');
  });
});

// ── B6 ───────────────────────────────────────────────────────────────────────
describe('«Comentario del coach» no es una habilidad (B6)', () => {
  it('criterio de texto fuera de las barras, por clave, por nombre o por scale', () => {
    expect(isTextMetric({ metric_key: 'comentario' })).toBe(true);
    expect(isTextMetric({ metric_key: 'x', display_name: 'Comentario del coach' })).toBe(true);
    expect(isTextMetric({ metric_key: 'x', scale: 'text' })).toBe(true);
    expect(isTextMetric({ metric_key: 'comunicacion', display_name: 'Comunicación' })).toBe(false);
    expect(isSkillMetric({ metric_key: 'comentario' })).toBe(false);
  });

  it('skillRows ya no pinta «Comentario 0»', () => {
    const rows = skillRows(
      [
        { metric_key: 'actitud', display_name: 'Actitud', min_value: 1, max_value: 5, higher_is_better: true },
        { metric_key: 'comentario', display_name: 'Comentario del coach', min_value: null, max_value: null, higher_is_better: true },
        { metric_key: 'nota_libre', display_name: 'Observación', unit: '', min_value: null, max_value: null, higher_is_better: true },
      ],
      {
        actitud: [{ date: '2026-10-24', value: 5 }],
        comentario: [{ date: '2026-10-24', value: 0 }],
        nota_libre: [{ date: '2026-10-24', value: 0 }],
      },
    );
    expect(rows.map((r) => r.key)).toEqual(['actitud']);
    expect(skillRowsFromSnapshot([
      { metric_key: 'comentario', label: 'Comentario del coach', unit: null, category: null, value: 0, delta: null, higher_is_better: true, measured_at: '2026-10-24' },
    ])).toEqual([]);
  });

  it('«Lo que dijo el profe» sale del texto (notes), del más reciente, sin repetir', () => {
    const c = comentariosDelProfe([
      { metric_key: 'comentario', value: 0, context_type: 'competition', recorded_at: '2026-10-24T20:00:00Z', notes: 'Dos goles y mucha entrega.' },
      { metric_key: 'comentario', value: 0, context_type: 'competition', recorded_at: '2026-10-26T20:00:00Z', notes: '  Gran partido.  ' },
      { metric_key: 'comentario', value: 0, context_type: 'competition', recorded_at: '2026-10-20T20:00:00Z', notes: 'Gran partido.' },
      { metric_key: 'comentario', value: 0, recorded_at: '2026-10-27T20:00:00Z', notes: '   ' },
      { metric_key: 'actitud', value: 5, recorded_at: '2026-10-27T20:00:00Z', notes: 'no es comentario' },
    ], 3);
    expect(c.map((x) => x.texto)).toEqual(['Gran partido.', 'Dos goles y mucha entrega.']);
    expect(c[0].contexto).toBe('competition');
  });
});

// ── B2 ───────────────────────────────────────────────────────────────────────
describe('carpetas de documentos que revisa la escuela (B2)', () => {
  it('la vieja y la de la familia (la única que el bucket le deja escribir al acudiente)', () => {
    expect(carpetasDocumentosDeportista('c-1', 'u-papa')).toEqual(['children/c-1/docs', 'children/u-papa/c-1/docs']);
    expect(carpetasDocumentosDeportista('c-1', null)).toEqual(['children/c-1/docs']);
    // La familia sube exactamente donde la escuela lee.
    expect(carpetaDocsFamilia('u-papa', 'c-1')).toBe(carpetasDocumentosDeportista('c-1', 'u-papa')[1]);
  });
});

// ── B9 ───────────────────────────────────────────────────────────────────────
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { puedeCrearAnuncios } from '@/pages/AnnouncementsPage';

describe('Anuncios: la familia lee pero no crea (B9)', () => {
  it('acudiente y deportista no ven «Nuevo Anuncio»; el staff sí', () => {
    expect(puedeCrearAnuncios('parent')).toBe(false);
    expect(puedeCrearAnuncios('athlete')).toBe(false);
    expect(puedeCrearAnuncios(undefined)).toBe(false);
    for (const r of ['coach', 'school', 'school_admin', 'admin']) expect(puedeCrearAnuncios(r)).toBe(true);
  });
});
