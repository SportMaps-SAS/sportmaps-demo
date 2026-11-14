/**
 * «Analizar jugada» con IA (M3 de docs/specs/pizarra-multideporte-3d-ia.md, D6).
 *
 *  - TacticalAiPanel: panel lateral (hoja inferior en el celular) con la lectura,
 *    los riesgos y las tarjetas de contraataques y variantes. Todo marcado
 *    «Sugerencia IA»: la IA sugiere, el coach decide; nada se guarda solo.
 *  - TacticalAiOverlay: capa encima de la cancha que anima la sugerencia
 *    («Ver contraataque»): rivales en su color, los propios como fantasmas
 *    punteados. Interpola con tacticalAnimation.interpolateFrames.
 *
 * TacticalBoard solo monta el botón, este panel y la capa (otros cambios de
 * la pizarra viven en otras ramas): toda la lógica está acá y en
 * lib/school/tacticalAi.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, MessageCircle, Play, Save, Sparkles, Square, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  analyzePlay, boostLabel, fetchAiBalance, humanizeResult, isRivalKey, quotaLabel, rechargeOfferOf, requestMoreHref, rivalColorOf,
  sendSuggestionFeedback, suggestionToBoardFrames,
  type AiBalance, type AiFeedbackVerdict, type AiResult, type AiSuggestion, type AnalyzeRequest,
} from '@/lib/school/tacticalAi';
import type { Viewer3DSource } from '@/lib/school/tactical3dLaunch';
import type { TacticalBoardEvent } from '@/lib/school/tacticalUsage';
import { interpolateFrames, totalDurationMs } from '@/lib/school/tacticalAnimation';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import { viewBoxOf, type PitchView } from '@/lib/school/tacticalGeometry';
import { ARROW_COLOR_HEX } from '@/lib/school/tacticalPalette';
import type { TacticalArrowColor } from '@/lib/school/footballQueries';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import { TacticalStaticSvg } from './TacticalStaticSvg';
// Liviano: el visor y three.js llegan con import() solo al tocar «Ver en 3D».
import { Tactical3DLauncher } from './tactical3d/Tactical3DLauncher';

/** Eventos de la métrica de uso (T0) que dispara el panel. */
export type TacticalAiEvent = Extract<TacticalBoardEvent, 'ai_analyze' | 'ai_view_counter' | 'ai_save_variant' | 'view_3d'>;

export type AiPreviewKind = 'contraataque' | 'variante';
export interface AiPreview {
  id: string;
  kind: AiPreviewKind;
  /** Cuadros de la sugerencia (claves reales + rival:N). */
  frames: TacticalFrame[];
  rivalColor: TacticalArrowColor;
}

// ─── Capa sobre la cancha ───────────────────────────────────────────────────

/** Pausa al final antes de repetir (ms). */
const LOOP_HOLD_MS = 900;

