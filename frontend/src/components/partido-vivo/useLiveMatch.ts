/**
 * Partido en vivo — orquesta estado del servidor + cola offline + reloj para la pantalla de cancha.
 * Todas las RPC van con el JWT del usuario (las RPC validan el alcance adentro; types.ts aún no las trae → `as any`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import {
  buildPeriodEnd, buildPeriodStart, buildSlotEvent, buildSub, clockView, keyOfRef, lastVoidable, logItems, newClientEventId,
  projectState, VOIDABLE, type LiveState, type SubjectRef, type WireEvent,
} from './liveMatchLogic';
import { LiveQueue, classifyRpcError, safeLocalStorage, type FlushResult } from './liveQueue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const ADMIN_ROLES = ['owner', 'admin', 'school_admin', 'super_admin'];
export const FLUSH_INTERVAL_MS = 10_000;
const POLL_VIEWER_MS = 15_000;
const POLL_DIRECTOR_MS = 60_000;

export interface MatchHeader {
  id: string;
  school_id: string;
  team_id: string | null;
  opponent: string;
  is_home: boolean | null;
  status: string | null;
  live_periods_count: number | null;
  live_period_minutes: number | null;
}

/** Texto en español para un error de RPC (código estable en HINT). */
export function mensajeError(err: unknown): string {
  const c = classifyRpcError(err);
  if (c.kind === 'network') return 'Sin conexión con el servidor.';
  return c.message;
}

