/**
 * Tablero táctico (P0) — cancha con drag-and-drop, formación libre (D1 de
 * docs/specs/football-tactical-experience.md). Reemplaza gradualmente a
 * LineupModal; LineupModal se mantiene como vista clásica hasta validar este
 * flujo en producción (ver docs/plan-p0-tablero-tactico.md, sección 3).
 *
 * @dnd-kit en vez de HTML5 Drag and Drop nativo: pointer events unificados
 * mouse+touch, sin el comportamiento errático de HTML5 DnD dentro de
 * WebViews de Capacitor (D7).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  DndContext,
  useDraggable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuSub, DropdownMenuSubTrigger,
  DropdownMenuSubContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { Settings2, Shirt, Loader2, Square, X, Bookmark, Redo2, Trash2, PenLine, Undo2, Eraser, Ruler, Sparkles, Plus, Play, Copy, RotateCw, Pencil, Type, Users, MoreHorizontal, Package, LayoutGrid, ChevronDown, ChevronUp, Eye, CalendarPlus } from 'lucide-react';
import type { ExportBranding } from '@/lib/export/tacticalWatermark';
import { whatsappTextUrl } from '@/lib/export/tacticalShare';
import { boardHasContent, rosterCounts, rosterCountsLabel } from '@/lib/school/tacticalBoardUx';
import { buildSharedPlayPayload, sharedPlayMessage, sharedPlayUrl } from '@/lib/school/tacticalSharedPlay';
import { createSharedPlay } from '@/lib/school/tacticalSharedPlayApi';
import { getFootballLineups } from '@/lib/school/footballQueries';
import { useToast } from '@/hooks/use-toast';
import { startHintFormationLabel } from '@/lib/school/tacticalStartHint';
import { useTeamPerformanceRoster } from '@/hooks/usePerformanceData';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { useIsMobile, useCompactLandscape } from '@/hooks/use-mobile';
import {
  useFootballLineups,
  useFootballLineup,
  useSaveFootballLineup,
  useTacticalPresets,
  useCreateTacticalPreset,
  useUpdateTacticalPreset,
  useDeleteTacticalPreset,
  useFootballEvents,
  useFootballSeasonStats,
} from '@/hooks/useFootballData';
import { CourtBackground } from './courts/CourtBackground';
// M6d: herramientas de dibujo y diálogo «Campo» (lógica fuera de este archivo).
import { InteractiveM6dShape, LineLegendOverlay, PolygonDraftView, SeqOverlay, StyledLinePreview } from './TacticalM6dLayer';
import { TacticalDrawToolsPanel } from './TacticalDrawToolsPanel';
import { decorateNewShape, isM6dShape, lineStylesIn, renumber, snapToNearest, type DrawOptions } from '@/lib/school/tacticalDrawing';
import { useTacticalDrawTools, usePolygonDraft } from '@/lib/school/useTacticalDrawTools';
import { courtOf, drawableShapes, inkForSurface, keepCourtOnly, viewForCourt, withCourt, type CourtConfig } from '@/lib/school/tacticalCourt';
import { PlayerCard } from './PlayerCard';
import { TacticalExportMenu, type TacticalExportEvent } from './TacticalExportMenu';
import { Tactical3DLauncher } from './tactical3d/Tactical3DLauncher';
import { SaveToLibraryDialog } from './SaveToLibraryDialog';
import type { TacticalExportInput } from '@/lib/export/tacticalExport';
import type { TacticalStaticPlayer } from './TacticalStaticSvg';
import { boardFromPitch, isExerciseSport, type ExerciseBoard } from '@/lib/school/exerciseLibrary';
import { useTeamTacticalSport } from '@/hooks/useTeamTacticalSport';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import { boardMetersFor, boardSportConfig, defaultBoardFormation, type BoardFormation } from '@/lib/school/tacticalBoardSport';
import { logTacticalEvent, type TacticalBoardEvent } from '@/lib/school/tacticalUsage';
import { emptyHistory, historyCommit, historyRedo, historySetBase, historyUndo, type HistoryState } from '@/lib/school/tacticalHistory';
import { POSITION_LABEL, suggestLabel, legacyFallbackPosition } from '@/lib/school/footballDisplay';
import type { LineupSourceType, LineupPlayerInput, TacticalPreset, TacticalSituation, TacticalArrow, TacticalArrowColor, TacticalShapeType, BallPathKind, EventSourceType } from '@/lib/school/footballQueries';
import {
  GK_VIEW, viewBoxOf, yToView, yFromView, curveControlPoint, hydrateShape,
  BALL_PATH_BEND, isLoftedPath, ballPathPoint, isPointShape, OBJECT_BOX,
  OBJ_SIZE_MIN, OBJ_SIZE_MAX, type PitchView, type ArrowPoint, type ObjectType,
  buildFreehandShape, smoothPathD, pairsOf, eraserHits, offsetShape, TEXT_MAX_LENGTH,
} from '@/lib/school/tacticalGeometry';
import {
  ARROW_COLOR_HEX, COLOR_LABEL, OBJECT_LABEL, BALL_PATH_LABEL, PIN_STYLE_KEY, readPinStyle,
  PIN_PHOTOS_KEY, readPinPhotos, isGoalkeeperLabel, type PinStyle,
} from '@/lib/school/tacticalPalette';
import { BallGlyph, SilhouetteGlyph, ObjectIcon } from './tacticalGlyphs';
import {
  MAX_STARTERS, repositionedCenterPx, pitchPctFromPx,
  buildPresetSlots, applyPresetSlots, nearestEmptySlot, splitKnownKeys, greedyNearestMatch,
  type PlacedSlot, type EmptySlot,
} from '@/lib/school/tacticalBoardLogic';
import type { RosterSubject } from '@/lib/school/performanceQueries';
import {
  placeInFormation, sortRosterForFormation, formationAsPresetSlots,
} from '@/lib/school/tacticalFormations';
import { DEFAULT_FRAME_MS, MAX_FRAMES, presetSlotIndex, presetSlotKey, type TacticalFrame } from '@/lib/school/tacticalFrames';
import {
  advancePlayback, createPlaybackClock, duplicateFrameAt, ghostTrail, hydrateFrames, moveFrame, newFrameId,
  removeFrameAt, serializeFrames, setFrameDuration, totalDurationMs, type InterpolatedPlayer,
} from '@/lib/school/tacticalAnimation';
import { TacticalTimeline, TacticalFramePlayback, type PlayState, type PlaybackSpeed } from './TacticalTimeline';
import { TacticalAiOverlay, TacticalAiPanel, type AiPreview } from './TacticalAiPanel';
import { FormationGallery } from './FormationGallery';
import { countRivals, galleryFormations, initialPlayersFilter, removeRivalShapes, replaceRivalShapes } from '@/lib/school/tacticalFormationGallery';
// M6g «Ajustes de la pizarra»: la lógica vive en módulos propios; acá solo los enganches.
import { PinNameTag, TacticalBoardPrefsProvider, useTacticalBoardPrefs } from './tacticalBoardPrefs';
import { TacticalBoardSettingsButton } from './TacticalBoardSettingsDialog';
import { TacticalPossessionBar } from './TacticalPossessionBar';
import { ballAtFeet, placeBallShape, remapBallOwner, setBallOwner } from '@/lib/school/tacticalPossession';
import { buildAnalyzeRequest, hasAiAnalysis } from '@/lib/school/tacticalAi';
// M6c notas y videos: la lógica vive en ./tacticalMedia; acá solo el enganche.
import { usePlayMedia } from './tacticalMedia/usePlayMedia';
import { PlayMediaButtons, PlayMediaDialogs, PlayMediaMenuItems, type MediaDialog } from './tacticalMedia/PlayMediaControls';
import { FrameNoteBar } from './tacticalMedia/FrameNoteBar';
import { PresetTagFilterSub, filterPresetsByTag, presetTags } from './tacticalMedia/PresetTagFilter';
// M6b «Configuración de los equipos»: la lógica vive en estos módulos; acá solo los enganches.
import { TacticalTeamsContext, useBoardTeams, useTeamsConfig, useTeamsContext } from '@/hooks/useTacticalTeams';
import { chipCaption, pointScale, rivalSlots } from '@/lib/school/tacticalTeams';
import { sportDef } from '@/lib/school/tacticalSports';
import { TeamPinVisual } from './TacticalTeamPin';
import { RivalChip } from './tacticalTeamGlyphs';
// M6h «Videos subidos»: el panel va como pestaña «Subir» del diálogo «Videos» de M6c.
import { LazySchoolVideosPanel } from './schoolVideos/LazySchoolVideosPanel';

// Diálogos que se abren a pedido (M6b «Configuración de los equipos», M6d
// «Campo»): chunk aparte, no engordan la pizarra.
const TacticalTeamsDialog = lazy(() => import('./TacticalTeamsDialog').then((m) => ({ default: m.TacticalTeamsDialog })));
const TacticalCourtDialog = lazy(() => import('./TacticalCourtDialog').then((m) => ({ default: m.TacticalCourtDialog })));
// Pizarra libre (/pizarra): «Agregar a una sesión».
const PizarraAgregarASesionDialog = lazy(() => import('./PizarraAgregarASesionDialog').then((m) => ({ default: m.PizarraAgregarASesionDialog })));

const SITUATION_LABEL: Record<TacticalSituation, string> = {
  ataque: 'Ataque',
  defensa: 'Defensa',
  presion: 'Presión',
  transicion: 'Transición',
  corner: 'Córner',
  tiro_libre: 'Tiro libre',
  penalti: 'Penalti',
  arqueros: 'Arqueros',
};
const SITUATIONS = Object.keys(SITUATION_LABEL) as TacticalSituation[];

interface TacticalBoardProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
  sourceType: LineupSourceType;
  sourceId: string;
  /** "vs Rival — 20 ago" o "Entrenamiento — 20 ago", según el contexto. */
  contextLabel: string;
  /** 'edit' (por defecto): el editor completo. 'view': solo la cancha con
   *  jugadores y dibujos, Reproducir y Cerrar; quien puede editar
   *  (TACTICAL_EDIT_ROLES) ve además un botón Editar que pasa a 'edit' ahí
   *  mismo. Un rol de solo lectura siempre ve el tablero como 'view'. */
  mode?: 'edit' | 'view';
  /** Deporte de la cancha (T4). Sin él, la pizarra lo resuelve del equipo
   *  (teams.sport con sportFromTeam); sin deporte reconocible → fútbol 11. */
  sport?: TacticalSport | null;
  /** Pizarra libre (/pizarra): no está atada a una sesión ni a un partido. No
   *  carga ni guarda una alineación propia; «Guardar» ofrece «Guardar en Mis
   *  jugadas» y «Agregar a una sesión» (un bloque de entrenamiento del equipo). */
  scratch?: boolean;
}

const subjectKey = (t: string, id: string) => `${t}:${id}`;

/** Sugerencia de etiqueta según la altura donde se soltó -- un default
 *  editable, no una regla de negocio (D1: formación libre, sin catálogo). */
// suggestLabel/LEGACY_BAND_Y/legacyFallbackPosition viven en footballDisplay.ts
// -- compartidas con LineupModal.tsx, que ahora usa la misma cancha libre
// (x/y) en vez de su viejo sistema de bandas con cupo por formación.

/** Franjas de la cancha (mismos cortes que suggestLabel) para el overlay de
 *  zonas -- solo se usa acá (el overlay de zonas es exclusivo del tablero
 *  táctico), por eso se queda local. */
const ZONE_BANDS: { label: string; y0: number; y1: number }[] = [
  { label: 'Ataque', y0: 0, y1: 22 },
  { label: 'Medio', y0: 22, y1: 48 },
  { label: 'Defensa', y0: 48, y1: 78 },
  { label: 'Arquero', y0: 78, y1: 100 },
];

/** P4 (sugerencia de XI): 11 posiciones de un 4-4-2 genérico, sin saber la
 *  posición real de cada jugador (las season-stats no la traen) -- es un
 *  punto de partida ordenado por minutos jugados, no una formación "correcta"
 *  para ese equipo. El coach reacomoda desde ahí. */
function generateFormation442(): { x: number; y: number; label: string }[] {
  const rows: { y: number; count: number; label: string }[] = [
    { y: 92, count: 1, label: 'Arquero' },
    { y: 65, count: 4, label: 'Defensa' },
    { y: 38, count: 4, label: 'Medio' },
    { y: 12, count: 2, label: 'Delantero' },
  ];
  const slots: { x: number; y: number; label: string }[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const x = row.count <= 1 ? 50 : 15 + i * (70 / (row.count - 1));
      slots.push({ x, y: row.y, label: row.label });
    }
  }
  return slots;
}

/** D6 de la spec: con muy pocos jugadores con partidos registrados, "sugerir"
 *  algo sería ruido estadístico, no una sugerencia real. */
const MIN_SUGGEST_SAMPLE = 5;

function initialsOf(name: string) {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/** Tarjeta de jugador estilo videojuego (banca): avatar circular con anillo,
 *  nombre debajo, en una tira horizontal desplazable. */
function BenchDraggable({ subject, onOpenCard, needsRotation, showPhotos, readOnly }: { subject: RosterSubject; onOpenCard: () => void; needsRotation?: boolean; showPhotos?: boolean; readOnly?: boolean }) {
  const key = subjectKey(subject.subject_type, subject.subject_id);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `bench:${key}`,
    data: { subject },
    disabled: readOnly,
  });
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`relative touch-none cursor-grab active:cursor-grabbing shrink-0 w-[62px] flex flex-col items-center gap-1 rounded-lg border border-white/10 bg-gradient-to-b from-zinc-800/95 to-zinc-900/95 px-1.5 py-1.5 shadow-lg transition-all hover:-translate-y-0.5 hover:border-emerald-400/50 hover:shadow-emerald-500/10 ${isDragging ? 'opacity-40 scale-95' : ''}`}
    >
      {/* P4 (D6): tercio de menos minutos jugados en la temporada -- candidato
          a sumar minutos. Punto, no texto, para no competir con el nombre en
          una tarjeta de 62px. */}
      {needsRotation && (
        <span
          title="Entre el tercio con menos minutos jugados esta temporada"
          className="absolute top-1 right-1 h-2 w-2 rounded-full bg-amber-400 ring-1 ring-black/40"
        />
      )}
      {/* Tocar (sin arrastrar) abre la tarjeta -- dnd-kit solo activa el drag
          después de moverse `distance` px, así que un tap corto sigue
          disparando este onClick normal, mismo patrón que ya usa la etiqueta
          del pin para renombrar. */}
      <Avatar className="h-8 w-8 ring-2 ring-white/15 cursor-pointer" onClick={(e) => { e.stopPropagation(); onOpenCard(); }}>
        {showPhotos && <AvatarImage src={subject.avatar_url ?? undefined} />}
        <AvatarFallback className="text-xs font-bold bg-gradient-to-br from-emerald-500 to-emerald-700 text-white">
          {initialsOf(subject.full_name)}
        </AvatarFallback>
      </Avatar>
      <span className="text-[10px] font-semibold text-white/90 text-center leading-tight line-clamp-2">
        {subject.full_name}
      </span>
    </div>
  );
}

/** Marcador de plantilla cargada -- no arrastrable, solo referencia visual
 *  hasta que un jugador se suelte cerca y lo "adopte" (ver SNAP_DISTANCE). */
function EmptySlotMarker({ slot, view, onRemove }: { slot: EmptySlot; view: PitchView; onRemove: () => void }) {
  const topPct = yToView(slot.y, view);
  if (topPct < -1 || topPct > 101) return null; // fuera de la ventana (zoom al área)
  return (
    <div
      style={{
        position: 'absolute',
        left: `${slot.x}%`,
        top: `${topPct}%`,
        transform: 'translate(-50%, -50%)',
        zIndex: 5,
      }}
      className="flex flex-col items-center gap-0.5 group"
    >
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 z-10 h-3.5 w-3.5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Quitar marcador"
      >
        <X className="h-2 w-2" />
      </button>
      <div style={PIN_ZOOM} className="flex flex-col items-center gap-0.5">
        <div className="h-11 w-11 rounded-full border-2 border-dashed border-emerald-300/70 bg-emerald-400/10 animate-pulse" />
        <span className="text-[10px] font-bold text-white bg-black/50 backdrop-blur-sm rounded-full px-2 py-0.5 leading-tight max-w-[84px] truncate">
          {slot.slot_label}
        </span>
      </div>
    </div>
  );
}

/** Overlay de zonas (ataque/medio/defensa/arquero + bandas), togglable con el
 *  ícono de ojo. Puramente visual -- pointer-events-none para no interferir
 *  con el drag de los pines que quedan encima. Recorta las franjas a la
 *  ventana visible (zoom al área). */
function ZoneOverlay({ view }: { view: PitchView }) {
  return (
    <div className="absolute inset-0 pointer-events-none z-[1]">
      {ZONE_BANDS.map((b, i) => {
        const top = Math.max(0, yToView(b.y0, view));
        const bottom = Math.min(100, yToView(b.y1, view));
        if (bottom <= 0 || top >= 100) return null;
        return (
          <div
            key={b.label}
            style={{ position: 'absolute', top: `${top}%`, height: `${bottom - top}%`, left: 0, right: 0 }}
            className={`flex items-start justify-center pt-1.5 border-t border-white/25 ${i % 2 === 0 ? 'bg-white/[0.05]' : ''}`}
          >
            <span className="text-[10px] uppercase tracking-widest text-white/45 font-bold">{b.label}</span>
          </div>
        );
      })}
      {/* Bandas (izquierda/centro/derecha) */}
      <div style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1 }} className="bg-white/20" />
      <div style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1 }} className="bg-white/20" />
    </div>
  );
}

/** Campos editables de una figura desde la capa de dibujo y el panel. */
type ShapePatch = Partial<Omit<TacticalArrow, 'type'>>;

/** Herramienta activa del modo dibujo: una figura, o el borrador (que no es
 *  una figura -- no se guarda, solo quita lo que toca). */
type DrawTool = TacticalShapeType | 'eraser';

/** Figuras que se mueven enteras con un punto (x1/y1 = x2/y2) y se
 *  seleccionan con un toque: el material y el texto. */
const isMovableByPoint = (t: TacticalShapeType | undefined) => isPointShape(t) || t === 'text' || t === 'spotlight';

/** Pestañas de la hoja de la pizarra en celular. */
type MobileTab = 'escribir' | 'lineas' | 'material' | 'color' | 'ajustes' | 'medir';
const MOBILE_TABS: { key: MobileTab; label: string }[] = [
  { key: 'escribir', label: 'Escribir' },
  { key: 'lineas', label: 'Líneas' },
  { key: 'material', label: 'Material' },
  { key: 'color', label: 'Color' },
  // "Objeto": tamaño, giro, duplicar y quitar del material/texto (o los
  // valores con que se coloca). Medir va aparte: juntos no entran en la hoja.
  { key: 'ajustes', label: 'Objeto' },
  { key: 'medir', label: 'Medir' },
];

/** Alto de la hoja inferior (Pizarra / Plantilla) en celular, en vh. */
// 36 y no 42: en un iPhone 14 (664 px útiles) con 42vh la cancha quedaba de
// 122-145 px de ancho. El material va en 4 columnas en celular para caber.
const SHEET_VH = 36;

/** Botones del toolbar: palabra + ícono, alto táctil de 32px. */
const TB_BTN = 'h-8 gap-1 text-[11px] px-2';
const TB_IDLE = 'text-white/80 hover:text-white hover:bg-white/10';
const TB_ON = 'bg-emerald-600 hover:bg-emerald-500 text-white hover:text-white';

/** Radio del borrador en % de cancha. */
const ERASER_RADIUS = 2.6;
/** Tamaño base del texto en unidades del viewBox (se multiplica por size). */
const TEXT_FONT = 9;

/** Balón "fantasma" que recorre un ball_path durante "Reproducir jugada"
 *  (x/y en % de cancha; scale > 1 = elevado, en remate/penal). */
interface GhostBall { x: number; y: number; scale: number }

/** Capa de dibujo + edición del modo pizarra (P2d): crea flechas/curvas/
 *  zonas/recorridos de balón, coloca material, deja mover cada figura por sus
 *  extremos (o entera, si es un objeto), seleccionar un objeto para girarlo y
 *  quitarlo, y la herramienta de medir distancia. Todo el manejo de puntero
 *  vive ACÁ (no en el padre) para no re-renderizar TacticalBoard entero en
 *  cada pixel de arrastre.
 *
 *  Capas de pointer-events: el <svg> raíz solo intercepta el puntero
 *  (pointer-events-auto) cuando drawMode o measureMode están activos -- así
 *  el resto del tiempo los pines de abajo se arrastran normal. Los handles y
 *  el cuerpo de cada figura SÍ son siempre interactivos (pointer-events
 *  explícito por elemento), para poder ajustar o borrar una figura ya hecha
 *  sin tener que activar el modo dibujo.
 *
 *  Gestos sobre un OBJETO: arrastrar = mover; tocar sin arrastrar = seleccionar
 *  (marco + handle de giro + ×). Antes tocar borraba: con tamaño y giro por
 *  objeto hace falta un estado "seleccionado" y borrar pasa a ser explícito. */
