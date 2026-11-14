/**
 * Galería de formaciones de la pizarra (M6a de docs/specs/pizarra-m6-paridad-tacticalpad.md).
 *
 * Reemplaza el menú «Formación ▾»: tarjetas con la miniatura de la cancha del
 * deporte y los puntos en sus posiciones (como TacticalPad), agrupadas por
 * familia, con búsqueda y filtro por jugadores. Dos pestañas:
 *  - «Mi equipo»: lo de siempre (applyFormation de la pizarra: llena la cancha
 *    vacía o reacomoda a los que ya están);
 *  - «Rival»: pone al rival en espejo en la mitad de arriba, como figuras
 *    `opponent` (la representación que la pizarra ya usa para el rival).
 *
 * El catálogo viene de afuera (sportCfg.formations): este componente no
 * decide qué formaciones existen.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, LayoutGrid, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { BoardFormation } from '@/lib/school/tacticalBoardSport';
import { sportDef, type TacticalSport } from '@/lib/school/tacticalSports';
import { isGoalkeeperLabel } from '@/lib/school/tacticalPalette';
import {
  DEFAULT_GROUP,
  filterFormations,
  formationGroups,
  galleryCaption,
  galleryFormations,
  mirrorPoint,
  playerCounts,
} from '@/lib/school/tacticalFormationGallery';

export type FormationTeam = 'own' | 'rival';

export interface FormationGalleryProps {
  sport: TacticalSport;
  formations: BoardFormation[];
  /** Formación del equipo propio que está puesta (para el texto del botón). */
  currentKey: string | null;
  /** Rivales que hay hoy en la cancha (figuras `opponent`). */
  rivalCount: number;
  onApplyOwn: (f: BoardFormation) => void;
  onApplyRival: (f: BoardFormation) => void;
  onClearRival: () => void;
  /** Clases del botón (las de la barra de la pizarra). */
  triggerClassName?: string;
  disabled?: boolean;
  /** Modalidad de la cancha (jugadores por lado): la galería abre filtrada a
   *  ella (F7 → formaciones de 7). null/sin dato = todas. */
  initialPlayers?: number | null;
}

// ─── Miniatura ──────────────────────────────────────────────────────────────

const VB_W = 300;
const VB_H = 340;

/** Miniatura de la cancha del deporte con los puntos de la formación. Dibujo
 *  simplificado (líneas básicas) para que se lea a 100 px; la cancha completa
 *  de cada deporte la dibuja CourtBackground en la pizarra. */
