import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Loader2, Users, Plus, X, AlertCircle, ArrowDownToLine, Search, ChevronDown } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTeamPerformanceRoster } from '@/hooks/usePerformanceData';
import { useFootballLineups, useFootballLineup, useSaveFootballLineup } from '@/hooks/useFootballData';
import { POSITION_LABEL, suggestLabel, legacyFallbackPosition, LEGACY_BAND_Y } from '@/lib/school/footballDisplay';
import type { FootballSourceType, LineupPlayer, LineupRole, PositionCode } from '@/lib/school/footballQueries';
import type { RosterSubject } from '@/lib/school/performanceQueries';
import { CourtBackground } from './courts/CourtBackground';
import { useTeamTacticalSport } from '@/hooks/useTeamTacticalSport';

interface LineupModalProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
  sourceType: FootballSourceType;
  sourceId: string;
  matchLabel: string;
}

const MAX_STARTERS = 11;
const FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-4-3', '3-5-2', '5-3-2'];
/** Solo para el popover de ubicación rápida (tocar en vez de arrastrar) --
 *  de ataque a defensa, como se lee la cancha de arriba a abajo. */
const ZONE_ORDER: PositionCode[] = ['delantero', 'medio', 'defensa', 'arquero'];
/** Distancia (en % de cancha) para "adoptar" un marco sugerido -- mismo
 *  valor que usa TacticalBoard para su propio snap a plantilla. */
const SNAP_DISTANCE = 8;

/** Es una alineación: antes de poner a nadie ya se veían los marcos según
 *  la formación elegida. Cada número entre el primero (defensa) y el
 *  último (delantero) es su PROPIA línea -- "4-2-1-2-1" son 5 líneas
 *  (defensa, 2 volantes, 1 mediapunta más adelantado, 2 todavía más
 *  adelantados, delantero), cada una más cerca del ataque que la
 *  anterior, no una sola banda de "medio" con 5 amontonados a la misma
 *  altura (así se leía antes de este ajuste). Son puntos SUGERIDOS --
 *  soltar un jugador cerca de uno lo "adopta" (toma su x/y y su etiqueta
 *  exactos), no lo obliga a nada. */
function formationToSlots(formationStr: string): { x: number; y: number; label: string }[] {
  const clean = (formationStr || '').trim();
  let parts = clean.split('-').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (parts.length < 2) parts = [4, 4, 2];

  const rows: { y: number; count: number; label: string }[] = [
    { y: LEGACY_BAND_Y.arquero, count: 1, label: POSITION_LABEL.arquero },
    { y: LEGACY_BAND_Y.defensa, count: parts[0], label: POSITION_LABEL.defensa },
  ];

  // Líneas intermedias repartidas en altura ENTRE defensa y delantero, en
  // el mismo orden en que se escribieron: la primera queda más retrasada,
  // la última más adelantada -- sin importar cuántas sean.
  const middleParts = parts.slice(1, -1);
  const n = middleParts.length;
  middleParts.forEach((count, i) => {
    const t = (i + 1) / (n + 1); // 0 < t < 1, creciente hacia el ataque
    const y = LEGACY_BAND_Y.defensa + (LEGACY_BAND_Y.delantero - LEGACY_BAND_Y.defensa) * t;
    rows.push({ y, count, label: POSITION_LABEL.medio });
  });

  rows.push({ y: LEGACY_BAND_Y.delantero, count: parts[parts.length - 1], label: POSITION_LABEL.delantero });

  const slots: { x: number; y: number; label: string }[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const x = row.count <= 1 ? 50 : 15 + i * (70 / (row.count - 1));
      slots.push({ x, y: row.y, label: row.label });
    }
  }
  return slots;
}

/** Empareja cada punto de `from` con el más cercano de `to`, sin repetir
 *  ninguno de los dos lados (no es el algoritmo húngaro/óptimo, pero
 *  alcanza) -- mismo criterio que ya usa el tablero táctico para aplicar
 *  una plantilla sobre jugadores ya puestos. */
function greedyNearestMatch<A extends { x: number; y: number }, B extends { x: number; y: number }>(
  from: A[],
  to: B[],
): { from: A; to: B }[] {
  const pairs: { fi: number; ti: number; dist: number }[] = [];
  from.forEach((f, fi) => {
    to.forEach((t, ti) => {
      pairs.push({ fi, ti, dist: Math.hypot(f.x - t.x, f.y - t.y) });
    });
  });
  pairs.sort((a, b) => a.dist - b.dist);

  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();
  const matches: { from: A; to: B }[] = [];
  for (const p of pairs) {
    if (usedFrom.has(p.fi) || usedTo.has(p.ti)) continue;
    usedFrom.add(p.fi);
    usedTo.add(p.ti);
    matches.push({ from: from[p.fi], to: to[p.ti] });
  }
  return matches;
}

/** Antes la posición era SOLO una de 4 bandas (arquero/defensa/medio/
 *  delantero) con cupo fijo por formación -- no distinguía lateral
 *  izquierdo de derecho, y agregar un segundo jugador a una banda ya
 *  "llena" según la formación quedaba bloqueado. Ahora la cancha es libre
 *  (x/y, igual que TacticalBoard): se suelta donde se quiera y la etiqueta
 *  es texto editable ("Lateral derecho" vs "Lateral izquierdo"), sin tope. */