export function useLiveMatch(matchId: string) {
  const { user } = useAuth();
  const { currentUserRole } = useSchoolContext();
  const esAdmin = ADMIN_ROLES.includes(currentUserRole || '');

  const [header, setHeader] = useState<MatchHeader | null>(null);
  const [server, setServer] = useState<LiveState | null>(null);
  const [liveExists, setLiveExists] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [reachable, setReachable] = useState(true);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const queue = useMemo(() => new LiveQueue(matchId, safeLocalStorage()), [matchId]);
  useSyncExternalStore(
    useCallback((fn) => queue.subscribe(fn), [queue]),
    () => queue.getVersion(),
  );

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // ── lecturas ──
  const loadState = useCallback(async (): Promise<LiveState | null> => {
    const { data: row, error } = await db.from('match_live').select('status, director_id').eq('match_id', matchId).maybeSingle();
    if (error) throw error;
    if (!row || row.status === 'not_started') {
      setLiveExists(!!row);
      setServer(null);
      return null;
    }
    // start_live_match es idempotente: con el partido ya iniciado devuelve el estado sin cambiar nada.
    const { data, error: e2 } = await db.rpc('start_live_match', { p_match: matchId, p_options: {} });
    if (e2) throw e2;
    setLiveExists(true);
    setServer(data as LiveState);
    return data as LiveState;
  }, [matchId]);

  const refresh = useCallback(async () => {
    try {
      await loadState();
      setReachable(true);
    } catch (err) {
      if (classifyRpcError(err).kind === 'network') setReachable(false);
    }
  }, [loadState]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const { data: m, error } = await db.from('match_results')
          .select('id, school_id, team_id, opponent, is_home, status, live_periods_count, live_period_minutes').eq('id', matchId).maybeSingle();
        if (error) throw error;
        if (!m) throw new Error('No encontramos este partido.');
        if (!vivo) return;
        setHeader(m as MatchHeader);
        await loadState();
        if (vivo) setPhase('ready');
      } catch (err) {
        if (!vivo) return;
        setLoadError(mensajeError(err));
        setPhase(server || (queue.size > 0) ? 'ready' : 'error');
      }
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  // ── conexión ──
  useEffect(() => {
    const on = () => { setOnline(true); setReachable(true); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // ── reloj (el dispositivo cuenta solo, sin depender de la señal) ──
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── derivados ──
  const proj = useMemo(() => projectState(server, queue.events, queue.anchors),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, queue.getVersion()]);
  const clock = useMemo(() => clockView(server, proj, nowMs), [server, proj, nowMs]);

  const esDirector = !server?.director_id || server.director_id === user?.id || esAdmin;
  const readOnly = !!server && !esDirector;
  const finished = server?.status === 'finished';
  const log = useMemo(() => logItems(server, proj.pending),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, queue.getVersion()]);

  // ── envío de la cola ──
  const flush = useCallback(async (): Promise<FlushResult> => {
    const r = await queue.flush(async (batch) => db.rpc('apply_live_events', { p_match: matchId, p_events: batch }));
    if (!mounted.current) return r;
    if (r.status === 'network') setReachable(false);
    else if (r.status === 'ok' || r.status === 'blocked') setReachable(true);
    if (r.state) setServer(r.state as LiveState);
    if (r.rejected > 0) toast.error(`${r.rejected} evento(s) no se pudieron aplicar. Míralos en «Pendientes».`);
    return r;
  }, [queue, matchId]);

  const pendientes = queue.size;
  const bloqueada = queue.blockedReason;

  useEffect(() => {
    if (readOnly || pendientes === 0 || bloqueada) return;
    void flush();
    const t = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [readOnly, pendientes, bloqueada, flush]);

  useEffect(() => {
    if (online && pendientes > 0 && !readOnly) void flush();
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sondeo: lector cada 15 s; director cada 60 s y sin cola en vuelo.
  useEffect(() => {
    if (!liveExists || finished) return;
    const t = setInterval(() => { if (!queue.isFlushing && queue.size === 0) void refresh(); }, readOnly ? POLL_VIEWER_MS : POLL_DIRECTOR_MS);
    return () => clearInterval(t);
  }, [liveExists, finished, readOnly, queue, refresh]);

  // Pantalla encendida mientras hay tiempo en juego.
  useEffect(() => {
    if (proj.status !== 'in_period') return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => { /* sin permiso o sin soporte */ });
    return () => { void lock?.release().catch(() => {}); };
  }, [proj.status]);

  // ── acciones ──
  const guard = useCallback(() => {
    if (readOnly) { toast.info('Solo lectura: el director de este partido es otra persona.'); return false; }
    if (finished) { toast.info('El partido terminó. La administración puede reabrirlo.'); return false; }
    return true;
  }, [readOnly, finished]);

  const enqueue = useCallback((ev: WireEvent | null, label: string) => {
    if (!ev) { toast.info('Primero da el pitazo inicial.'); return false; }
    const ok = queue.enqueue(ev, label);
    if (ok) void flush();
    return ok;
  }, [queue, flush]);

  const ctx = useCallback(() => ({ nowMs: Date.now() }), []);
  const nameOf = useCallback((r: SubjectRef | null) => {
    if (!r) return 'Jugador';
    const p = server?.lineup.find((x) => keyOfRef(x) === keyOfRef(r));
    return p ? `${p.jersey_number ?? '—'} ${p.name}` : 'Jugador';
  }, [server]);

  const actions = useMemo(() => ({
    refresh,
    flush,

    async start(): Promise<boolean> {
      setBusy(true);
      try {
        const { data, error } = await db.rpc('start_live_match', { p_match: matchId, p_options: {} });
        if (error) { toast.error(mensajeError(error)); return false; }
        setServer(data as LiveState);
        setLiveExists(true);
        return true;
      } finally { setBusy(false); }
    },

    startPeriod() {
      if (!guard()) return;
      if (proj.status === 'in_period') return;
      enqueue(buildPeriodStart(proj, ctx()), `Pitazo inicial · tiempo ${proj.currentPeriod + 1}`);
    },

    endPeriod() {
      if (!guard() || proj.status !== 'in_period') return;
      const c = clockView(server, proj, Date.now());
      enqueue(buildPeriodEnd(proj, c, ctx()), `Fin del tiempo ${proj.currentPeriod}`);
    },

    sub(out: SubjectRef, inn: SubjectRef) {
      if (!guard()) return;
      const c = clockView(server, proj, Date.now());
      const ev = buildSub(proj, c, ctx(), out, inn);
      if (!ev) { toast.error('Ese cambio no es válido (¿está expulsado o ya en cancha?).'); return; }
      enqueue(ev, `Cambio: sale ${nameOf(out)}, entra ${nameOf(inn)}`);
    },

    goal(scorer: SubjectRef) {
      if (!guard()) return;
      enqueue(buildSlotEvent('goal', proj, clockView(server, proj, Date.now()), ctx(), { subject: scorer }), `Gol de ${nameOf(scorer)}`);
    },

    goalAgainst() {
      if (!guard()) return;
      enqueue(buildSlotEvent('goal_against', proj, clockView(server, proj, Date.now()), ctx()), 'Gol en contra');
    },

    card(kind: 'yellow' | 'red', who: SubjectRef) {
      if (!guard()) return;
      enqueue(buildSlotEvent(kind, proj, clockView(server, proj, Date.now()), ctx(), { subject: who }),
        `${kind === 'yellow' ? 'Amarilla' : 'Roja'} a ${nameOf(who)}`);
    },

    /** Anula el último evento: si aún está en la cola se retira local; si ya está en el servidor, void_live_event (necesita red). */
    async undoLast(): Promise<void> {
      if (!guard()) return;
      const last = lastVoidable(logItems(server, queue.events));
      if (!last) { toast.info('No hay nada que anular.'); return; }
      if (last.pending) {
        if (queue.isFlushing) { toast.info('Se está enviando; inténtalo en un momento.'); return; }
        queue.remove(last.clientEventId);
        toast.success('Evento anulado.');
        return;
      }
      if (!last.serverId || !VOIDABLE.has(last.type)) return;
      if (queue.size > 0) {
        const r = await flush();
        if (r.status !== 'ok' && r.status !== 'empty') { toast.error('Hay eventos sin enviar; espera la conexión para anular.'); return; }
      }
      setBusy(true);
      try {
        const { data, error } = await db.rpc('void_live_event', { p_match: matchId, p_event_id: last.serverId });
        if (error) { toast.error(mensajeError(error)); return; }
        setServer(data as LiveState);
        toast.success('Evento anulado.');
      } finally { setBusy(false); }
    },

    async addCallup(subject: SubjectRef, jersey: number): Promise<boolean> {
      if (!guard()) return false;
      setBusy(true);
      try {
        const { data, error } = await db.rpc('add_live_callup', {
          p_match: matchId, p_subject_type: subject.subject_type, p_subject_id: subject.subject_id,
          p_jersey: jersey, p_client_event_id: newClientEventId(), p_role: 'bench',
        });
        if (error) { toast.error(mensajeError(error)); return false; }
        setServer(data as LiveState);
        toast.success('Convocado sumado a la banca.');
        return true;
      } finally { setBusy(false); }
    },

    async setJersey(subject: SubjectRef, jersey: number): Promise<boolean> {
      if (!guard()) return false;
      const { data, error } = await db.rpc('set_live_jersey', {
        p_match: matchId, p_subject_type: subject.subject_type, p_subject_id: subject.subject_id, p_jersey: jersey,
      });
      if (error) { toast.error(mensajeError(error)); return false; }
      setServer(data as LiveState);
      return true;
    },

    /** Solo administración (la RPC lo valida): deshace «terminado» por error. */
    async reopen(): Promise<boolean> {
      setBusy(true);
      try {
        const { data, error } = await db.rpc('reopen_live_match', { p_match: matchId });
        if (error) { toast.error(mensajeError(error)); return false; }
        setServer(data as LiveState);
        setReport(null);
        return true;
      } finally { setBusy(false); }
    },

    async fetchReport(): Promise<void> {
      const { data, error } = await db.rpc('match_live_report', { p_match: matchId });
      if (error) { if (classifyRpcError(error).kind !== 'network') toast.error(mensajeError(error)); return; }
      setReport(data as Record<string, unknown>);
    },

    async finish(scoreFor: number, scoreAgainst: number): Promise<boolean> {
      if (!guard()) return false;
      if (queue.size > 0) {
        const r = await flush();
        if (queue.size > 0 || (r.status !== 'ok' && r.status !== 'empty')) {
          toast.error('Aún hay eventos sin enviar. Espera la conexión para terminar el partido.');
          return false;
        }
      }
      setBusy(true);
      try {
        const { data, error } = await db.rpc('finish_live_match', { p_match: matchId, p_score_for: scoreFor, p_score_against: scoreAgainst });
        if (error) { toast.error(mensajeError(error)); return false; }
        setReport(data as Record<string, unknown>);
        await loadState();
        queue.clear();
        return true;
      } finally { setBusy(false); }
    },
  }), [refresh, flush, matchId, guard, proj, server, enqueue, ctx, nameOf, queue, loadState]);

  return {
    phase, loadError, header, server, liveExists, proj, clock, log, report, busy, nowMs,
    online: online && reachable, offline: !online || !reachable,
    pendientes, rechazados: queue.rejected, bloqueada,
    pendientesItems: queue.items,
    dismissRejected: (id: string) => queue.dismissRejected(id),
    esDirector, readOnly, finished, esAdmin,
    actions,
  };
}
