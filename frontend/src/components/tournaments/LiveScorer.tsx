import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bffClient, type AuthMode } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ArrowLeft, ArrowLeftRight, Undo2, Play, Flag, Pencil, RotateCcw, Plus, Trash2, Wifi, WifiOff, Loader2, Trophy } from 'lucide-react';
import { applyAction, derive, emptyState, formatHalfPoints, type Action, type CricketInnings, type LiveState, type Side } from '@/lib/tournamentScoring';
import { scorerKindFor, sportForPreset } from '@/lib/tournamentSports';
import { PlanillaPartidoButton, loadMatchRoster } from './planilla/PlanillaPartidoButton';
import type { ActionResponse, MatchDto } from '@/lib/tournamentTypes';
import {
  ActionQueue, classifyError, safeStorage, type FlushEvent, type QueuedAction, type SendResult,
} from '@/lib/tournamentActionQueue';
import { formatBogota, STATUS_LABEL, teamName } from '@/lib/tournamentDisplay';
import { ShareResultButton } from './live/ShareResultButton';
import { PointTagger } from './live/PointTagger';
import { liveApi } from './live/liveApi';
import { sortTags, type PendingTag } from './live/tagQueue';
import { scorerScopeFromUrl, setEventText, sideStorageKey } from './live/scorerErgonomics';

/** Dónde pegarle al BFF: igual para el organizador (`/school/:id/...`) y para el token (`/scorer/:token/...`). */
export interface ScorerEndpoints {
  actionsUrl: (matchId: string) => string;
  takeUrl: (matchId: string) => string;
  authMode?: AuthMode;
}

interface Props {
  match: MatchDto;
  endpoints: ScorerEndpoints;
  /** Identifica la cola local (una por torneo/enlace). */
  queueKey: string;
  onClose: () => void;
  /** Avisa al padre de la versión confirmada por el servidor (para refrescar su lista). */
  onMatchChange?: (m: MatchDto) => void;
  /** Nombre del torneo para la tarjeta de resultado que se comparte (opcional). */
  tournamentTitle?: string;
}

const toLiveState = (m: MatchDto): LiveState => {
  if (!m.live_state) return emptyState(m.status);
  const st: LiveState = { status: m.live_state.status, points: m.live_state.points ?? '', walkover: m.live_state.walkover ?? null };
  if (m.live_state.detail) st.detail = m.live_state.detail;
  return st;
};

/** «156/7 (20)» */
export const inningsText = (i: CricketInnings | undefined) => (i ? `${i.runs}/${i.wickets} (${i.overs})` : '—');

/** Estado local = estado confirmado + acciones pendientes aplicadas con el motor (las que no apliquen se ignoran). */
export function foldPending(base: LiveState, pending: QueuedAction[], cfg: MatchDto['config'], knockout: boolean): LiveState {
  let s = base;
  for (const p of pending) {
    const r = applyAction(s, p.action, cfg, { knockout });
    if (r.ok) s = r.state;
  }
  return s;
}