export function FormationThumbnail({ sport, formation, team }: { sport: TacticalSport; formation: BoardFormation; team: FormationTeam }) {
  const def = sportDef(sport);
  const { court, colors } = def;
  const x0 = (court.x0 / 100) * VB_W;
  const y0 = (court.y0 / 100) * VB_H;
  const w = ((court.x1 - court.x0) / 100) * VB_W;
  const h = ((court.y1 - court.y0) / 100) * VB_H;
  const pad = Math.max(w, h) * 0.04;
  const midY = y0 + h / 2;
  const line = { fill: 'none', stroke: colors.line, strokeOpacity: 0.85, strokeWidth: Math.max(1.6, w / 90) };
  const hasGoal = def.hasGoalkeeper || sport === 'futbol';
  const isVolley = sport === 'voleibol';
  const isBasket = sport === 'baloncesto';
  const r = Math.max(5.5, Math.min(w, h) / 20);
  const boxW = w * 0.5;
  const boxH = h * 0.1;
  const pts = formation.slots.map((s) => (team === 'rival' ? { ...mirrorPoint(s), label: s.label } : s));

  return (
    <svg
      viewBox={`${x0 - pad} ${y0 - pad} ${w + pad * 2} ${h + pad * 2}`}
      className="h-28 w-full"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <rect x={x0 - pad} y={y0 - pad} width={w + pad * 2} height={h + pad * 2} rx={pad} fill={colors.surround} />
      <rect x={x0} y={y0} width={w} height={h} fill={colors.court} />
      <rect x={x0} y={y0} width={w} height={h} {...line} />
      {isVolley ? (
        <>
          <line x1={x0 - pad * 0.6} y1={midY} x2={x0 + w + pad * 0.6} y2={midY} {...line} strokeWidth={line.strokeWidth * 2} />
          <line x1={x0} y1={midY - h / 6} x2={x0 + w} y2={midY - h / 6} {...line} />
          <line x1={x0} y1={midY + h / 6} x2={x0 + w} y2={midY + h / 6} {...line} />
        </>
      ) : (
        <>
          <line x1={x0} y1={midY} x2={x0 + w} y2={midY} {...line} />
          <ellipse cx={x0 + w / 2} cy={midY} rx={w * 0.14} ry={w * 0.14} {...line} />
        </>
      )}
      {isBasket && (
        <>
          <rect x={x0 + w * 0.34} y={y0} width={w * 0.32} height={h * 0.2} {...line} />
          <rect x={x0 + w * 0.34} y={y0 + h * 0.8} width={w * 0.32} height={h * 0.2} {...line} />
          <path d={`M ${x0 + w * 0.06} ${y0} V ${y0 + h * 0.1} A ${w * 0.44} ${h * 0.2} 0 0 0 ${x0 + w * 0.94} ${y0 + h * 0.1} V ${y0}`} {...line} />
          <path d={`M ${x0 + w * 0.06} ${y0 + h} V ${y0 + h * 0.9} A ${w * 0.44} ${h * 0.2} 0 0 1 ${x0 + w * 0.94} ${y0 + h * 0.9} V ${y0 + h}`} {...line} />
        </>
      )}
      {hasGoal && (
        <>
          <rect x={x0 + (w - boxW) / 2} y={y0} width={boxW} height={boxH} {...line} />
          <rect x={x0 + (w - boxW) / 2} y={y0 + h - boxH} width={boxW} height={boxH} {...line} />
        </>
      )}
      {pts.map((p, i) => {
        const gk = isGoalkeeperLabel(p.label);
        const fill = team === 'rival' ? '#dc2626' : gk ? '#facc15' : '#ffffff';
        return (
          <circle
            key={i}
            cx={(p.x / 100) * VB_W}
            cy={(p.y / 100) * VB_H}
            r={r}
            fill={fill}
            stroke={team === 'rival' ? '#ffffff' : '#0f172a'}
            strokeWidth={r * 0.28}
          />
        );
      })}
    </svg>
  );
}

// ─── Galería ────────────────────────────────────────────────────────────────

function FormationCard({ sport, formation, team, active, onPick }: {
  sport: TacticalSport;
  formation: BoardFormation;
  team: FormationTeam;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={formation.label}
      aria-describedby={formation.description ? `fg-desc-${formation.key}` : undefined}
      data-formation-key={formation.key}
      className={`group flex min-h-[44px] flex-col gap-1 rounded-xl border p-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
        active ? 'border-emerald-500 bg-emerald-500/10' : 'border-border bg-muted/40 hover:border-emerald-500/60 hover:bg-muted'
      }`}
    >
      <FormationThumbnail sport={sport} formation={formation} team={team} />
      <span className="text-sm font-bold leading-tight break-words">{formation.label}</span>
      {formation.description && (
        <span id={`fg-desc-${formation.key}`} className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {formation.description}
        </span>
      )}
    </button>
  );
}

const CHIP = 'min-h-[36px] rounded-full border px-3 text-xs font-semibold transition-colors';
const chipClass = (on: boolean) =>
  `${CHIP} ${on ? 'border-emerald-500 bg-emerald-600 text-white' : 'border-border bg-background hover:bg-muted'}`;