export function TacticalAiOverlay({ preview, view }: { preview: AiPreview; view: PitchView }) {
  const [t, setT] = useState(0);
  const total = useMemo(() => totalDurationMs(preview.frames), [preview.frames]);
  useEffect(() => {
    setT(0);
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const cycle = total + LOOP_HOLD_MS;
      setT(cycle > 0 ? Math.min(total, (now - start) % cycle) : 0);
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [preview, total]);

  const state = interpolateFrames(preview.frames, t);
  const rival = ARROW_COLOR_HEX[preview.rivalColor] ?? ARROW_COLOR_HEX.red;
  const own = preview.kind === 'variante' ? '#34d399' : '#f8fafc';
  return (
    <svg
      viewBox={viewBoxOf(view)}
      preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full z-[48] pointer-events-none"
      data-testid="tactical-ai-overlay"
      aria-label={preview.kind === 'contraataque' ? 'Contraataque sugerido por la IA' : 'Variante sugerida por la IA'}
    >
      <defs>
        <marker id="ai-head" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
          <path d="M0,0 L5,2.5 L0,5 Z" fill="#fde047" />
        </marker>
      </defs>
      {state.arrows.map(({ shape, opacity }, i) => {
        const c = ARROW_COLOR_HEX[shape.color ?? 'yellow'] ?? '#fde047';
        if (shape.type === 'zone') {
          return (
            <rect key={`a${i}`} x={Math.min(shape.x1, shape.x2) * 3} y={Math.min(shape.y1, shape.y2) * 3.4}
              width={Math.abs(shape.x2 - shape.x1) * 3} height={Math.abs(shape.y2 - shape.y1) * 3.4}
              fill={c} fillOpacity={0.12 * opacity} stroke={c} strokeOpacity={0.6 * opacity} strokeDasharray="3 2" />
          );
        }
        return (
          <line key={`a${i}`} x1={shape.x1 * 3} y1={shape.y1 * 3.4} x2={shape.x2 * 3} y2={shape.y2 * 3.4}
            stroke={c} strokeOpacity={opacity} strokeWidth={1.8} strokeLinecap="round"
            strokeDasharray={shape.type === 'ball_path' ? '4 3' : undefined} markerEnd="url(#ai-head)" />
        );
      })}
      {state.players.map((p) => {
        const isR = isRivalKey(p.key);
        const cx = p.x * 3;
        const cy = p.y * 3.4;
        return isR ? (
          <g key={p.key} opacity={p.opacity} data-ai-rival="true">
            <circle cx={cx} cy={cy + 1} r={9.5} fill="#000" opacity={0.35} />
            <circle cx={cx} cy={cy} r={9.5} fill={rival} stroke="#fff" strokeWidth={1.4} />
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={7} fontWeight={900} fill="#fff"
              fontFamily="Helvetica, Arial, sans-serif">R{p.key.split(':')[1]}</text>
          </g>
        ) : (
          <circle key={p.key} data-ai-own="true" cx={cx} cy={cy} r={10} fill={own} fillOpacity={0.18 * p.opacity}
            stroke={own} strokeOpacity={0.9 * p.opacity} strokeWidth={1.4} strokeDasharray="3 2" />
        );
      })}
      {state.ball && (
        <circle cx={state.ball.x * 3} cy={state.ball.y * 3.4} r={4} fill="#fff" stroke="#111827" strokeWidth={1.2} opacity={state.ball.opacity} />
      )}
      <g>
        <rect x={6} y={view.y0 * 3.4 + 6} width={78} height={16} rx={8} fill="#7c3aed" fillOpacity={0.9} />
        <text x={45} y={view.y0 * 3.4 + 14} textAnchor="middle" dominantBaseline="central" fontSize={8} fontWeight={800} fill="#fff"
          fontFamily="Helvetica, Arial, sans-serif">Sugerencia IA</text>
      </g>
    </svg>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export interface TacticalAiPanelProps {
  open: boolean;
  onClose: () => void;
  /** Arma la petición con la jugada que está en la cancha (null = no hay nada que analizar). */
  getRequest: () => AnalyzeRequest | null;
  sport: TacticalSport;
  /** Puede pasar la sugerencia a la cancha (rol con permiso táctico). */
  canApply: boolean;
  preview: AiPreview | null;
  onPreview: (p: AiPreview | null) => void;
  /** Reemplaza los cuadros de la pizarra (con deshacer). */
  onApply: (frames: TacticalFrame[], titulo: string) => void;
  isMobile?: boolean;
  /** Celular horizontal: panel lateral angosto (300 px) en vez de 380, para no tapar la cancha. */
  narrow?: boolean;
  /** La jugada del coach para «Ver en 3D» (lo mismo que arma «Exportar»).
   *  Sin esto las tarjetas no ofrecen 3D. */
  get3DSource?: () => Viewer3DSource;
  /** Métrica de uso (T0), un evento por acción. */
  onEvent?: (event: TacticalAiEvent) => void;
}

/** «Útil / No útil»: un toque marca, otro toque sobre el mismo lo quita. */
export function SuggestionFeedback({
  verdict, onVote, titulo,
}: { verdict: AiFeedbackVerdict | null; onVote: (v: AiFeedbackVerdict | null) => void; titulo: string }) {
  const btn = (v: AiFeedbackVerdict, label: string, Icon: typeof ThumbsUp) => {
    const on = verdict === v;
    return (
      <Button
        size="sm"
        variant="ghost"
        className={`h-8 gap-1 px-2 text-[11px] ${on ? (v === 'util' ? 'bg-emerald-500/20 text-emerald-200' : 'bg-red-500/20 text-red-200') : 'text-white/70'} hover:bg-white/10 hover:text-white`}
        aria-pressed={on}
        aria-label={`${label}: ${titulo}`}
        onClick={() => onVote(on ? null : v)}
      >
        <Icon className="h-3.5 w-3.5" /> {label}
      </Button>
    );
  };
  return (
    <div className="flex items-center gap-1" role="group" aria-label="¿Te sirvió esta sugerencia?">
      {btn('util', 'Útil', ThumbsUp)}
      {btn('no_util', 'No útil', ThumbsDown)}
    </div>
  );
}

function SuggestionCard({
  s, id, kind, rivalColor, sport, active, canApply, onPreview, onApply, get3DSource, onEvent, verdict, onVote, onSaved,
}: {
  s: AiSuggestion; id: string; kind: AiPreviewKind; rivalColor: TacticalArrowColor; sport: TacticalSport;
  active: boolean; canApply: boolean;
  onPreview: (p: AiPreview | null) => void;
  onApply: (frames: TacticalFrame[], titulo: string) => void;
  get3DSource?: () => Viewer3DSource;
  onEvent?: (event: TacticalAiEvent) => void;
  /** Sin análisis identificable (BFF viejo) no se ofrece valorar. */
  verdict?: AiFeedbackVerdict | null;
  onVote?: (v: AiFeedbackVerdict | null) => void;
  onSaved?: () => void;
}) {
  // Miniatura: último cuadro, con los rivales como material «Rival».
  const thumb = useMemo(() => {
    const board = suggestionToBoardFrames(s, rivalColor);
    const last = board[board.length - 1];
    return { players: last.players.map((p) => ({ x: p.x, y: p.y })), arrows: last.arrows };
  }, [s, rivalColor]);
  const verb = kind === 'contraataque' ? 'Ver contraataque' : 'Ver variante';
  return (
    <article className={`rounded-xl border p-3 space-y-2 ${active ? 'border-violet-400 bg-violet-500/10' : 'border-white/10 bg-white/5'}`} data-testid={`ai-card-${id}`}>
      <div className="flex items-start gap-2">
        <div className="shrink-0 rounded-md overflow-hidden ring-1 ring-white/10">
          <TacticalStaticSvg players={thumb.players} arrows={thumb.arrows} width={72} sport={sport} />
        </div>
        <div className="min-w-0 space-y-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-violet-600/80 px-2 py-0.5 text-[10px] font-bold text-white">
            <Sparkles className="h-3 w-3" /> Sugerencia IA
          </span>
          <h4 className="text-sm font-bold leading-tight text-white">{s.titulo}</h4>
          {s.explicacion && <p className="text-xs leading-snug text-white/75">{s.explicacion}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-[11px] bg-transparent border-white/20 text-white hover:bg-white/10 hover:text-white"
          onClick={() => {
            if (!active) onEvent?.('ai_view_counter');
            onPreview(active ? null : { id, kind, frames: s.frames, rivalColor });
          }}
          aria-pressed={active}
        >
          {active ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5" />}
          {active ? 'Detener' : verb}
        </Button>
        {get3DSource && (
          <Tactical3DLauncher
            getInput={() => ({ ...get3DSource(), aiSuggestion: { kind, titulo: s.titulo, frames: s.frames } })}
            onOpen={() => { onPreview(null); onEvent?.('view_3d'); }}
            label="Ver en 3D"
            ariaLabel={`Ver en 3D: ${s.titulo}`}
            className="h-8 min-w-0 gap-1 px-2 text-[11px] bg-transparent border-white/20 text-white hover:bg-white/10 hover:text-white"
          />
        )}
        {canApply && (
          <Button
            size="sm"
            className="h-8 gap-1 text-[11px] bg-emerald-600 hover:bg-emerald-500 text-white"
            onClick={() => { onEvent?.('ai_save_variant'); onSaved?.(); onApply(suggestionToBoardFrames(s, rivalColor), s.titulo); }}
          >
            <Save className="h-3.5 w-3.5" /> Guardar como nueva jugada
          </Button>
        )}
      </div>
      {onVote && <SuggestionFeedback verdict={verdict ?? null} onVote={onVote} titulo={s.titulo} />}
    </article>
  );
}

// ─── Cupo de IA del mes ─────────────────────────────────────────────────────

/** «Te queda el 60 % de tu IA este mes · unos 9 análisis de fútbol 11». */
export function AiQuotaBar({ balance, sport }: { balance: AiBalance | null; sport: TacticalSport }) {
  const label = quotaLabel(balance, sport);
  if (!balance || !label) return null;
  const pct = Math.max(0, Math.min(100, balance.remaining_pct));
  const tone = balance.exhausted ? 'bg-amber-400' : pct <= 20 ? 'bg-amber-400' : 'bg-violet-400';
  return (
    <div className="px-4 py-2 border-b border-white/10 space-y-1.5" data-testid="ai-quota">
      <p className="text-[11px] leading-snug text-white/80" data-testid="ai-balance">{label}</p>
      {boostLabel(balance) && (
        <p className="text-[10px] font-semibold text-violet-200" data-testid="ai-boost">{boostLabel(balance)}</p>
      )}
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-label="IA que te queda este mes"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={`h-full rounded-full ${tone} transition-[width]`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Agotado: «Usaste tu IA de este mes» + «Quiero +50 % de IA» (WhatsApp del
 *  comercial). La recarga va en la misma moneda que el medidor. */
export function AiQuotaExhausted({
  balance, sport, message, requestMoreMessage,
}: { balance: AiBalance | null; sport: TacticalSport; message?: string | null; requestMoreMessage?: string | null }) {
  const school = balance?.limited_by === 'school';
  return (
    <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 space-y-2" role="status" data-testid="ai-exhausted">
      <p className="text-sm font-semibold text-amber-200">{message || (school ? 'Tu escuela usó toda la IA de este mes.' : 'Usaste tu IA de este mes')}</p>
      <p className="text-xs text-white/75">
        Se renueva el 1.º de cada mes. Si necesitas más ahora, escríbenos y te habilitamos más cupo.
        Una jugada que ya analizaste se puede volver a ver sin gastar.
      </p>
      <Button asChild size="sm" className="h-9 gap-1.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold">
        <a href={requestMoreHref(balance, sport, requestMoreMessage)} target="_blank" rel="noopener noreferrer" data-testid="ai-more">
          <MessageCircle className="h-4 w-4" /> Quiero {rechargeOfferOf(balance).label}
        </a>
      </Button>
    </div>
  );
}

/** Cerrado no monta nada (ni hooks de router): la pizarra lo monta siempre. */
export function TacticalAiPanel(props: TacticalAiPanelProps) {
  return props.open ? <TacticalAiPanelBody {...props} /> : null;
}

function TacticalAiPanelBody({
  open, onClose, getRequest, sport, canApply, preview, onPreview, onApply, isMobile, narrow, get3DSource, onEvent,
}: TacticalAiPanelProps) {
  const [balance, setBalance] = useState<AiBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsMore, setNeedsMore] = useState<{ message: string; requestMoreMessage: string | null } | null>(null);
  const [result, setResult] = useState<AiResult | null>(null);
  const [cached, setCached] = useState(false);
  const [rivalColor, setRivalColor] = useState<TacticalArrowColor>('red');
  const [minimized, setMinimized] = useState(false);
  const [analysisRef, setAnalysisRef] = useState<string | null>(null);
  /** Voto por sugerencia ('c0', 'v1'…) del análisis en pantalla. */
  const [votes, setVotes] = useState<Record<string, AiFeedbackVerdict | null>>({});
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchAiBalance(sport).then((b) => { if (alive) setBalance(b); });
    return () => { alive = false; };
  }, [open, sport]);

  // Al dejar de ver una sugerencia, el panel vuelve a abrirse en el celular.
  useEffect(() => { if (!preview) setMinimized(false); }, [preview]);

  async function run() {
    const req = getRequest();
    if (!req) {
      setError('Pon al menos un jugador en la cancha para analizar la jugada.');
      return;
    }
    onEvent?.('ai_analyze');
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    setNeedsMore(null);
    onPreview(null);
    setRivalColor(rivalColorOf(req.frames));
    const out = await analyzePlay(req);
    if (seq !== reqSeq.current) return;
    setLoading(false);
    if (out.kind === 'ok') {
      // Ningún «p5»/«r4» a la pantalla: etiqueta del jugador en la cancha
      // (la misma que se mandó) o «jugador N» / «rival N».
      setResult(humanizeResult(out.data.result, out.data.keys, (k) => req.labels[k]));
      setCached(out.data.cached);
      setAnalysisRef(out.data.analysis_ref ?? null);
      setVotes({});
      if (out.data.balance) setBalance(out.data.balance);
    } else if (out.kind === 'needs_more') {
      setNeedsMore({ message: out.message, requestMoreMessage: out.requestMoreMessage });
      if (out.balance) setBalance(out.balance);
    } else {
      setError(out.message);
    }
  }

  // Valoración optimista: si falla el envío, el voto vuelve a como estaba.
  const feedbackProps = (kind: AiPreviewKind, index: number) => {
    if (!analysisRef) return {};
    const id = `${kind === 'contraataque' ? 'c' : 'v'}${index}`;
    return {
      verdict: votes[id] ?? null,
      onVote: (v: AiFeedbackVerdict | null) => {
        const prev = votes[id] ?? null;
        setVotes((m) => ({ ...m, [id]: v }));
        void sendSuggestionFeedback({ analysisRef, sport, kind, index, verdict: v }).then((ok) => {
          if (!ok) setVotes((m) => ({ ...m, [id]: prev }));
        });
      },
      onSaved: () => { void sendSuggestionFeedback({ analysisRef, sport, kind, index, saved: true }); },
    };
  };

  const previewSuggestion = (p: AiPreview | null) => {
    onPreview(p);
    if (p && isMobile) setMinimized(true);
  };

  const exhausted = !!needsMore || (!!balance?.exhausted && !result);

  const shell = isMobile
    ? 'absolute inset-x-0 bottom-0 z-[70] max-h-[62vh] rounded-t-2xl border-t'
    : `absolute right-0 top-0 bottom-0 z-[70] ${narrow ? 'w-[300px]' : 'w-[380px]'} max-w-full border-l`;

  if (minimized && preview) {
    return (
      <div className="absolute inset-x-3 bottom-3 z-[70] flex items-center gap-2 rounded-full bg-zinc-950/95 px-3 py-2 ring-1 ring-violet-400/50 shadow-2xl" role="region" aria-label="Sugerencia IA en la cancha">
        <Sparkles className="h-4 w-4 text-violet-300 shrink-0" />
        <span className="text-xs font-semibold text-white truncate flex-1">Viendo la sugerencia IA</span>
        <Button size="sm" variant="ghost" className="h-8 text-[11px] text-white hover:bg-white/10" onClick={() => onPreview(null)}>Detener</Button>
        <Button size="sm" className="h-8 text-[11px] bg-violet-600 hover:bg-violet-500 text-white" onClick={() => setMinimized(false)}>Volver al análisis</Button>
      </div>
    );
  }

  return (
    <aside
      className={`${shell} flex flex-col bg-zinc-950/95 backdrop-blur border-white/10 text-white shadow-2xl`}
      role="complementary"
      aria-label="Análisis de la jugada con IA"
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <Sparkles className="h-4 w-4 text-violet-300" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold">Analizar jugada</h3>
        </div>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-white/70 hover:text-white hover:bg-white/10" onClick={onClose} aria-label="Cerrar el análisis">
          <X className="h-4 w-4" />
        </Button>
      </header>
      <AiQuotaBar balance={balance} sport={sport} />

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {!result && !loading && !exhausted && (
          <p className="text-xs leading-snug text-white/75">
            La IA lee la jugada que tienes en la cancha y te sugiere riesgos, contraataques del rival y variantes.
            Son sugerencias: tú decides qué usar. No enviamos nombres ni fotos de tus deportistas.
          </p>
        )}

        {exhausted && (
          <AiQuotaExhausted balance={balance} sport={sport} message={needsMore?.message} requestMoreMessage={needsMore?.requestMoreMessage} />
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-400/40 bg-red-500/10 p-3 text-xs text-red-100" role="alert">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-300" />
            <span>{error}</span>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-white/75" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Analizando la jugada… puede tardar hasta un minuto.
          </div>
        )}

        {result && !loading && (
          <>
            <section className="space-y-1.5">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-bold uppercase tracking-wide text-white/60">Lectura de la jugada</h4>
                <span className="rounded-full bg-violet-600/80 px-2 py-0.5 text-[10px] font-bold">Sugerencia IA</span>
                {cached && <span className="text-[10px] text-white/50">(ya analizada: no descontó)</span>}
              </div>
              <p className="text-sm leading-snug text-white/90">{result.lectura}</p>
            </section>

            {result.riesgos.length > 0 && (
              <section className="space-y-1.5">
                <h4 className="text-xs font-bold uppercase tracking-wide text-white/60">Riesgos</h4>
                <ul className="space-y-1.5">
                  {result.riesgos.map((r, i) => (
                    <li key={i} className="rounded-lg bg-white/5 px-3 py-2">
                      <p className="text-xs font-semibold text-amber-200">{r.titulo}{r.zona ? ` · ${r.zona}` : ''}</p>
                      <p className="text-xs leading-snug text-white/75">{r.detalle}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {result.contraataques.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wide text-white/60">Contraataques del rival</h4>
                {result.contraataques.map((s, i) => (
                  <SuggestionCard key={`c${i}`} id={`c${i}`} kind="contraataque" s={s} sport={sport} rivalColor={rivalColor}
                    active={preview?.id === `c${i}`} canApply={canApply} onPreview={previewSuggestion} onApply={onApply}
                    get3DSource={get3DSource} onEvent={onEvent} {...feedbackProps('contraataque', i)} />
                ))}
              </section>
            )}

            {result.variantes.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wide text-white/60">Variantes de tu jugada</h4>
                {result.variantes.map((s, i) => (
                  <SuggestionCard key={`v${i}`} id={`v${i}`} kind="variante" s={s} sport={sport} rivalColor={rivalColor}
                    active={preview?.id === `v${i}`} canApply={canApply} onPreview={previewSuggestion} onApply={onApply}
                    get3DSource={get3DSource} onEvent={onEvent} {...feedbackProps('variante', i)} />
                ))}
              </section>
            )}
          </>
        )}
      </div>

      {/* Sin saldo el botón sigue: una jugada ya analizada sale de la caché
          sin gastar; si no, el BFF responde needs_more sin llamar a la IA. */}
      <footer className="border-t border-white/10 px-4 py-3">
        <Button className="w-full h-10 gap-2 bg-violet-600 hover:bg-violet-500 text-white font-bold" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {result ? 'Analizar de nuevo' : 'Analizar jugada'}
        </Button>
      </footer>
    </aside>
  );
}