export function LiveScorer({ match, endpoints, queueKey, onClose, onMatchChange, tournamentTitle }: Props) {
  const { toast } = useToast();
  const cfg = match.config;
  const kind = scorerKindFor(cfg);
  const sportInfo = sportForPreset(cfg.preset);
  const setWord = kind === 'maps' ? 'Mapa' : 'Set';
  const [shootOpen, setShootOpen] = useState(false);
  // El botón de desempate aparece cuando se intentó terminar (o cargar) un empate que no se admite.
  const [shootAsked, setShootAsked] = useState(false);
  const knockout = match.stage === 'knockout' || match.stage === 'third_place';
  const epRef = useRef(endpoints);
  epRef.current = endpoints;

  const [serverMatch, setServerMatch] = useState<MatchDto>(match);
  const [, setTick] = useState(0);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  const [lastRetry, setLastRetry] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [woOpen, setWoOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  // Cambio de lado: solo cambia cómo se ven los botones en ESTE celular (no toca el marcador).
  const [swapped, setSwapped] = useState(() => { try { return localStorage.getItem(sideStorageKey(match.id)) === '1'; } catch { return false; } });
  const toggleSides = () => setSwapped((v) => { const n = !v; try { localStorage.setItem(sideStorageKey(match.id), n ? '1' : '0'); } catch { /* sin almacenamiento */ } return n; });
  const [banner, setBanner] = useState<string | null>(null);
  const [lastPoint, setLastPoint] = useState<{ side: Side; index: number } | null>(null);

  const send = useCallback(async (item: QueuedAction, expected: number): Promise<SendResult> => {
    try {
      const ep = epRef.current;
      const r = await bffClient.post<ActionResponse>(
        ep.actionsUrl(item.matchId),
        { action: item.action, client_action_id: item.client_action_id, expected_version: expected },
        undefined, ep.authMode ?? 'required',
      );
      return { kind: 'ok', duplicate: r.duplicate, warning: r.warning, match: r.match };
    } catch (e) { return classifyError(e); }
  }, []);

  const queueRef = useRef<ActionQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new ActionQueue({ key: queueKey, storage: safeStorage(), send, onChange: () => setTick((t) => t + 1) });
  }
  const queue = queueRef.current;

  // Última secuencia confirmada por el servidor (las etiquetas de punto esperan a que su punto esté acá).
  const pointsRef = useRef(String(match.live_state?.points ?? ''));
  pointsRef.current = String(serverMatch.live_state?.points ?? '');
  // Se llena más abajo (necesita el alcance del anotador): procesa las etiquetas de punto en espera.
  const processTagsRef = useRef<(points: string) => void>(() => {});

  const handleEvents = useCallback((events: FlushEvent[]) => {
    if (events.length === 0) return;
    setLastRetry(events.some((e) => e.type === 'retry'));
    // Secuencia confirmada más reciente de ESTE partido (para soltar las etiquetas que esperaban su punto).
    let confirmed: string | null = null;
    for (const e of events) {
      if (e.type === 'sent' && e.match.id === match.id) confirmed = String(e.match.live_state?.points ?? '');
      if (e.type === 'conflict' && e.matchId === match.id && e.match) confirmed = String(e.match.live_state?.points ?? '');
    }
    if (confirmed !== null || events.some((e) => e.type === 'rule_error' || e.type === 'conflict')) processTagsRef.current(confirmed ?? pointsRef.current);
    for (const e of events) {
      if (e.type === 'sent' && e.match.id === match.id) { setServerMatch(e.match); onMatchChange?.(e.match); setTaken(null); }
      if (e.type === 'sent' && e.warning) toast({ title: 'Aviso', description: e.warning });
      if (e.type === 'other_scorer' && e.matchId === match.id) setTaken(e.message || 'Otra persona está anotando este partido.');
      if (e.type === 'conflict' && e.matchId === match.id) {
        if (e.match) { setServerMatch(e.match); onMatchChange?.(e.match); }
        toast({ title: 'Marcador sincronizado', description: 'Otra persona cambió este partido. Mostramos lo que tiene el servidor; revisa el marcador.', variant: 'destructive' });
      }
      if (e.type === 'rule_error') toast({ title: 'Acción no aplicada', description: e.message, variant: 'destructive' });
      if (e.type === 'auth_error') toast({ title: 'No se pudo sincronizar', description: e.message, variant: 'destructive' });
    }
  }, [match.id, onMatchChange, toast]);

  const takeOver = async () => {
    try {
      const ep = epRef.current;
      await bffClient.post(ep.takeUrl(match.id), {}, undefined, ep.authMode ?? 'required');
      setTaken(null);
      await flush(true);
    } catch (e) { toast({ title: 'No se pudo tomar el partido', description: (e as Error).message, variant: 'destructive' }); }
  };

  const flush = useCallback(async (force = false) => { handleEvents(await queue.flush(force)); }, [queue, handleEvents]);

  // Versión confirmada al abrir (solo si no hay nada pendiente de este partido) + «tomar» el partido.
  useEffect(() => {
    if (queue.pending(match.id).length === 0) queue.setVersion(match.id, match.version);
    setServerMatch(match);
    if (match.status !== 'played' && match.status !== 'walkover' && match.status !== 'cancelled') {
      const ep = epRef.current;
      bffClient.post(ep.takeUrl(match.id), {}, undefined, ep.authMode ?? 'required').catch(() => { /* otro anotador activo: el servidor lo resolverá por versión */ });
    }
    void flush(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id]);

  // Reintento periódico + al volver la señal.
  useEffect(() => {
    const iv = setInterval(() => { void flush(); }, 2000);
    const on = () => { setOnline(true); void flush(true); };
    const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { clearInterval(iv); window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [flush]);

  // Pantalla encendida mientras se anota (Wake Lock, con respaldo silencioso si el navegador no lo soporta).
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
        if (!nav.wakeLock || document.visibilityState !== 'visible') return;
        const l = await nav.wakeLock.request('screen');
        if (cancelled) { void l.release().catch(() => undefined); return; }
        lock = l;
      } catch { /* sin permiso o sin soporte */ }
    };
    const onVis = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      try { void lock?.release().catch(() => undefined); } catch { /* ya liberado */ }
    };
  }, []);

  const pending = queue.pending(match.id);
  const state = useMemo(
    () => foldPending(toLiveState(serverMatch), pending, cfg, knockout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverMatch, pending.length, pending[pending.length - 1]?.client_action_id, cfg, knockout],
  );
  const d = derive(state, cfg);
  const status = state.status;
  const live = status === 'live';
  // Un partido terminado antes del motor (sin secuencia de puntos) muestra lo que guardó el servidor.
  const legacy = pending.length === 0 && !serverMatch.live_state && status !== 'scheduled';
  const homeScore = legacy ? serverMatch.home_score ?? 0 : d.homeScore;
  const awayScore = legacy ? serverMatch.away_score ?? 0 : d.awayScore;
  const sets = legacy ? serverMatch.sets : d.sets;
  const openSet = sets.find((s) => !s.closed) ?? null;
  const bigHome: number | string = kind === 'tennis' ? (d.game?.home ?? '0') : kind === 'maps' ? homeScore : cfg.model === 'sets' ? (openSet?.home ?? 0) : homeScore;
  const bigAway: number | string = kind === 'tennis' ? (d.game?.away ?? '0') : kind === 'maps' ? awayScore : cfg.model === 'sets' ? (openSet?.away ?? 0) : awayScore;
  const fmtGoal = (n: number) => (cfg.half_points ? formatHalfPoints(n) : String(n));
  const decided = cfg.model === 'sets' && d.decided;
  // Aviso grande de set / partido ganado (solo cuando se cierra un set nuevo en este celular).
  const closedCount = sets.filter((s) => s.closed).length;
  const prevClosed = useRef(closedCount);
  useEffect(() => {
    const before = prevClosed.current;
    prevClosed.current = closedCount;
    if (closedCount <= before) return undefined;
    setBanner(setEventText(sets, closedCount - 1, teamName(match, 'home'), teamName(match, 'away'), decided));
    const t = setTimeout(() => setBanner(null), decided ? 8000 : 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closedCount]);

  // Estado tras la última acción encolada en este mismo render (para encadenar dos acciones seguidas).
  const chained = useRef<LiveState | null>(null);
  chained.current = null;
  const run = (action: Action): boolean => {
    const r = applyAction(chained.current ?? state, action, cfg, { knockout });
    if (r.ok === false && r.code === 'empate_no_permitido') setShootAsked(true);
    if (r.ok === false) { toast({ title: 'No se puede', description: r.message, variant: 'destructive' }); return false; }
    chained.current = r.state;
    if (action.type === 'correct' && action.penalties) setShootAsked(false);
    queue.enqueue(match.id, action);
    void flush(true);
    setLastPoint(action.type === 'point' ? { side: action.side, index: Math.max(0, (r.state.points?.length ?? 1) - 1) } : null);
    return true;
  };

  const runAfter = (action: Action) => { run(action); };

  const totalPending = queue.size;
  const sync = !online || lastRetry
    ? { label: totalPending > 0 ? `Sin señal · ${totalPending} pendiente${totalPending === 1 ? '' : 's'}` : 'Sin señal', icon: <WifiOff className="h-4 w-4" />, cls: 'bg-destructive/10 text-destructive' }
    : totalPending > 0
      ? { label: `${totalPending} pendiente${totalPending === 1 ? '' : 's'}`, icon: <Loader2 className="h-4 w-4 animate-spin" />, cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' }
      : { label: 'Sincronizado', icon: <Wifi className="h-4 w-4" />, cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' };

  const scope = useMemo(() => scorerScopeFromUrl(endpoints.actionsUrl(match.id)), [endpoints, match.id]);

  // Etiquetas de punto en espera: se envían cuando su punto ya está confirmado por el servidor (B11).
  const tagsRef = useRef<PendingTag[]>([]);
  const sendTag = useCallback((t: PendingTag) => {
    if (!scope) return Promise.reject(new Error('sin_alcance'));
    return liveApi.tagPoint(scope, match.id, { member_id: t.member_id, stat: t.stat, point_index: t.point_index });
  }, [scope, match.id]);
  const submitTag = useCallback(async (t: PendingTag): Promise<'sent' | 'queued'> => {
    const { ready, keep } = sortTags([t], pointsRef.current, queue.pending(match.id).length);
    if (ready.length) { await sendTag(t); return 'sent'; }
    if (keep.length) { tagsRef.current = [...tagsRef.current.filter((x) => x.point_index !== t.point_index), t]; return 'queued'; }
    throw new Error('punto_no_sincronizado');
  }, [queue, match.id, sendTag]);
  // Se llama al terminar cada envío de la cola, con la secuencia que el servidor acaba de confirmar.
  processTagsRef.current = (points: string) => {
    if (tagsRef.current.length === 0) return;
    const { ready, keep } = sortTags(tagsRef.current, points, queue.pending(match.id).length);
    tagsRef.current = keep;
    for (const t of ready) {
      sendTag(t).catch(() => toast({ title: 'No se guardó quién hizo el punto', description: 'El marcador sí quedó guardado.', variant: 'destructive' }));
    }
  };
  const homeName = teamName(match, 'home');
  const awayName = teamName(match, 'away');
  const drawnNow = cfg.model === 'goals' && d.drawn;
  const needsShootout = live && drawnNow && shootAsked && (knockout || !cfg.allow_draw) && cfg.preset !== 'baloncesto';
  const canUndo = live && (state.points?.length ?? 0) > 0;

  const scoreButton = (side: Side, name: string, value: number | string) => (
    <Button
      type="button" disabled={!live || decided}
      onClick={() => run({ type: 'point', side })}
      className={`flex h-52 flex-1 touch-manipulation select-none flex-col items-center justify-center gap-1 rounded-2xl text-center active:scale-[0.97] motion-reduce:active:scale-100 ${side === 'away' ? 'bg-orange-600 text-white hover:bg-orange-600/90' : ''}`}
      aria-label={kind === 'maps' ? `${name} gana el mapa` : `Sumar un punto a ${name}`}
    >
      <span className="line-clamp-2 px-1 text-base font-semibold">{name}</span>
      <span className="text-6xl font-bold tabular-nums">{value}</span>
      <span className="flex items-center gap-1 text-sm opacity-90">{kind === 'maps' ? 'Gana el mapa' : <><Plus className="h-4 w-4" /> 1</>}</span>
    </Button>
  );

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col gap-3 p-3" data-testid="live-scorer">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Volver"><ArrowLeft className="h-5 w-5" /></Button>
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          <div>{match.court ?? 'Sin cancha'} · {formatBogota(match.scheduled_at)}</div>
        </div>
        <Badge variant={live ? 'default' : 'outline'}>{STATUS_LABEL[status]}</Badge>
      </div>

      {taken && (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <p>{taken}</p>
          <Button size="sm" onClick={takeOver}>Tomar el partido</Button>
        </div>
      )}

      <div role="status" className={`flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ${sync.cls}`}>{sync.icon}{sync.label}</div>

      {cfg.model === 'sets' && (
        <div className="rounded-lg border p-2 text-center text-sm">
          <div className="text-xs text-muted-foreground">{kind === 'maps' ? 'Mapas ganados' : 'Sets ganados'}</div>
          <div className="text-2xl font-bold tabular-nums" data-testid="sets-won">{homeScore} - {awayScore}</div>
          {kind !== 'maps' && sets.filter((s) => s.closed).length > 0 && (
            <div className="text-muted-foreground">{sets.filter((s) => s.closed).map(setScoreText).join(' · ')}</div>
          )}
          {kind === 'tennis' && live && !decided && openSet && (
            <div className="mt-0.5 text-sm font-semibold tabular-nums" data-testid="tennis-games">Games: {openSet.home} - {openSet.away}{d.game?.tiebreak ? (openSet.super ? ' · super tie-break' : ' · tie-break') : ''}</div>
          )}
          {live && !decided && kind !== 'maps' && <div className="mt-0.5 text-xs">{setWord} {Math.min(sets.length + (openSet ? 0 : 1), cfg.best_of)} en juego · {kind === 'tennis' ? 'los games y el set se cuentan solos' : 'el set se cierra solo al llegar a los puntos'}</div>}
          {live && !decided && kind === 'maps' && <div className="mt-0.5 text-xs">Al mejor de {cfg.best_of}: toca el equipo que gana cada mapa</div>}
          {decided && <div className="mt-0.5 text-xs font-medium text-primary">Partido decidido: termínalo o deshaz el último punto</div>}
        </div>
      )}

      {banner && (
        <div role="status" aria-live="assertive" className="flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-3 text-center text-base font-semibold text-primary-foreground" data-testid="set-banner">
          <Trophy className="h-5 w-5" /> {banner}
        </div>
      )}

      {cfg.model === 'sets' && live && !decided && (
        <div className="text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground" data-testid="current-set">
          {setWord} {Math.min(sets.length + (openSet ? 0 : 1), cfg.best_of)}{openSet?.deciding ? ' · decisivo' : ''}
        </div>
      )}

      {kind === 'chess' && (
        <ChessResultPanel
          status={status} homeName={homeName} awayName={awayName}
          sideHome={sportInfo?.sides?.home ?? 'Blancas'} sideAway={sportInfo?.sides?.away ?? 'Negras'}
          scoreText={status === 'scheduled' ? null : `${fmtGoal(homeScore)} - ${fmtGoal(awayScore)}`}
          onResult={(h, a) => { if (run({ type: 'correct', home: h, away: a }) && live && !(h === a && knockout)) runAfter({ type: 'finish' }); }}
        />
      )}

      {kind === 'cricket' && (
        <CricketPanel
          status={status} homeName={homeName} awayName={awayName} maxOvers={cfg.cricket?.overs ?? 20}
          innings={state.detail?.innings ?? []}
          onSave={(innings) => run({ type: 'correct', innings })}
        />
      )}

      {kind !== 'chess' && kind !== 'cricket' && (
        <div className="flex gap-3">
          {swapped
            ? <>{scoreButton('away', awayName, bigAway)}{scoreButton('home', homeName, bigHome)}</>
            : <>{scoreButton('home', homeName, bigHome)}{scoreButton('away', awayName, bigAway)}</>}
        </div>
      )}

      {cfg.model === 'goals' && d.byPenalties && state.detail?.penalties && (
        <div className="text-center text-sm text-muted-foreground" data-testid="shootout-result">
          {sportInfo?.shootout ?? 'Penales'}: {state.detail.penalties[0]} - {state.detail.penalties[1]}
        </div>
      )}
      {needsShootout && (
        <Button type="button" variant="secondary" className="h-12" onClick={() => setShootOpen(true)} data-testid="shootout-open">
          Empate: definir por {(sportInfo?.shootout ?? 'penales').toLowerCase()}
        </Button>
      )}

      {live && lastPoint && kind === 'sets' && scope && (
        <PointTagger
          key={lastPoint.index} scope={scope} matchId={match.id} side={lastPoint.side} pointIndex={lastPoint.index}
          teamName={lastPoint.side === 'home' ? homeName : awayName} onDone={() => setLastPoint(null)} submit={submitTag}
        />
      )}

      {kind !== 'chess' && kind !== 'cricket' && <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button type="button" variant="outline" className="h-16 text-lg" disabled={!canUndo} onClick={() => run({ type: 'undo' })}>
          <Undo2 className="mr-2 h-5 w-5" /> Deshacer
        </Button>
        <Button type="button" variant="outline" className="h-16" onClick={toggleSides} aria-pressed={swapped} aria-label="Cambiar de lado">
          <ArrowLeftRight className="mr-1 h-5 w-5" /> Lado
        </Button>
      </div>}

      <div className="grid grid-cols-2 gap-2">
        {status === 'scheduled' && (
          <Button type="button" className="col-span-2 h-12" onClick={() => run({ type: 'start' })}><Play className="mr-2 h-4 w-4" /> Iniciar partido</Button>
        )}
        {live && (
          <Button type="button" className="col-span-2 h-12" variant="secondary" onClick={() => setConfirmFinish(true)}><Flag className="mr-2 h-4 w-4" /> Terminar partido</Button>
        )}
        {(status === 'played' || status === 'walkover') && (
          <ShareResultButton
            className="col-span-2 h-12" size="lg" variant="default" label="Compartir resultado"
            tournament={tournamentTitle ?? 'Torneo'}
            match={{ ...serverMatch, status, home_score: homeScore, away_score: awayScore, sets }}
          />
        )}
        {(status === 'played' || status === 'walkover') && (
          <Button type="button" className="col-span-2 h-12" variant="secondary" onClick={() => run({ type: 'reopen' })}><RotateCcw className="mr-2 h-4 w-4" /> Reabrir partido</Button>
        )}
        {(status === 'scheduled' || status === 'live') && (
          <Button type="button" variant="outline" onClick={() => setWoOpen(true)}>W.O.</Button>
        )}
        {status !== 'cancelled' && kind !== 'chess' && kind !== 'cricket' && (
          <Button type="button" variant="outline" onClick={() => setFixOpen(true)}><Pencil className="mr-1 h-4 w-4" /> Corregir marcador</Button>
        )}
        <PlanillaPartidoButton
          className="col-span-2" match={serverMatch} tournamentTitle={tournamentTitle} sport={sportInfo?.name ?? null}
          loadRoster={scope?.kind === 'school' ? () => loadMatchRoster(scope.eventId, match.id) : undefined}
          label="Planilla (PDF)"
        />
      </div>

      <AlertDialog open={confirmFinish} onOpenChange={setConfirmFinish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Terminar el partido?</AlertDialogTitle>
            <AlertDialogDescription>
              {homeName} {fmtGoal(homeScore)} - {fmtGoal(awayScore)} {awayName}. Podrás reabrirlo si te equivocas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Seguir anotando</AlertDialogCancel>
            <AlertDialogAction onClick={() => { run({ type: 'finish' }); }}>Sí, terminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ShootoutDialog
        open={shootOpen} onOpenChange={setShootOpen} title={sportInfo?.shootout ?? 'Penales'} homeName={homeName} awayName={awayName}
        onSubmit={(ph, pa) => {
          const [h, a] = kind === 'chess' ? [1, 1] : [homeScore, awayScore];
          if (run({ type: 'correct', home: h, away: a, penalties: [ph, pa] })) setShootOpen(false);
        }}
      />
      <WalkoverDialog open={woOpen} onOpenChange={setWoOpen} homeName={homeName} awayName={awayName} onPick={(winner) => { if (run({ type: 'walkover', winner })) setWoOpen(false); }} />
      <CorrectDialog
        open={fixOpen} onOpenChange={setFixOpen} model={cfg.model} homeName={homeName} awayName={awayName}
        initialGoals={[homeScore, awayScore]} initialSets={sets.filter((s) => s.closed).map((s) => [s.home, s.away] as [number, number])}
        onSubmit={(a) => { if (run(a)) setFixOpen(false); }}
      />
    </div>
  );
}

function WalkoverDialog({ open, onOpenChange, homeName, awayName, onPick }: {
  open: boolean; onOpenChange: (o: boolean) => void; homeName: string; awayName: string; onPick: (w: Side) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>W.O.</DialogTitle>
          <DialogDescription>¿Quién gana por no presentación del rival?</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Button className="h-12" onClick={() => onPick('home')}>Gana {homeName}</Button>
          <Button className="h-12" onClick={() => onPick('away')}>Gana {awayName}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CorrectDialog({ open, onOpenChange, model, homeName, awayName, initialGoals, initialSets, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; model: 'goals' | 'sets'; homeName: string; awayName: string;
  initialGoals: [number, number]; initialSets: Array<[number, number]>; onSubmit: (a: Action) => void;
}) {
  const [h, setH] = useState('0');
  const [a, setA] = useState('0');
  const [rows, setRows] = useState<Array<[string, string]>>([]);
  useEffect(() => {
    if (!open) return;
    setH(String(initialGoals[0])); setA(String(initialGoals[1]));
    setRows((initialSets.length ? initialSets : [[0, 0]]).map(([x, y]) => [String(x), String(y)] as [string, string]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    if (model === 'goals') onSubmit({ type: 'correct', home: Number(h), away: Number(a) });
    else onSubmit({ type: 'correct', sets: rows.map(([x, y]) => [Number(x), Number(y)] as [number, number]) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Corregir marcador</DialogTitle>
          <DialogDescription>
            {model === 'goals' ? 'Escribe el marcador final.' : 'Escribe el marcador de cada set jugado (solo sets cerrados).'}
          </DialogDescription>
        </DialogHeader>
        {model === 'goals' ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>{homeName}</Label><Input type="number" min={0} value={h} onChange={(e) => setH(e.target.value)} className="h-12 text-center text-xl" /></div>
            <div className="space-y-1.5"><Label>{awayName}</Label><Input type="number" min={0} value={a} onChange={(e) => setA(e.target.value)} className="h-12 text-center text-xl" /></div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1.5rem_1fr_1fr_2rem] items-end gap-2 text-xs text-muted-foreground"><span /><span>{homeName}</span><span>{awayName}</span><span /></div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1.5rem_1fr_1fr_2rem] items-center gap-2">
                <span className="text-sm text-muted-foreground">{i + 1}</span>
                <Input aria-label={`Set ${i + 1} local`} type="number" min={0} value={r[0]} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? [e.target.value, x[1]] : x))} className="h-11 text-center" />
                <Input aria-label={`Set ${i + 1} visitante`} type="number" min={0} value={r[1]} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? [x[0], e.target.value] : x))} className="h-11 text-center" />
                <Button type="button" variant="ghost" size="icon" aria-label={`Quitar set ${i + 1}`} disabled={rows.length <= 1} onClick={() => setRows((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((p) => [...p, ['0', '0']])}><Plus className="mr-1 h-4 w-4" /> Agregar set</Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={submit}>Guardar marcador</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** «6-4», «7-6(4)» (tie-break del que perdió), «[10-8]» (super tie-break). */
export function setScoreText(s: { home: number; away: number; tb?: { home: number; away: number }; super?: boolean }): string {
  if (s.super && s.tb) return `[${s.tb.home}-${s.tb.away}]`;
  if (s.tb && s.home !== s.away) return `${s.home}-${s.away}(${Math.min(s.tb.home, s.tb.away)})`;
  return `${s.home}-${s.away}`;
}

function ChessResultPanel({ status, homeName, awayName, sideHome, sideAway, scoreText, onResult }: {
  status: string; homeName: string; awayName: string; sideHome: string; sideAway: string; scoreText: string | null;
  onResult: (home: number, away: number) => void;
}) {
  const open = status === 'scheduled' || status === 'live';
  return (
    <div className="space-y-2" data-testid="chess-panel">
      <div className="grid grid-cols-2 gap-2 text-center text-sm">
        <div className="rounded-lg border p-2"><div className="text-xs text-muted-foreground">{sideHome}</div><div className="font-semibold">{homeName}</div></div>
        <div className="rounded-lg border p-2"><div className="text-xs text-muted-foreground">{sideAway}</div><div className="font-semibold">{awayName}</div></div>
      </div>
      {scoreText && <div className="text-center text-4xl font-bold tabular-nums" data-testid="chess-score">{scoreText}</div>}
      {open && (
        <div className="grid gap-2">
          <Button className="h-14 text-base" onClick={() => onResult(2, 0)}>Ganan {sideHome.toLowerCase()} · 1 - 0</Button>
          <Button className="h-14 text-base" variant="secondary" onClick={() => onResult(1, 1)}>Tablas · ½ - ½</Button>
          <Button className="h-14 bg-orange-600 text-base text-white hover:bg-orange-600/90" onClick={() => onResult(0, 2)}>Ganan {sideAway.toLowerCase()} · 0 - 1</Button>
        </div>
      )}
    </div>
  );
}

function CricketPanel({ status, homeName, awayName, maxOvers, innings, onSave }: {
  status: string; homeName: string; awayName: string; maxOvers: number; innings: CricketInnings[];
  onSave: (innings: CricketInnings[]) => void;
}) {
  const init = (side: Side) => {
    const i = innings.find((x) => x.side === side);
    return { runs: String(i?.runs ?? 0), wickets: String(i?.wickets ?? 0), overs: String(i?.overs ?? 0) };
  };
  const [vals, setVals] = useState(() => ({ home: init('home'), away: init('away') }));
  const editable = status !== 'cancelled';
  const field = (side: Side, key: 'runs' | 'wickets' | 'overs', label: string) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        aria-label={`${label} ${side === 'home' ? homeName : awayName}`} inputMode="decimal" value={vals[side][key]} disabled={!editable}
        onChange={(e) => setVals((p) => ({ ...p, [side]: { ...p[side], [key]: e.target.value } }))} className="h-12 text-center text-lg"
      />
    </div>
  );
  return (
    <div className="space-y-3" data-testid="cricket-panel">
      {(['home', 'away'] as const).map((side) => (
        <div key={side} className="rounded-xl border p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-semibold">{side === 'home' ? homeName : awayName}</span>
            <span className="text-sm tabular-nums text-muted-foreground">{inningsText(innings.find((x) => x.side === side))}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {field(side, 'runs', 'Runs')}{field(side, 'wickets', 'Wickets')}{field(side, 'overs', `Overs (máx. ${maxOvers})`)}
          </div>
        </div>
      ))}
      {editable && (
        <Button className="h-12 w-full" onClick={() => onSave((['home', 'away'] as const).map((side) => ({
          side, runs: Number(vals[side].runs), wickets: Number(vals[side].wickets), overs: Number(String(vals[side].overs).replace(',', '.')),
        })))}>Guardar innings</Button>
      )}
    </div>
  );
}

function ShootoutDialog({ open, onOpenChange, title, homeName, awayName, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; homeName: string; awayName: string; onSubmit: (h: number, a: number) => void;
}) {
  const [h, setH] = useState('0');
  const [a, setA] = useState('0');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>El partido terminó empatado. Escribe el resultado del desempate; el marcador del partido no cambia.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>{homeName}</Label><Input aria-label={`${title} ${homeName}`} type="number" min={0} value={h} onChange={(e) => setH(e.target.value)} className="h-12 text-center text-xl" /></div>
          <div className="space-y-1.5"><Label>{awayName}</Label><Input aria-label={`${title} ${awayName}`} type="number" min={0} value={a} onChange={(e) => setA(e.target.value)} className="h-12 text-center text-xl" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={() => onSubmit(Number(h), Number(a))}>Guardar desempate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