export function FormationGallery({
  sport, formations: catalog, currentKey, rivalCount, onApplyOwn, onApplyRival, onClearRival, triggerClassName, disabled,
  initialPlayers = null,
}: FormationGalleryProps) {
  // Fútbol 11 suma las de F7 y F5 (llevadas a la cancha grande).
  const formations = useMemo(() => galleryFormations(sport, catalog) as BoardFormation[], [sport, catalog]);
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState<FormationTeam>('own');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [players, setPlayers] = useState<number | null>(null);

  const groups = useMemo(() => formationGroups(formations), [formations]);
  const counts = useMemo(() => playerCounts(formations), [formations]);
  const visible = useMemo(() => filterFormations(formations, { query, group, players }), [formations, query, group, players]);
  const currentLabel = currentKey ? formations.find((f) => f.key === currentKey)?.label : null;

  // Secciones por familia (si se filtra por una familia, una sola sección).
  const sections = useMemo(() => {
    const out: { group: string; items: BoardFormation[] }[] = [];
    for (const g of groups) {
      const items = visible.filter((f) => (f.group ?? DEFAULT_GROUP) === g);
      if (items.length) out.push({ group: g, items });
    }
    return out;
  }, [groups, visible]);

  function pick(f: BoardFormation) {
    if (team === 'own') onApplyOwn(f);
    else onApplyRival(f);
    setOpen(false);
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={triggerClassName}
        onClick={() => {
          // Cada apertura arranca sin búsqueda (si no, «4231» de la vez anterior
          // escondería todo lo demás al cambiar a la pestaña Rival).
          setQuery('');
          // Abre en la modalidad de la cancha (F7 → las de 7); «Todos» quita el filtro.
          setPlayers(initialPlayers && counts.includes(initialPlayers) ? initialPlayers : null);
          setOpen(true);
        }}
        disabled={disabled}
        title="Galería de formaciones: pon a tu equipo o al rival en una formación"
        aria-haspopup="dialog"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        <span className="truncate">{currentLabel ?? 'Formación'}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1rem)] max-w-4xl flex-col gap-3 overflow-hidden p-3 sm:p-5">
          <DialogHeader className="pr-8 text-left">
            <DialogTitle>Formaciones</DialogTitle>
            <DialogDescription className="text-xs">
              {galleryCaption(sport, visible.length, players)}. Elige para quién y toca una tarjeta.
            </DialogDescription>
          </DialogHeader>

          <div role="tablist" aria-label="Equipo" className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            {(['own', 'rival'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={team === t}
                onClick={() => setTeam(t)}
                className={`min-h-[44px] rounded-lg text-sm font-semibold transition-colors ${
                  team === t ? (t === 'rival' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white') : 'text-muted-foreground hover:bg-background'
                }`}
              >
                {t === 'own' ? 'Mi equipo' : 'Rival'}
              </button>
            ))}
          </div>

          {team === 'rival' && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs">
              <span className="flex-1 min-w-[180px]">
                El rival se pone en espejo en la mitad de arriba (fichas rojas «R»).
                {rivalCount > 0 ? ` Hoy hay ${rivalCount} en la cancha: se reemplazan.` : ''}
              </span>
              {rivalCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-[44px] gap-1"
                  onClick={() => { onClearRival(); setOpen(false); }}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Quitar rival
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar: 4-2-3-1, rombo, zona, presión…"
                aria-label="Buscar formación"
                className="h-11 pl-9"
              />
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Familias">
              <button type="button" className={chipClass(group === null)} aria-pressed={group === null} onClick={() => setGroup(null)}>
                Todas
              </button>
              {groups.map((g) => (
                <button key={g} type="button" className={`${chipClass(group === g)} shrink-0 whitespace-nowrap`} aria-pressed={group === g} onClick={() => setGroup(group === g ? null : g)}>
                  {g}
                </button>
              ))}
            </div>
            {counts.length > 1 && (
              <div className="flex gap-1.5" role="group" aria-label="Jugadores">
                <button type="button" className={chipClass(players === null)} aria-pressed={players === null} onClick={() => setPlayers(null)}>
                  Todos
                </button>
                {counts.map((n) => (
                  <button key={n} type="button" className={chipClass(players === n)} aria-pressed={players === n} onClick={() => setPlayers(players === n ? null : n)}>
                    {n} jugadores
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" data-testid="formation-gallery-list">
            {sections.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">Ninguna formación coincide con la búsqueda.</p>
            )}
            {sections.map((s) => (
              <section key={s.group} className="mb-4" aria-label={s.group}>
                <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  {s.group} <span className="font-normal">· {s.items.length}</span>
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {s.items.map((f) => (
                    <FormationCard
                      key={f.key}
                      sport={sport}
                      formation={f}
                      team={team}
                      active={team === 'own' && f.key === currentKey}
                      onPick={() => pick(f)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