function ArrowLayer({
  shapes, drawMode, drawShapeType, drawColor, ballKind, newObjSize, newObjRot,
  measureMode, pitchLengthMeters, view, pinStyle, selectedIndex, ghostBalls, hiddenIndexes,
  onCreateShape, onUpdateShape, onDeleteShape, onSelectShape, onEraseShapes, readOnly = false,
  drawOptions, polygonDraft,
}: {
  /** M6d: estilo de línea, forma de zona, numeración y foco (ver tacticalDrawing). */
  drawOptions?: DrawOptions;
  /** M6d: polígono en construcción (usePolygonDraft). */
  polygonDraft?: ReturnType<typeof usePolygonDraft>;
  shapes: TacticalArrow[];
  drawMode: boolean;
  drawShapeType: DrawTool;
  drawColor: TacticalArrowColor;
  ballKind: BallPathKind;
  newObjSize: number;
  newObjRot: number;
  measureMode: boolean;
  pitchLengthMeters: number;
  view: PitchView;
  pinStyle: PinStyle;
  selectedIndex: number | null;
  ghostBalls: GhostBall[] | null;
  hiddenIndexes: ReadonlySet<number>;
  onCreateShape: (shape: TacticalArrow) => void;
  onUpdateShape: (index: number, patch: ShapePatch) => void;
  onDeleteShape: (index: number) => void;
  onSelectShape: (index: number | null) => void;
  /** Borrador: quita de una vez todas las figuras que tocó el gesto. */
  onEraseShapes: (indexes: number[]) => void;
  /** Modo ver / solo lectura: ninguna figura captura el puntero y no se
   *  dibujan los puntos de agarre (solo estorban a quien no puede editar). */
  readOnly?: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  // M6b: rivales con la configuración del equipo de afuera (null = como siempre).
  const teamsCtx = useTeamsContext();
  const rivals = useMemo(() => (teamsCtx ? rivalSlots(shapes, teamsCtx.teams, teamsCtx.hasGoalkeeper) : null), [teamsCtx, shapes]);
  // Lápiz: puntos crudos del trazo en curso (en % de cancha). Se guarda en
  // state para dibujarlo mientras se arrastra; al soltar se simplifica.
  const [stroke, setStroke] = useState<ArrowPoint[] | null>(null);
  // Borrador: posición del círculo mientras se arrastra.
  const [eraserAt, setEraserAt] = useState<ArrowPoint | null>(null);
  // Texto en edición: nuevo (index null) o uno ya puesto. El ref evita que el
  // blur y el Enter lo guarden dos veces.
  const [textDraft, setTextDraft] = useState<{ index: number | null; x: number; y: number; value: string } | null>(null);
  const textDraftRef = useRef<typeof textDraft>(null);
  textDraftRef.current = textDraft;
  // Escribir es independiente de lo que haya debajo: con lápiz o borrador
  // NINGUNA figura captura el puntero (si no, rayar encima de una flecha
  // arrastraría su punta), y con texto solo los textos (para editarlos) --
  // tocar encima de un cono o una zona pone la nota ahí, no selecciona el cono.
  // Los jugadores ya quedan debajo: la capa de dibujo (z-40) los tapa.
  const peFor = (t: TacticalShapeType) => {
    if (readOnly) return 'pointer-events-none';
    if (!drawMode) return 'pointer-events-auto';
    if (drawShapeType === 'freehand' || drawShapeType === 'eraser') return 'pointer-events-none';
    if (drawShapeType === 'text' && t !== 'text') return 'pointer-events-none';
    return 'pointer-events-auto';
  };
  const [preview, setPreview] = useState<{ start: ArrowPoint; current: ArrowPoint } | null>(null);
  const [measurePoints, setMeasurePoints] = useState<ArrowPoint[]>([]);
  // `moved` distingue un tap real (selecciona un objeto de un punto) de un
  // drag (lo reposiciona) -- se marca en handleHandlePointerMove, que el
  // navegador solo dispara cuando el puntero de verdad se movió.
  const draggingHandle = useRef<{ index: number; endpoint: 'start' | 'end'; moved: boolean } | null>(null);
  const draggingMeasurePoint = useRef<0 | 1 | null>(null);
  // Handle de giro del objeto seleccionado: centro del objeto en espacio SVG.
  const rotating = useRef<{ index: number; cx: number; cy: number } | null>(null);

  const toSvg = (p: ArrowPoint) => ({ x: p.x * 3, y: p.y * 3.4 });
  const clamp01 = (n: number) => Math.min(100, Math.max(0, n));

  /** Puntero → % de cancha COMPLETA (0-100), pasando por la ventana visible:
   *  con zoom, el alto del <svg> en pantalla representa solo y0..y1. */
  function pctFromEvent(e: { clientX: number; clientY: number }): ArrowPoint | null {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const vx = ((e.clientX - rect.left) / rect.width) * 100;
    const vy = ((e.clientY - rect.top) / rect.height) * 100;
    return { x: clamp01(vx), y: clamp01(yFromView(vy, view)) };
  }

  /** Abre el campo de texto y le da foco DENTRO del gesto: iOS solo saca el
   *  teclado si focus() corre sincrónico en el handler del toque, por eso el
   *  flushSync (render ya) en vez de un autoFocus en un efecto posterior. */
  function openTextDraft(draft: { index: number | null; x: number; y: number; value: string }) {
    commitTextDraft();
    flushSync(() => setTextDraft(draft));
    textInputRef.current?.focus();
  }

  function commitTextDraft() {
    const d = textDraftRef.current;
    if (!d) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const value = d.value.trim().slice(0, TEXT_MAX_LENGTH);
    if (d.index === null) {
      if (!value) return;
      const shape: TacticalArrow = { type: 'text', x1: d.x, y1: d.y, x2: d.x, y2: d.y, color: drawColor, text: value };
      if (newObjSize !== 1) shape.size = newObjSize;
      onCreateShape(shape);
    } else if (value) {
      onUpdateShape(d.index, { text: value });
    } else {
      onDeleteShape(d.index); // vaciar un texto = quitarlo
    }
  }

  function eraseAt(p: ArrowPoint) {
    const hits = shapes.flatMap((s, i) => (eraserHits(s, p, ERASER_RADIUS) ? [i] : []));
    if (hits.length > 0) onEraseShapes(hits);
  }

  function handleCanvasPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (measureMode || !drawMode) return;
    const p = pctFromEvent(e);
    if (!p) return;
    if (drawShapeType === 'eraser') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setEraserAt(p);
      eraseAt(p);
      return;
    }
    if (drawShapeType === 'freehand') {
      e.currentTarget.setPointerCapture(e.pointerId);
      setStroke([p]);
      return;
    }
    if (drawShapeType === 'text') {
      // Que el toque no le robe el foco al campo recién abierto.
      e.preventDefault();
      openTextDraft({ index: null, x: p.x, y: p.y, value: '' });
      return;
    }
    // M6d: el foco se pega al jugador tocado; el polígono, vértice por toque.
    if (drawShapeType === 'spotlight') {
      const at = snapToNearest(p, drawOptions?.snapTargets ?? []);
      const shape: TacticalArrow = { type: 'spotlight', x1: at.x, y1: at.y, x2: at.x, y2: at.y, color: drawColor };
      if (newObjSize !== 1) shape.size = newObjSize;
      onCreateShape(shape);
      return;
    }
    if (drawShapeType === 'zone' && drawOptions?.zoneForm === 'polygon' && polygonDraft) {
      polygonDraft.add(p);
      return;
    }
    // Objetos de un punto se colocan con un toque, con el tamaño y giro que
    // estén fijados en el panel; flecha/curva/zona/recorrido, arrastrando de A a B.
    if (isPointShape(drawShapeType)) {
      const shape: TacticalArrow = { type: drawShapeType, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: drawColor };
      if (newObjSize !== 1) shape.size = newObjSize;
      if (newObjRot) shape.rot = newObjRot;
      onCreateShape(shape);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setPreview({ start: p, current: p });
  }

  function handleCanvasPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (eraserAt) {
      const p = pctFromEvent(e);
      if (!p) return;
      setEraserAt(p);
      eraseAt(p);
      return;
    }
    if (stroke) {
      // Eventos coalescidos: con lápiz (Apple Pencil, S Pen) llegan muchos
      // puntos por frame; sin ellos el trazo rápido sale en tramos rectos.
      const native = e.nativeEvent as PointerEvent;
      const events = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      const pts = (events.length > 0 ? events : [native]).map(pctFromEvent).filter((q): q is ArrowPoint => !!q);
      if (pts.length > 0) setStroke((prev) => (prev ? [...prev, ...pts] : prev));
      return;
    }
    if (polygonDraft?.active && drawShapeType === 'zone') {
      const q = pctFromEvent(e);
      if (q) polygonDraft.setCursor(q);
    }
    if (!preview) return;
    const p = pctFromEvent(e);
    if (!p) return;
    setPreview((prev) => (prev ? { ...prev, current: p } : prev));
  }

  function handleCanvasPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (eraserAt) {
      setEraserAt(null);
      return;
    }
    if (stroke) {
      const shape = buildFreehandShape(stroke, drawColor);
      if (shape) onCreateShape(shape);
      setStroke(null);
      return;
    }
    if (!preview) return;
    const p = pctFromEvent(e) ?? preview.current;
    const dist = Math.hypot(p.x - preview.start.x, p.y - preview.start.y);
    // El preview solo lo abren las figuras de 2 puntos: el borrador nunca llega acá.
    if (dist >= 4 && drawShapeType !== 'eraser') {
      const shape: TacticalArrow = { type: drawShapeType, x1: preview.start.x, y1: preview.start.y, x2: p.x, y2: p.y, color: drawColor };
      if (drawShapeType === 'ball_path') shape.kind = ballKind;
      onCreateShape(decorateNewShape(shape, drawOptions, shapes));
    }
    setPreview(null);
  }

  function handleCanvasClick(e: ReactMouseEvent<SVGSVGElement>) {
    if (!measureMode) return;
    // Con los 2 puntos ya puestos, un click en la cancha NO reinicia la
    // medición: se ajusta arrastrando los puntos y se borra tocando la línea.
    if (measurePoints.length >= 2) return;
    const p = pctFromEvent(e);
    if (!p) return;
    setMeasurePoints((prev) => [...prev, p]);
  }

  function handleMeasurePointerDown(index: 0 | 1, e: ReactPointerEvent<SVGCircleElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingMeasurePoint.current = index;
  }

  function handleMeasurePointerMove(e: ReactPointerEvent<SVGCircleElement>) {
    const idx = draggingMeasurePoint.current;
    if (idx === null) return;
    const p = pctFromEvent(e);
    if (!p) return;
    setMeasurePoints((prev) => prev.map((pt, i) => (i === idx ? p : pt)));
  }

  function handleMeasurePointerUp() {
    draggingMeasurePoint.current = null;
  }

  function handleHandlePointerDown(index: number, endpoint: 'start' | 'end', e: ReactPointerEvent<SVGCircleElement | SVGGElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingHandle.current = { index, endpoint, moved: false };
  }

  function handleHandlePointerMove(e: ReactPointerEvent<SVGCircleElement | SVGGElement>) {
    const dh = draggingHandle.current;
    if (!dh) return;
    const p = pctFromEvent(e);
    if (!p) return;
    dh.moved = true;
    // Objeto de un punto: mover su único handle actualiza x1/y1 Y x2/y2
    // juntos, para que se mantengan iguales (el ícono sigue siendo un punto).
    if (isMovableByPoint(shapes[dh.index]?.type)) {
      onUpdateShape(dh.index, { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      return;
    }
    onUpdateShape(dh.index, dh.endpoint === 'start' ? { x1: p.x, y1: p.y } : { x2: p.x, y2: p.y });
  }

  function handleHandlePointerUp() {
    draggingHandle.current = null;
  }

  /** Solo objetos de un punto: soltar sin haber movido = seleccionar (o
   *  deseleccionar si ya lo estaba); soltar habiendo arrastrado = solo mover. */
  function handleObjectPointerUp(index: number) {
    const wasTap = draggingHandle.current !== null && !draggingHandle.current.moved;
    draggingHandle.current = null;
    if (!wasTap) return;
    // Texto ya seleccionado + otro toque = editarlo (el objeto, en cambio, se
    // deselecciona: no tiene nada que editar en la cancha).
    const s = shapes[index];
    if (s?.type === 'text' && selectedIndex === index) {
      openTextDraft({ index, x: s.x1, y: s.y1, value: s.text ?? '' });
      return;
    }
    onSelectShape(selectedIndex === index ? null : index);
  }

  function handleRotatePointerDown(index: number, s: TacticalArrow, e: ReactPointerEvent<SVGCircleElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const c = toSvg({ x: s.x1, y: s.y1 });
    rotating.current = { index, cx: c.x, cy: c.y };
  }

  /** Ángulo entre el centro del objeto y el puntero, en espacio SVG. La
   *  cancha se dibuja isotrópica en pantalla (el contenedor tiene la misma
   *  proporción que el viewBox), así que el ángulo en SVG es el que se ve. */
  function handleRotatePointerMove(e: ReactPointerEvent<SVGCircleElement>) {
    const r = rotating.current;
    if (!r) return;
    const p = pctFromEvent(e);
    if (!p) return;
    const sp = toSvg(p);
    const deg = (Math.atan2(sp.y - r.cy, sp.x - r.cx) * 180) / Math.PI + 90;
    onUpdateShape(r.index, { rot: Math.round(((deg % 360) + 360) % 360) });
  }

  function handleRotatePointerUp() {
    rotating.current = null;
  }

  /** El sistema puede interrumpir un gesto (llamada, gesto del sistema, otro
   *  dedo que roba el puntero): llega `pointercancel`/`lostpointercapture` en
   *  vez de `pointerup`. Sin esto el trazo en curso, la vista previa de una
   *  flecha o el arrastre de un handle quedaban colgados hasta el próximo toque. */
  function cancelGestures() {
    setPreview(null);
    setStroke(null);
    setEraserAt(null);
    draggingHandle.current = null;
    draggingMeasurePoint.current = null;
    rotating.current = null;
  }

  // Ancho real = largo * proporción de la cancha (300/340) -- la cancha no
  // es cuadrada, y el largo (arco a arco) es el que el coach conoce mejor.
  const pitchWidthMeters = pitchLengthMeters * (300 / 340);
  const measureDistanceM = measurePoints.length === 2
    ? Math.hypot(
        ((measurePoints[1].x - measurePoints[0].x) / 100) * pitchWidthMeters,
        ((measurePoints[1].y - measurePoints[0].y) / 100) * pitchLengthMeters,
      )
    : null;

  /** Handles de una figura de 2 puntos (flecha/curva/recorrido): siempre
   *  interactivos, muevan o no drawMode/measureMode. */
  function renderEndHandles(i: number, p1: ArrowPoint, p2: ArrowPoint, color: string) {
    if (readOnly) return null;
    const pe = peFor(shapes[i]?.type ?? 'arrow');
    return (
      <>
        <circle cx={p1.x} cy={p1.y} r={3.2} fill="white" stroke={color} strokeWidth={1.5}
          className={`${pe} cursor-grab touch-none`}
          onPointerDown={(e) => handleHandlePointerDown(i, 'start', e)}
          onPointerMove={handleHandlePointerMove}
          onPointerUp={handleHandlePointerUp}
        />
        <circle cx={p2.x} cy={p2.y} r={3.2} fill="white" stroke={color} strokeWidth={1.5}
          className={`${pe} cursor-grab touch-none`}
          onPointerDown={(e) => handleHandlePointerDown(i, 'end', e)}
          onPointerMove={handleHandlePointerMove}
          onPointerUp={handleHandlePointerUp}
        />
      </>
    );
  }

  return (
    <>
    <svg
      ref={svgRef}
      viewBox={viewBoxOf(view)}
      preserveAspectRatio="none"
      className={`absolute inset-0 w-full h-full z-40 touch-none ${
        measureMode ? 'cursor-crosshair pointer-events-auto'
          : drawMode ? `${drawShapeType === 'text' ? 'cursor-text' : 'cursor-crosshair'} pointer-events-auto`
          : 'pointer-events-none'
      }`}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      onPointerCancel={cancelGestures}
      onLostPointerCapture={cancelGestures}
      onClick={handleCanvasClick}
    >
      <defs>
        {/* Punta chica (5.5): una más grande se sentía pesada sobre una cancha
            con jugadores y etiquetas ya de por sí cargada. */}
        {(Object.keys(ARROW_COLOR_HEX) as TacticalArrowColor[]).map((c) => (
          <marker key={c} id={`arrowhead-${c}`} markerWidth="5.5" markerHeight="5.5" refX="4" refY="2.75" orient="auto">
            <path d="M0,0 L5.5,2.75 L0,5.5 Z" fill={ARROW_COLOR_HEX[c]} />
          </marker>
        ))}
        {/* Red del arco (patrón en unidades del usuario: escala con el objeto). */}
        <pattern id="tb-net" width="2.6" height="2.6" patternUnits="userSpaceOnUse">
          <path d="M0 0 L2.6 2.6 M2.6 0 L0 2.6" stroke="#f8fafc" strokeOpacity={0.6} strokeWidth={0.35} />
        </pattern>
      </defs>

      {shapes.map((s, i) => {
        const p1 = toSvg({ x: s.x1, y: s.y1 });
        const p2 = toSvg({ x: s.x2, y: s.y2 });
        const color = ARROW_COLOR_HEX[s.color ?? 'white'];
        const type = s.type ?? 'arrow';
        const pe = peFor(type);
        if (type === 'court') return null; // M6d: configuración de cancha, no es un dibujo
        if (isM6dShape(s)) {
          return (
            <InteractiveM6dShape key={i} shape={s} index={i} selected={selectedIndex === i} pe={pe} readOnly={readOnly}
              toPct={pctFromEvent} onUpdate={onUpdateShape} onSelect={onSelectShape} onDelete={onDeleteShape} endHandles={renderEndHandles} />
          );
        }

        if (type === 'freehand') {
          const d = smoothPathD(pairsOf(s.points).map(toSvg));
          return (
            <g key={i} className="pointer-events-none">
              <path d={d} stroke="#111827" strokeOpacity={0.35} strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <path d={d} stroke={color} strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          );
        }

        if (type === 'text') {
          if (textDraft?.index === i) return null; // se está editando en el campo de abajo
          const size = s.size ?? 1;
          const rot = s.rot ?? 0;
          const fs = TEXT_FONT * size;
          const label = s.text ?? '';
          // Caja aproximada (el SVG no mide texto sin tocar el DOM): alcanza
          // para el área de toque y el marco de selección.
          const hw = Math.max(8, label.length * fs * 0.3) + 3;
          const hh = fs * 0.75;
          const selected = selectedIndex === i;
          return (
            <g key={i}>
              <g
                className={`${pe} cursor-grab touch-none`}
                onPointerDown={(e) => handleHandlePointerDown(i, 'start', e)}
                onPointerMove={handleHandlePointerMove}
                onPointerUp={() => handleObjectPointerUp(i)}
                transform={`rotate(${rot} ${p1.x} ${p1.y})`}
              >
                <rect x={p1.x - hw} y={p1.y - hh} width={hw * 2} height={hh * 2} fill="transparent" />
                <text x={p1.x} y={p1.y} textAnchor="middle" dominantBaseline="central" fontSize={fs} fontWeight={800}
                  fill={color} stroke={s.color === 'black' ? '#f8fafc' : '#111827'} strokeWidth={fs * 0.22} strokeLinejoin="round" paintOrder="stroke"
                  style={{ userSelect: 'none' }}>
                  {label}
                </text>
              </g>
              {selected && (
                <g transform={`rotate(${rot} ${p1.x} ${p1.y})`}>
                  <rect x={p1.x - hw} y={p1.y - hh} width={hw * 2} height={hh * 2} rx={2} fill="none" stroke="#34d399" strokeWidth={1} strokeDasharray="3 2" className="pointer-events-none" />
                  <g className={`${pe} cursor-pointer`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDeleteShape(i); }}>
                    <circle cx={p1.x + hw + 4} cy={p1.y - hh - 4} r={4.6} fill="#dc2626" stroke="white" strokeWidth={1} />
                    <path d={`M ${p1.x + hw + 2} ${p1.y - hh - 6} l 4 4 M ${p1.x + hw + 6} ${p1.y - hh - 6} l -4 4`} stroke="white" strokeWidth={1.3} strokeLinecap="round" />
                  </g>
                </g>
              )}
            </g>
          );
        }

        if (isPointShape(type)) {
          if (hiddenIndexes.has(i)) return null; // balón real "en juego": lo reemplaza el fantasma
          const size = (s.size ?? 1) * pointScale(teamsCtx?.teams, type);
          const rot = s.rot ?? 0;
          const box = OBJECT_BOX[type];
          const hw = (box.w / 2 + 2) * size;
          const hh = (box.h / 2 + 2) * size;
          const selected = selectedIndex === i;
          return (
            <g key={i}>
              {/* El ícono ENTERO es el handle: arrastrar mueve, tocar selecciona.
                  El rect transparente es el área de toque real (gira con él). */}
              <g
                className={`${pe} cursor-grab touch-none`}
                onPointerDown={(e) => handleHandlePointerDown(i, 'start', e)}
                onPointerMove={handleHandlePointerMove}
                onPointerUp={() => handleObjectPointerUp(i)}
              >
                <ObjectIcon type={type} x={p1.x} y={p1.y} size={size} rot={rot} color={s.color} pinStyle={pinStyle}
                  override={teamsCtx && type === 'opponent' ? <RivalChip teams={teamsCtx.teams} slot={rivals?.get(i)} /> : undefined} />
                <rect x={p1.x - hw} y={p1.y - hh} width={hw * 2} height={hh * 2} fill="transparent" transform={`rotate(${rot} ${p1.x} ${p1.y})`} />
              </g>
              {selected && (
                <g transform={`rotate(${rot} ${p1.x} ${p1.y})`}>
                  <rect x={p1.x - hw} y={p1.y - hh} width={hw * 2} height={hh * 2} rx={2} fill="none" stroke="#34d399" strokeWidth={1} strokeDasharray="3 2" className="pointer-events-none" />
                  {/* Handle de giro: arrastrarlo alrededor del centro fija rot. */}
                  <line x1={p1.x} y1={p1.y - hh} x2={p1.x} y2={p1.y - hh - 9} stroke="#34d399" strokeWidth={1} className="pointer-events-none" />
                  <circle cx={p1.x} cy={p1.y - hh - 11} r={4.2} fill="#34d399" stroke="#064e3b" strokeWidth={1}
                    className={`${pe} cursor-grab touch-none`}
                    onPointerDown={(e) => handleRotatePointerDown(i, s, e)}
                    onPointerMove={handleRotatePointerMove}
                    onPointerUp={handleRotatePointerUp}
                  />
                  {/* Quitar: explícito, ya no es "tocar de nuevo". */}
                  <g className={`${pe} cursor-pointer`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDeleteShape(i); }}>
                    <circle cx={p1.x + hw + 4} cy={p1.y - hh - 4} r={4.6} fill="#dc2626" stroke="white" strokeWidth={1} />
                    <path d={`M ${p1.x + hw + 2} ${p1.y - hh - 6} l 4 4 M ${p1.x + hw + 6} ${p1.y - hh - 6} l -4 4`} stroke="white" strokeWidth={1.3} strokeLinecap="round" />
                  </g>
                </g>
              )}
            </g>
          );
        }

        if (type === 'ball_path') {
          const kind = s.kind ?? 'pase';
          const lofted = kind !== 'pase';
          const c = lofted ? curveControlPoint(p1, p2, BALL_PATH_BEND) : null;
          const d = c ? `M ${p1.x} ${p1.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}` : `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
          return (
            <g key={i}>
              <path d={d} stroke="transparent" strokeWidth={12} fill="none"
                className={`${pe} cursor-pointer`} onClick={(e) => { e.stopPropagation(); onDeleteShape(i); }} />
              {/* Sombra oscura debajo del trazo: legible sobre el verde con cualquier color. */}
              <path d={d} stroke="#111827" strokeOpacity={0.35} strokeWidth={3.6} fill="none" strokeLinecap="round" className="pointer-events-none" />
              <path d={d} stroke={color} strokeWidth={2} fill="none" strokeLinecap="round"
                strokeDasharray={lofted ? '2.5 3.5' : '5 3'}
                markerEnd={kind === 'pase' ? `url(#arrowhead-${s.color ?? 'white'})` : undefined}
                className="pointer-events-none" />
              <g transform={`translate(${p1.x} ${p1.y})`} className="pointer-events-none"><BallGlyph r={3.6} /></g>
              {lofted && (
                <g className="pointer-events-none">
                  <circle cx={p2.x} cy={p2.y} r={4.5} fill="none" stroke={color} strokeWidth={1.6} />
                  <circle cx={p2.x} cy={p2.y} r={1.3} fill={color} />
                  {kind === 'penal' && (
                    <text x={p2.x} y={p2.y - 7} textAnchor="middle" fontSize={7} fontWeight={800} fill={color} stroke="#111827" strokeWidth={0.5} paintOrder="stroke">P</text>
                  )}
                </g>
              )}
              {renderEndHandles(i, p1, p2, color)}
            </g>
          );
        }

        return (
          <g key={i}>
            {type === 'zone' ? (
              <>
                {/* El relleno NO captura toques: una zona grande tapaba a los
                    jugadores de abajo (tocarla la borraba y no se podía
                    arrastrar al jugador cubierto). Solo el borde es tocable,
                    con un trazo ancho invisible para que sea fácil de acertar. */}
                <rect
                  x={Math.min(p1.x, p2.x)} y={Math.min(p1.y, p2.y)}
                  width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)}
                  rx={5} fill={color} fillOpacity={0.14} stroke={color} strokeOpacity={0.7} strokeWidth={1.2}
                  className="pointer-events-none"
                />
                <rect
                  x={Math.min(p1.x, p2.x)} y={Math.min(p1.y, p2.y)}
                  width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)}
                  rx={5} fill="none" stroke="transparent" strokeWidth={12}
                  pointerEvents={pe === 'pointer-events-auto' ? 'stroke' : 'none'}
                  className="cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); onDeleteShape(i); }}
                />
              </>
            ) : type === 'curve' ? (() => {
              const c = curveControlPoint(p1, p2);
              return (
                <>
                  {/* Trazo ancho invisible = área de click más generosa para
                      borrar, sin engordar la línea que se ve. */}
                  <path d={`M ${p1.x} ${p1.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`} stroke="transparent" strokeWidth={12} fill="none"
                    className={`${pe} cursor-pointer`} onClick={(e) => { e.stopPropagation(); onDeleteShape(i); }} />
                  <path d={`M ${p1.x} ${p1.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`} stroke={color} strokeWidth={2} fill="none"
                    strokeLinecap="round" markerEnd={`url(#arrowhead-${s.color ?? 'white'})`} className="pointer-events-none" />
                </>
              );
            })() : (
              <>
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={12}
                  className={`${pe} cursor-pointer`} onClick={(e) => { e.stopPropagation(); onDeleteShape(i); }} />
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={color} strokeWidth={2} strokeLinecap="round"
                  markerEnd={`url(#arrowhead-${s.color ?? 'white'})`} className="pointer-events-none" />
              </>
            )}
            {renderEndHandles(i, p1, p2, color)}
          </g>
        );
      })}

      {preview && (() => {
        const p1 = toSvg(preview.start);
        const p2 = toSvg(preview.current);
        const c = ARROW_COLOR_HEX[drawColor];
        if ((drawShapeType === 'arrow' || drawShapeType === 'curve') && drawOptions?.lineStyle) {
          return <StyledLinePreview start={preview.start} current={preview.current} type={drawShapeType} style={drawOptions.lineStyle} />;
        }
        if (drawShapeType === 'zone' && drawOptions?.zoneForm === 'ellipse') {
          return (
            <ellipse cx={(p1.x + p2.x) / 2} cy={(p1.y + p2.y) / 2} rx={Math.abs(p2.x - p1.x) / 2} ry={Math.abs(p2.y - p1.y) / 2}
              fill={c} fillOpacity={0.15} stroke={c} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="5 4" />
          );
        }
        if (drawShapeType === 'zone') {
          return (
            <rect
              x={Math.min(p1.x, p2.x)} y={Math.min(p1.y, p2.y)}
              width={Math.abs(p2.x - p1.x)} height={Math.abs(p2.y - p1.y)}
              rx={6} fill={c} fillOpacity={0.15} stroke={c} strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="5 4"
            />
          );
        }
        if (drawShapeType === 'curve') {
          const cp = curveControlPoint(p1, p2);
          return <path d={`M ${p1.x} ${p1.y} Q ${cp.x} ${cp.y} ${p2.x} ${p2.y}`} stroke="#f8fafc" strokeOpacity={0.7} strokeWidth={2} fill="none" strokeDasharray="5 4" strokeLinecap="round" />;
        }
        if (drawShapeType === 'ball_path') {
          const lofted = ballKind !== 'pase';
          const cp = lofted ? curveControlPoint(p1, p2, BALL_PATH_BEND) : null;
          const d = cp ? `M ${p1.x} ${p1.y} Q ${cp.x} ${cp.y} ${p2.x} ${p2.y}` : `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
          return (
            <>
              <path d={d} stroke="#f8fafc" strokeOpacity={0.7} strokeWidth={2} fill="none" strokeDasharray="3 3" strokeLinecap="round" />
              <g transform={`translate(${p1.x} ${p1.y})`}><BallGlyph r={3.6} /></g>
            </>
          );
        }
        return <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#f8fafc" strokeOpacity={0.7} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" />;
      })()}

      {/* M6d: número de cada movimiento y polígono en construcción. */}
      {shapes.map((s, i) => (typeof s.seq === 'number' ? <SeqOverlay key={`seq${i}`} shape={s} /> : null))}
      {polygonDraft && <PolygonDraftView points={polygonDraft.points} cursor={polygonDraft.cursor} color={ARROW_COLOR_HEX[drawColor]} />}
      {stroke && stroke.length > 0 && (
        <path d={smoothPathD(stroke.map(toSvg))} stroke={ARROW_COLOR_HEX[drawColor]} strokeWidth={2.2} fill="none"
          strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none" />
      )}
      {eraserAt && (() => {
        const c = toSvg(eraserAt);
        return <ellipse cx={c.x} cy={c.y} rx={ERASER_RADIUS * 3} ry={ERASER_RADIUS * 3.4} fill="#ffffff" fillOpacity={0.15} stroke="#ffffff" strokeOpacity={0.8} strokeWidth={1} strokeDasharray="2 2" className="pointer-events-none" />;
      })()}

      {/* Balones fantasma de "Reproducir jugada": recorren cada ball_path.
          Elevados (remate/penal) crecen y proyectan sombra. Encima de todo. */}
      {ghostBalls?.map((b, i) => {
        const p = toSvg(b);
        return (
          <g key={`gb${i}`} className="pointer-events-none">
            {b.scale > 1.05 && (
              <ellipse cx={p.x} cy={p.y + 6 * b.scale} rx={4.5} ry={1.8} fill="#000" opacity={0.35 / b.scale} />
            )}
            <g transform={`translate(${p.x} ${p.y}) scale(${b.scale})`}><BallGlyph r={5} /></g>
          </g>
        );
      })}

      {/* Regla de medir (no se guarda con la plantilla -- es una consulta
          puntual). Los puntos se arrastran para ajustar la medición sin
          reiniciarla, y tocar la línea la borra. */}
      {measurePoints.length === 2 && measureDistanceM !== null && (() => {
        const a = toSvg(measurePoints[0]);
        const b = toSvg(measurePoints[1]);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        return (
          <>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={12}
              className="pointer-events-auto cursor-pointer" onClick={(e) => { e.stopPropagation(); setMeasurePoints([]); }} />
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#facc15" strokeWidth={1.25} strokeDasharray="4 3" className="pointer-events-none" />
            <rect x={mid.x - 22} y={mid.y - 9} width={44} height={16} rx={4} fill="#111827" fillOpacity={0.9} className="pointer-events-none" />
            <text x={mid.x} y={mid.y + 1.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#facc15" className="pointer-events-none">
              ~{measureDistanceM.toFixed(1)}m
            </text>
          </>
        );
      })()}
      {measurePoints.map((p, i) => {
        const svgP = toSvg(p);
        return (
          <circle
            key={i} cx={svgP.x} cy={svgP.y} r={2.6} fill="#facc15" stroke="#78350f" strokeWidth={1}
            className="pointer-events-auto cursor-grab touch-none"
            onPointerDown={(e) => handleMeasurePointerDown(i as 0 | 1, e)}
            onPointerMove={handleMeasurePointerMove}
            onPointerUp={handleMeasurePointerUp}
          />
        );
      })}
    </svg>
    {/* Campo de texto sobre la cancha, centrado donde se tocó. HTML y no
        <foreignObject>: el input dentro de un SVG escalado se comporta mal en
        Safari de iOS (teclado y cursor fuera de lugar). */}
    {textDraft && (
      <input
        ref={textInputRef}
        value={textDraft.value}
        maxLength={TEXT_MAX_LENGTH}
        placeholder="Escribe…"
        aria-label="Texto sobre la cancha"
        onChange={(e) => setTextDraft((d) => (d ? { ...d, value: e.target.value } : d))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitTextDraft(); }
          if (e.key === 'Escape') { e.preventDefault(); textDraftRef.current = null; setTextDraft(null); }
        }}
        onBlur={commitTextDraft}
        className="absolute z-50 -translate-x-1/2 -translate-y-1/2 max-w-[80%] rounded-md border-2 border-emerald-400 bg-black/80 px-2 py-1 text-center text-sm font-bold placeholder:text-white/70 outline-none"
        style={{
          left: `${textDraft.x}%`,
          top: `${yToView(textDraft.y, view)}%`,
          color: ARROW_COLOR_HEX[drawColor],
          width: `${Math.max(7, textDraft.value.length * 0.6 + 2)}rem`,
        }}
      />
    )}
    </>
  );
}
/** Ficha de jugador en la cancha: disco de videojuego (número de camiseta o
 *  iniciales, foto si hay) o silueta genérica por posición (arquero en
 *  amarillo, resto en verde; NUNCA la foto -- es una figura, no la persona),
 *  con etiqueta flotante debajo. */
/** Ficha proporcional a la cancha: --pin-k lo fija el contenedor de la cancha
 *  (ver pinK en TacticalBoard). `zoom` escala también el layout, así el área de
 *  toque y la separación entre ficha y etiqueta encogen juntas. */
const PIN_ZOOM = { zoom: 'var(--pin-k, 1)' } as CSSProperties;

function PitchPin({ subject, slot, onLabelChange, onRemove, onOpenCard, events, animate, pinStyle, showPhotos, readOnly, view }: {
  subject: RosterSubject;
  slot: PlacedSlot;
  onLabelChange: (label: string) => void;
  onRemove: () => void;
  onOpenCard: () => void;
  events?: { goals: number; assists: number };
  /** true durante "Reproducir jugada" o al aplicar una plantilla sobre
   *  jugadores ya puestos -- el cambio de left/top se anima en vez de
   *  saltar de golpe. Fuera de esos momentos NO se anima (arrastrar se
   *  sentiría con retraso si el transition estuviera siempre activo). */
  animate?: boolean;
  pinStyle: PinStyle;
  /** Foto del jugador en el disco: opt-in (ver PIN_PHOTOS_KEY). */
  showPhotos: boolean;
  /** Solo lectura: no se arrastra, no se quita, no se edita la etiqueta. */
  readOnly?: boolean;
  view: PitchView;
}) {
  const key = subjectKey(subject.subject_type, subject.subject_id);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `pitch:${key}`,
    data: { subject },
    disabled: readOnly,
  });
  const [editing, setEditing] = useState(false);
  // Esc descarta lo escrito en la etiqueta (sin esto el blur lo guardaba igual).
  const cancelLabelEdit = useRef(false);
  // `imgError` cubre el caso de una avatar_url rota (404, bucket privado,
  // etc.): cae de vuelta al disco de siempre en vez de dejar un ícono roto.
  const [imgError, setImgError] = useState(false);
  const displayNumber = slot.jersey_number !== '' ? String(slot.jersey_number) : null;
  const hasPhoto = showPhotos && !!subject.avatar_url && !imgError;
  const topPct = yToView(slot.y, view);
  // Fuera de la ventana visible (zoom al área): se oculta, no se desmonta,
  // para que useDraggable siga registrado y la posición guardada no cambie.
  const hidden = topPct < -1 || topPct > 101;
  const isGK = isGoalkeeperLabel(slot.slot_label);
  // M6b: con «Configuración de los equipos» la ficha y lo de abajo salen de ahí.
  const teams = useTeamsConfig();
  const teamSubject = { number: displayNumber, name: subject.full_name, position: slot.slot_label };
  const teamCaption = teams ? chipCaption(teams.home, teamSubject) : null;

  // P2c: goles/asistencias de este partido, de un vistazo.
  const eventsBadge = events && (events.goals > 0 || events.assists > 0) ? (
    <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 flex gap-0.5 whitespace-nowrap">
      {events.goals > 0 && (
        <span className="text-[9px] bg-zinc-950 rounded-full px-1 ring-1 ring-white/30">⚽{events.goals > 1 ? `×${events.goals}` : ''}</span>
      )}
      {events.assists > 0 && (
        <span className="text-[9px] bg-zinc-950 rounded-full px-1 ring-1 ring-white/30">🅰️{events.assists > 1 ? `×${events.assists}` : ''}</span>
      )}
    </div>
  ) : null;

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'absolute',
        left: `${slot.x}%`,
        top: `${topPct}%`,
        transform: `translate(-50%, -50%) ${transform ? CSS.Translate.toString(transform) : ''}`,
        transition: animate ? 'left 1.3s ease-in-out, top 1.3s ease-in-out' : undefined,
        zIndex: isDragging ? 30 : 10,
        display: hidden ? 'none' : undefined,
      }}
      className="flex flex-col items-center gap-1 touch-none"
    >
      {!readOnly && <button
        type="button"
        onClick={onRemove}
        // 20 px en cancha grande, ~17 px en chica (no crece con el zoom de la ficha:
        // sigue siendo tocable).
        style={{ width: 'calc(14px + 6px * var(--pin-k, 1))', height: 'calc(14px + 6px * var(--pin-k, 1))' }}
        className="absolute -top-2 -right-2 z-10 rounded-full bg-red-600 text-white flex items-center justify-center shadow-lg ring-2 ring-zinc-950/80"
        aria-label={`Quitar a ${subject.full_name} de la cancha`}
      >
        <X className="h-3 w-3" />
      </button>}
      {/* El handle de arrastre cubre figura + etiqueta juntos. El botón X
          queda AFUERA de este div a propósito, para que nunca compita con el drag. */}
      <div style={PIN_ZOOM} className="flex flex-col items-center">
      <div
        {...listeners}
        {...attributes}
        className="flex flex-col items-center gap-1 touch-none cursor-grab active:cursor-grabbing"
      >
        {teams ? (
          <TeamPinVisual teams={teams} isGK={isGK} subject={teamSubject} dragging={isDragging} onClick={onOpenCard}>
            {eventsBadge}
          </TeamPinVisual>
        ) : pinStyle === 'silhouette' ? (
          <div
            onClick={(e) => { e.stopPropagation(); onOpenCard(); }}
            className={`relative h-12 w-11 cursor-pointer transition-transform drop-shadow-[0_3px_8px_rgba(0,0,0,0.65)] ${isDragging ? 'scale-110' : ''}`}
          >
            <svg viewBox="0 0 40 44" className="h-full w-full overflow-visible" aria-hidden="true">
              <SilhouetteGlyph jersey={isGK ? '#facc15' : '#10b981'} accent="#0f172a" number={displayNumber ?? initialsOf(subject.full_name)} />
            </svg>
            {eventsBadge}
          </div>
        ) : (
          <div
            onClick={(e) => { e.stopPropagation(); onOpenCard(); }}
            className={`relative h-11 w-11 rounded-full overflow-hidden flex items-center justify-center font-black text-sm text-white cursor-pointer
              ${hasPhoto ? 'bg-zinc-800' : 'bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700'}
              shadow-[0_3px_12px_rgba(0,0,0,0.55)] ring-2 transition-transform
              ${isDragging ? 'ring-white scale-110' : 'ring-white/80'}`}
          >
            {hasPhoto ? (
              <img
                src={subject.avatar_url ?? undefined}
                alt={subject.full_name}
                className="absolute inset-0 h-full w-full object-cover"
                onError={() => setImgError(true)}
              />
            ) : (
              displayNumber ?? initialsOf(subject.full_name)
            )}
            {/* Con foto, el número pasa a insignia de esquina (estilo FC/PES)
                en vez de superpuesto sobre la cara del jugador. */}
            {hasPhoto && displayNumber && (
              <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-zinc-950 ring-1 ring-white/70 text-[8px] font-black flex items-center justify-center">
                {displayNumber}
              </span>
            )}
            {eventsBadge}
          </div>
        )}
        {editing ? (
          // En pantallas táctiles la fuente tiene que ser >=16px: con menos, iOS
          // Safari hace zoom a la página al enfocar el campo y la cancha se
          // desacomoda. Con mouse queda compacto como siempre.
          <Input
            autoFocus
            defaultValue={slot.slot_label}
            className="h-5 w-20 text-[10px] px-1 py-0 text-center bg-white/95 text-black [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-28 [@media(pointer:coarse)]:text-[16px]"
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              if (cancelLabelEdit.current) { cancelLabelEdit.current = false; setEditing(false); return; }
              onLabelChange(e.target.value.trim() || slot.slot_label);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { e.stopPropagation(); cancelLabelEdit.current = true; (e.target as HTMLInputElement).blur(); }
            }}
          />
        ) : teamCaption === '' ? null : (
          <span
            onClick={() => { if (!readOnly) setEditing(true); }}
            className="text-[10px] font-bold text-white bg-black/55 backdrop-blur-sm rounded-full px-2 py-0.5 leading-tight max-w-[84px] truncate cursor-text shadow"
          >
            {teamCaption ?? slot.slot_label}
          </span>
        )}
        <PinNameTag name={subject.full_name} />
      </div>
      </div>
    </div>
  );
}
// ─── Animación por cuadros (T1, docs/specs/pizarra-nivel-tacticalpad.md) ────

/** Cuadro vacío: el cuadro que se está editando se arma en vivo con
 *  `placed` + `arrows` (ver liveFrames), así que solo aporta id y duración. */
const blankFrame = (): TacticalFrame => ({ id: newFrameId(), duration_ms: DEFAULT_FRAME_MS, players: [], ball: null, arrows: [] });

/** Posiciones de un cuadro → `placed`, con etiqueta/dorsal del jugador sacados
 *  de la primera fuente que lo conozca (la etiqueta es del jugador, no del
 *  cuadro: no se recalcula al cambiar de cuadro). */
function placedFromFrame(frame: TacticalFrame, ...metaSources: Record<string, PlacedSlot>[]): Record<string, PlacedSlot> {
  const next: Record<string, PlacedSlot> = {};
  for (const p of frame.players) {
    const meta = metaSources.map((m) => m[p.key]).find(Boolean);
    next[p.key] = {
      x: p.x, y: p.y,
      slot_label: meta?.slot_label ?? suggestLabel(p.y),
      labelIsCustom: meta?.labelIsCustom ?? false,
      jersey_number: meta?.jersey_number ?? '',
    };
  }
  return next;
}

/** Cuadros de una jugada de Mis jugadas (claves = índice de slot) → claves de
 *  los jugadores que la cargaron. Se empareja igual que applyPresetSlots
 *  (mismo greedyNearestMatch sobre los mismos puntos) para que el jugador que
 *  ocupa el slot i en el cuadro 1 sea el que se mueve en los demás. Los que no
 *  ocuparon ningún slot se quedan quietos donde estaban. */
function mapPresetFrames(
  presetFrames: TacticalFrame[],
  before: Record<string, PlacedSlot>,
  after: Record<string, PlacedSlot>,
  slots: { x: number | string; y: number | string }[],
): TacticalFrame[] {
  const entries = Object.entries(before).map(([key, s]) => ({ key, x: s.x, y: s.y }));
  const indexed = slots.map((s, i) => ({ i, x: Number(s.x), y: Number(s.y) }));
  const slotToKey = new Map<number, string>();
  if (entries.length > 0) for (const m of greedyNearestMatch(entries, indexed)) slotToKey.set(m.to.i, m.from.key);
  const mapped = new Set(slotToKey.values());
  const extras = Object.entries(after).filter(([k]) => !mapped.has(k)).map(([key, s]) => ({ key, x: s.x, y: s.y }));
  return presetFrames.map((f) => ({
    ...remapBallOwner(f, (k) => { const i = presetSlotIndex(k); return i === null ? undefined : slotToKey.get(i); }),
    players: [
      ...f.players.flatMap((p) => {
        const idx = presetSlotIndex(p.key);
        const key = idx === null ? undefined : slotToKey.get(idx);
        return key ? [{ key, x: p.x, y: p.y }] : [];
      }),
      ...extras,
    ],
  }));
}

/** Foto del tablero para deshacer/rehacer: todos los cuadros (el actual ya
 *  armado en vivo), cuál está abierto y las etiquetas/dorsales de la cancha. */
interface BoardSnapshot { frames: TacticalFrame[]; frameIndex: number; placed: Record<string, PlacedSlot> }
/** Un arrastre manda decenas de cambios: se agrupan en un solo paso de
 *  deshacer cuando la cancha queda quieta este tiempo. */
const HISTORY_SETTLE_MS = 350;
const snapshotKey = (s: BoardSnapshot) => JSON.stringify([s.frames, s.frameIndex, s.placed]);

const NO_INDEXES: ReadonlySet<number> = new Set();
const noop = () => {};

/** Ficha liviana de la reproducción por cuadros: el mismo aspecto que
 *  PitchPin, sin drag ni edición (se re-renderiza a 60 fps). */
function PlaybackPin({ subject, meta, x, top, opacity, pinStyle, showPhotos }: {
  subject: RosterSubject;
  meta: PlacedSlot | undefined;
  x: number;
  top: number;
  opacity: number;
  pinStyle: PinStyle;
  showPhotos: boolean;
}) {
  const number = meta && meta.jersey_number !== '' ? String(meta.jersey_number) : null;
  const label = meta?.slot_label ?? '';
  const photo = showPhotos && pinStyle === 'disc' ? subject.avatar_url : null;
  const teams = useTeamsConfig();
  const teamSubject = { number, name: subject.full_name, position: label };
  const caption = teams ? chipCaption(teams.home, teamSubject) : label;
  return (
    <div
      style={{ position: 'absolute', left: `${x}%`, top: `${top}%`, transform: 'translate(-50%, -50%)', opacity, zIndex: 10 }}
      className="flex flex-col items-center gap-1"
    >
      <div style={PIN_ZOOM} className="flex flex-col items-center gap-1">
      {teams ? (
        <TeamPinVisual teams={teams} isGK={isGoalkeeperLabel(label)} subject={teamSubject} />
      ) : pinStyle === 'silhouette' ? (
        <div className="relative h-12 w-11 drop-shadow-[0_3px_8px_rgba(0,0,0,0.65)]">
          <svg viewBox="0 0 40 44" className="h-full w-full overflow-visible" aria-hidden="true">
            <SilhouetteGlyph jersey={isGoalkeeperLabel(label) ? '#facc15' : '#10b981'} accent="#0f172a" number={number ?? initialsOf(subject.full_name)} />
          </svg>
        </div>
      ) : (
        <div className={`relative h-11 w-11 rounded-full overflow-hidden flex items-center justify-center font-black text-sm text-white ring-2 ring-white/80 shadow-[0_3px_12px_rgba(0,0,0,0.55)] ${photo ? 'bg-zinc-800' : 'bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700'}`}>
          {photo ? <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover" /> : (number ?? initialsOf(subject.full_name))}
        </div>
      )}
      {caption && (
        <span className="text-[10px] font-bold text-white bg-black/55 rounded-full px-2 py-0.5 leading-tight max-w-[84px] truncate shadow">
          {caption}
        </span>
      )}
      <PinNameTag name={subject.full_name} />
      </div>
    </div>
  );
}

/** Roles que pueden MODIFICAR el tablero: espejo de TACTICAL_EDIT_ROLES del BFF
 *  y de user_tactical_edit_school_ids() en la base. Admin/staff pueden verlo,
 *  pero guardar les devolvía 403 después de armar todo -- ahora entran en modo
 *  lectura y se enteran desde el principio. */
const TACTICAL_EDIT_ROLES = ['owner', 'coach', 'super_admin'];

export function TacticalBoard({ open, onClose, teamId, teamName, sourceType, sourceId, contextLabel, mode = 'edit', sport: sportProp, scratch = false }: TacticalBoardProps) {
  const { toast } = useToast();
  const { currentUserRole, schoolId: activeSchoolId, schoolBranding } = useSchoolContext();
  // T4: el deporte del equipo manda la cancha. Quien abre puede pasarlo; si
  // no, se resuelve del equipo (teams.sport) — fútbol 11 por defecto.
  const teamSport = useTeamTacticalSport(teamId, { enabled: open });
  const sport: TacticalSport = sportProp ?? teamSport.sport;
  const sportCfg = useMemo(() => boardSportConfig(sport), [sport]);
  const loadingSport = !sportProp && teamSport.isLoading;
  // T0: la métrica va a la escuela del EQUIPO (fallback: la escuela activa).
  const metricSchoolId = teamSport.schoolId ?? activeSchoolId ?? null;
  // Marca de agua de PNG/PDF/video (siempre, salvo marca blanca) y logo del
  // club SOLO si el tier de la escuela incluye la marca propia
  // (school_has_branding_feature: permiso por plan, no school_shows_own_brand).
  // Se resuelve al exportar (lib/export/tacticalBrandingApi.ts) y se guarda.
  const brandingRef = useRef<{ key: string; value: Promise<ExportBranding> } | null>(null);
  const exportBranding = useCallback((): Promise<ExportBranding> => {
    // El logo del contexto es el de la escuela ACTIVA: solo si es la del equipo.
    const logoUrl = metricSchoolId && metricSchoolId === activeSchoolId ? schoolBranding?.logo_url : null;
    const setting = metricSchoolId === activeSchoolId ? schoolBranding?.branding_settings?.show_sportmaps_watermark : null;
    const key = `${metricSchoolId}|${logoUrl ?? ''}|${String(setting)}`;
    if (brandingRef.current?.key !== key) {
      brandingRef.current = {
        key,
        value: import('@/lib/export/tacticalBrandingApi')
          .then((m) => m.fetchExportBranding({ schoolId: metricSchoolId, logoUrl, showWatermarkSetting: setting }))
          .catch(() => ({ watermark: true, clubLogoUrl: null })),
      };
    }
    return brandingRef.current.value;
  }, [metricSchoolId, activeSchoolId, schoolBranding]);
  const logEvent = useCallback((event: TacticalBoardEvent, source: string = sourceType) => {
    logTacticalEvent({ schoolId: metricSchoolId, event, teamId, sourceType: source, sport });
  }, [metricSchoolId, teamId, sourceType, sport]);
  /** El ROL puede modificar el tablero (espejo del BFF). */
  const roleCanEdit = TACTICAL_EDIT_ROLES.includes(currentUserRole || '');
  // Modo ver/editar: arranca en el que pida quien abre y se reinicia cada vez
  // que el tablero se abre; 'Editar' lo pasa a edición sin cerrar.
  const [boardMode, setBoardMode] = useState<'edit' | 'view'>(mode);
  useEffect(() => { if (open) setBoardMode(mode); }, [open, mode]);
  /** Se puede editar AHORA: rol con permiso y tablero en modo edición. Todas
   *  las guardas de edición de abajo usan esto, así el modo ver no necesita
   *  un camino aparte. */
  const canEdit = roleCanEdit && boardMode === 'edit';
  const viewing = !canEdit;
  // M3 «Analizar jugada» con IA: acá solo el montaje (botón + panel + capa);
  // la lógica vive en TacticalAiPanel.tsx y lib/school/tacticalAi.ts.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPreview, setAiPreview] = useState<AiPreview | null>(null);
  useEffect(() => { if (!open) { setAiOpen(false); setAiPreview(null); } }, [open]);
  // M6c: notas + videos de la jugada (usePlayMedia) y sus diálogos.
  const media = usePlayMedia();
  const [mediaDialog, setMediaDialog] = useState<MediaDialog>(null);
  const [presetTag, setPresetTag] = useState<string | null>(null);
  useEffect(() => { if (!open) setMediaDialog(null); }, [open]);
  const { data: roster, isLoading: loadingRoster } = useTeamPerformanceRoster({ team_id: teamId });
  // Pizarra libre: no hay alineación que cargar (la consulta queda apagada).
  const { data: existingList, isLoading: loadingList } = useFootballLineups(scratch ? {} : { source_type: sourceType, source_id: sourceId });
  const existingLineupId = existingList?.[0]?.id;
  const { data: existingLineup, isLoading: loadingLineup } = useFootballLineup(existingLineupId);
  const saveLineup = useSaveFootballLineup();
  // M6b: configuración de los equipos de ESTA jugada (null = aspecto de siempre).
  const teamsCtl = useBoardTeams();
  const teamsCtxValue = useMemo(
    () => (teamsCtl.teams ? { teams: teamsCtl.teams, hasGoalkeeper: sportDef(sport).hasGoalkeeper } : null),
    [teamsCtl.teams, sport],
  );

  // P2c: eventos de ESTE partido, para resaltar goles/asistencias en la
  // cancha. Un entrenamiento no tiene eventos (no es 'team_match' ni
  // 'tournament_match'), así que ahí simplemente no se pide nada.
  const isMatchContext = sourceType === 'team_match' || sourceType === 'tournament_match';
  const { data: matchEvents } = useFootballEvents(
    isMatchContext ? { source_type: sourceType as EventSourceType, source_id: sourceId } : {},
  );

  // P4: sugerencia de XI, a partir de minutos jugados en la temporada.
  const { data: seasonStats } = useFootballSeasonStats(teamId);

  const pitchRef = useRef<HTMLDivElement>(null);
  // Espacio REAL que le queda a la cancha (caja de contenido del área, sin
  // padding). Antes se restaba a ojo el alto del toolbar ("100vh - 90px") y en
  // celular, con el toolbar en 3 filas, safe-area y la hoja inferior, la
  // cancha se salía y quedaba cortada arriba y abajo.
  // Callback ref (no useEffect): el área se monta recién cuando termina de
  // cargar el roster, y así el observer nace y muere con el nodo.
  const [pitchArea, setPitchArea] = useState<{ w: number; h: number } | null>(null);
  const pitchAreaObserver = useRef<ResizeObserver | null>(null);
  const pitchAreaRef = useCallback((el: HTMLDivElement | null) => {
    pitchAreaObserver.current?.disconnect();
    pitchAreaObserver.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setPitchArea((prev) => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    });
    ro.observe(el);
    pitchAreaObserver.current = ro;
  }, []);
  const [placed, setPlaced] = useState<Record<string, PlacedSlot>>({});
  const [benchKeys, setBenchKeys] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  // Plantillas guardadas (P2a/P2b) -- ver docs/plan-p2-estrategias-guardadas.md
  const [situation, setSituation] = useState<TacticalSituation>('ataque');
  const [emptySlots, setEmptySlots] = useState<EmptySlot[]>([]);
  const [savingName, setSavingName] = useState<string | null>(null);
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  // Confirmación de acciones que descartan trabajo (cargar plantilla sobre
  // dibujos, cambiar de situación, borrar todo, eliminar plantilla). Un solo
  // diálogo para todas: la acción pendiente vive acá hasta que se confirma.
  const [confirmAction, setConfirmAction] = useState<{
    title: string; description: string; confirmLabel: string; onConfirm: () => void;
  } | null>(null);
  const { data: presets } = useTacticalPresets({ team_id: teamId, situation });
  const createPreset = useCreateTacticalPreset();
  const updatePreset = useUpdateTacticalPreset();
  const deletePreset = useDeleteTacticalPreset();
  const [showZones, setShowZones] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);

  // Modo pizarra (P2d) -- flechas/curvas/zonas, viajan con la plantilla
  // guardada (D8 extendido: mismo mecanismo de "Guardar como plantilla").
  const [tacticsOpen, setTacticsOpen] = useState(false);
  // Celular (<768px): Pizarra y Plantilla salen como hoja inferior debajo de
  // la cancha, no al costado (un panel de 220-260px al lado de una cancha en
  // 390px de ancho no cabe). Solo una hoja abierta a la vez.
  // Celular girado: 926 px de ancho pasan el umbral de escritorio pero hay ~400 px
  // de alto. Se trata como celular (mismos menús y hojas que en vertical, que son
  // los que se probaron en el iPhone) pero con el panel al costado, no abajo.
  const isPortraitPhone = useIsMobile();
  const landscapePhone = useCompactLandscape();
  const isMobile = isPortraitPhone || landscapePhone;
  // M6g: Ajustes de la pizarra del coach (curva, rastros, posesión, nombres, tema, pantalla completa).
  const prefs = useTacticalBoardPrefs(open);
  /** Pestaña de la hoja (celular) donde vive cada herramienta. */
  const tabOfTool = (t: DrawTool): MobileTab =>
    t === 'freehand' || t === 'text' || t === 'eraser' ? 'escribir'
      : t === 'arrow' || t === 'curve' || t === 'zone' || t === 'ball_path' ? 'lineas'
      : 'material';
  /** «Dibujar» abre el panel CON el modo dibujo prendido: antes había que tocar
   *  además «Activar dibujo». Al cerrarlo se apaga, para volver a arrastrar
   *  jugadores. */
  function toggleTactics() {
    const next = !tacticsOpen;
    setTacticsOpen(next);
    setDrawMode(next);
    if (next) {
      setMeasureMode(false);
      setMobileTab(tabOfTool(drawShapeType));
      setSheetCollapsed(false);
    } else {
      polygon.cancel();
    }
    if (isMobile) setRosterOpen(false);
  }
  // Celular vertical: la hoja de herramientas se pliega a una fila (las
  // pestañas) para que la cancha no se encoja mientras se dibuja.
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  // Hoja de la pizarra en celular: una pestaña a la vez (todo apilado no
  // entraba en 42vh y las acciones quedaban fuera de vista).
  const [mobileTab, setMobileTab] = useState<MobileTab>('escribir');
  /** Clase de una sección del panel: en celular solo se ve la de la pestaña
   *  (y ninguna con la hoja plegada). */
  const tabCls = (k: MobileTab) => (isMobile && (mobileTab !== k || (isPortraitPhone && sheetCollapsed)) ? 'hidden' : '');
  function toggleRoster() {
    setRosterOpen((v) => !v);
    if (isMobile) setTacticsOpen(false);
  }
  const [drawMode, setDrawMode] = useState(false);
  const [drawShapeType, setDrawShapeType] = useState<DrawTool>('arrow');
  const [arrows, setArrows] = useState<TacticalArrow[]>([]);

  // ── Animación por cuadros (T1) ──────────────────────────────────────────
  // `frames` guarda todos los cuadros; el que se está editando (frameIndex)
  // vive en `placed` + `arrows` como siempre — así arrastrar, dibujar,
  // formaciones y "Reproducir jugada" no cambian —, y `liveFrames` lo arma en
  // vivo. Cambiar de cuadro primero guarda el actual en `frames`.
  const [frames, setFrames] = useState<TacticalFrame[]>(() => [blankFrame()]);
  const [frameIndex, setFrameIndex] = useState(0);
  // Etiqueta/dorsal más reciente de cada jugador que pasó por la cancha (un
  // jugador puede no estar en el cuadro abierto y volver en otro).
  const metaRef = useRef<Record<string, PlacedSlot>>({});
  useEffect(() => { Object.assign(metaRef.current, placed); }, [placed]);
  const liveFrames = useMemo(() => {
    const cur = frames[frameIndex] ?? frames[0];
    const live: TacticalFrame = {
      ...cur,
      players: Object.entries(placed).map(([key, s]) => ({ key, x: s.x, y: s.y })),
      arrows,
    };
    return frames.map((f, i) => (i === frameIndex ? live : f));
  }, [frames, frameIndex, placed, arrows]);
  // M6g: con dueño del balón en el cuadro abierto, la figura balón va pegada
  // a sus pies (al elegirlo y al arrastrarlo), igual que en la reproducción.
  const openBallOwner = frames[frameIndex]?.ball_owner ?? null;
  const openOwnerSlot = openBallOwner ? placed[openBallOwner] : undefined;
  useEffect(() => {
    if (!openOwnerSlot) return;
    const at = ballAtFeet(openOwnerSlot);
    setArrows((list) => placeBallShape(list, at));
  }, [openOwnerSlot]);

  // Reproducción por cuadros: el tiempo vive en un reloj observable (solo se
  // re-renderizan la capa de reproducción y la barra, no el tablero) y los
  // cuadros se congelan al darle play. Mientras se reproduce o está en pausa,
  // la capa de reproducción reemplaza a los pines y a los dibujos: no se edita.
  const clock = useMemo(() => createPlaybackClock(), []);
  const [playState, setPlayState] = useState<PlayState>('stopped');
  const [playbackFrames, setPlaybackFrames] = useState<TacticalFrame[] | null>(null);
  const [playSpeed, setPlaySpeed] = useState<PlaybackSpeed>(1);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const framePlaybackActive = playState !== 'stopped' && !!playbackFrames;
  useEffect(() => {
    if (playState !== 'playing' || !playbackFrames) return;
    const total = totalDurationMs(playbackFrames);
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const r = advancePlayback(clock.get(), now - last, playSpeed, total, loopPlayback);
      last = now;
      clock.set(r.t);
      if (r.ended) { setPlayState('paused'); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playState, playbackFrames, playSpeed, loopPlayback, clock]);
  const [drawColor, setDrawColor] = useState<TacticalArrowColor>('white');
  // M6d: estilo de línea, forma de zona, numeración, foco y polígono en curso.
  const snapTargets = useMemo(() => Object.values(placed).map((p) => ({ x: p.x, y: p.y })), [placed]);
  const drawTools = useTacticalDrawTools(snapTargets);
  const polygon = usePolygonDraft(handleCreateShape, drawColor);
  // Recorridos de balón (pase/remate/penal) y material con tamaño y giro.
  const [ballKind, setBallKind] = useState<BallPathKind>('pase');
  const [newObjSize, setNewObjSize] = useState(1);
  const [newObjRot, setNewObjRot] = useState(0);
  // Objeto seleccionado (índice en `arrows`): tamaño/giro/duplicar/quitar
  // desde el panel y handle de giro en la cancha.
  const [selectedShape, setSelectedShape] = useState<number | null>(null);
  // Disco vs. silueta: preferencia del coach, persistida en localStorage.
  const [pinStyle, setPinStyle] = useState<PinStyle>(() => readPinStyle());
  const [showPhotos, setShowPhotos] = useState<boolean>(() => readPinPhotos());
  // Zoom al área (modo arqueros): se prende solo al elegir esa situación y
  // se puede alternar a mano desde el toolbar en cualquier situación.
  // Solo en deportes con arco (T4): voleibol, baloncesto y genérico no tienen
  // área de arquero que mirar de cerca.
  const [gkZoomPref, setGkZoom] = useState(false);
  const gkZoom = gkZoomPref && sportCfg.allowGkZoom;
  // M6d: la cámara del diálogo «Campo» viaja en las figuras (pseudo-figura court).
  const courtCfg = useMemo(() => courtOf(arrows), [arrows]);
  // Figuras dibujadas (sin la configuración de cancha): lo que el coach cuenta.
  const drawnCount = drawableShapes(arrows).length;
  const [courtOpen, setCourtOpen] = useState(false);
  // M6g: «Ajustes de la pizarra» controlado (en el celular se abre desde «Más»).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const view = gkZoom ? GK_VIEW : viewForCourt(courtCfg, sportCfg.allowGkZoom);
  const zoomedView = view.y1 - view.y0 < 90;
  useEffect(() => { setGkZoom(situation === 'arqueros'); }, [situation]);
  // Balones fantasma de "Reproducir jugada" + balones reales que se esconden
  // mientras corre la animación (los que están en el origen de un recorrido).
  const [ghostBalls, setGhostBalls] = useState<GhostBall[] | null>(null);
  const [hiddenBallIdx, setHiddenBallIdx] = useState<ReadonlySet<number>>(() => new Set());
  const ballRaf = useRef<number | null>(null);
  useEffect(() => () => { if (ballRaf.current) cancelAnimationFrame(ballRaf.current); }, []);

  // Regla de medir -- consulta puntual, no viaja con la plantilla (mutuamente
  // excluyente con drawMode: no tiene sentido dibujar y medir con el mismo gesto).
  const [measureMode, setMeasureMode] = useState(false);
  // «Largo cancha» es el largo REAL de la cancha del deporte (fútbol 11: 90 m
  // como siempre); la regla mide sobre el tablero entero, de ahí boardScale.
  const [courtLengthMeters, setPitchLengthMeters] = useState(sportCfg.courtLengthMeters);
  useEffect(() => { setPitchLengthMeters(sportCfg.courtLengthMeters); }, [sportCfg]);
  const pitchLengthMeters = boardMetersFor(sportCfg, courtLengthMeters);

  // Guías de alineación (mientras se arrastra un jugador ya puesto) --
  // puramente visuales, no se guardan en ningún lado.
  const [alignGuides, setAlignGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });

  // Tarjeta de jugador (P1) -- se abre con la data que ya trae el roster
  // cargado (metrics + latest_values), sin pedir nada nuevo al BFF.
  const [cardSubject, setCardSubject] = useState<RosterSubject | null>(null);

  // Animaciones de movimiento -- true solo mientras dura la transición CSS
  // de PitchPin (1.3s), después vuelve a false para no dejar el transition
  // activo durante un arrastre normal (se sentiría con retraso).
  const [animatingMove, setAnimatingMove] = useState(false);
  const ANIMATE_MS = 1300;
  // Cubre TODA la secuencia de "Reproducir jugada" (ida + pausa + vuelta),
  // no solo el tramo animado -- si solo gateara con animatingMove, el botón
  // se re-habilitaría durante la pausa a mitad de la reproducción.
  const [playingSequence, setPlayingSequence] = useState(false);
  const PLAY_HOLD_MS = 900;

  // Con el tablero abierto se pierde tiempo trabajando sin mover el mouse
  // (mirando el campo, pensando la jugada) o el coach se va a otra pestaña un
  // rato -- eso no debe contar como "inactividad" y cerrarle la sesión,
  // borrando alineación/flechas sin guardar. Mismo mecanismo que ya usan
  // CoachAttendancePage/RoutineFormModal para lo mismo.
  useUnsavedChanges(`tactical-board-${sourceId}`, open);

  const subjects = roster?.subjects ?? [];
  const subjectByKey = useMemo(() => {
    const m = new Map<string, RosterSubject>();
    for (const s of subjects) m.set(subjectKey(s.subject_type, s.subject_id), s);
    return m;
  }, [subjects]);

  // P2c: goles/asistencias de ESTE partido por jugador, para el badge sobre
  // el pin. own_goal/tarjetas no se muestran acá -- son datos negativos que
  // no aportan al "de un vistazo" que busca el badge, se siguen viendo
  // completos en MatchEventsModal.
  const eventSummaryByKey = useMemo(() => {
    const m = new Map<string, { goals: number; assists: number }>();
    for (const e of matchEvents ?? []) {
      const key = subjectKey(e.subject_type, e.subject_id);
      const entry = m.get(key) ?? { goals: 0, assists: 0 };
      if (e.type === 'goal') entry.goals += 1;
      if (e.type === 'assist') entry.assists += 1;
      m.set(key, entry);
    }
    return m;
  }, [matchEvents]);

  // Hidrata desde la alineación existente UNA sola vez -- no en cada refetch,
  // para no pisar lo que el coach está armando en pantalla mientras trabaja.
  //
  // Puente con alineaciones VIEJAS (creadas con el LineupModal clásico, antes
  // de que existieran x/y): un titular sin coordenadas no se pierde -- se
  // ubica aproximado según su position_code, repartiendo en fila a los que
  // comparten la misma posición para que no queden todos apilados en un punto.
  if (!initialized && existingLineup && subjects.length > 0) {
    const nextPlaced: Record<string, PlacedSlot> = {};
    const nextBench = new Set<string>();

    const legacyStarters = existingLineup.players.filter(
      (p) => p.role === 'starter' && (p.x == null || p.y == null),
    );
    const legacyByBand = new Map<string, typeof legacyStarters>();
    for (const p of legacyStarters) {
      const bandKey = p.position_code ?? 'sin_posicion';
      if (!legacyByBand.has(bandKey)) legacyByBand.set(bandKey, []);
      legacyByBand.get(bandKey)!.push(p);
    }

    for (const p of existingLineup.players) {
      const key = subjectKey(p.subject_type, p.subject_id);
      // x/y numeric de Postgres puede llegar como string por PostgREST.
      const px = p.x != null ? Number(p.x) : null;
      const py = p.y != null ? Number(p.y) : null;

      if (px != null && py != null && !Number.isNaN(px) && !Number.isNaN(py)) {
        nextPlaced[key] = {
          x: px, y: py,
          slot_label: p.slot_label || suggestLabel(py),
          labelIsCustom: !!p.slot_label,
          jersey_number: p.jersey_number ?? '',
        };
      } else if (p.role === 'starter') {
        const bandKey = p.position_code ?? 'sin_posicion';
        const band = legacyByBand.get(bandKey)!;
        const idx = band.indexOf(p);
        const { x, y } = legacyFallbackPosition(p.position_code, idx, band.length);
        nextPlaced[key] = {
          x, y,
          slot_label: (p.position_code && POSITION_LABEL[p.position_code]) || suggestLabel(y),
          labelIsCustom: false,
          jersey_number: p.jersey_number ?? '',
        };
      } else if (p.role === 'bench') {
        nextBench.add(key);
      }
    }
    setPlaced(nextPlaced);
    setBenchKeys(nextBench);
    // Modo pizarra (P2d) de ESTE partido/entrenamiento -- viaja con la
    // alineación desde 20260919195137_match_lineups_arrows.sql. Antes de esa
    // migración `existingLineup.arrows` no existía (undefined): el `?? []`
    // deja el tablero vacío en vez de romper con alineaciones ya guardadas.
    setArrows((existingLineup.arrows ?? []).map(hydrateShape));
    media.hydrate(existingLineup);
    teamsCtl.load(existingLineup.teams);
    // Jugada animada (T1): con `frames` las posiciones salen de los cuadros;
    // sin `frames` (jugadas de siempre) es un solo cuadro con lo de arriba.
    metaRef.current = { ...nextPlaced };
    const savedFrames = hydrateFrames(existingLineup.frames, { ballAsObject: true });
    if (savedFrames) {
      setFrames(savedFrames);
      setPlaced(placedFromFrame(savedFrames[0], nextPlaced));
      setArrows(savedFrames[0].arrows);
    } else {
      setFrames([blankFrame()]);
    }
    setFrameIndex(0);
    setInitialized(true);
  }

  const availableSubjects = subjects.filter((s) => {
    const key = subjectKey(s.subject_type, s.subject_id);
    return !placed[key] && !benchKeys.has(key);
  });
  // «En cancha N · Banco M» (antes contaba solo a los de afuera y se leía al revés).
  const counts = rosterCounts(subjectByKey.keys(), Object.keys(placed));

  // PointerSensor unifica mouse + touch + pen (D7) -- no se combina con
  // TouchSensor aparte, porque los dos a la vez pueden disparar el drag dos
  // veces sobre el mismo gesto táctil.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /** Distancia (en % de cancha) dentro de la cual dos jugadores se
   *  consideran "alineados" y aparece la guía. */
  const ALIGN_TOLERANCE = 2;

  // Guías de alineación: solo para REPOSICIONAR un jugador ya puesto (el
  // caso real de "armar una línea pareja") -- no se calculan para un
  // arrastre nuevo desde la banca, que ya tiene su propia lógica de
  // snap-a-marcador-de-plantilla en handleDragEnd.
  function handleDragMove(event: DragMoveEvent) {
    const { active, delta } = event;
    const data = active.data.current as { subject: RosterSubject } | undefined;
    if (!data?.subject || !String(active.id).startsWith('pitch:')) return;
    const key = subjectKey(data.subject.subject_type, data.subject.subject_id);
    const current = placed[key];
    if (!current) return;

    const pitchRect = pitchRef.current?.getBoundingClientRect();
    if (!pitchRect) return;

    const xPct = current.x + (delta.x / pitchRect.width) * 100;
    // Con zoom, el alto del contenedor representa solo y0..y1 de la cancha.
    const yPct = current.y + (delta.y / pitchRect.height) * (view.y1 - view.y0);

    const xs: number[] = [];
    const ys: number[] = [];
    for (const [otherKey, other] of Object.entries(placed)) {
      if (otherKey === key) continue;
      if (Math.abs(other.x - xPct) <= ALIGN_TOLERANCE) xs.push(other.x);
      if (Math.abs(other.y - yPct) <= ALIGN_TOLERANCE) ys.push(other.y);
    }
    setAlignGuides({ x: xs, y: ys });
  }

  function handleDragEnd(event: DragEndEvent) {
    setAlignGuides({ x: [], y: [] });
    if (!canEdit) return;
    const { active, delta } = event;
    const data = active.data.current as { subject: RosterSubject } | undefined;
    if (!data?.subject) return;
    const key = subjectKey(data.subject.subject_type, data.subject.subject_id);

    const pitchRect = pitchRef.current?.getBoundingClientRect();
    if (!pitchRect) return;

    const isReposicionando = String(active.id).startsWith('pitch:') && placed[key];
    let centerX: number;
    let centerY: number;

    if (isReposicionando) {
      // Reposicionar un jugador YA puesto: sumar el delta (px, siempre
      // confiable en @dnd-kit) a su posición actual -- remedir el rect del
      // nodo acá da mal porque el pin ya trae su propio transform de reposo
      // (translate(-50%,-50%)) combinado con el de arrastre. La posición
      // guardada pasa por la ventana visible (zoom de arqueros).
      const c = repositionedCenterPx(placed[key], pitchRect, delta, view);
      centerX = c.x;
      centerY = c.y;
    } else {
      // Nuevo desde la banca: sin transform previo, sí es confiable medir
      // dónde quedó el elemento.
      const activeRect = active.rect.current.translated ?? active.rect.current.initial;
      if (!activeRect) return;
      centerX = activeRect.left + activeRect.width / 2;
      centerY = activeRect.top + activeRect.height / 2;
    }

    const dropped = pitchPctFromPx({ x: centerX, y: centerY }, pitchRect, view);

    // Soltar afuera de la cancha no hace nada -- ni agrega, ni borra. Sacar
    // a alguien ya puesto es el botón X, a propósito: un drag accidental no
    // debería borrar una posición ya armada.
    if (!dropped.inside) return;

    let xPct = dropped.x;
    let yPct = dropped.y;
    let adoptedLabel: string | null = null;

    // Si es un jugador NUEVO (no reposicionando) y cae cerca de un marcador
    // de plantilla, lo adopta: toma su posición exacta y su etiqueta, y el
    // marcador desaparece. Reposicionar uno ya puesto no adopta marcadores --
    // sería confuso que mover a alguien lo tironee hacia un slot ajeno.
    if (!isReposicionando && emptySlots.length > 0) {
      const closest = nearestEmptySlot(emptySlots, xPct, yPct);
      if (closest) {
        xPct = closest.x;
        yPct = closest.y;
        adoptedLabel = closest.slot_label;
        setEmptySlots((prev) => prev.filter((s) => s.id !== closest!.id));
      }
    }

    setPlaced((prev) => {
      const existing = prev[key];
      // La etiqueta se recalcula por altura MIENTRAS siga siendo una
      // sugerencia (labelIsCustom=false) -- si el coach la escribió a mano,
      // se respeta sin importar a dónde mueva al jugador.
      const keepCustomLabel = !adoptedLabel && existing?.labelIsCustom;
      return {
        ...prev,
        [key]: {
          x: xPct,
          y: yPct,
          slot_label: adoptedLabel || (keepCustomLabel ? existing!.slot_label : suggestLabel(yPct)),
          labelIsCustom: !!keepCustomLabel,
          jersey_number: existing?.jersey_number ?? '',
        },
      };
    });
    setBenchKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function removeFromPitch(key: string) {
    if (!canEdit) return;
    setPlaced((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function toggleBench(key: string) {
    if (!canEdit) return;
    setBenchKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  /** Aplica la plantilla: los jugadores ya puestos se reubican (animado) en el
   *  slot más cercano, los slots sin jugador quedan como marcadores, y los
   *  dibujos se REEMPLAZAN por los de la plantilla (no tiene sentido "sumar"
   *  flechas de dos tácticas distintas). */
  function applyPreset(preset: TacticalPreset) {
    exitFramePlayback();
    const result = applyPresetSlots(placed, preset.id, preset.slots);
    if (result.placed !== placed) {
      setPlaced(result.placed);
      setAnimatingMove(true);
      setTimeout(() => setAnimatingMove(false), ANIMATE_MS);
    }
    setEmptySlots(result.emptySlots);
    // Una jugada guardada con cuadros trae su animación; sin cuadros, la
    // cancha queda en un solo cuadro (la animación anterior se reemplaza,
    // igual que los dibujos).
    const presetFrames = hydrateFrames(preset.frames, { ballAsObject: true });
    if (presetFrames && presetFrames.length > 1) {
      const mapped = mapPresetFrames(presetFrames, placed, result.placed, preset.slots);
      setFrames(mapped);
      setArrows(mapped[0].arrows);
    } else {
      setFrames([blankFrame()]);
      setArrows((preset.arrows ?? []).map(hydrateShape));
    }
    setFrameIndex(0);
    setSelectedShape(null);
    if (preset.teams) teamsCtl.load(preset.teams);
    setLoadedPresetId(preset.id);
    media.hydrate(preset);
  }

  /** Cargar una plantilla reubica a los jugadores y reemplaza los dibujos --
   *  los dibujos pueden ser trabajo sin guardar de esta alineación, así que si
   *  hay algo que se va a perder se pregunta antes (no hay deshacer). */
  function handleLoadPreset(presetId: string) {
    const preset = presets?.find((p) => p.id === presetId);
    if (!preset) return;

    const willMovePlayers = Object.keys(placed).length > 0 && preset.slots.length > 0;
    const willReplaceDrawings = drawnCount > 0;
    const willReplaceAnimation = liveFrames.length > 1;
    if (!willMovePlayers && !willReplaceDrawings && !willReplaceAnimation) {
      applyPreset(preset);
      return;
    }
    const efectos: string[] = [];
    if (willMovePlayers) efectos.push(`los ${Object.keys(placed).length} jugadores en cancha se mueven a las posiciones de la jugada guardada`);
    if (willReplaceDrawings) efectos.push(`los ${drawnCount} dibujos actuales se reemplazan por los de la jugada guardada`);
    if (willReplaceAnimation) efectos.push(`los ${liveFrames.length} cuadros de la animación se reemplazan`);
    setConfirmAction({
      title: `¿Cargar «${preset.name}»?`,
      description: `Al cargarla, ${efectos.join(' y ')}. Si te arrepientes, usa Deshacer.`,
      confirmLabel: 'Cargar jugada',
      onConfirm: () => applyPreset(preset),
    });
  }

  async function handleSaveAsPreset() {
    const name = savingName?.trim();
    if (!name || !canEdit) return;
    // Jugadores puestos + marcadores que todavía no adoptó nadie (una
    // plantilla es layout: un marcador sin jugador sigue siendo una posición).
    const { slots, arrows: presetArrows, frames: presetFrames } = buildPresetPayload();
    if (slots.length === 0) {
      toast({ title: 'Nada que guardar', description: 'Ubica al menos un jugador en la cancha primero.', variant: 'destructive' });
      return;
    }
    try {
      const created = await createPreset.mutateAsync({ team_id: teamId, name, situation, slots, arrows: presetArrows, frames: presetFrames, ...media.payload(), teams: teamsCtl.teams });
      logEvent('save', 'preset');
      toast({ title: 'Guardada en Mis jugadas', description: `"${name}" para ${SITUATION_LABEL[situation]}.` });
      setSavingName(null);
      // Queda "cargada" la que se acaba de crear -- así un ajuste siguiente
      // usa Actualizar en vez de crear otra copia sin querer.
      setLoadedPresetId(created.id);
    } catch (err: any) {
      toast({ title: 'No se pudo guardar en Mis jugadas', description: err?.message, variant: 'destructive' });
    }
  }

  /** Actualiza EN EL MISMO registro la plantilla que está cargada -- antes no
   *  existía este camino: "editar" una plantilla siempre terminaba en
   *  handleSaveAsPreset, que crea una fila nueva (POST), nunca actualiza la
   *  que se cargó (PUT). Ese era el bug: cargar, mover una flecha, "guardar"
   *  → aparecía una plantilla duplicada con el cambio, la original quedaba
   *  intacta y el coach no entendía por qué "no editaba bien". */
  async function handleUpdatePreset() {
    if (!loadedPresetId || !canEdit) return;
    const { slots, arrows: presetArrows, frames: presetFrames } = buildPresetPayload();
    if (slots.length === 0) {
      toast({ title: 'Nada que guardar', description: 'Ubica al menos un jugador en la cancha primero.', variant: 'destructive' });
      return;
    }
    try {
      await updatePreset.mutateAsync({ id: loadedPresetId, slots, arrows: presetArrows, frames: presetFrames, ...media.payload(), teams: teamsCtl.teams });
      logEvent('save', 'preset');
      toast({ title: 'Jugada actualizada en Mis jugadas' });
    } catch (err: any) {
      toast({ title: 'No se pudo actualizar la jugada', description: err?.message, variant: 'destructive' });
    }
  }

  /** "Borrar todo" quita todos los dibujos de la pizarra; no hay deshacer
   *  más allá de la última figura, así que se pregunta antes. */
  function requestClearDrawings() {
    if (drawnCount === 0 || !canEdit) return;
    setConfirmAction({
      title: '¿Borrar todos los dibujos?',
      description: `Se quitan las ${drawnCount} figuras de la pizarra (flechas, material y anotaciones). Los jugadores no se tocan.${liveFrames.length > 1 ? ' Solo en este cuadro.' : ''} Si te arrepientes, usa Deshacer.`,
      confirmLabel: 'Borrar todo',
      onConfirm: () => { exitFramePlayback(); setArrows((prev) => keepCourtOnly(prev)); setSelectedShape(null); },
    });
  }

  /** Cambiar de situación descarta los dibujos y los marcadores de la
   *  plantilla cargada: si hay algo que perder, se pregunta primero. */
  function handleChangeSituation(next: TacticalSituation) {
    if (next === situation) return;
    const apply = () => {
      setSituation(next);
      setEmptySlots([]);
      setLoadedPresetId(null);
      setArrows((prev) => keepCourtOnly(prev));
      setSelectedShape(null);
      setGhostBalls(null);
    };
    if (drawnCount === 0 && emptySlots.length === 0) {
      apply();
      return;
    }
    setConfirmAction({
      title: `¿Cambiar a ${SITUATION_LABEL[next]}?`,
      description: 'Al cambiar de situación se quitan los dibujos y los marcadores de la jugada cargada. Los jugadores en cancha se mantienen.',
      confirmLabel: 'Cambiar situación',
      onConfirm: apply,
    });
  }

  /** Elimina la plantilla cargada. El estado local solo se limpia si el
   *  servidor confirmó: antes se limpiaba aunque el DELETE fallara y la
   *  plantilla seguía existiendo sin que el coach lo notara. */
  function requestDeletePreset() {
    if (!loadedPresetId || !canEdit) return;
    const preset = presets?.find((p) => p.id === loadedPresetId);
    const id = loadedPresetId;
    setConfirmAction({
      title: `¿Eliminar de Mis jugadas${preset ? ` «${preset.name}»` : ''}?`,
      description: 'Se elimina para todo el cuerpo técnico del equipo. Lo que hay en la cancha ahora no cambia.',
      confirmLabel: 'Eliminar jugada',
      onConfirm: async () => {
        try {
          await deletePreset.mutateAsync(id);
          setEmptySlots([]);
          setLoadedPresetId(null);
          toast({ title: 'Jugada eliminada de Mis jugadas' });
        } catch (err: any) {
          toast({ title: 'No se pudo eliminar la jugada', description: err?.message, variant: 'destructive' });
        }
      },
    });
  }

  const suggestibleCount = (seasonStats?.stats ?? []).filter((s) => s.matches_played > 0).length;
  const canSuggestXI = suggestibleCount >= MIN_SUGGEST_SAMPLE && Object.keys(placed).length === 0;

  /** P4 (segunda regla, D6): alerta de rotación -- el tercio de jugadores con
   *  MENOS minutos jugados en la temporada, entre los que sí tienen partidos
   *  registrados. Mismo piso mínimo que "Sugerir XI" (MIN_SUGGEST_SAMPLE):
   *  con pocos datos, "el tercio de abajo" es ruido, no señal. Se calcula
   *  siempre sobre la temporada completa, nunca sobre un partido suelto. */
  const rotationKeys = useMemo(() => {
    if (suggestibleCount < MIN_SUGGEST_SAMPLE) return new Set<string>();
    const jugados = (seasonStats?.stats ?? [])
      .filter((s) => s.matches_played > 0)
      .sort((a, b) => a.minutes_played - b.minutes_played);
    const corte = Math.max(1, Math.floor(jugados.length / 3));
    return new Set(jugados.slice(0, corte).map((s) => subjectKey(s.subject_type, s.subject_id)));
  }, [seasonStats, suggestibleCount]);

  /** P4: ordena por minutos jugados (no hay dato de posición real en las
   *  season-stats) y los ubica en un 4-4-2 genérico. Solo actúa sobre cancha
   *  vacía a propósito -- sobre una alineación que el coach ya armó, "sugerir"
   *  significaría reemplazar su trabajo sin avisar, y eso no es aceptable. */
  function handleSuggestXI() {
    if (!canEdit || !seasonStats) return;
    const ranked = seasonStats.stats
      .filter((s) => s.matches_played > 0)
      .sort((a, b) => b.minutes_played - a.minutes_played);

    if (ranked.length < MIN_SUGGEST_SAMPLE) {
      toast({
        title: 'Todavía no hay suficientes datos',
        description: `Se necesitan al menos ${MIN_SUGGEST_SAMPLE} jugadores con partidos registrados en la temporada.`,
        variant: 'destructive',
      });
      return;
    }

    const top = ranked.slice(0, 11);
    const slots = generateFormation442();
    const nextPlaced: Record<string, PlacedSlot> = {};

    top.forEach((stat, i) => {
      const key = subjectKey(stat.subject_type, stat.subject_id);
      if (!subjectByKey.has(key)) return; // la plantilla pudo cambiar desde que se calcularon las stats
      const slot = slots[i];
      nextPlaced[key] = { x: slot.x, y: slot.y, slot_label: slot.label, labelIsCustom: false, jersey_number: '' };
    });

    setPlaced(nextPlaced);
    setBenchKeys(new Set());
    toast({
      title: 'XI sugerido por minutos jugados',
      description: 'Formación genérica (no conoce la posición real de cada jugador): reacomoda a mano lo que haga falta.',
    });
  }

  // ── Formaciones fijas (F2): la cancha arranca llena sin depender de
  // estadísticas de partidos (a diferencia de "Sugerir XI").
  // T4: las formaciones del menú son las del deporte (fútbol 11: las de siempre).
  const [formationKey, setFormationKey] = useState<string | null>(null);
  // "Empieza aquí" se cierra solo cuando hay algo en la cancha; "Dibujar un
  // ejercicio" o "Prefiero arrastrarlos yo" lo cierran a mano (la cancha
  // sigue vacía y el aviso taparía el ejercicio).
  const [emptyHintDismissed, setEmptyHintDismissed] = useState(false);
  useEffect(() => { if (open) setEmptyHintDismissed(false); }, [open]);
  const defaultFormation = defaultBoardFormation(sportCfg, subjects.length);
  // La galería abre en la modalidad de la cancha (F7 → las de 7, no «38 de Fútbol 11»).
  const galleryPlayers = initialPlayersFilter(galleryFormations(sport, sportCfg.formations), {
    currentKey: formationKey, onPitch: counts.onPitch, defaultPlayers: defaultFormation.players,
  });
  const loadedPresetName = loadedPresetId ? (presets?.find((p) => p.id === loadedPresetId)?.name ?? null) : null;
  const pitchIsEmpty = Object.keys(placed).length === 0 && drawnCount === 0 && emptySlots.length === 0 && frames.length === 1;

  /** Aplica una formación. Cancha sin jugadores: reparte el roster disponible
   *  (orden alfabético, el roster no trae dorsal) en sus posiciones; los
   *  huecos quedan como marcadores. Con jugadores ya puestos: los reubica en
   *  la posición más cercana de la formación (misma lógica que cargar una
   *  jugada guardada) y las posiciones sin jugador quedan como marcadores. */
  function applyFormation(formation: BoardFormation) {
    if (!canEdit) return;
    if (playingSequence) stopPlayback();
    exitFramePlayback();
    setFormationKey(formation.key);
    if (Object.keys(placed).length === 0) {
      const keys = sortRosterForFormation(availableSubjects)
        .map((s) => subjectKey(s.subject_type, s.subject_id));
      const result = placeInFormation(keys, formation);
      setPlaced(result.placed);
      setEmptySlots(result.emptySlots);
      setLoadedPresetId(null);
      const n = Object.keys(result.placed).length;
      toast({
        title: `${n} ${n === 1 ? 'jugador' : 'jugadores'} en ${formation.label}`,
        description: result.emptySlots.length > 0
          ? `Faltan ${result.emptySlots.length} para completar la formación: arrástralos desde Jugadores a los círculos punteados.`
          : 'Arrastra a cualquiera para cambiarlo de posición, o abre Jugadores para hacer cambios.',
      });
      return;
    }
    const result = applyPresetSlots(placed, `formation:${formation.key}`, formationAsPresetSlots(formation));
    setPlaced(result.placed);
    setEmptySlots(result.emptySlots);
    setLoadedPresetId(null);
    setAnimatingMove(true);
    setTimeout(() => setAnimatingMove(false), ANIMATE_MS);
  }

  /** M6a: el rival en una formación, en espejo en la mitad de arriba (figuras
   *  `opponent`, lógica en tacticalFormationGallery.ts). */
  function applyRivalFormation(formation: BoardFormation) {
    if (!canEdit) return;
    if (playingSequence) stopPlayback();
    exitFramePlayback();
    setArrows((prev) => replaceRivalShapes(prev, formation));
    setSelectedShape(null);
    toast({ title: `Rival en ${formation.label}`, description: 'Fichas rojas en espejo: arrástralas para ajustar.' });
  }
  function clearRival() {
    if (!canEdit) return;
    setArrows((prev) => removeRivalShapes(prev));
    setSelectedShape(null);
  }

  /** "Dibujar" abre/cierra el panel de dibujo; "Material" lo abre directo en
   *  la sección de material (pestaña en celular; en pantalla ancha se lleva
   *  la sección a la vista). */
  const materialSectionRef = useRef<HTMLDivElement>(null);
  function openMaterial() {
    if (tacticsOpen && mobileTab === 'material') {
      setTacticsOpen(false);
      setDrawMode(false);
      return;
    }
    setTacticsOpen(true);
    setMobileTab('material');
    setSheetCollapsed(false);
    if (isMobile) setRosterOpen(false);
    requestAnimationFrame(() => materialSectionRef.current?.scrollIntoView({ block: 'nearest' }));
  }
  function openDrawingFromHint() {
    setEmptyHintDismissed(true);
    setTacticsOpen(true);
    // Se puede dibujar de una: lápiz elegido y modo dibujo prendido.
    setDrawShapeType('freehand');
    setDrawMode(true);
    setMeasureMode(false);
    setMobileTab('escribir');
    setSheetCollapsed(false);
    if (isMobile) setRosterOpen(false);
  }
  /** «Pídele una jugada a la IA»: solo abre el panel de IA de siempre. */
  const canAskAi = roleCanEdit && hasAiAnalysis(sport);
  function openAiFromHint() {
    setEmptyHintDismissed(true);
    setAiPreview(null);
    setAiOpen(true);
  }

  /** Hay algo que "Reproducir" en modo ver: líneas de movimiento o recorridos
   *  de balón (una flecha suelta que no sale de nadie igual se intenta; si no
   *  hay nada que mover, handlePlayMovement avisa). */
  const hasAnimation = arrows.some((a) => {
    const t = a.type ?? 'arrow';
    return t === 'arrow' || t === 'curve' || t === 'ball_path';
  });

  /** Distancia (en % de cancha) dentro de la cual una flecha "sale de" un
   *  jugador -- si el inicio de la flecha no está cerca de nadie, no se
   *  anima (es una flecha de zona/espacio, no de un jugador puntual). */
  const PLAY_MATCH_DISTANCE = 6;

  /** Anima balones fantasma a lo largo de cada recorrido, con
   *  requestAnimationFrame (los objetos son SVG, no tienen transition CSS de
   *  left/top como los pines). Ease in-out para que arranque y frene suave. */
  function runBallAnimation(paths: TacticalArrow[], durationMs: number) {
    if (paths.length === 0) return;
    if (ballRaf.current) cancelAnimationFrame(ballRaf.current);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      setGhostBalls(paths.map((p) => {
        const pos = ballPathPoint(p, e);
        return { ...pos, scale: isLoftedPath(p) ? 1 + Math.sin(Math.PI * e) * 0.8 : 1 };
      }));
      if (t < 1) ballRaf.current = requestAnimationFrame(step);
      else ballRaf.current = null;
    };
    ballRaf.current = requestAnimationFrame(step);
  }

  /** "Reproducir jugada": cada jugador puesto que tenga una flecha o curva
   *  arrancando cerca de su posición se desliza animado hasta la punta, y
   *  cada recorrido de balón (pase/remate/penal) lo recorre un balón
   *  fantasma -- elevándose si es remate o penal. Es una aproximación (los
   *  jugadores van en línea recta con CSS, no siguen el arco de una curva);
   *  alcanza para "mostrar la jugada", no pretende ser exacta.
   *
   *  Ida, pausa breve mostrando la formación final, y VUELTA al punto de
   *  partida -- así "Reproducir" es un ensayo repetible (el coach lo aprieta
   *  las veces que quiera) y no algo que se "gasta". */
  // Temporizadores de la secuencia y foto de las posiciones reales: la
  // reproducción mueve `placed` de verdad (los pines se animan por CSS), así
  // que detenerla tiene que restaurar lo que el coach tenía armado.
  const playTimers = useRef<number[]>([]);
  const playSnapshot = useRef<Record<string, PlacedSlot> | null>(null);

  const schedulePlay = (fn: () => void, ms: number) => {
    playTimers.current.push(window.setTimeout(fn, ms));
  };

  /** Corta la reproducción en cualquier punto (botón Detener, cerrar el
   *  tablero, tocar la cancha) y devuelve a los jugadores a su posición real. */
  function stopPlayback() {
    playTimers.current.forEach((t) => window.clearTimeout(t));
    playTimers.current = [];
    if (ballRaf.current) { cancelAnimationFrame(ballRaf.current); ballRaf.current = null; }
    if (playSnapshot.current) setPlaced(playSnapshot.current);
    playSnapshot.current = null;
    setGhostBalls(null);
    setHiddenBallIdx(new Set());
    setAnimatingMove(false);
    setPlayingSequence(false);
  }

  useEffect(() => {
    if (!open && playSnapshot.current) stopPlayback();
  }, [open]);
  useEffect(() => () => { playTimers.current.forEach((t) => window.clearTimeout(t)); }, []);

  function handlePlayMovement() {
    if (playingSequence) { stopPlayback(); return; }
    exitFramePlayback();

    const candidateArrows = arrows.filter((a) => (a.type ?? 'arrow') === 'arrow' || a.type === 'curve');
    const ballPaths = arrows.filter((a) => a.type === 'ball_path');

    const placedEntries = Object.entries(placed);
    const matches: { key: string; fromX: number; fromY: number; fromLabel: string; toX: number; toY: number }[] = [];
    for (const [key, slot] of placedEntries) {
      let closest: TacticalArrow | null = null;
      let closestDist = PLAY_MATCH_DISTANCE;
      for (const a of candidateArrows) {
        const dist = Math.hypot(a.x1 - slot.x, a.y1 - slot.y);
        if (dist < closestDist) { closest = a; closestDist = dist; }
      }
      if (closest) matches.push({ key, fromX: slot.x, fromY: slot.y, fromLabel: slot.slot_label, toX: closest.x2, toY: closest.y2 });
    }

    if (matches.length === 0 && ballPaths.length === 0) {
      toast({
        title: 'Nada que reproducir',
        description: 'Dibuja una flecha o curva que salga de un jugador, o un recorrido de balón (pase, remate o penal).',
        variant: 'destructive',
      });
      return;
    }
    logEvent('play');

    // Un balón real puesto en el origen de un recorrido se esconde mientras
    // corre el fantasma: si no, se verían dos balones (uno quieto, uno en juego).
    const hidden = new Set<number>();
    arrows.forEach((a, i) => {
      if (a.type === 'ball' && ballPaths.some((p) => Math.hypot(p.x1 - a.x1, p.y1 - a.y1) < PLAY_MATCH_DISTANCE)) hidden.add(i);
    });
    setHiddenBallIdx(hidden);
    setSelectedShape(null);
    setPlayingSequence(true);
    playSnapshot.current = placed;

    // 1) Ida.
    setPlaced((prev) => {
      const next = { ...prev };
      for (const m of matches) {
        next[m.key] = { ...next[m.key], x: m.toX, y: m.toY, slot_label: next[m.key]?.labelIsCustom ? next[m.key].slot_label : suggestLabel(m.toY) };
      }
      return next;
    });
    setAnimatingMove(true);
    runBallAnimation(ballPaths, ANIMATE_MS);

    schedulePlay(() => {
      setAnimatingMove(false);

      // 2) Pausa viendo la formación final, después 3) vuelta al origen.
      schedulePlay(() => {
        setPlaced((prev) => {
          const next = { ...prev };
          for (const m of matches) {
            next[m.key] = { ...next[m.key], x: m.fromX, y: m.fromY, slot_label: m.fromLabel };
          }
          return next;
        });
        setAnimatingMove(true);
        // El balón vuelve al punto de partida (el fantasma desaparece y el
        // balón real, si había, reaparece donde estaba).
        setGhostBalls(null);
        setHiddenBallIdx(new Set());

        schedulePlay(() => {
          // Terminó solo: las posiciones ya volvieron al origen, no hay nada
          // que restaurar.
          playSnapshot.current = null;
          playTimers.current = [];
          setAnimatingMove(false);
          setPlayingSequence(false);
        }, ANIMATE_MS);
      }, PLAY_HOLD_MS);
    }, ANIMATE_MS);
  }
  // El manejo de puntero para dibujar/editar vive dentro de ArrowLayer (no
  // acá) para no re-renderizar todo TacticalBoard en cada pixel de
  // arrastre -- estos 3 callbacks son la única superficie que necesita.
  // Editar dibujos mientras corre la reproducción corta la reproducción:
  // los índices de `hiddenBallIdx` y las posiciones de ensayo dejarían de
  // corresponder a lo que hay en pantalla.
  function handleCreateShape(shape: TacticalArrow) {
    if (!canEdit) return;
    if (playingSequence) stopPlayback();
    setArrows((prev) => [...prev, shape]);
  }
  function handleUpdateShape(index: number, patch: ShapePatch) {
    if (!canEdit) return;
    if (playingSequence) stopPlayback();
    setArrows((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }
  /** Borrar corre los índices de las figuras posteriores: la selección se
   *  ajusta para seguir apuntando al mismo objeto (o se limpia si era ese). */
  function handleDeleteShape(index: number) {
    if (!canEdit) return;
    if (playingSequence) stopPlayback();
    setArrows((prev) => prev.filter((_, i) => i !== index));
    setSelectedShape((prev) => (prev === null || prev === index ? null : prev > index ? prev - 1 : prev));
  }
  /** Borrador: varias figuras de una vez. La selección se limpia (los
   *  índices se corren y el borrador no es un gesto de selección). */
  function handleEraseShapes(indexes: number[]) {
    if (!canEdit) return;
    const drop = new Set(indexes);
    setArrows((prev) => prev.filter((_, i) => !drop.has(i)));
    setSelectedShape(null);
  }
  function setCourtConfig(cfg: CourtConfig) {
    if (!canEdit) return;
    setArrows((prev) => withCourt(prev, cfg));
    setFrames((prev) => prev.map((f, i) => (i === frameIndex ? f : { ...f, arrows: withCourt(f.arrows, cfg) })));
    setSelectedShape(null);
  }
  function handleDuplicateSelected() {
    if (selectedShape === null) return;
    const src = arrows[selectedShape];
    if (!src) return;
    const copy = offsetShape(src, 4, 3);
    setArrows((prev) => [...prev, copy]);
    setSelectedShape(arrows.length); // la copia queda al final
  }
  function togglePinPhotos() {
    setShowPhotos((prev) => {
      const next = !prev;
      try { localStorage.setItem(PIN_PHOTOS_KEY, next ? '1' : '0'); } catch { /* storage bloqueado: se pierde al recargar */ }
      return next;
    });
  }
  function togglePinStyle() {
    setPinStyle((prev) => {
      const next: PinStyle = prev === 'disc' ? 'silhouette' : 'disc';
      try { localStorage.setItem(PIN_STYLE_KEY, next); } catch { /* modo privado / storage bloqueado: se pierde al recargar, nada más */ }
      return next;
    });
  }

  // Objeto seleccionado (si el índice sigue siendo válido y es un objeto de
  // un punto): el panel edita SU tamaño/giro. Sin selección, edita los
  // valores con los que se colocan los objetos nuevos.
  const selected = selectedShape !== null ? arrows[selectedShape] : undefined;
  // Material y texto comparten el panel de tamaño/giro/duplicar/quitar.
  const selectedIsObject = !!selected && isMovableByPoint(selected.type);
  // En celular, tocar un objeto puesto abre sus controles (tamaño, giro,
  // duplicar, quitar): si no, quedan en otra pestaña y no se encuentran.
  useEffect(() => {
    if (isMobile && selectedIsObject) { setMobileTab('ajustes'); setSheetCollapsed(false); }
  }, [isMobile, selectedIsObject, selectedShape]);
  const panelSize = selectedIsObject ? (selected!.size ?? 1) : newObjSize;
  const panelRot = selectedIsObject ? (selected!.rot ?? 0) : newObjRot;
  function setPanelSize(v: number) {
    const clamped = Math.min(OBJ_SIZE_MAX, Math.max(OBJ_SIZE_MIN, v));
    if (selectedIsObject) handleUpdateShape(selectedShape!, { size: clamped }); else setNewObjSize(clamped);
  }
  function setPanelRot(v: number) {
    const norm = ((Math.round(v) % 360) + 360) % 360;
    if (selectedIsObject) handleUpdateShape(selectedShape!, { rot: norm }); else setNewObjRot(norm);
  }
  /** Elegir una herramienta de dibujo prende el modo dibujo: antes había que
   *  activarlo aparte y era el tropiezo más común ("toco Cono y no pasa nada"). */
  function pickTool(type: DrawTool, kind?: BallPathKind) {
    if (type !== 'zone') polygon.cancel();
    setDrawShapeType(type);
    if (kind) setBallKind(kind);
    setDrawMode(true);
    setMeasureMode(false);
    // Celular vertical: elegida la herramienta, la hoja se pliega y la cancha
    // recupera el alto (tocar una pestaña la vuelve a abrir).
    if (isPortraitPhone) setSheetCollapsed(true);
  }
  async function handleSave(target?: { sourceId: string; label: string }) {
    if (!canEdit) return;
    // La pizarra libre no tiene destino propio: guarda solo con «Agregar a una sesión».
    if (scratch && !target) return;
    if (playingSequence) return; // posiciones intermedias de la reproducción
    // Un jugador de una alineación guardada puede ya no estar en el roster
    // (dado de baja, cambiado de equipo): no se puede guardar y no cuenta para
    // el máximo. Antes `subjectByKey.get(key)!` reventaba el guardado entero.
    // Con cuadros, lo que va a las columnas de siempre (jugadores + figuras) es
    // el CUADRO 1, esté abierto el que esté: el PDF, la miniatura y los
    // clientes viejos ven la posición inicial.
    const allFrames = liveFrames.map((f) => ({ ...f, players: f.players.filter((p) => subjectByKey.has(p.key)) }));
    const crowded = allFrames.findIndex((f) => f.players.length > MAX_STARTERS);
    if (allFrames.length > 1 && crowded >= 0) {
      toast({ title: 'Máximo 11 en cancha', description: `El cuadro ${crowded + 1} tiene ${allFrames[crowded].players.length} jugadores.`, variant: 'destructive' });
      return;
    }
    const firstPlaced = frameIndex === 0 ? placed : placedFromFrame(allFrames[0], placed, metaRef.current);
    const starterKeys = splitKnownKeys(Object.keys(firstPlaced), subjectByKey);
    const benchSplit = splitKnownKeys(Array.from(benchKeys), subjectByKey);
    const missingCount = starterKeys.missing.length + benchSplit.missing.length;

    if (starterKeys.valid.length > MAX_STARTERS) {
      toast({ title: 'Máximo 11 en cancha', description: `Hay ${starterKeys.valid.length} jugadores colocados.`, variant: 'destructive' });
      return;
    }

    const players: LineupPlayerInput[] = [
      ...starterKeys.valid.map((key) => {
        const subject = subjectByKey.get(key)!;
        const slot = firstPlaced[key];
        return {
          subject_type: subject.subject_type,
          subject_id: subject.subject_id,
          role: 'starter' as const,
          slot_label: slot.slot_label,
          x: slot.x,
          y: slot.y,
          jersey_number: slot.jersey_number === '' ? null : Number(slot.jersey_number),
        };
      }),
      ...benchSplit.valid.map((key) => {
        const subject = subjectByKey.get(key)!;
        return {
          subject_type: subject.subject_type,
          subject_id: subject.subject_id,
          role: 'bench' as const,
        };
      }),
    ];

    try {
      await saveLineup.mutateAsync({
        team_id: teamId,
        source_type: target ? 'training_session' : sourceType,
        source_id: target ? target.sourceId : sourceId,
        players,
        arrows: allFrames[0].arrows,
        // null = un solo cuadro: la fila no carga una animación de 1 cuadro.
        frames: serializeFrames(allFrames),
        ...media.payload(),
        teams: teamsCtl.teams,
      });
      logEvent('save', target ? 'training_session' : sourceType);
      toast({
        title: target ? `Agregada a ${target.label}` : 'Jugada guardada',
        description: missingCount > 0
          ? `${missingCount} ${missingCount === 1 ? 'jugador ya no está' : 'jugadores ya no están'} en el equipo y no se guardó.`
          : undefined,
      });
      // Pizarra libre: se queda abierta (se puede seguir o agregarla a otra sesión).
      if (!target) onClose();
    } catch (err: any) {
      toast({ title: 'No se pudo guardar', description: err?.message, variant: 'destructive' });
    }
  }

  // ── Pizarra libre: «Agregar a una sesión» ──────────────────────────────
  const [addToSessionOpen, setAddToSessionOpen] = useState(false);
  /** Elegido el bloque: si ya tiene una jugada, se pregunta antes de reemplazarla. */
  async function addToSessionBlock(blockId: string, label: string) {
    setAddToSessionOpen(false);
    let existing = false;
    try {
      existing = (await getFootballLineups({ source_type: 'training_session', source_id: blockId })).length > 0;
    } catch {
      existing = false;
    }
    if (!existing) { void handleSave({ sourceId: blockId, label }); return; }
    setConfirmAction({
      title: '¿Reemplazar la jugada de ese bloque?',
      description: `${label} ya tiene una jugada en la pizarra. Si sigues, se reemplaza por la de ahora.`,
      confirmLabel: 'Reemplazar',
      onConfirm: () => { void handleSave({ sourceId: blockId, label }); },
    });
  }

  // ── Compartir por enlace (vista pública de solo lectura) ───────────────
  const [sharingLink, setSharingLink] = useState(false);
  async function handleShareLink() {
    if (sharingLink || !roleCanEdit) return;
    setSharingLink(true);
    // La pestaña se abre YA (dentro del toque): abierta después del await, el
    // navegador del celular la bloquea como ventana emergente.
    const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    try {
      const input = buildExportInput();
      const payload = buildSharedPlayPayload(input);
      const title = (input.title || '').trim();
      const token = await createSharedPlay({ teamId, title, sport: sport ?? null, payload });
      const url = sharedPlayUrl(window.location.origin, token);
      const wa = whatsappTextUrl(sharedPlayMessage(title, url));
      logEvent('share');
      if (win) win.location.href = wa; else window.location.href = wa;
      toast({ title: 'Enlace listo', description: 'Se abre en la web, sin descargar nada y sin nombres de los jugadores.' });
    } catch (err: any) {
      win?.close();
      toast({ title: 'No se pudo compartir la jugada', description: err?.message, variant: 'destructive' });
    } finally {
      setSharingLink(false);
    }
  }

  // ── Cuadros: seleccionar, agregar, quitar, reordenar, duración (T1) ─────
  /** Posiciones reales de la cancha: durante "Reproducir jugada" (un solo
   *  cuadro) `placed` está a mitad de camino y la foto previa es la verdadera. */
  function realPlaced(): Record<string, PlacedSlot> {
    return playSnapshot.current ?? placed;
  }
  /** Todos los cuadros, con el abierto armado desde la cancha real. */
  function committedFrames(): TacticalFrame[] {
    if (!playSnapshot.current) return liveFrames;
    const real = playSnapshot.current;
    return liveFrames.map((f, i) => (
      i === frameIndex ? { ...f, players: Object.entries(real).map(([key, s]) => ({ key, x: s.x, y: s.y })) } : f
    ));
  }
  /** Deja `list` como cuadros y abre el `index` en la cancha. */
  function loadFrame(list: TacticalFrame[], index: number, meta: Record<string, PlacedSlot>) {
    const target = list[index];
    if (!target) return;
    setFrames(list);
    setFrameIndex(index);
    setPlaced(placedFromFrame(target, meta, metaRef.current));
    setArrows(target.arrows);
    setSelectedShape(null);
  }
  /** M3: la sugerencia de la IA pasa a ser la jugada de la cancha. No se
   *  guarda sola (Guardar jugada) y Deshacer vuelve a la del coach. */
  function applyAiFrames(next: TacticalFrame[], titulo: string) {
    if (next.length === 0) return;
    setAiPreview(null);
    if (playingSequence) stopPlayback();
    exitFramePlayback();
    const meta = realPlaced();
    setBoardMode('edit');
    loadFrame(next.map((f) => ({ ...f, arrows: withCourt(f.arrows, courtCfg) })), 0, meta);
    toast({ title: 'Sugerencia IA en la cancha', description: `«${titulo}». No se guarda hasta que toques Guardar jugada; Deshacer vuelve a tu jugada.` });
  }
  function selectFrame(index: number) {
    exitFramePlayback();
    if (index === frameIndex) return;
    const list = committedFrames();
    const meta = realPlaced();
    if (playingSequence) stopPlayback();
    loadFrame(list, index, meta);
  }
  /** «+ Cuadro»: copia el cuadro abierto justo después y lo abre — desde ahí
   *  se mueven los jugadores a donde van en ese momento de la jugada. */
  function addFrame() {
    if (!canEdit) return;
    exitFramePlayback();
    const list = committedFrames();
    const meta = realPlaced();
    if (list.length >= MAX_FRAMES) {
      toast({ title: `Máximo ${MAX_FRAMES} cuadros`, description: 'Quita un cuadro para agregar otro.', variant: 'destructive' });
      return;
    }
    if (playingSequence) stopPlayback();
    const r = duplicateFrameAt(list, frameIndex);
    loadFrame(r.frames, r.index, meta);
    logEvent('frame_add');
  }
  function deleteFrame(index: number) {
    if (!canEdit) return;
    exitFramePlayback();
    const list = committedFrames();
    if (list.length <= 1) return;
    const meta = realPlaced();
    if (playingSequence) stopPlayback();
    const r = removeFrameAt(list, index);
    // Quitar un cuadro que no es el abierto deja abierto el mismo.
    const openId = list[frameIndex]?.id;
    const nextIndex = index === frameIndex ? r.index : r.frames.findIndex((f) => f.id === openId);
    loadFrame(r.frames, Math.max(0, nextIndex), meta);
  }
  function moveFrameTo(from: number, to: number) {
    if (!canEdit) return;
    exitFramePlayback();
    const list = committedFrames();
    const next = moveFrame(list, from, to);
    if (next === list) return;
    if (playingSequence) stopPlayback();
    const openId = list[frameIndex]?.id;
    setFrames(next);
    setFrameIndex(Math.max(0, next.findIndex((f) => f.id === openId)));
  }
  function changeFrameDuration(index: number, ms: number) {
    if (!canEdit) return;
    setFrames(setFrameDuration(committedFrames(), index, ms));
  }

  // ── Reproducción por cuadros ────────────────────────────────────────────
  /** Sale de la reproducción (o de la pausa) y vuelve al cuadro abierto. */
  function exitFramePlayback() {
    if (playState === 'stopped' && !playbackFrames) return;
    setPlayState('stopped');
    setPlaybackFrames(null);
    clock.set(0);
  }
  function toggleFramePlayback() {
    if (playState === 'playing') { setPlayState('paused'); return; }
    const list = playbackFrames ?? committedFrames();
    if (list.length < 2) return;
    if (playingSequence) stopPlayback();
    setSelectedShape(null);
    // Métrica: una reproducción = darle ▶ desde el principio (seguir tras una
    // pausa no es otra reproducción).
    if (!playbackFrames) {
      setPlaybackFrames(list);
      clock.set(0);
      logEvent('play');
    } else if (clock.get() >= totalDurationMs(list)) {
      clock.set(0); // terminó: ▶ vuelve a empezar
      logEvent('play');
    }
    setPlayState('playing');
  }
  /** Tocar la barra de progreso: salta a ese momento (en pausa si no corría). */
  function seekPlayback(tMs: number) {
    if (!playbackFrames) {
      const list = committedFrames();
      if (list.length < 2) return;
      if (playingSequence) stopPlayback();
      setPlaybackFrames(list);
      setPlayState('paused');
    }
    clock.set(tMs);
  }
  useEffect(() => {
    if (open) return;
    setPlayState('stopped');
    setPlaybackFrames(null);
    clock.set(0);
  }, [open, clock]);

  /** Mis jugadas: slots = cuadro 1 (+ marcadores sin jugador); con varios
   *  cuadros, las claves pasan de jugador a índice de slot (una jugada
   *  guardada es layout, no personas). */
  /** «Exportar ▾» (T2): lo que se ve AHORA (PNG) + todos los cuadros (PDF y
   *  video), con el deporte para que salga la cancha correcta. */
  function buildExportInput(): TacticalExportInput {
    const list = committedFrames();
    const now = realPlaced();
    const jerseyOf = (s: PlacedSlot) => (s.jersey_number === '' ? null : Number(s.jersey_number));
    const playerLabels: Record<string, string> = {};
    const playerJerseys: Record<string, number | null> = {};
    for (const [key, s] of Object.entries({ ...metaRef.current, ...now })) {
      playerLabels[key] = s.slot_label;
      playerJerseys[key] = jerseyOf(s);
    }
    // M6b: nombres reales SOLO si el coach prendió «Mostrar nombres al exportar».
    const playerNames: Record<string, string> | undefined = teamsCtl.teams?.export_names
      ? Object.fromEntries(Object.keys(playerLabels).flatMap((k) => {
        const sub = subjectByKey.get(k);
        return sub ? [[k, sub.full_name]] : [];
      }))
      : undefined;
    const players: TacticalStaticPlayer[] = Object.entries(now).map(([key, s]) => ({
      x: s.x, y: s.y, label: s.slot_label, jersey: jerseyOf(s), role: 'starter',
      ...(playerNames?.[key] ? { name: playerNames[key] } : {}),
    }));
    return {
      title: contextLabel,
      teamName,
      frames: list.length > 1 ? list : null,
      players,
      arrows: list[frameIndex]?.arrows ?? arrows,
      playerLabels,
      playerJerseys,
      sport,
      notes: media.notes,
      videos: media.videos,
      teams: teamsCtl.teams,
      playerNames,
      playback: prefs.playback,
    };
  }
  /** Lo que recibe «Exportar»: lo de siempre + la marca (marca de agua / logo). */
  async function buildExportInputWithBranding(): Promise<TacticalExportInput> {
    const input = buildExportInput();
    return { ...input, branding: await exportBranding() };
  }

  /** «Guardar en biblioteca» (T3): la jugada con los PUESTOS del cuadro 1,
   *  nunca los atletas (boardFromPitch). Se abre diferido un tick: el menú
   *  que lo dispara todavía se está cerrando. */
  const [libraryBoard, setLibraryBoard] = useState<ExerciseBoard | null>(null);
  function openLibrarySave() {
    const list = committedFrames();
    const first = list[0];
    const firstPlaced = frameIndex === 0 ? realPlaced() : placedFromFrame(first, realPlaced(), metaRef.current);
    const board = boardFromPitch({
      players: Object.entries(firstPlaced).map(([key, s]) => ({
        key, x: s.x, y: s.y, slot_label: s.slot_label, jersey_number: s.jersey_number,
      })),
      arrows: first.arrows,
      frames: list,
    });
    const { notes, videos } = media.payload();
    window.setTimeout(() => setLibraryBoard({ ...board, notes, videos }), 0);
  }

  function buildPresetPayload(): { slots: { slot_label: string; x: number; y: number }[]; arrows: TacticalArrow[]; frames: TacticalFrame[] | null } {
    const list = committedFrames();
    const first = list[0];
    const firstPlaced = frameIndex === 0 ? realPlaced() : placedFromFrame(first, realPlaced(), metaRef.current);
    const slots = buildPresetSlots(firstPlaced, emptySlots);
    if (list.length <= 1) return { slots, arrows: first.arrows, frames: null };
    const slotKeyOf = new Map(Object.keys(firstPlaced).map((k, i) => [k, presetSlotKey(i)]));
    const frames = serializeFrames(list.map((f) => ({
      ...remapBallOwner(f, (k) => slotKeyOf.get(k)),
      players: f.players.flatMap((p) => {
        const key = slotKeyOf.get(p.key);
        return key ? [{ key, x: p.x, y: p.y }] : [];
      }),
    })));
    return { slots, arrows: first.arrows, frames };
  }

  // loadingList: sin esperar la lista, el aviso "Empieza aquí" aparecía un
  // instante sobre una sesión que SÍ tenía jugada, y la hidratación pisaba lo
  // que el coach alcanzara a poner.
  // loadingSport: sin esperar el deporte, un equipo de voleibol veía un
  // instante la cancha de fútbol (y su formación de arranque).
  const loading = loadingRoster || loadingList || (!!existingLineupId && loadingLineup) || loadingSport;

  // ── Métrica de uso (T0) ─────────────────────────────────────────────────
  // «open» UNA vez por apertura: cuando terminó de cargar (ya se sabe el
  // deporte y la escuela), no en cada render. El ref sobrevive al doble
  // montaje de StrictMode en desarrollo y se rearma al cerrar.
  const openLoggedRef = useRef(false);
  useEffect(() => {
    if (!open) { openLoggedRef.current = false; return; }
    if (loading || openLoggedRef.current || !metricSchoolId) return;
    openLoggedRef.current = true;
    logEvent('open');
  }, [open, loading, metricSchoolId, logEvent]);

  // ── Deshacer / rehacer (T1) ─────────────────────────────────────────────
  // Historial del tablero entero (todos los cuadros + el abierto + etiquetas),
  // no de cada acción: cualquier cambio queda registrado sin que cada función
  // tenga que acordarse. Un arrastre (decenas de cambios) es UN paso: se anota
  // cuando la cancha queda quieta HISTORY_SETTLE_MS.
  // La lógica (anotar, deshacer, rehacer) es pura: lib/school/tacticalHistory.ts.
  const historyRef = useRef<HistoryState<BoardSnapshot>>(emptyHistory());
  const restoringRef = useRef(false);
  const [, setHistoryTick] = useState(0);
  // Al abrir o terminar de cargar, el historial arranca de cero (la carga no
  // es un paso que se pueda deshacer).
  useEffect(() => {
    historyRef.current = emptyHistory();
    setHistoryTick((v) => v + 1);
  }, [open, initialized, loading]);

  function commitHistory(snap: BoardSnapshot): boolean {
    const ok = historyCommit(historyRef.current, snap, snapshotKey(snap));
    if (ok) setHistoryTick((v) => v + 1);
    return ok;
  }
  useEffect(() => {
    // "Reproducir jugada" mueve `placed` de verdad: no son cambios del coach.
    if (!open || loading || playingSequence) return;
    const h = historyRef.current;
    const snap: BoardSnapshot = { frames: liveFrames, frameIndex, placed };
    if (restoringRef.current || !h.base) {
      restoringRef.current = false;
      historySetBase(h, snap, snapshotKey(snap));
      return;
    }
    const timer = window.setTimeout(() => commitHistory(snap), HISTORY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open, loading, playingSequence, liveFrames, frameIndex, placed]);

  function applySnapshot(s: BoardSnapshot) {
    restoringRef.current = true;
    exitFramePlayback();
    setFrames(s.frames);
    setFrameIndex(s.frameIndex);
    setPlaced(s.placed);
    setArrows(s.frames[s.frameIndex]?.arrows ?? []);
    setSelectedShape(null);
    setHistoryTick((v) => v + 1);
  }
  function undo() {
    if (!canEdit || playingSequence) return;
    const h = historyRef.current;
    // Lo que todavía no se anotó (menos de HISTORY_SETTLE_MS) cuenta como paso.
    commitHistory({ frames: liveFrames, frameIndex, placed });
    const prev = historyUndo(h, snapshotKey);
    if (prev) applySnapshot(prev);
  }
  function redo() {
    if (!canEdit || playingSequence) return;
    const h = historyRef.current;
    commitHistory({ frames: liveFrames, frameIndex, placed }); // un cambio nuevo anula el rehacer
    const next = historyRedo(h, snapshotKey);
    if (next) applySnapshot(next);
  }
  const canUndo = historyRef.current.undo.length > 0;
  const canRedo = historyRef.current.redo.length > 0;
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (⌘ en Mac). No mientras se escribe en un campo.
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  useEffect(() => {
    if (!open || !canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRef.current(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, canEdit]);

  // Rastro fantasma: desde el cuadro 2, una línea punteada desde donde estaba
  // cada jugador en el cuadro anterior hasta donde está ahora.
  const trail = canEdit && !framePlaybackActive && frameIndex > 0
    ? ghostTrail(frames[frameIndex - 1], liveFrames[frameIndex])
    : [];

  const timelineFrames = playbackFrames ?? liveFrames;
  const renderPlaybackPlayer = (p: InterpolatedPlayer, top: number) => {
    const subject = subjectByKey.get(p.key);
    if (!subject) return null;
    return (
      <PlaybackPin key={p.key} subject={subject} meta={metaRef.current[p.key] ?? placed[p.key]}
        x={p.x} top={top} opacity={p.opacity} pinStyle={pinStyle} showPhotos={showPhotos} />
    );
  };
  const renderPlaybackShapes = (shapes: TacticalArrow[], _opacity: number, layerKey: string) => (
    <ArrowLayer
      key={layerKey}
      shapes={shapes}
      readOnly
      drawMode={false}
      drawShapeType="arrow"
      drawColor="white"
      ballKind="pase"
      newObjSize={1}
      newObjRot={0}
      measureMode={false}
      pitchLengthMeters={pitchLengthMeters}
      view={view}
      pinStyle={pinStyle}
      selectedIndex={null}
      ghostBalls={null}
      hiddenIndexes={NO_INDEXES}
      onCreateShape={noop}
      onUpdateShape={noop}
      onDeleteShape={noop}
      onSelectShape={noop}
      onEraseShapes={noop}
    />
  );
  // M6g: posesión del balón del cuadro abierto. Elegir dueño pega la figura
  // balón a sus pies (el cuadro quieto la muestra donde la llevará la
  // reproducción); «Suelto» la deja donde está.
  const changeBallOwner = (key: string | null) => {
    setFrames((list) => setBallOwner(list, frameIndex, key));
  };
  const possessionBar = !loading && canEdit && prefs.settings.possession && !framePlaybackActive ? (
    <TacticalPossessionBar
      frameNumber={frameIndex + 1}
      value={liveFrames[frameIndex]?.ball_owner ?? null}
      onChange={changeBallOwner}
      candidates={Object.entries(placed).flatMap(([key, slot]) => {
        const subject = subjectByKey.get(key);
        return subject ? [{ key, name: subject.full_name, hint: slot.jersey_number !== '' ? String(slot.jersey_number) : slot.slot_label }] : [];
      })}
    />
  ) : null;
  const timeline = !loading && (canEdit || liveFrames.length > 1) ? (
    <TacticalTimeline
      mode={canEdit ? 'edit' : 'view'}
      frames={timelineFrames}
      currentIndex={frameIndex}
      playState={playState}
      clock={clock}
      totalMs={totalDurationMs(timelineFrames)}
      speed={playSpeed}
      loop={loopPlayback}
      onPlayPause={toggleFramePlayback}
      onSeek={seekPlayback}
      onSpeedChange={setPlaySpeed}
      onLoopChange={setLoopPlayback}
      onSelect={selectFrame}
      onAdd={addFrame}
      onDelete={deleteFrame}
      onMove={moveFrameTo}
      onDurationChange={changeFrameDuration}
      // Celular con hoja abierta: solo la tira, para que la cancha no se angoste.
      compact={landscapePhone || (isMobile && (tacticsOpen || rosterOpen))}
      dense={landscapePhone}
    />
  ) : null;

  // Ancho real de la cancha (px), medido. Las fichas, etiquetas y el aviso de
  // «Empieza aquí» escalan con él: con tamaño fijo en px, en una cancha chica
  // (celular horizontal) las fichas se montaban unas sobre otras.
  // Tope alto (antes 580 px): en escritorio la cancha usa todo el alto
  // disponible en vez de quedar chica en el centro con márgenes vacíos.
  const pitchW = pitchArea
    ? Math.max(120, Math.floor(Math.min(zoomedView ? 1400 : 1100, pitchArea.w, pitchArea.h * 300 / ((view.y1 - view.y0) * 3.4))))
    : null;
  // 1 = tamaño de siempre (cancha de 400 a 580 px); mínimo 0.62 para que el
  // texto siga leyéndose; en canchas más grandes las fichas crecen con ella,
  // topadas en 1.4 para no taparse entre sí.
  const pinK = pitchW === null
    ? 1
    : pitchW <= 580
      ? Math.min(1, Math.max(0.62, pitchW / 400))
      : Math.min(1.4, pitchW / 580);
  const smallPitch = pitchW !== null && pitchW < 300;

  return (
    <TacticalTeamsContext.Provider value={teamsCtxValue}>
    <TacticalBoardPrefsProvider value={prefs}>
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {/* rounded-none Y sm:rounded-none a propósito: la base de DialogContent
          trae "sm:rounded-lg" -- sin el mismo prefijo, el merge de clases no
          lo reconoce como el mismo "slot" y la base gana en desktop.

          height/overflow van por `style`, no por className -- el propio
          componente Dialog trae una clase global ".dialog-safe" (para el
          safe-area de iOS) que fija overflow-y:auto y max-height:100dvh
          como CSS plano; al no ser una utilidad de Tailwind, tailwind-merge
          no la deduplica contra "overflow-hidden"/"h-[100dvh]", y en la
          hoja de estilos compilada esa clase compartida termina ganando el
          empate de especificidad (mismo bug que ya se encontró y corrigió
          en LineupModal.tsx). Un estilo inline sí le gana a cualquier clase
          sin tener que tocar ese componente compartido.

          100vh, no 100dvh -- dvh se comportaba distinto entre la ventana
          real de un navegador y la vista emulada donde se probaba, y es
          justo el tipo de inconsistencia que puede leerse como "se ve
          aprisionado" en un dispositivo real. vh es la unidad más probada. */}
      <DialogContent
        className={`${landscapePhone ? '[&>button:last-child]:!top-1 ' : ''}left-0 top-0 translate-x-0 translate-y-0 w-screen max-w-none max-h-none rounded-none sm:rounded-none border-0 flex flex-col p-0 bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950 text-white shadow-2xl`}
        style={isMobile
          // Celular: anclado arriba-izquierda (top/bottom:0), sin el centrado de
          // Radix. Con top:50% + translateY(-50%) y height:100vh, si el alto real
          // de la ventana (WKWebView) no coincide con 100vh el diálogo se corre
          // hacia arriba y la primera fila del toolbar queda bajo la barra de estado.
          ? { height: 'auto', bottom: 0, maxHeight: 'none', overflow: 'hidden',
              paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))',
              paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)',
              ...prefs.contentStyle }
          : { height: '100vh', maxHeight: '100vh', overflow: 'hidden', ...prefs.contentStyle }}
        data-board-theme={prefs.settings.theme}
      >
        {/* DialogTitle/Description quedan para accesibilidad (Radix los exige)
            pero visualmente ocultos -- el título completo y las instrucciones
            no justifican una sección propia cuando la prioridad es la cancha. */}
        <DialogHeader className="sr-only">
          <DialogTitle>Tablero táctico — {teamName}</DialogTitle>
          <DialogDescription>{contextLabel} · arrastra jugadores a la cancha, toca la etiqueta para renombrarla</DialogDescription>
        </DialogHeader>

        {/* Toolbar con PALABRAS y una sola acción principal (F2 de
            docs/specs/rediseno-seguimiento-deportivo.md): Formación ·
            Jugadores · Dibujar · Material · Más · Guardar jugada. Antes eran
            íconos sueltos (marcador, ojo, persona, expandir) que nadie sabía
            leer, y "Plantilla" significaba dos cosas: el roster y las
            formaciones guardadas (ahora "Jugadores" y "Mis jugadas").
            En modo ver: solo Reproducir, Editar (si el rol puede) y Cerrar. */}
        {/* paddingTop con safe-area: en iPhone el diálogo ocupa la pantalla
            entera y sin esto la primera fila queda debajo del reloj/notch.
            pr-12 en celular: la X del Dialog (absolute, también bajo
            safe-area) cae sobre la primera fila. */}
        <div
          data-board-chrome=""
          className={`${landscapePhone ? 'pl-3 pr-12 pb-1 flex-nowrap gap-1' : 'pl-3 pr-12 md:px-4 pb-1.5 flex-wrap gap-1.5'} flex items-center border-b border-white/10 bg-black/30 shrink-0`}
          style={{ paddingTop: landscapePhone ? '0.25rem' : 'max(0.375rem, env(safe-area-inset-top))' }}
        >
          {/* En celular editando, el nombre del equipo se esconde: con él el
              toolbar ocupaba 3 filas y la cancha quedaba de 122 px de ancho. */}
          <span className={`text-xs font-bold text-white/80 truncate max-w-[110px] sm:max-w-none mr-1 ${isMobile && !viewing ? 'hidden' : ''}`} title={teamName}>
            {teamName}
          </span>

          {!loading && viewing && (
            <>
              <span className="hidden sm:inline text-[11px] text-white/60 truncate max-w-[220px]" title={contextLabel}>
                {contextLabel}
              </span>
              {!roleCanEdit && (
                <Badge variant="outline" className="h-6 text-[10px] border-amber-400/50 text-amber-300" title="Tu rol puede ver el tablero pero no modificarlo">
                  Solo lectura
                </Badge>
              )}
              <PlayMediaButtons media={media} onOpen={setMediaDialog} isMobile={isMobile} viewing className={`${TB_BTN} ${TB_IDLE}`} />
            </>
          )}

          {!loading && !viewing && (
            <>
              {/* M6a: galería de formaciones (equipo propio y rival en espejo). */}
              <FormationGallery
                sport={sport}
                formations={sportCfg.formations}
                initialPlayers={galleryPlayers}
                currentKey={formationKey}
                rivalCount={countRivals(arrows)}
                onApplyOwn={applyFormation}
                onApplyRival={applyRivalFormation}
                onClearRival={clearRival}
                triggerClassName={`${TB_BTN} ${TB_IDLE} ${landscapePhone ? 'max-w-[8.5rem] min-w-0' : ''}`}
              />

              <Button
                size="sm"
                variant="ghost"
                className={`${TB_BTN} ${rosterOpen ? TB_ON : TB_IDLE}`}
                onClick={toggleRoster}
                aria-pressed={rosterOpen}
                title="Jugadores del equipo: arrástralos a la cancha o pásalos a la banca"
              >
                <Users className="h-3.5 w-3.5" />
                <span className={isMobile ? 'sr-only' : ''}>Jugadores ·</span>
                <span data-testid="tb-roster-counts">{rosterCountsLabel(counts)}</span>
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className={`${TB_BTN} ${tacticsOpen ? TB_ON : TB_IDLE}`}
                onClick={toggleTactics}
                aria-pressed={tacticsOpen}
                title="Dibujar: flechas, recorridos de balón, lápiz, texto y material"
              >
                <PenLine className="h-3.5 w-3.5" />
                Dibujar{drawnCount > 0 ? ` (${drawnCount})` : ''}
              </Button>

              {/* M6b: «Configuración de los equipos» (TacticalTeamsDialog). */}
              <Button
                size="sm"
                variant="ghost"
                className={`${TB_BTN} ${teamsCtl.teams ? TB_ON : TB_IDLE} ${isMobile ? 'hidden' : ''}`}
                onClick={() => teamsCtl.setDialogOpen(true)}
                title="Nombre, escudo, colores y estilo de ficha de tu equipo y del rival"
                data-testid="tb-equipos"
              >
                <Shirt className="h-3.5 w-3.5" />
                Equipos
              </Button>

              {/* Celular: Material ya es una pestaña de la hoja de Dibujar. */}
              <Button
                size="sm"
                variant="ghost"
                className={`${TB_BTN} ${tacticsOpen && mobileTab === 'material' ? TB_ON : TB_IDLE} ${isMobile ? 'hidden' : ''}`}
                onClick={openMaterial}
                title="Material de entrenamiento: conos, balones, vallas, arcos, aros…"
              >
                <Package className="h-3.5 w-3.5" />
                Material
              </Button>

              <PlayMediaButtons media={media} onOpen={setMediaDialog} isMobile={isMobile} viewing={false} className={`${TB_BTN} ${TB_IDLE}`} />

              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className={`${TB_BTN} ${TB_IDLE}`} aria-label="Más opciones" title="Más opciones">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                    Más
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-64 max-h-[70vh] overflow-y-auto"
                  // Que cerrar el menú no le robe el foco al campo de nombre de
                  // "Guardar en Mis jugadas…" ni a los diálogos de confirmación.
                  onCloseAutoFocus={(e) => e.preventDefault()}
                >
                  {isMobile && (
                    <>
                      <PlayMediaMenuItems media={media} onOpen={setMediaDialog} />
                      {/* Celular: «Equipos» (M6b) y «Ajustes» (M6g) viven acá; en el toolbar no caben. */}
                      <DropdownMenuItem onSelect={() => window.setTimeout(() => teamsCtl.setDialogOpen(true), 0)} data-testid="tb-equipos-menu">
                        <Shirt className="h-4 w-4 mr-2" /> Equipos
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => window.setTimeout(() => setSettingsOpen(true), 0)}>
                        <Settings2 className="h-4 w-4 mr-2" /> Ajustes de la pizarra
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      Situación: <span className="ml-1 font-semibold">{SITUATION_LABEL[situation]}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup value={situation} onValueChange={(v) => handleChangeSituation(v as TacticalSituation)}>
                        {SITUATIONS.map((s) => (
                          <DropdownMenuRadioItem key={s} value={s}>{SITUATION_LABEL[s]}</DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Abrir · Mis jugadas de {SITUATION_LABEL[situation]}</DropdownMenuLabel>
                  <PresetTagFilterSub tags={presetTags(presets)} value={presetTag} onChange={setPresetTag} />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!presets || presets.length === 0}>
                      {presets && presets.length > 0 ? `Abrir una jugada (${filterPresetsByTag(presets, presetTag).length})` : 'Todavía no hay jugadas guardadas'}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-[60vh] overflow-y-auto">
                      {filterPresetsByTag(presets, presetTag).map((p) => (
                        <DropdownMenuItem key={p.id} onSelect={() => handleLoadPreset(p.id)}>
                          <span className={p.id === loadedPresetId ? 'font-semibold' : ''}>{p.name}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {loadedPresetId && (
                    <>
                      <DropdownMenuItem onSelect={() => handleLoadPreset(loadedPresetId)}>
                        <RotateCw className="h-4 w-4 mr-2" /> Volver a cargar «{loadedPresetName}»
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={requestDeletePreset} className="text-red-600 focus:text-red-600">
                        <Trash2 className="h-4 w-4 mr-2" /> Eliminar «{loadedPresetName}»
                      </DropdownMenuItem>
                    </>
                  )}

                  {/* «Guardar» aparte de «Abrir» y de «Vista» (antes iba todo
                      seguido y no se distinguía qué guardaba y qué solo cambiaba
                      cómo se ve la cancha). */}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="flex items-center gap-1.5" data-testid="tb-more-guardar">Guardar</DropdownMenuLabel>
                  {loadedPresetId && (
                    <DropdownMenuItem onSelect={handleUpdatePreset} disabled={updatePreset.isPending}>
                      <Bookmark className="h-4 w-4 mr-2" /> Actualizar «{loadedPresetName}»
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => setSavingName('')}>
                    <Plus className="h-4 w-4 mr-2" /> {loadedPresetId ? 'Guardar como jugada nueva…' : 'Guardar en Mis jugadas…'}
                  </DropdownMenuItem>
                  {/* T3: la jugada a la biblioteca de la escuela (sin atletas).
                      M6f: los deportes de nivel «cancha» (rugby, tenis…) no tienen biblioteca. */}
                  {isExerciseSport(sport) && (
                    <DropdownMenuItem onSelect={openLibrarySave}>
                      <Bookmark className="h-4 w-4 mr-2" /> Guardar en biblioteca…
                    </DropdownMenuItem>
                  )}

                  {scratch && (
                    <DropdownMenuItem onSelect={() => window.setTimeout(() => setAddToSessionOpen(true), 0)}>
                      <CalendarPlus className="h-4 w-4 mr-2" /> Agregar a una sesión…
                    </DropdownMenuItem>
                  )}

                  <DropdownMenuSeparator />
                  {/* «Vista» en su propio submenú: cambia cómo se ve, no guarda nada. */}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger data-testid="tb-more-vista">
                      <Eye className="h-4 w-4 mr-2" /> Vista de la cancha
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-60">
                  {/* M6d: plantillas de líneas, cámara, orientación, piso y colores. */}
                  <DropdownMenuItem onSelect={() => setTimeout(() => setCourtOpen(true), 0)} data-testid="tb-open-court">
                    <LayoutGrid className="h-4 w-4 mr-2" /> Campo…
                  </DropdownMenuItem>
                  {/* preventDefault: prender/apagar no cierra el menú (se
                      pueden ajustar varias cosas de una). */}
                  {sportCfg.showZonesOption && (
                    <DropdownMenuCheckboxItem checked={showZones} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setShowZones((v) => !v)}>
                      Zonas de la cancha
                    </DropdownMenuCheckboxItem>
                  )}
                  <DropdownMenuCheckboxItem checked={pinStyle === 'silhouette'} onSelect={(e) => e.preventDefault()} onCheckedChange={togglePinStyle}>
                    Jugadores como siluetas
                  </DropdownMenuCheckboxItem>
                  {pinStyle === 'disc' && (
                    <DropdownMenuCheckboxItem checked={showPhotos} onSelect={(e) => e.preventDefault()} onCheckedChange={togglePinPhotos}>
                      <span className="flex flex-col">
                        <span>Fotos de los jugadores</span>
                        <span className="text-[10px] text-muted-foreground leading-tight">Solo si los padres autorizaron el uso de la imagen</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  )}
                  {sportCfg.allowGkZoom && (
                    <DropdownMenuCheckboxItem checked={gkZoom} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setGkZoom((v) => !v)}>
                      Zoom al área (arqueros)
                    </DropdownMenuCheckboxItem>
                  )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>

              {loadedPresetName && (
                <span className="hidden md:inline text-[10px] text-white/60 truncate max-w-[160px]" title="Jugada de Mis jugadas cargada en la cancha">
                  Mis jugadas: <span className="text-white/85 font-semibold">{loadedPresetName}</span>
                </span>
              )}

              {savingName !== null && (
                <div className="flex items-center gap-1 basis-full sm:basis-auto">
                  <Input
                    autoFocus
                    value={savingName}
                    onChange={(e) => setSavingName(e.target.value)}
                    placeholder="Nombre de la jugada"
                    aria-label="Nombre de la jugada para Mis jugadas"
                    className="h-8 flex-1 sm:flex-none sm:w-[160px] text-[11px] bg-white/5 border-white/15 text-white placeholder:text-white/70"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAsPreset(); if (e.key === 'Escape') setSavingName(null); }}
                  />
                  <Button size="sm" className="h-8 text-[11px] px-2 bg-emerald-600 hover:bg-emerald-500 text-white" disabled={createPreset.isPending} onClick={handleSaveAsPreset}>
                    Guardar
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Cancelar" className="h-8 text-[11px] px-2 text-white/60 hover:text-white hover:bg-white/10" onClick={() => setSavingName(null)}>✕</Button>
                </div>
              )}
            </>
          )}

          {/* pr-8: la X nativa del Dialog (absolute right-4 top-4) queda
              encima del último botón si el toolbar llega hasta el borde. En el celular este grupo
              baja a su propia fila (la X queda arriba): sin el pr-8, que lo hacía
              7 px más ancho que la pantalla y corría toda la pizarra. */}
          <div className={`ml-auto flex items-center ${landscapePhone ? 'gap-1' : 'gap-1.5'} ${isMobile && !viewing ? 'pr-0' : 'pr-8'}`}>
            {/* «Exportar ▾» (T2) en ver y en editar; cada exportación es un
                evento de la métrica (T0). */}
            {!loading && roleCanEdit && hasAiAnalysis(sport) && (
              <Button
                size="sm"
                variant="ghost"
                className={`${TB_BTN} ${aiOpen ? TB_ON : TB_IDLE}`}
                onClick={() => { setAiOpen((v) => !v); setAiPreview(null); }}
                aria-pressed={aiOpen}
                disabled={playingSequence}
                title="La IA lee la jugada y sugiere riesgos, contraataques y variantes"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span className={isMobile ? 'hidden' : 'hidden sm:inline'}>Analizar jugada</span>
                <span className={isMobile ? '' : 'sm:hidden'}>IA</span>
              </Button>
            )}
            {!loading && (
              <TacticalBoardSettingsButton prefs={prefs} className={`${TB_BTN} ${TB_IDLE}`}
                open={settingsOpen} onOpenChange={setSettingsOpen} hideTrigger={isMobile && !viewing} />
            )}
            {!loading && (
              <TacticalExportMenu
                getInput={buildExportInputWithBranding}
                frameCount={liveFrames.length}
                hasContent={boardHasContent(liveFrames)}
                onAddFrame={canEdit && !framePlaybackActive ? addFrame : undefined}
                onShareLink={roleCanEdit ? () => void handleShareLink() : undefined}
                onEvent={(e: TacticalExportEvent) => logEvent(e)}
                disabled={playingSequence || sharingLink}
                compact
                className="text-[11px] px-2 bg-transparent border-white/20 text-white hover:bg-white/10 hover:text-white"
              />
            )}
            {/* «Ver en 3D» (M4): visor de los mismos cuadros, chunk aparte. */}
            {!loading && (
              <Tactical3DLauncher
                getInput={buildExportInput}
                onOpen={() => logEvent('view_3d')}
                disabled={playingSequence}
                className="h-8 min-w-0 text-[11px] px-2 bg-transparent border-white/20 text-white hover:bg-white/10 hover:text-white"
              />
            )}
            {viewing ? (
              <>
                {/* Con cuadros, Reproducir vive en la línea de tiempo de abajo. */}
                {!loading && hasAnimation && liveFrames.length < 2 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className={`${TB_BTN} ${playingSequence ? TB_ON : TB_IDLE}`}
                    onClick={handlePlayMovement}
                    aria-pressed={playingSequence}
                  >
                    {playingSequence ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5" />}
                    {playingSequence ? 'Detener' : 'Reproducir'}
                  </Button>
                )}
                {!loading && roleCanEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 text-[11px] px-2 bg-transparent border-white/20 text-white hover:bg-white/10 hover:text-white"
                    onClick={() => { if (playingSequence) stopPlayback(); setBoardMode('edit'); }}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </Button>
                )}
                <Button size="sm" className="h-8 text-[11px] px-3 bg-white/10 hover:bg-white/20 text-white" onClick={onClose}>
                  Cerrar
                </Button>
              </>
            ) : (
              <>
                {/* En celular la X del diálogo ya cierra: Cancelar solo ocupaba
                    lugar en el toolbar. */}
                <Button size="sm" variant="ghost" className={`${isMobile ? 'hidden' : 'hidden sm:inline-flex'} h-8 text-[11px] px-2 text-white/60 hover:text-white hover:bg-white/10`} onClick={onClose}>
                  Cancelar
                </Button>
                {scratch ? (
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        className="h-8 gap-1 text-[11px] px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                        disabled={saveLineup.isPending || loading || playingSequence}
                        data-testid="tb-scratch-save"
                      >
                        {saveLineup.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                        Guardar <ChevronDown className="h-3 w-3 opacity-80" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
                      <DropdownMenuItem onSelect={() => setSavingName('')}>
                        <Bookmark className="h-4 w-4 mr-2" /> Guardar en mis jugadas…
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => window.setTimeout(() => setAddToSessionOpen(true), 0)}>
                        <CalendarPlus className="h-4 w-4 mr-2" /> Agregar a una sesión…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                <Button
                  size="sm"
                  className="h-8 text-[11px] px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                  onClick={() => void handleSave()}
                  // Durante "Reproducir jugada" los pines están a mitad de camino:
                  // guardar ahora persistiría posiciones intermedias.
                  disabled={saveLineup.isPending || loading || playingSequence}
                  title={playingSequence ? 'Espera a que termine la reproducción o presiona Detener' : 'Guarda los jugadores y los dibujos de esta sesión'}
                >
                  {saveLineup.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                  Guardar jugada
                </Button>
                )}
              </>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-white/50" />
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            onDragStart={() => { if (playingSequence) stopPlayback(); exitFramePlayback(); }}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setAlignGuides({ x: [], y: [] })}
          >
            {/* Fila: cancha (usa lo que sobre) + panel de plantilla a la
                derecha, en el margen lateral que antes quedaba vacío -- ya no
                tapa la cancha por abajo. El lado izquierdo se deja libre a
                propósito (futuro panel de tácticas), sin agregar nada ahí
                todavía para no saturar la pantalla. */}
            <div className="relative flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
              {/* Columna: cancha + línea de tiempo de los cuadros debajo. */}
              <div className="flex-1 min-h-0 min-w-0 flex flex-col">
              <div ref={pitchAreaRef} className={`relative flex-1 min-h-0 flex items-center justify-center px-3 sm:px-6 ${landscapePhone ? 'py-1.5' : 'py-3'} overflow-hidden`}>
                {/* Ancho = alto de pantalla menos el toolbar (~90px) convertido
                    a ancho según la proporción de la cancha (300/340), topado
                    en 1100px. El 100% final del min() ya cubre el caso de que
                    el panel de plantilla angoste el espacio disponible.

                    100vh, no 100dvh -- el mismo cambio que en LineupModal.tsx:
                    dvh se comportaba distinto entre la ventana real de un
                    navegador y la vista emulada donde se probaba originalmente
                    (el comentario viejo decía "verificado en pantalla real",
                    pero esa verificación no cubría esta inconsistencia
                    puntual). Con dvh mal resuelto, "(100dvh-90px)" podía dar
                    un número mucho menor al real y el min() elegía ESE
                    resultado achicado en vez de 580px -- exactamente el
                    síntoma de "se ve aprisionado" en un dispositivo real. */}
                <div
                  ref={pitchRef}
                  data-testid="tablero-cancha"
                  className="relative rounded-2xl overflow-hidden select-none shadow-[0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
                  style={{
                    // Proporción = la de la ventana visible (300 × alto visible del
                    // viewBox), así las líneas de la cancha no se deforman ni con zoom.
                    // Ancho: alto disponible convertido a ancho por esa proporción,
                    // topado (más ancho en zoom: la ventana es apaisada).
                    aspectRatio: `300 / ${(view.y1 - view.y0) * 3.4}`,
                    // Con el área medida: el ancho que entra a lo ancho Y a lo
                    // alto (alto disponible × proporción). Antes de medir (primer
                    // render) cae a la fórmula vieja.
                    ['--pin-k' as string]: pinK,
                    width: pitchW !== null
                      ? `${pitchW}px`
                      : `min(${zoomedView ? 1400 : 1100}px, calc((100vh - 90px) * 300 / ${(view.y1 - view.y0) * 3.4}), 100%)`,
                  }}
                >
                  {/* T4: fondo del deporte del equipo. Fútbol 11 = FootballPitchBackground tal cual. */}
                  <CourtBackground sport={sport} viewBox={viewBoxOf(view)} court={courtCfg} />
                  {showZones && sportCfg.showZonesOption && <ZoneOverlay view={view} />}
                  {aiPreview && <TacticalAiOverlay preview={aiPreview} view={view} />}
                  {!viewing && !framePlaybackActive && emptySlots.map((es) => (
                    <EmptySlotMarker
                      key={es.id}
                      slot={es}
                      view={view}
                      onRemove={() => setEmptySlots((prev) => prev.filter((s) => s.id !== es.id))}
                    />
                  ))}
                  {trail.length > 0 && (
                    <svg viewBox={viewBoxOf(view)} preserveAspectRatio="none" className="absolute inset-0 w-full h-full z-[6] pointer-events-none" aria-hidden="true">
                      {trail.map((m) => (
                        <g key={m.key}>
                          <circle cx={m.from.x * 3} cy={m.from.y * 3.4} r={4.5} fill="#ffffff" fillOpacity={0.12} stroke="#ffffff" strokeOpacity={0.45} strokeWidth={0.8} strokeDasharray="2 2" />
                          <line x1={m.from.x * 3} y1={m.from.y * 3.4} x2={m.to.x * 3} y2={m.to.y * 3.4}
                            stroke="#ffffff" strokeOpacity={0.5} strokeWidth={1.2} strokeDasharray="3 3" strokeLinecap="round" />
                        </g>
                      ))}
                    </svg>
                  )}
                  {!framePlaybackActive && Object.entries(placed).map(([key, slot]) => {
                    const subject = subjectByKey.get(key);
                    if (!subject) return null;
                    return (
                      <PitchPin
                        key={key}
                        subject={subject}
                        slot={slot}
                        onLabelChange={(label) => setPlaced((prev) => ({ ...prev, [key]: { ...prev[key], slot_label: label, labelIsCustom: true } }))}
                        onRemove={() => removeFromPitch(key)}
                        onOpenCard={() => setCardSubject(subject)}
                        events={eventSummaryByKey.get(key)}
                        animate={animatingMove}
                        pinStyle={pinStyle}
                        showPhotos={showPhotos}
                        readOnly={!canEdit}
                        view={view}
                      />
                    );
                  })}
                  {/* z-40: intercepta el puntero cuando drawMode o
                      measureMode están activos, así el gesto dibuja/mide en
                      vez de arrastrar a un jugador. El resto del tiempo es
                      pointer-events-none y los pines se arrastran normal --
                      salvo los handles de cada figura, que son siempre
                      interactivos (ver comentario dentro de ArrowLayer). */}
                  {framePlaybackActive && playbackFrames ? (
                    <TacticalFramePlayback
                      frames={playbackFrames}
                      clock={clock}
                      view={view}
                      renderPlayer={renderPlaybackPlayer}
                      renderShapes={renderPlaybackShapes}
                      playback={prefs.playback}
                    />
                  ) : (
                  <ArrowLayer
                    shapes={inkForSurface(courtCfg, arrows)}
                    drawMode={drawMode && !viewing}
                    drawShapeType={drawShapeType}
                    drawColor={drawColor}
                    ballKind={ballKind}
                    newObjSize={newObjSize}
                    newObjRot={newObjRot}
                    measureMode={measureMode && !viewing}
                    readOnly={viewing}
                    pitchLengthMeters={pitchLengthMeters}
                    view={view}
                    pinStyle={pinStyle}
                    selectedIndex={selectedShape}
                    ghostBalls={ghostBalls}
                    hiddenIndexes={hiddenBallIdx}
                    onCreateShape={handleCreateShape}
                    onUpdateShape={handleUpdateShape}
                    onDeleteShape={handleDeleteShape}
                    onSelectShape={setSelectedShape}
                    onEraseShapes={handleEraseShapes}
                    drawOptions={drawTools.drawOptions}
                    polygonDraft={polygon}
                  />
                  )}
                  <LineLegendOverlay styles={lineStylesIn(arrows)} />
                  {courtCfg.orient === 'h' && (
                    <span className="absolute right-1.5 top-1.5 z-[45] pointer-events-none rounded-full bg-zinc-950/75 px-2 py-0.5 text-[10px] font-semibold text-white">
                      Horizontal al exportar
                    </span>
                  )}
                  {/* "Empieza aquí": la cancha vacía con los paneles cerrados
                      no decía qué hacer (la instrucción estaba en sr-only).
                      Se va sola apenas hay algo en la cancha, y se esconde con
                      un panel abierto (Dibujar/Material/Jugadores): ahí el
                      coach ya eligió qué hacer y el aviso taparía la cancha. */}
                  {canEdit && pitchIsEmpty && !emptyHintDismissed && !tacticsOpen && !rosterOpen && subjects.length > 0 && (
                    <div className={`absolute inset-0 z-[45] flex items-center justify-center pointer-events-none ${smallPitch ? 'p-1.5' : 'p-3'}`}>
                      <div
                        role="region"
                        aria-label="Empieza aquí"
                        className={`pointer-events-auto w-full min-w-0 max-w-[290px] overflow-hidden rounded-2xl bg-zinc-950/85 backdrop-blur-sm ring-1 ring-white/15 shadow-2xl text-center ${smallPitch ? 'p-2 space-y-1.5' : 'p-4 space-y-2.5'}`}
                      >
                        <p className={`font-bold text-white ${smallPitch ? 'text-sm' : 'text-base'}`}>Empieza aquí</p>
                        {!smallPitch && (
                          <p className="text-xs text-white/75 leading-snug">
                            Pon a tus jugadores en la cancha o dibuja un ejercicio. Todo se puede mover después.
                          </p>
                        )}
                        <Button
                          className={`w-full min-w-0 h-auto py-1.5 gap-1.5 font-bold whitespace-normal bg-emerald-600 hover:bg-emerald-500 text-white ${smallPitch ? 'min-h-9 px-2 text-xs' : 'min-h-11 py-2 gap-2 text-sm'}`}
                          onClick={() => applyFormation(defaultFormation)}
                        >
                          <LayoutGrid className="h-4 w-4 shrink-0" />
                          <span className="flex min-w-0 flex-col items-center leading-tight">
                            <span>Poner jugadores</span>
                            <span className={`font-semibold text-white/85 break-words ${smallPitch ? 'text-[10px]' : 'text-xs'}`}>{startHintFormationLabel(defaultFormation)}</span>
                          </span>
                        </Button>
                        <Button
                          variant="outline"
                          className={`w-full min-w-0 gap-1.5 px-2 font-semibold whitespace-normal bg-transparent border-white/25 text-white hover:bg-white/10 hover:text-white ${smallPitch ? 'h-auto min-h-9 py-1 text-xs' : 'h-11 gap-2 text-sm'}`}
                          onClick={openDrawingFromHint}
                        >
                          <PenLine className="h-4 w-4" />
                          Dibujar un ejercicio
                        </Button>
                        {canAskAi && (
                          <Button
                            variant="outline"
                            className={`w-full min-w-0 gap-1.5 px-2 font-semibold whitespace-normal bg-transparent border-amber-300/40 text-amber-200 hover:bg-amber-300/10 hover:text-amber-100 ${smallPitch ? 'h-auto min-h-9 py-1 text-xs' : 'h-11 gap-2 text-sm'}`}
                            onClick={openAiFromHint}
                            data-testid="hint-ask-ai"
                          >
                            <Sparkles className="h-4 w-4" />
                            Pídele una jugada a la IA
                          </Button>
                        )}
                        <button
                          type="button"
                          className="text-[11px] text-white/65 underline underline-offset-2 hover:text-white"
                          onClick={() => { setEmptyHintDismissed(true); setRosterOpen(true); if (isMobile) setTacticsOpen(false); }}
                        >
                          Prefiero arrastrarlos yo
                        </button>
                      </div>
                    </div>
                  )}
                  {viewing && pitchIsEmpty && (
                    <div className="absolute inset-0 z-[45] flex items-center justify-center p-3 pointer-events-none">
                      <p className="rounded-xl bg-zinc-950/80 ring-1 ring-white/10 px-4 py-3 text-xs text-white/80 text-center max-w-[260px]">
                        Todavía no hay una jugada guardada para esta sesión.
                        {roleCanEdit ? ' Toca Editar para armarla.' : ''}
                      </p>
                    </div>
                  )}
                  {/* Guías de alineación mientras se arrastra un jugador ya
                      puesto -- puramente visuales, encima de todo (z-50). */}
                  {(alignGuides.x.length > 0 || alignGuides.y.length > 0) && (
                    <svg viewBox={viewBoxOf(view)} preserveAspectRatio="none" className="absolute inset-0 w-full h-full z-50 pointer-events-none">
                      {alignGuides.x.map((x, i) => (
                        <line key={`x${i}`} x1={x * 3} y1={0} x2={x * 3} y2={340} stroke="#34d399" strokeWidth={1} strokeDasharray="4 4" opacity={0.8} />
                      ))}
                      {alignGuides.y.map((y, i) => (
                        <line key={`y${i}`} x1={0} y1={y * 3.4} x2={300} y2={y * 3.4} stroke="#34d399" strokeWidth={1} strokeDasharray="4 4" opacity={0.8} />
                      ))}
                    </svg>
                  )}
                </div>
              </div>
              <FrameNoteBar frames={timelineFrames} frameIndex={frameIndex} clock={clock} playing={framePlaybackActive}
                compact={landscapePhone || (isMobile && (tacticsOpen || rosterOpen))} />
              {timeline}
              {possessionBar}
              </div>

              {/* Panel de pizarra táctica -- a la izquierda, en el margen que
                  antes quedaba vacío. Se abre con "Dibujar" o "Material" del
                  toolbar. Todo pasa dentro del mismo modal del tablero, sin
                  vistas aparte. */}
              {tacticsOpen && !viewing && (
                <div
                  data-board-chrome=""
                  className="w-full md:w-[252px] shrink-0 border-t md:border-t-0 md:border-r border-white/10 bg-black/30 backdrop-blur-sm overflow-y-auto overscroll-contain px-3 py-3 space-y-3 order-last md:order-first"
                  style={isPortraitPhone
                    ? { height: sheetCollapsed ? 'auto' : `${SHEET_VH}vh`, paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }
                    : undefined}
                  data-sheet-collapsed={isPortraitPhone && sheetCollapsed ? 'true' : undefined}
                >
                  {isMobile && (
                    // Celular: acciones de siempre fijas arriba + pestañas. Lo de
                    // abajo muestra solo la sección de la pestaña elegida.
                    <div className="sticky -top-3 z-10 -mx-3 -mt-3 px-3 pt-3 pb-2 bg-zinc-950/95 border-b border-white/10 space-y-2">
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          className={`h-9 flex-1 gap-1 text-[11px] px-2 ${drawMode ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-white/5 hover:bg-white/10 text-white border border-white/15'}`}
                          onClick={() => { setDrawMode((v) => !v); setMeasureMode(false); }}
                          aria-pressed={drawMode}
                          title={drawMode ? 'Toca para dejar de dibujar y mover fichas' : 'Toca para volver a dibujar'}
                        >
                          <PenLine className="h-3.5 w-3.5" /> {drawMode ? 'Dibujando' : 'Mover fichas'}
                        </Button>
                        <Button size="sm" variant="outline" aria-label={playingSequence ? 'Detener reproducción' : 'Reproducir jugada'}
                          aria-pressed={playingSequence}
                          title={playingSequence ? 'Detener reproducción' : 'Reproducir jugada'}
                          className={`h-9 w-10 p-0 bg-transparent border-white/15 hover:bg-white/10 hover:text-white ${playingSequence ? 'text-emerald-400' : 'text-white/80'}`}
                          onClick={handlePlayMovement}>
                          {playingSequence ? <Square className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4" />}
                        </Button>
                        <Button size="sm" variant="outline" aria-label="Deshacer" title="Deshacer"
                          className="h-9 w-10 p-0 bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30"
                          disabled={!canUndo} onClick={undo}>
                          <Undo2 className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" aria-label="Rehacer" title="Rehacer"
                          className="h-9 w-10 p-0 bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30"
                          disabled={!canRedo} onClick={redo}>
                          <Redo2 className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" aria-label="Borrar todo" title="Borrar todo"
                          className="h-9 w-10 p-0 bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-red-400 disabled:opacity-30"
                          disabled={drawnCount === 0} onClick={requestClearDrawings}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        {isPortraitPhone && (
                          <Button size="sm" variant="outline"
                            aria-label={sheetCollapsed ? 'Mostrar herramientas' : 'Plegar herramientas'}
                            title={sheetCollapsed ? 'Mostrar herramientas' : 'Plegar herramientas (más cancha)'}
                            aria-expanded={!sheetCollapsed}
                            data-testid="tb-sheet-toggle"
                            className="h-9 w-10 p-0 bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white"
                            onClick={() => setSheetCollapsed((v) => !v)}>
                            {sheetCollapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          </Button>
                        )}
                      </div>
                      {/* Partes iguales y sin scroll: 6 pestañas entran en 360px. */}
                      <div className="flex gap-1 overflow-x-auto scrollbar-none" role="tablist" aria-label="Herramientas de la pizarra">
                        {MOBILE_TABS.map((t) => (
                          <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={mobileTab === t.key}
                            onClick={() => {
                              // Tocar la pestaña abierta con la hoja abierta la pliega; si no, la abre en esa pestaña.
                              if (isPortraitPhone && mobileTab === t.key && !sheetCollapsed) { setSheetCollapsed(true); return; }
                              setMobileTab(t.key);
                              setSheetCollapsed(false);
                            }}
                            className={`flex-1 min-w-fit shrink-0 whitespace-nowrap h-8 px-2 rounded-full text-[11px] font-semibold border ${
                              mobileTab === t.key ? 'bg-white text-zinc-900 border-white' : 'bg-white/5 border-white/15 text-white/70'
                            }`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className={isMobile ? 'hidden' : ''}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">Pizarra táctica</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-8 gap-1.5 text-xs justify-start bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white mb-1.5"
                      onClick={handlePlayMovement}
                      title="Anima a cada jugador hasta la punta de su flecha/curva y lo devuelve; se puede repetir"
                    >
                      {playingSequence ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5" />}
                      {playingSequence ? 'Detener' : 'Reproducir jugada'}
                    </Button>
                    <Button
                      size="sm"
                      className={`w-full h-8 gap-1.5 text-xs justify-start ${drawMode ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-white/5 hover:bg-white/10 text-white border border-white/15'}`}
                      onClick={() => { setDrawMode((v) => !v); setMeasureMode(false); }}
                    >
                      <PenLine className="h-3.5 w-3.5" />
                      {drawMode ? 'Dibujando…' : 'Modo dibujo'}
                    </Button>
                    <p className="text-[10px] text-white/70 mt-1.5 leading-snug">
                      {drawMode
                        ? 'Arrastra sobre la cancha para dibujar. Los puntos blancos de cada figura se pueden arrastrar para ajustarla; tócala para borrarla.'
                        : 'Activa el modo dibujo y arrastra sobre la cancha. Ya puestas, cada figura se ajusta o se borra sin necesidad de este modo.'}
                    </p>
                  </div>

                  <div className={tabCls('escribir')}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">Escribir</p>
                    <div className="flex gap-1.5">
                      {([
                        { type: 'freehand' as const, label: 'Lápiz', Icon: Pencil },
                        { type: 'text' as const, label: 'Texto', Icon: Type },
                        { type: 'eraser' as const, label: 'Borrador', Icon: Eraser },
                      ]).map(({ type, label, Icon }) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => pickTool(type)}
                          className={`flex-1 h-9 rounded text-[10px] font-semibold border flex flex-col items-center justify-center leading-none gap-0.5 ${
                            drawMode && drawShapeType === type
                              ? 'bg-emerald-600 border-emerald-500 text-white'
                              : 'bg-white/5 border-white/15 text-white/70 hover:bg-white/10'
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="hidden md:block text-[10px] text-white/70 mt-1 leading-snug">
                      {drawShapeType === 'text'
                        ? 'Toca la cancha donde va la nota y escribe; Enter la deja puesta.'
                        : drawShapeType === 'eraser'
                        ? 'Pasa el dedo por encima de lo que quieras quitar.'
                        : 'Raya libre con el dedo o el lápiz: encierra jugadores, marca recorridos, escribe a mano.'}
                    </p>
                  </div>

                  <div className={tabCls('lineas')}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">Líneas</p>
                    <div className="flex gap-1.5">
                      {([
                        { type: 'arrow' as const, label: 'Flecha' },
                        { type: 'curve' as const, label: 'Curva' },
                        { type: 'zone' as const, label: 'Zona' },
                      ]).map((opt) => (
                        <button
                          key={opt.type}
                          type="button"
                          onClick={() => pickTool(opt.type)}
                          className={`flex-1 h-7 rounded text-[10px] font-semibold border ${
                            drawShapeType === opt.type
                              ? 'bg-emerald-600 border-emerald-500 text-white'
                              : 'bg-white/5 border-white/15 text-white/70 hover:bg-white/10'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={tabCls('lineas')}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">Balón en juego</p>
                    <div className="flex gap-1.5">
                      {(Object.keys(BALL_PATH_LABEL) as BallPathKind[]).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => pickTool('ball_path', k)}
                          className={`flex-1 h-7 rounded text-[10px] font-semibold border ${
                            drawShapeType === 'ball_path' && ballKind === k
                              ? 'bg-emerald-600 border-emerald-500 text-white'
                              : 'bg-white/5 border-white/15 text-white/70 hover:bg-white/10'
                          }`}
                        >
                          {BALL_PATH_LABEL[k]}
                        </button>
                      ))}
                    </div>
                    <p className="hidden md:block text-[10px] text-white/70 mt-1 leading-snug">
                      Arrastra desde donde sale el balón hasta donde llega. En "Reproducir jugada" el balón recorre la línea; remate y penal lo muestran elevándose.
                    </p>
                  </div>

                  {/* M6d: tipo de línea, zonas con forma, resaltar jugador y numeración. */}
                  <TacticalDrawToolsPanel
                    className={tabCls('lineas')}
                    tools={drawTools}
                    drawMode={drawMode}
                    drawShapeType={drawShapeType}
                    pickTool={pickTool}
                    selected={selected}
                    selectedIndex={selectedShape}
                    onUpdateShape={handleUpdateShape}
                    onRenumber={() => setArrows((prev) => renumber(prev))}
                    polygonPoints={polygon.points.length}
                    onClosePolygon={polygon.close}
                    onCancelPolygon={polygon.cancel}
                  />

                  <div ref={materialSectionRef} className={tabCls('material')}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">Material</p>
                    <div className="grid grid-cols-4 md:grid-cols-2 gap-1.5">
                      {/* T4: solo el material que tiene sentido en el deporte. */}
                      {sportCfg.objects.map((type) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => pickTool(type)}
                          title={OBJECT_LABEL[type]}
                          className={`h-8 px-1 md:px-1.5 min-w-0 rounded text-[10px] font-semibold border flex items-center gap-1 md:gap-1.5 ${
                            drawShapeType === type
                              ? 'bg-emerald-600 border-emerald-500 text-white'
                              : 'bg-white/5 border-white/15 text-white/70 hover:bg-white/10'
                          }`}
                        >
                          {/* Vista previa con el color elegido: el mismo dibujo que va a la cancha. */}
                          <svg viewBox="-19 -19 38 38" className="h-5 w-5 md:h-6 md:w-6 shrink-0" aria-hidden="true">
                            <ObjectIcon type={type} x={0} y={0} size={type === 'goal' || type === 'ladder' ? 0.9 : 1.15} color={drawColor} pinStyle={pinStyle} />
                          </svg>
                          <span className="truncate">{OBJECT_LABEL[type]}</span>
                        </button>
                      ))}
                    </div>
                    <p className="hidden md:block text-[10px] text-white/70 mt-1 leading-snug">
                      Un toque en la cancha lo coloca. Arrástralo para moverlo; tócalo para seleccionarlo (tamaño, giro, duplicar, quitar).
                    </p>
                  </div>
                  <div className={tabCls('color')}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">Color</p>
                    <div className="flex flex-wrap gap-2">
                      {(Object.keys(ARROW_COLOR_HEX) as TacticalArrowColor[]).map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setDrawColor(c)}
                          aria-label={`Color ${COLOR_LABEL[c]}`}
                          title={COLOR_LABEL[c]}
                          className={`h-6 w-6 rounded-full border-2 transition-transform ${drawColor === c ? 'border-emerald-400 scale-110 ring-2 ring-emerald-400/40' : 'border-white/30'}`}
                          style={{ backgroundColor: ARROW_COLOR_HEX[c] }}
                        />
                      ))}
                    </div>
                    <p className="hidden md:block text-[10px] text-white/70 mt-1 leading-snug">
                      Aplica a líneas, zonas y material. Zonas de distinto color = distintas consignas.
                    </p>
                  </div>

                  <div className={`pt-2 border-t border-white/10 ${tabCls('ajustes')}`}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">
                      {selectedIsObject
                        ? `Seleccionado: ${selected!.type === 'text' ? 'Texto' : selected!.type === 'spotlight' ? 'Foco' : OBJECT_LABEL[selected!.type as ObjectType]}`
                        : 'Tamaño y giro al colocar'}
                    </p>
                    <label className="flex items-center gap-2 text-[10px] text-white/60">
                      <span className="w-12 shrink-0">Tamaño</span>
                      <input
                        type="range"
                        min={OBJ_SIZE_MIN}
                        max={OBJ_SIZE_MAX}
                        step={0.1}
                        value={panelSize}
                        onChange={(e) => setPanelSize(Number(e.target.value))}
                        className="flex-1 min-w-0 accent-emerald-500"
                        aria-label="Tamaño del objeto"
                      />
                      <span className="w-9 text-right tabular-nums text-white/80">{panelSize.toFixed(1)}×</span>
                    </label>
                    <label className="flex items-center gap-2 text-[10px] text-white/60 mt-1">
                      <span className="w-12 shrink-0">Giro</span>
                      <input
                        type="range"
                        min={0}
                        max={355}
                        step={5}
                        value={panelRot}
                        onChange={(e) => setPanelRot(Number(e.target.value))}
                        className="flex-1 min-w-0 accent-emerald-500"
                        aria-label="Giro del objeto"
                      />
                      <span className="w-9 text-right tabular-nums text-white/80">{panelRot}°</span>
                    </label>
                    <div className="flex gap-1.5 mt-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-7 gap-1 text-[11px] bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white"
                        onClick={() => setPanelRot(panelRot + 90)}
                        title="Girar 90° (dos veces = arco mirando hacia abajo)"
                      >
                        <RotateCw className="h-3.5 w-3.5" /> +90°
                      </Button>
                      {selectedIsObject && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1 h-7 gap-1 text-[11px] bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white"
                            onClick={handleDuplicateSelected}
                            title="Copia el objeto con su tamaño y giro, un poco desplazado"
                          >
                            <Copy className="h-3.5 w-3.5" /> Duplicar
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 w-7 p-0 bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-red-400"
                            onClick={() => handleDeleteShape(selectedShape!)}
                            title="Quitar el objeto seleccionado"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                    <p className="hidden md:block text-[10px] text-white/70 mt-1 leading-snug">
                      {selectedIsObject && selected!.type === 'text'
                        ? 'Arrástralo para moverlo; tócalo de nuevo para cambiar lo que dice; la × lo quita.'
                        : selectedIsObject
                        ? 'Arrástralo para moverlo; el punto verde de arriba lo gira; la × lo quita. Tócalo de nuevo para deseleccionar.'
                        : 'Se aplica a los objetos nuevos. Toca un objeto ya puesto para editar el suyo.'}
                    </p>
                  </div>

                  <div className={`flex gap-1.5 ${isMobile ? 'hidden' : ''}`}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 min-w-0 h-7 gap-1 px-1.5 text-[11px] whitespace-nowrap bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30"
                      disabled={!canUndo}
                      onClick={undo}
                      title="Deshacer (Ctrl+Z)"
                    >
                      <Undo2 className="h-3.5 w-3.5 shrink-0" /> Deshacer
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label="Rehacer"
                      title="Rehacer (Ctrl+Shift+Z)"
                      className="h-7 w-7 shrink-0 p-0 bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30"
                      disabled={!canRedo}
                      onClick={redo}
                    >
                      <Redo2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 min-w-0 h-7 gap-1 px-1.5 text-[11px] whitespace-nowrap bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-red-400 disabled:opacity-30"
                      disabled={drawnCount === 0}
                      onClick={requestClearDrawings}
                      title="Borrar todos los dibujos"
                    >
                      <Eraser className="h-3.5 w-3.5 shrink-0" /> Borrar todo
                    </Button>
                  </div>
                  <p className={`text-[10px] text-white/70 ${isPortraitPhone && sheetCollapsed ? 'hidden' : ''}`}>
                    {drawnCount} {drawnCount === 1 ? 'figura' : 'figuras'} · se guardan con la jugada.
                  </p>

                  <div className={`pt-2 border-t border-white/10 ${tabCls('medir')}`}>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">Medir distancia</p>
                    <Button
                      size="sm"
                      className={`w-full h-8 gap-1.5 text-xs justify-start ${measureMode ? 'bg-amber-500 hover:bg-amber-400 text-black' : 'bg-white/5 hover:bg-white/10 text-white border border-white/15'}`}
                      onClick={() => { setMeasureMode((v) => !v); setDrawMode(false); }}
                    >
                      <Ruler className="h-3.5 w-3.5" />
                      {measureMode ? 'Midiendo…' : 'Regla'}
                    </Button>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <label className="text-[10px] text-white/50 whitespace-nowrap">Largo cancha</label>
                      <Input
                        type="number"
                        min={1}
                        value={courtLengthMeters}
                        onChange={(e) => setPitchLengthMeters(Math.max(1, Number(e.target.value) || 1))}
                        className="h-6 text-[10px] px-1.5 bg-white/5 border-white/15 text-white"
                      />
                      <span className="text-[10px] text-white/50">m</span>
                    </div>
                    <p className="hidden md:block text-[10px] text-white/70 mt-1 leading-snug">
                      Toca 2 puntos en la cancha. Es aproximado: se calcula con el largo que pongas arriba, no con el tamaño real de tu cancha.
                    </p>
                  </div>
                </div>
              )}

              {/* Panel de plantilla/banca -- ahora es un panel lateral real
                  (no flotante encima de la cancha). Se abre y cierra con el
                  botón "Jugadores" del toolbar; el usuario decide si lo deja
                  visible todo el tiempo o lo oculta. */}
              {rosterOpen && !viewing && (
                <div
                  className="w-full md:w-[260px] shrink-0 border-t md:border-t-0 md:border-l border-white/10 bg-black/30 backdrop-blur-sm overflow-y-auto overscroll-contain px-3 py-3 space-y-3"
                  style={isPortraitPhone ? { height: `${SHEET_VH}vh`, paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' } : undefined}
                >
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 gap-1.5 text-[11px] bg-transparent border-white/15 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30"
                      disabled={!canSuggestXI}
                      onClick={handleSuggestXI}
                      title={
                        Object.keys(placed).length > 0
                          ? 'Vacía la cancha primero: no reemplaza una alineación ya armada'
                          : suggestibleCount < MIN_SUGGEST_SAMPLE
                            ? `Necesitas al menos ${MIN_SUGGEST_SAMPLE} jugadores con partidos registrados`
                            : 'Ubica un XI de partida ordenado por minutos jugados en la temporada'
                      }
                    >
                      <Sparkles className="h-3.5 w-3.5" /> Sugerir XI
                    </Button>
                    <p className="text-[10px] text-white/70 mt-1 mb-2 leading-snug">
                      Por minutos jugados, en una formación genérica (no es la posición real de cada uno).
                    </p>
                  </div>

                  <div>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">
                      Disponibles ({availableSubjects.length})
                    </p>
                    {availableSubjects.length === 0 ? (
                      <p className="text-xs text-white/70 italic">Todos los jugadores ya están ubicados.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {availableSubjects.map((s) => (
                          <BenchDraggable
                            key={subjectKey(s.subject_type, s.subject_id)}
                            subject={s}
                            onOpenCard={() => setCardSubject(s)}
                            needsRotation={rotationKeys.has(subjectKey(s.subject_type, s.subject_id))}
                            showPhotos={showPhotos}
                            readOnly={!canEdit}
                          />
                        ))}
                      </div>
                    )}
                    {availableSubjects.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {availableSubjects.map((s) => {
                          const key = subjectKey(s.subject_type, s.subject_id);
                          return (
                            <Button
                              key={key}
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-5 text-[9px] px-1.5 bg-transparent border-white/15 text-white/70 hover:bg-white/10 hover:text-white"
                              onClick={() => toggleBench(key)}
                            >
                              + {s.full_name.split(' ')[0]} a banca
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="text-[10px] font-bold text-white/60 mb-1.5 uppercase tracking-widest">
                      Banca ({benchKeys.size})
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(benchKeys).map((key) => {
                        const subject = subjectByKey.get(key);
                        if (!subject) return null;
                        return (
                          <Badge key={key} variant="secondary" className="gap-1.5 pr-1 bg-white/10 text-white border border-white/15 hover:bg-white/15 text-[11px]">
                            {subject.full_name}
                            <button type="button" onClick={() => toggleBench(key)} aria-label="Quitar de la banca">
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              {/* Panel IA dentro de la fila de la cancha (no de todo el diálogo):
                  así no tapa el toolbar (Exportar, Ver en 3D, Guardar, la X). */}
              <TacticalAiPanel
                open={aiOpen && !loading}
                onClose={() => { setAiOpen(false); setAiPreview(null); }}
                getRequest={() => {
                  const list = committedFrames().map((f) => ({ ...f, players: f.players.filter((p) => subjectByKey.has(p.key)) }));
                  if (!list.some((f) => f.players.length > 0)) return null;
                  // `formation`: contexto para la IA (el BFF también la deduce por posiciones).
                  // Va por variable para compilar aunque esta rama todavía no tenga el parámetro.
                  const aiArgs = { teamId, sport, frames: list, labelOf: (k: string) => (placed[k] ?? metaRef.current[k])?.slot_label, intention: media.intention, formation: formationKey };
                  return buildAnalyzeRequest(aiArgs);
                }}
                sport={sport}
                canApply={roleCanEdit}
                preview={aiPreview}
                onPreview={setAiPreview}
                onApply={applyAiFrames}
                isMobile={isPortraitPhone}
                narrow={landscapePhone}
                get3DSource={buildExportInput}
                onEvent={(e) => logEvent(e)}
              />
            </div>
          </DndContext>
        )}
      </DialogContent>
    </Dialog>
    </TacticalBoardPrefsProvider>
    {cardSubject && roster && (
      <PlayerCard
        open={!!cardSubject}
        onClose={() => setCardSubject(null)}
        subject={cardSubject}
        metrics={roster.metrics}
        latestValues={roster.latest_values}
      />
    )}
    <AlertDialog open={!!confirmAction} onOpenChange={(v) => { if (!v) setConfirmAction(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirmAction?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const action = confirmAction;
              setConfirmAction(null);
              action?.onConfirm();
            }}
          >
            {confirmAction?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {scratch && addToSessionOpen && (
      <Suspense fallback={null}>
        <PizarraAgregarASesionDialog
          open={addToSessionOpen}
          onOpenChange={setAddToSessionOpen}
          teamId={teamId}
          onPick={(blockId, label) => void addToSessionBlock(blockId, label)}
        />
      </Suspense>
    )}
    {courtOpen && (
      <Suspense fallback={null}>
        <TacticalCourtDialog
          open={courtOpen}
          onOpenChange={setCourtOpen}
          sport={sport}
          court={courtCfg}
          onChange={setCourtConfig}
          allowArea={sportCfg.allowGkZoom}
        />
      </Suspense>
    )}
    {libraryBoard && isExerciseSport(sport) && (
      <SaveToLibraryDialog
        open={!!libraryBoard}
        onOpenChange={(v) => { if (!v) setLibraryBoard(null); }}
        board={libraryBoard}
        defaultSport={sport}
        defaultTags={libraryBoard.notes?.tags}
        onSaved={() => logEvent('library_save')}
      />
    )}
    <PlayMediaDialogs
      media={media}
      open={open ? mediaDialog : null}
      onOpenChange={setMediaDialog}
      readOnly={!canEdit}
      frameIndex={frameIndex}
      frameCount={liveFrames.length}
      frameNote={liveFrames[frameIndex]?.note ?? ''}
      onFrameNoteSave={(note) => setFrames((prev) => prev.map((f, i) => (i === frameIndex ? { ...f, note: note || undefined } : f)))}
      uploadPanel={<LazySchoolVideosPanel teamId={teamId} lineupId={existingLineupId ?? null} canEdit={roleCanEdit} />}
    />
    {/* Montado solo al abrirlo: la pizarra no consulta «Equipos almacenados» si nadie los pide. */}
    {teamsCtl.dialogOpen && <Suspense fallback={null}><TacticalTeamsDialog
      open={teamsCtl.dialogOpen}
      onOpenChange={teamsCtl.setDialogOpen}
      value={teamsCtl.teams}
      onApply={teamsCtl.setTeams}
      homeName={teamName}
      schoolLogoUrl={schoolBranding?.logo_url ?? null}
      sample={(() => {
        const keys = Object.keys(placed);
        const key = keys.find((k) => !isGoalkeeperLabel(placed[k].slot_label)) ?? keys[0];
        const sub = key ? subjectByKey.get(key) : undefined;
        const sl = key ? placed[key] : undefined;
        return sub && sl ? { number: sl.jersey_number === '' ? null : String(sl.jersey_number), name: sub.full_name, position: sl.slot_label } : undefined;
      })()}
      onOpenRoster={() => { if (!rosterOpen) toggleRoster(); }}
      readOnly={!canEdit}
    /></Suspense>}
    </TacticalTeamsContext.Provider>
  );
}