interface PlayerState {
  role: LineupRole | null;
  x: number | null;
  y: number | null;
  slot_label: string;
  /** false = etiqueta sugerida automáticamente por altura (se recalcula si
   *  se arrastra a otra franja). true = el coach la escribió a mano. */
  labelIsCustom: boolean;
  jersey_number: number | '';
  minutes_played: number | '';
}

const emptyState: PlayerState = {
  role: null, x: null, y: null, slot_label: '', labelIsCustom: false, jersey_number: '', minutes_played: '',
};

const subjectKey = (t: string, id: string) => `${t}:${id}`;

function initialsOf(name: string) {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/** Hidrata el estado local desde una alineación guardada. Dos formatos
 *  conviven: el nuevo (x/y/slot_label, como lo guarda también TacticalBoard)
 *  y el viejo (solo position_code, de antes de este cambio) -- un titular
 *  sin x/y no se pierde, se reparte en fila dentro de su banda clásica
 *  aproximada (ver legacyFallbackPosition). */
function hydratePlayers(lineupPlayers: LineupPlayer[]): Record<string, PlayerState> {
  const bandGroups: Record<PositionCode, string[]> = { arquero: [], defensa: [], medio: [], delantero: [] };
  for (const p of lineupPlayers) {
    if (p.role === 'starter' && (p.x == null || p.y == null) && p.position_code) {
      bandGroups[p.position_code].push(subjectKey(p.subject_type, p.subject_id));
    }
  }
  const bandIndex: Record<PositionCode, number> = { arquero: 0, defensa: 0, medio: 0, delantero: 0 };

  const result: Record<string, PlayerState> = {};
  for (const p of lineupPlayers) {
    const k = subjectKey(p.subject_type, p.subject_id);
    let x: number | null = null;
    let y: number | null = null;
    let label = p.slot_label ?? '';

    if (p.role === 'starter') {
      if (p.x != null && p.y != null) {
        x = p.x;
        y = p.y;
      } else {
        const band = p.position_code ?? undefined;
        const total = band ? bandGroups[band].length : 1;
        const idx = band ? bandIndex[band]++ : 0;
        const pos = legacyFallbackPosition(band, idx, total);
        x = pos.x;
        y = pos.y;
      }
      if (!label) label = (p.position_code && POSITION_LABEL[p.position_code]) || suggestLabel(y);
    }

    result[k] = {
      role: p.role,
      x,
      y,
      slot_label: label,
      labelIsCustom: !!p.slot_label,
      jersey_number: p.jersey_number ?? '',
      minutes_played: p.minutes_played ?? '',
    };
  }
  return result;
}

/** Marco sugerido según la formación (D1: es una alineación, se espera ver
 *  dónde va cada línea antes de poner a nadie), sin jugador todavía --
 *  puramente visual, se "adopta" soltando cerca (ver SNAP_DISTANCE). */
function EmptySlotMarker({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <div
      style={{ position: 'absolute', left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)', zIndex: 1 }}
      className="flex flex-col items-center gap-1 pointer-events-none"
    >
      <div className="h-10 w-10 rounded-full border-2 border-dashed border-white/40 animate-pulse" />
      <span className="text-[9px] font-semibold text-white/60 bg-black/40 rounded-full px-1.5 py-0.5">{label}</span>
    </div>
  );
}

/** Zona de suelta del banco -- soltar ahí manda al jugador a suplente,
 *  venga de "Disponibles" o de un pin ya puesto en la cancha. */
function DroppableBench({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'bench-zone' });
  return (
    <div ref={setNodeRef} className={`space-y-1.5 rounded-lg p-1 transition-colors ${isOver ? 'bg-emerald-400/10 ring-2 ring-emerald-300/50' : ''}`}>
      {children}
    </div>
  );
}

/** Fila del panel "Disponibles". Se asigna de dos formas: tocando el "+"
 *  (elige zona aproximada de una lista, como antes) o arrastrando directo
 *  a cualquier punto de la cancha o al banco -- mismo @dnd-kit que ya usa
 *  TacticalBoard. Sin tope: cualquier cantidad de jugadores puede ir a la
 *  misma zona (útil si el titular 1 no está disponible).
 *
 *  Los listeners de arrastre van en el bloque avatar+nombre, NO en el botón
 *  "+" -- mezclar drag y click en el mismo elemento es frágil (mismo motivo
 *  que en PitchPin más abajo). */
function AvailablePlayerRow({
  subject, assigningKey, onOpenAssign, onCloseAssign, onAssignZone, onAssignBench,
}: {
  subject: RosterSubject;
  assigningKey: string | null;
  onOpenAssign: (k: string) => void;
  onCloseAssign: () => void;
  onAssignZone: (k: string, zone: PositionCode) => void;
  onAssignBench: (k: string) => void;
}) {
  const k = subjectKey(subject.subject_type, subject.subject_id);
  // Sin `style={{transform}}` acá a propósito: aplicar el transform de
  // arrastre directo sobre una fila DENTRO de un panel con overflow-y-auto
  // hacía que el navegador recalculara el scrollWidth del panel según esa
  // posición transformada -- arrastrar hacia la derecha (hacia la cancha)
  // sin soltar rápido hacía crecer sin fin la barra de scroll horizontal.
  // La vista que sigue al puntero ahora es <DragOverlay>, que se pinta
  // fuera del panel scrolleable -- ver el final del archivo.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `avail:${k}`,
    data: { subjectKeyValue: k },
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-1 rounded-lg border p-1.5 transition-colors ${isDragging ? 'opacity-30' : 'hover:border-primary/50 hover:bg-muted/50'}`}
    >
      <div {...listeners} {...attributes} className="flex flex-1 min-w-0 items-center gap-2 touch-none cursor-grab active:cursor-grabbing">
        <Avatar className="h-7 w-7 shrink-0">
          <AvatarImage src={subject.avatar_url ?? undefined} />
          <AvatarFallback className="text-[10px]">{subject.full_name.charAt(0)}</AvatarFallback>
        </Avatar>
        <span className="flex-1 min-w-0 text-xs truncate">{subject.full_name}</span>
      </div>
      <Popover open={assigningKey === k} onOpenChange={(o) => (o ? onOpenAssign(k) : onCloseAssign())}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Ubicar en la cancha"
            className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="end">
          <p className="px-2 py-1 text-[10px] font-semibold text-muted-foreground">Ubicar cerca de...</p>
          {ZONE_ORDER.map((zone) => (
            <button
              key={zone}
              type="button"
              className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => onAssignZone(k, zone)}
            >
              {POSITION_LABEL[zone]}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
            onClick={() => onAssignBench(k)}
          >
            <ArrowDownToLine className="h-3 w-3" /> Banco (suplente)
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Pin de un titular ya puesto en la cancha -- arrastrable a cualquier
 *  punto (D1: un lateral derecho no es lo mismo que uno izquierdo, así que
 *  la posición exacta la decide el coach arrastrando, no un cupo de banda),
 *  con etiqueta de texto editable con un toque y foto igual que en
 *  TacticalBoard. */
function PitchPin({
  pKey, subject, state, isEditingChip, onToggleChip, onLabelChange, onJerseyChange,
  onMinutesChange, onSendToBench, onRemove,
}: {
  pKey: string;
  subject: RosterSubject;
  state: PlayerState;
  isEditingChip: boolean;
  onToggleChip: (open: boolean) => void;
  onLabelChange: (label: string) => void;
  onJerseyChange: (v: number | '') => void;
  onMinutesChange: (v: number | '') => void;
  onSendToBench: () => void;
  onRemove: () => void;
}) {
  // Sin combinar el transform de arrastre acá tampoco (mismo motivo que
  // AvailablePlayerRow): la cancha es overflow-hidden, así que un pin
  // arrastrado cerca del borde se recortaba en vez de seguir visible. El
  // que sigue al puntero es el <DragOverlay>, que se pinta en un portal
  // fuera de la cancha.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pitch:${pKey}`,
    data: { subjectKeyValue: pKey },
  });
  const [editingLabel, setEditingLabel] = useState(false);
  const [imgError, setImgError] = useState(false);
  const hasPhoto = !!subject.avatar_url && !imgError;

  if (state.x == null || state.y == null) return null;

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'absolute',
        left: `${state.x}%`,
        top: `${state.y}%`,
        transform: 'translate(-50%, -50%)',
        zIndex: isDragging ? 30 : 10,
        opacity: isDragging ? 0.3 : 1,
      }}
      className="flex flex-col items-center gap-1 touch-none"
    >
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-2 -right-2 z-10 h-4 w-4 rounded-full bg-red-600 text-white flex items-center justify-center shadow ring-2 ring-white/70"
        aria-label={`Quitar a ${subject.full_name} de la cancha`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
      <div {...listeners} {...attributes} className="flex flex-col items-center gap-1 cursor-grab active:cursor-grabbing">
        <Popover open={isEditingChip} onOpenChange={onToggleChip}>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className={`relative h-10 w-10 rounded-full overflow-hidden flex items-center justify-center font-black text-xs text-white
                ${hasPhoto ? 'bg-zinc-800' : 'bg-primary'}
                shadow-md ring-2 transition-transform ${isDragging ? 'ring-white scale-110' : 'ring-white/80'}`}
            >
              {hasPhoto ? (
                <img
                  src={subject.avatar_url ?? undefined}
                  alt={subject.full_name}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => setImgError(true)}
                />
              ) : (
                initialsOf(subject.full_name)
              )}
              {state.jersey_number !== '' && (
                <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-yellow-400 text-black text-[8px] font-black flex items-center justify-center ring-1 ring-white">
                  {state.jersey_number}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56 space-y-2" align="center" onPointerDown={(e) => e.stopPropagation()}>
            <p className="text-xs font-semibold">{subject.full_name}</p>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <Label className="text-[10px]">Camiseta</Label>
                <Input
                  type="number"
                  min={0}
                  className="h-7 text-xs"
                  value={state.jersey_number}
                  onChange={(e) => onJerseyChange(e.target.value === '' ? '' : Number(e.target.value))}
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label className="text-[10px]">Minutos</Label>
                <Input
                  type="number"
                  min={0}
                  className="h-7 text-xs"
                  value={state.minutes_played}
                  onChange={(e) => onMinutesChange(e.target.value === '' ? '' : Number(e.target.value))}
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" className="h-7 text-[11px] flex-1 gap-1" onClick={onSendToBench}>
                <ArrowDownToLine className="w-3 h-3" /> Al banco
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px] flex-1 gap-1 text-red-600 hover:text-red-600" onClick={onRemove}>
                <X className="w-3 h-3" /> Quitar
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {editingLabel ? (
          <Input
            autoFocus
            defaultValue={state.slot_label}
            className="h-5 w-20 text-[10px] px-1 py-0 text-center bg-white/95 text-black"
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => { onLabelChange(e.target.value.trim() || state.slot_label); setEditingLabel(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); setEditingLabel(true); }}
            title="Tocar para renombrar (ej. Lateral derecho)"
            className="text-[10px] font-bold text-white bg-black/60 backdrop-blur-sm rounded-full px-2 py-0.5 leading-tight max-w-20 truncate cursor-text shadow"
          >
            {state.slot_label}
          </span>
        )}
      </div>
    </div>
  );
}

