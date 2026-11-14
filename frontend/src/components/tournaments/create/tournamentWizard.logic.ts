/**
 * Lógica pura del asistente rápido de torneos (sin React): arma los pedidos al BFF para la
 * escuela (complemento Torneos) y para el organizador, que usan endpoints distintos.
 */
import type { TournamentSport, WizardFormat } from '@/lib/tournamentSports';
import type { TournamentActor } from '@/lib/tournaments/tournamentAccess';
import { resolveSport } from '@/lib/sports/sportCatalog';

export type WizardKind = 'single' | 'categories';

export interface WizardAnswers {
  name: string;
  kind: WizardKind;
  /** Solo con «Con categorías». */
  categories: string[];
  sport: TournamentSport;
  preset: string;
  format: WizardFormat;
}

/** Sugerencias rápidas para «Con categorías» (por edad, rama y deporte). */
export const CATEGORY_SUGGESTIONS = ['Sub-10', 'Sub-12', 'Sub-14', 'Sub-16', 'Sub-18', 'Libre', 'Femenino', 'Masculino', 'Mixto'];

/** Fecha local de Bogotá (YYYY-MM-DD) dentro de `days` días: el borrador necesita una fecha y se cambia después. */
export function draftDate(now: Date, days = 14): string {
  const d = new Date(now.getTime() + days * 86400_000 - 5 * 3600_000);
  return d.toISOString().slice(0, 10);
}

export function ramaFor(name: string): string {
  const n = name.toLowerCase();
  if (/femen|damas|mujer/.test(n)) return 'Femenino';
  if (/mascul|varon|hombre/.test(n)) return 'Masculino';
  return 'Mixto';
}

/** Categorías limpias: sin vacías ni repetidas, máximo 30. «Un solo torneo» = una categoría General. */
export function categoryRows(a: Pick<WizardAnswers, 'kind' | 'categories'>) {
  if (a.kind === 'single') return [{ division: 'General', category: 'General', rama: 'Mixto', sort_order: 0 }];
  const seen = new Set<string>();
  const names = a.categories.map((c) => c.trim().slice(0, 60)).filter((c) => {
    const k = c.toLowerCase();
    if (!c || seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 30);
  return names.map((c, i) => ({ division: 'General', category: c, rama: ramaFor(c), sort_order: i }));
}

/**
 * Deportes de la escuela (schools.sports ∪ deporte de sus equipos) como claves del catálogo único
 * (`resolveSport`, que entiende tildes, plurales y sinónimos). «Multideporte» o vacío = sin filtro.
 */
export function schoolSportKeys(texts: ReadonlyArray<string | null | undefined>): { keys: Set<string>; multi: boolean } {
  const keys = new Set<string>();
  let multi = false;
  for (const t of texts) {
    const r = resolveSport(t);
    if (r.key === 'multideporte') multi = true;
    else if (r.key !== 'desconocido') keys.add(r.key);
  }
  return { keys, multi };
}

/**
 * Paso «¿Qué deporte?»: si la escuela es de UN solo deporte, ese va arriba y los demás plegados
 * en «Ver otros deportes». Multideporte (o sin deportes conocidos): todos, los suyos primero.
 */
export function sportsForSchool<T extends { name: string }>(all: readonly T[], texts: ReadonlyArray<string | null | undefined>): { main: T[]; others: T[] } {
  const { keys, multi } = schoolSportKeys(texts);
  // Solo coincidencias exactas del catálogo: «Futvóley» se parece a voleibol pero es otro deporte.
  const isMine = (s: T) => { const r = resolveSport(s.name); return r.match === 'exacto' && keys.has(r.key); };
  const mine = all.filter(isMine);
  const rest = all.filter((s) => !isMine(s));
  if (!multi && keys.size === 1 && mine.length > 0) return { main: mine, others: rest };
  return { main: [...mine, ...rest], others: [] };
}

export function validateStep(step: number, a: Partial<WizardAnswers>): string | null {
  if (step === 0 && !(a.name ?? '').trim()) return 'Escribe el nombre del torneo.';
  if (step === 0 && (a.name ?? '').trim().length > 120) return 'El nombre es muy largo (máximo 120 letras).';
  if (step === 1 && a.kind === 'categories' && categoryRows({ kind: 'categories', categories: a.categories ?? [] }).length === 0) return 'Agrega al menos una categoría.';
  if (step === 1 && !a.kind) return 'Elige el tipo de torneo.';
  if (step === 2 && !a.sport) return 'Elige el deporte.';
  if (step === 3 && !a.format) return 'Elige el formato.';
  return null;
}

const slugify = (t: string) => {
  const base = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  return `${base || 'torneo'}-${Math.random().toString(36).slice(2, 8)}`;
};

/**
 * Escuela: POST /api/v1/events/school-tournament exige fecha, hora, dirección y ciudad; el asistente
 * no las pregunta (Copa Fácil tampoco) y manda valores de borrador que se editan en el detalle.
 * Alcance 'external' porque los equipos pueden ser de la escuela o invitados; gratis hasta que la
 * escuela configure el cobro.
 */
export function schoolPayload(a: WizardAnswers, now = new Date()) {
  return {
    title: a.name.trim(),
    sport: a.sport.name,
    event_date: draftDate(now),
    start_time: '08:00',
    address: 'Por definir',
    city: 'Por definir',
    tournament_scope: 'external' as const,
    visibility: 'public' as const,
    registration_type: 'delegation' as const,
    is_paid: false,
    payment_methods: [] as string[],
    categories: categoryRows(a),
    // El formato elegido queda en el torneo: el generador de calendario arranca con él.
    competition_format: a.format,
  };
}

/** Organizador: POST /api/v1/events (pide slug; dirección y ciudad son opcionales). */
export function organizerPayload(a: WizardAnswers, now = new Date()) {
  return {
    title: a.name.trim(),
    sport: a.sport.name,
    event_date: draftDate(now),
    start_time: '08:00',
    slug: slugify(a.name),
    visibility: 'public',
    registration_type: 'delegation',
    categories: categoryRows(a),
    competition_format: a.format,
  };
}

export interface CreateClient {
  post: <T>(url: string, body: unknown) => Promise<T>;
  patch: <T>(url: string, body: unknown) => Promise<T>;
}

export interface CreateOutcome {
  id: string;
  href: string;
  /** Avisos no bloqueantes (ej. no se pudo guardar la plantilla de marcador). */
  warnings: string[];
}

export async function createFromWizard(actor: TournamentActor, a: WizardAnswers, client: CreateClient, now = new Date()): Promise<CreateOutcome> {
  const warnings: string[] = [];
  const q = new URLSearchParams({ formato: a.format, nuevo: '1' }).toString();
  if (actor === 'organizer') {
    const ev = await client.post<{ id: string }>('/api/v1/events', organizerPayload(a, now));
    // El motor en vivo hoy solo atiende torneos de escuela (tournament-live/school/:id): la plantilla
    // del organizador queda en la URL hasta que exista su endpoint.
    return { id: ev.id, href: `/organizer/event/${ev.id}?${q}&reglas=${encodeURIComponent(a.preset)}`, warnings };
  }
  const ev = await client.post<{ id: string }>('/api/v1/events/school-tournament', schoolPayload(a, now));
  if (a.sport.mode === 'versus') {
    try {
      await client.patch(`/api/v1/tournament-live/school/${ev.id}/config`, { preset: a.preset });
    } catch {
      warnings.push('El torneo se creó, pero no se guardaron las reglas del marcador. Elígelas en «Marcador en vivo».');
    }
  }
  return { id: ev.id, href: `/school/tournaments/${ev.id}?${q}`, warnings };
}