/** Lo que sigue al puntero mientras se arrastra -- se pinta en un portal de
 *  @dnd-kit fuera de cualquier panel con scroll o recorte, así que no le
 *  afecta ni el overflow-y-auto de "Disponibles" ni el overflow-hidden de
 *  la cancha. */
function DragOverlayPreview({ subject }: { subject: RosterSubject }) {
  const [imgError, setImgError] = useState(false);
  const hasPhoto = !!subject.avatar_url && !imgError;
  return (
    <div className={`relative h-10 w-10 rounded-full overflow-hidden flex items-center justify-center font-black text-xs text-white shadow-xl ring-2 ring-white scale-110 cursor-grabbing ${hasPhoto ? 'bg-zinc-800' : 'bg-primary'}`}>
      {hasPhoto ? (
        <img
          src={subject.avatar_url ?? undefined}
          alt={subject.full_name}
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        initialsOf(subject.full_name)
      )}
    </div>
  );
}

export function LineupModal({ open, onClose, teamId, teamName, sourceType, sourceId, matchLabel }: LineupModalProps) {
  const { toast } = useToast();
  // T4: la cancha del deporte del equipo (sin deporte reconocible → fútbol 11).
  const { sport } = useTeamTacticalSport(teamId, { enabled: open });
  const { data: roster, isLoading: loadingRoster } = useTeamPerformanceRoster({ team_id: teamId });
  const { data: existingList } = useFootballLineups({ source_type: sourceType, source_id: sourceId });
  const existingLineupId = existingList?.[0]?.id;
  const { data: existingLineup, isLoading: loadingLineup } = useFootballLineup(existingLineupId);
  const saveLineup = useSaveFootballLineup();

  const pitchRef = useRef<HTMLDivElement>(null);
  const [formation, setFormation] = useState('');
  const [customFormation, setCustomFormation] = useState(false);
  const [players, setPlayers] = useState<Record<string, PlayerState>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [assigningKey, setAssigningKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeDragKey, setActiveDragKey] = useState<string | null>(null);
  // Solo importa en mobile (en desktop la lista siempre se ve, ver
  // "md:flex" más abajo): arrancar cerrado le deja a la cancha casi toda
  // la pantalla, que es lo que de verdad importa apenas se abre el modal.
  const [rosterPanelOpen, setRosterPanelOpen] = useState(false);

  const subjects = roster?.subjects ?? [];
  const subjectByKey = useMemo(() => {
    const m = new Map<string, RosterSubject>();
    for (const s of subjects) m.set(subjectKey(s.subject_type, s.subject_id), s);
    return m;
  }, [subjects]);

  useEffect(() => {
    if (!open) return;
    if (existingLineup) {
      setFormation(existingLineup.formation ?? '');
      setCustomFormation(!!existingLineup.formation && !FORMATIONS.includes(existingLineup.formation));
      setPlayers(hydratePlayers(existingLineup.players));
    } else if (!loadingLineup) {
      setFormation('');
      setCustomFormation(false);
      setPlayers({});
    }
  }, [open, existingLineup, loadingLineup]);

  const setPlayer = (k: string, patch: Partial<PlayerState>) => {
    setPlayers((prev) => ({ ...prev, [k]: { ...(prev[k] ?? emptyState), ...patch } }));
  };

  const removePlayer = (k: string) => {
    setPlayers((prev) => {
      const next = { ...prev };
      delete next[k];
      return next;
    });
    setEditingKey((cur) => (cur === k ? null : cur));
  };

  const entries = Object.entries(players);
  const starters = entries.filter(([, p]) => p.role === 'starter');
  const benchPlayers = entries.filter(([, p]) => p.role === 'bench');

  const assignedKeys = new Set(entries.filter(([, p]) => p.role !== null).map(([k]) => k));
  const availableSubjects = subjects.filter((s) => !assignedKeys.has(subjectKey(s.subject_type, s.subject_id)));
  const filteredAvailable = searchQuery.trim()
    ? availableSubjects.filter((s) => s.full_name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : availableSubjects;

  const handleClose = () => {
    setFormation('');
    setCustomFormation(false);
    setPlayers({});
    setEditingKey(null);
    setAssigningKey(null);
    setSearchQuery('');
    onClose();
  };

  // Es una alineación: antes de poner a nadie ya se ven los marcos según la
  // formación elegida. Derivado (no un estado propio que haya que ir
  // vaciando a mano): un marco desaparece solo apenas hay un titular cerca
  // de él, y reaparece si ese titular se mueve lejos -- no hace falta
  // "adoptar y borrar" de forma imperativa.
  const emptySlots = useMemo(() => {
    const targets = formationToSlots(formation);
    const placedPositions = starters
      .filter(([, p]) => p.x != null && p.y != null)
      .map(([, p]) => ({ x: p.x as number, y: p.y as number }));
    return targets
      .filter((t) => !placedPositions.some((pp) => Math.hypot(pp.x - t.x, pp.y - t.y) < SNAP_DISTANCE))
      .map((t, i) => ({ id: `slot-${i}`, ...t }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formation, players]);

  /** Ubicación rápida por toque: si hay un marco sugerido de esa zona
   *  disponible, lo adopta (posición y etiqueta exactas); si no, reparte en
   *  fila como antes. El coach ajusta el punto exacto (izquierda/derecha)
   *  arrastrando después -- esto es solo un punto de partida rápido para
   *  quien prefiere tocar en vez de arrastrar. */
  const assignToZone = (k: string, zone: PositionCode) => {
    const label = POSITION_LABEL[zone];
    const closestSlot = emptySlots.filter((s) => s.label === label).sort((a, b) => a.x - b.x)[0];
    if (closestSlot) {
      setPlayer(k, { role: 'starter', x: closestSlot.x, y: closestSlot.y, slot_label: label, labelIsCustom: false });
      setAssigningKey(null);
      return;
    }
    const countInZone = starters.filter(([kk, p]) => kk !== k && p.y != null && suggestLabel(p.y) === label).length;
    const pos = legacyFallbackPosition(zone, countInZone, countInZone + 1);
    setPlayer(k, { role: 'starter', x: pos.x, y: pos.y, slot_label: label, labelIsCustom: false });
    setAssigningKey(null);
  };

  const assignToBench = (k: string) => {
    setPlayer(k, { role: 'bench' });
    setAssigningKey(null);
  };

  /** Al cambiar de formación, los titulares YA puestos se quedaban en su
   *  posición vieja mientras los marcos guía se recalculaban para la
   *  formación nueva -- como no coincidían, quedaban superpuestos con las
   *  etiquetas de los jugadores. Ahora cada titular se reacomoda al marco
   *  más cercano de la formación nueva (mismo criterio que el tablero
   *  táctico al aplicar una plantilla), así no quedan marcos sueltos
   *  pisando a nadie. Si hay más titulares que marcos (u otro desajuste),
   *  los que sobran simplemente no se mueven. */
  const reflowToFormation = (newFormation: string) => {
    const targets = formationToSlots(newFormation);
    const placed = starters.filter(([, p]) => p.x != null && p.y != null);
    if (placed.length === 0 || targets.length === 0) return;
    const matches = greedyNearestMatch(
      placed.map(([k, p]) => ({ key: k, x: p.x as number, y: p.y as number })),
      targets,
    );
    setPlayers((prev) => {
      const next = { ...prev };
      for (const m of matches) {
        const existing = next[m.from.key];
        if (!existing) continue;
        next[m.from.key] = {
          ...existing,
          x: m.to.x,
          y: m.to.y,
          slot_label: existing.labelIsCustom ? existing.slot_label : m.to.label,
        };
      }
      return next;
    });
  };

  // Mismo sensor que TacticalBoard (6px de umbral antes de activar el
  // drag): sin eso, un tap corto para abrir un popover se interpretaría
  // como el inicio de un arrastre.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /** Igual que TacticalBoard: si viene de un pin YA puesto, suma el delta
   *  (px) a su posición actual; si viene de "Disponibles" (sin transform
   *  previo), mide dónde quedó el nodo arrastrado. Soltar fuera de la
   *  cancha (y fuera del banco) no hace nada. */
  function handleDragEnd(event: DragEndEvent) {
    const { active, over, delta } = event;
    const data = active.data.current as { subjectKeyValue?: string } | undefined;
    const k = data?.subjectKeyValue;
    if (!k) return;

    if (over && String(over.id) === 'bench-zone') {
      assignToBench(k);
      return;
    }

    const pitchRect = pitchRef.current?.getBoundingClientRect();
    if (!pitchRect) return;

    const isRepositioning = String(active.id).startsWith('pitch:');
    let centerX: number;
    let centerY: number;

    if (isRepositioning) {
      const current = players[k];
      if (!current || current.x == null || current.y == null) return;
      centerX = pitchRect.left + (current.x / 100) * pitchRect.width + delta.x;
      centerY = pitchRect.top + (current.y / 100) * pitchRect.height + delta.y;
    } else {
      const activeRect = active.rect.current.translated ?? active.rect.current.initial;
      if (!activeRect) return;
      centerX = activeRect.left + activeRect.width / 2;
      centerY = activeRect.top + activeRect.height / 2;
    }

    const withinPitch = centerX >= pitchRect.left && centerX <= pitchRect.right
      && centerY >= pitchRect.top && centerY <= pitchRect.bottom;
    if (!withinPitch) return;

    let xPct = Math.min(100, Math.max(0, ((centerX - pitchRect.left) / pitchRect.width) * 100));
    let yPct = Math.min(100, Math.max(0, ((centerY - pitchRect.top) / pitchRect.height) * 100));
    let adoptedLabel: string | null = null;

    // Solo un jugador NUEVO (no reposicionando) adopta un marco sugerido --
    // mover a alguien ya puesto no lo tironea hacia un marco ajeno.
    if (!isRepositioning && emptySlots.length > 0) {
      let closest: { x: number; y: number; label: string } | null = null;
      let closestDist = SNAP_DISTANCE;
      for (const slot of emptySlots) {
        const dist = Math.hypot(slot.x - xPct, slot.y - yPct);
        if (dist < closestDist) { closest = slot; closestDist = dist; }
      }
      if (closest) {
        xPct = closest.x;
        yPct = closest.y;
        adoptedLabel = closest.label;
      }
    }

    setPlayers((prev) => {
      const existing = prev[k];
      const keepCustomLabel = !adoptedLabel && !!existing?.labelIsCustom;
      return {
        ...prev,
        [k]: {
          ...(existing ?? emptyState),
          role: 'starter',
          x: xPct,
          y: yPct,
          slot_label: adoptedLabel || (keepCustomLabel ? existing!.slot_label : suggestLabel(yPct)),
          labelIsCustom: keepCustomLabel,
        },
      };
    });
  }

  const handleSave = async () => {
    if (starters.length > MAX_STARTERS) {
      toast({ title: `Máximo ${MAX_STARTERS} titulares`, description: `Tienes ${starters.length} marcados.`, variant: 'destructive' });
      return;
    }
    // Antes bloqueaba SIEMPRE con 0 jugadores, incluso con formación ya
    // elegida -- se sentía como "no deja guardar la formación". El backend
    // ya acepta players: [] sin problema, así que alcanza con formación O
    // al menos un jugador.
    if (starters.length === 0 && benchPlayers.length === 0 && !formation.trim()) {
      toast({ title: 'Elige una formación o marca al menos un jugador.', variant: 'destructive' });
      return;
    }

    const payloadPlayers = entries
      .filter(([, p]) => p.role !== null)
      .map(([k, p]) => {
        const s = subjectByKey.get(k);
        const [fallbackType, fallbackId] = k.split(':');

        const jerseyNum = (p.jersey_number === '' || p.jersey_number === undefined || p.jersey_number === null)
          ? undefined
          : Number(p.jersey_number);

        const minsPlayed = (p.minutes_played === '' || p.minutes_played === undefined || p.minutes_played === null)
          ? undefined
          : Number(p.minutes_played);

        return {
          subject_type: (s?.subject_type ?? fallbackType) as 'profile' | 'child' | 'unregistered',
          subject_id: s?.subject_id ?? fallbackId,
          role: p.role as LineupRole,
          slot_label: p.role === 'starter' && p.slot_label ? p.slot_label : undefined,
          x: p.role === 'starter' && p.x != null ? p.x : undefined,
          y: p.role === 'starter' && p.y != null ? p.y : undefined,
          jersey_number: (jerseyNum !== undefined && !isNaN(jerseyNum)) ? jerseyNum : undefined,
          minutes_played: (minsPlayed !== undefined && !isNaN(minsPlayed)) ? minsPlayed : undefined,
        };
      });

    try {
      await saveLineup.mutateAsync({
        team_id: teamId,
        source_type: sourceType,
        source_id: sourceId,
        formation: formation.trim() || null,
        players: payloadPlayers,
      });
      toast({
        title: '✅ Alineación guardada',
        description: `${starters.length} titular(es), ${benchPlayers.length} en banco.`,
      });
      handleClose();
    } catch (err: any) {
      toast({ title: 'Error al guardar la alineación', description: err?.message ?? 'Intenta de nuevo.', variant: 'destructive' });
    }
  };

  const isLoading = loadingRoster || (!!existingLineupId && loadingLineup);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      {/* Antes era un max-w-3xl con scroll interno -- en pantallas anchas
          dejaba casi toda la ventana vacía y adentro la cancha quedaba con
          un tamaño fijo (max-w-[340px]) que no crecía aunque sobrara alto,
          así que con varias líneas de formación los pines se pisaban entre
          sí. Ahora el modal usa el espacio real del dispositivo (92vw/90vh,
          con un techo para no quedar absurdo en un monitor ultra-wide).

          El techo NO es 1500px a propósito: Disponibles (260px) + la
          columna de la cancha (angosta, retrato) necesitan como mucho
          ~1000px en total -- ponerle un techo más ancho que eso solo
          dejaba un semi-modal vacío a la derecha, con "Formación"
          apretado contra el borde izquierdo en vez de repartido en el
          ancho real del modal.

          height/overflow van por `style` (no por className): el propio
          componente Dialog trae una clase global ".dialog-safe" (para
          respetar el safe-area de iOS en TODOS los modales) que fija
          overflow-y:auto como CSS plano -- eso no es una utilidad de
          Tailwind, así que tailwind-merge no la puede deduplicar contra la
          nuestra, y en la hoja de estilos compilada termina ganando el
          empate de especificidad. Un estilo inline sí le gana a cualquier
          clase sin tener que tocar ese componente compartido. */}
      <DialogContent
        className="w-[92vw] max-w-modal-lg p-0 flex flex-col gap-0"
        style={{ height: '90vh', maxHeight: '90vh', overflow: 'hidden' }}
      >
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle>Alineación</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Users className="h-3 w-3" /> {teamName} · {matchLabel}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center px-6">
            <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
            <span className="text-sm text-muted-foreground">Cargando roster...</span>
          </div>
        ) : subjects.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertCircle className="h-8 w-8 text-amber-500" />
            <p className="text-sm text-muted-foreground">Este equipo no tiene atletas inscritos todavía.</p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={(e: DragStartEvent) => {
              const d = e.active.data.current as { subjectKeyValue?: string } | undefined;
              setActiveDragKey(d?.subjectKeyValue ?? null);
            }}
            onDragEnd={(e) => { setActiveDragKey(null); handleDragEnd(e); }}
            onDragCancel={() => setActiveDragKey(null)}
          >
            {/* La cancha es lo más importante de este modal -- Formación
                queda en una barra angosta arriba, compartida por las dos
                columnas, en vez de vivir DENTRO de la columna de la cancha
                compitiéndole altura. Así la columna de la cancha es
                exclusivamente para la cancha. */}
            <div className="flex-1 min-h-0 flex flex-col gap-3 px-6 py-4">
              <div className="shrink-0 flex flex-wrap items-end gap-3">
                <div className="flex items-end gap-2 flex-1 min-w-56 max-w-sm">
                  <div className="flex-1 space-y-1.5">
                    <Label className="text-xs">Formación</Label>
                    {customFormation ? (
                      <Input
                        placeholder="Ej: 4-1-4-1"
                        value={formation}
                        onChange={(e) => setFormation(e.target.value)}
                        onBlur={(e) => reflowToFormation(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        maxLength={20}
                      />
                    ) : (
                      <Select value={formation || undefined} onValueChange={(v) => { setFormation(v); reflowToFormation(v); }}>
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="Elegir formación" />
                        </SelectTrigger>
                        <SelectContent>
                          {FORMATIONS.map((f) => (
                            <SelectItem key={f} value={f}>{f}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <Button
                    type="button" variant="ghost" size="sm" className="h-9 text-[11px] shrink-0"
                    onClick={() => setCustomFormation((v) => !v)}
                  >
                    {customFormation ? 'Presets' : 'Otra'}
                  </Button>
                </div>

                <Badge
                  variant="outline"
                  className={`gap-1.5 w-fit ${starters.length > MAX_STARTERS ? 'text-red-600 border-red-500/30 bg-red-500/5' : 'text-green-600 border-green-500/30 bg-green-500/5'}`}
                >
                  {starters.length} de {MAX_STARTERS} titulares · {benchPlayers.length} en banco
                </Badge>
              </div>

              {/* flex, no grid: un grid con una sola fila implícita ("auto")
                  no estira sus columnas al alto del contenedor -- terminaba
                  calculando el alto de la fila a partir del contenido (con
                  la cancha en su tamaño mínimo, ~0), y RECIÉN ahí la cancha
                  intentaba resolver su height:100% contra ese alto ya chico
                  -- un círculo que la dejaba en unos pocos px. flex no tiene
                  esa ambigüedad: reparte la altura real del contenedor entre
                  sus hijos primero. */}
              {/* overflow-y-auto solo mobile: si la cancha (piso de 240px)
                  + Disponibles/Banco (hasta 360px) no entran juntos en lo
                  que quede de alto, que esta sección entera scrollee en vez
                  de recortarse contra el borde del modal -- la cancha ya se
                  ve primero (order-1 arriba) de cualquier forma. */}
              <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-4 overflow-y-auto md:overflow-visible custom-scrollbar">
                {/* ── Disponibles ──────────────────────────────────────────
                    Panel fijo con toda la lista siempre visible: se busca y
                    se elige la posición desde acá (o se arrastra directo a
                    la cancha) -- sin tope, así que agregar un segundo
                    jugador a la misma posición (si el titular 1 no está
                    disponible) es simplemente elegirlo de nuevo.

                    Disponibles Y Banco viven acá -- las dos son listas de
                    jugadores, tiene sentido que compartan columna. Antes
                    Banco vivía debajo de la cancha, compitiéndole la
                    altura; moverlo acá le devuelve a la cancha el espacio
                    vertical que necesita para verse grande de verdad, no
                    solo sin pisarse.

                    order-2: en mobile la cancha va PRIMERO (ver la columna
                    de abajo, order-1) -- antes Disponibles+Banco quedaban
                    arriba y se comían la altura, dejando la cancha cortada
                    al fondo, ni siquiera visible completa sin scrollear.
                    En desktop (md:order-none) el orden visual vuelve a ser
                    el del DOM: Disponibles a la izquierda.

                    En mobile además arranca COLAPSADO detrás de un botón --
                    reservar hasta 360px fijos para estas listas, aunque
                    fueran segundas, seguía dejándole muy poco alto real a
                    la cancha (que es lo importante). Colapsado, esta
                    columna mide lo que mide el botón nomás. En desktop el
                    botón ni se muestra (md:hidden) y el contenido siempre
                    está visible (md:flex, sin importar rosterPanelOpen). */}
                <div className="order-2 md:order-none max-h-96 md:max-h-none md:h-full min-h-0 flex flex-col gap-2 md:gap-4 shrink-0 md:w-64 md:border-r md:pr-4">
                  <button
                    type="button"
                    onClick={() => setRosterPanelOpen((v) => !v)}
                    className="md:hidden shrink-0 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"
                  >
                    <span>Jugadores: {availableSubjects.length} disponibles · {benchPlayers.length} en banco</span>
                    <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${rosterPanelOpen ? 'rotate-180' : ''}`} />
                  </button>
                  <div className={`${rosterPanelOpen ? 'flex' : 'hidden'} md:flex flex-1 min-h-0 flex-col gap-4 overflow-hidden`}>
                    <div className="flex-1 min-h-0 flex flex-col gap-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground shrink-0">
                        Disponibles ({availableSubjects.length})
                      </p>
                      <div className="relative shrink-0">
                        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder="Buscar jugador..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="h-8 pl-7 text-xs"
                        />
                      </div>
                      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-1 pr-1">
                        {filteredAvailable.length === 0 ? (
                          <p className="py-4 text-center text-xs italic text-muted-foreground">
                            {availableSubjects.length === 0 ? 'Todos los jugadores ya están asignados.' : 'Sin resultados.'}
                          </p>
                        ) : (
                          filteredAvailable.map((s) => (
                            <AvailablePlayerRow
                              key={subjectKey(s.subject_type, s.subject_id)}
                              subject={s}
                              assigningKey={assigningKey}
                              onOpenAssign={setAssigningKey}
                              onCloseAssign={() => setAssigningKey(null)}
                              onAssignZone={assignToZone}
                              onAssignBench={assignToBench}
                            />
                          ))
                        )}
                      </div>
                    </div>

                    <div className="shrink-0 max-h-40 md:max-h-[35%] min-h-0 flex flex-col gap-2 border-t pt-3 overflow-y-auto custom-scrollbar">
                      <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground shrink-0">Banco</p>
                      <DroppableBench>
                        {benchPlayers.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">Sin suplentes cargados -- elegilos de arriba.</p>
                        ) : (
                          benchPlayers.map(([k]) => {
                            const s = subjectByKey.get(k);
                            const p = players[k];
                            if (!s || !p) return null;
                            return (
                              <div key={k} className="flex items-center gap-2 rounded-lg border p-1.5">
                                <Avatar className="h-6 w-6 shrink-0">
                                  <AvatarImage src={s.avatar_url ?? undefined} />
                                  <AvatarFallback className="text-[9px]">{s.full_name.charAt(0)}</AvatarFallback>
                                </Avatar>
                                <span className="flex-1 min-w-0 text-xs truncate">{s.full_name}</span>
                                <Input
                                  type="number"
                                  min={0}
                                  placeholder="#"
                                  className="h-6 text-xs w-12 px-1"
                                  value={p.jersey_number}
                                  onChange={(e) => setPlayer(k, { jersey_number: e.target.value === '' ? '' : Number(e.target.value) })}
                                />
                                <button type="button" onClick={() => removePlayer(k)} className="text-muted-foreground hover:text-red-500 shrink-0">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            );
                          })
                        )}
                      </DroppableBench>
                    </div>
                  </div>
                </div>

                {/* max-w-[480px] mx-auto: la cancha es angosta (retrato,
                    aspect-ratio 300/340) y su tamaño real lo manda la
                    ALTURA disponible, no el ancho -- dejar esta columna
                    estirarse de más solo dejaba un vacío enorme a los
                    costados sin hacer la cancha ni un pixel más grande. El
                    tope quedó justo por encima de lo que la cancha
                    necesita a la altura típica del modal, no un número
                    arbitrario grande. */}
                <div className="order-1 md:order-none flex-1 md:min-w-0 min-h-0 max-w-[480px] mx-auto w-full flex flex-col overflow-y-auto custom-scrollbar">
                  {/* ── Cancha ─────────────────────────────────────────────
                      Es una alineación: los marcos punteados según la
                      formación elegida se ven ANTES de poner a nadie (como
                      siempre) -- soltar cerca de uno lo adopta. La posición
                      exacta sigue siendo libre (arrastrar a cualquier
                      punto, sin cupo), así que un lateral derecho no es lo
                      mismo que uno izquierdo. Cada pin tiene su etiqueta
                      editable con un toque.

                      El wrapper (flex-1 min-h-0) le da a la cancha TODA la
                      altura que sobre en la columna; adentro, la cancha
                      mide height:100% + aspect-ratio -- crece con la
                      ventana real en vez de quedar fija en 340px, que era
                      lo que hacía que varias líneas de formación se
                      pisaran entre sí. */}
                  <div className="flex-1 min-h-60 flex items-center justify-center shrink-0">
                    <div
                      ref={pitchRef}
                      className="relative rounded-xl overflow-hidden h-full max-w-full border border-white/20 shadow-md bg-green-950"
                      style={{ aspectRatio: '300 / 340' }}
                    >
                      <CourtBackground sport={sport} />
                      {emptySlots.map((slot) => (
                        <EmptySlotMarker key={slot.id} x={slot.x} y={slot.y} label={slot.label} />
                      ))}
                      {starters.filter(([, p]) => p.x != null && p.y != null).map(([k, p]) => {
                        const s = subjectByKey.get(k);
                        if (!s) return null;
                        return (
                          <PitchPin
                            key={k}
                            pKey={k}
                            subject={s}
                            state={p}
                            isEditingChip={editingKey === k}
                            onToggleChip={(o) => setEditingKey(o ? k : null)}
                            onLabelChange={(label) => setPlayer(k, { slot_label: label, labelIsCustom: true })}
                            onJerseyChange={(v) => setPlayer(k, { jersey_number: v })}
                            onMinutesChange={(v) => setPlayer(k, { minutes_played: v })}
                            onSendToBench={() => { setPlayer(k, { role: 'bench' }); setEditingKey(null); }}
                            onRemove={() => removePlayer(k)}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {/* DialogContent de Radix se centra con translate-x/y[-50%] --
                ese transform en un ancestro convierte a DialogContent en el
                "containing block" de cualquier descendiente position:fixed
                (regla de CSS, no un bug de dnd-kit). <DragOverlay> es
                fixed por dentro, así que sin este portal quedaba atado al
                scroll de DialogContent en vez del viewport -- mismo
                síntoma de scrollbar infinito, ahora un nivel más arriba.
                El portal a document.body lo saca de esa cadena; el
                contexto de DndContext viaja igual a través del portal. */}
            {typeof document !== 'undefined' && createPortal(
              <DragOverlay dropAnimation={null}>
                {activeDragKey && subjectByKey.get(activeDragKey) ? (
                  <DragOverlayPreview subject={subjectByKey.get(activeDragKey)!} />
                ) : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
        )}

        <DialogFooter className="px-6 pb-6 pt-4 border-t shrink-0">
          <Button variant="outline" onClick={handleClose} disabled={saveLineup.isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saveLineup.isPending || subjects.length === 0}>
            {saveLineup.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Guardando...
              </>
            ) : (
              'Guardar Alineación'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
