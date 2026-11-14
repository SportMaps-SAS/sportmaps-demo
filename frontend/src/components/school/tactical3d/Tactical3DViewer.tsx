/**
 * «Ver en 3D» (fase M4, decisión D5 de docs/specs/pizarra-multideporte-3d-ia.md;
 * cámaras y animación M6e, docs/specs/pizarra-m6e-camaras-3d.md): VISOR, no
 * editor. Reproduce los MISMOS cuadros de la pizarra con la MISMA
 * interpolación (tacticalAnimation.ts) sobre la cancha del deporte a escala
 * real, con 11 cámaras (transmisión de TV, táctica alta, cenital, isométrica,
 * detrás de cada arco/aro, seguir balón, seguir jugador, spider-cam, dron y
 * libre), director automático, cámara lenta, repetición, cuadro congelado con
 * foco, cuadro a cuadro y video de lo que se ve.
 *
 * Se carga en un chunk aparte (React.lazy desde Tactical3DLauncher): three.js
 * no entra al chunk de la pizarra. Cero almacenamiento: todo sale de los
 * cuadros.
 *
 * Caída a 2D: si el contexto WebGL2 no se puede crear (o se pierde), o si los
 * primeros 2 s promedian menos de 20 fps, llama `onFallback` y quien lo abrió
 * vuelve a la pizarra con el aviso.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ChevronLeft, ChevronRight, Circle, Loader2, Pause, Play, Repeat, Snowflake, Square, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createPlaybackClock, totalDurationMs } from '@/lib/school/tacticalAnimation';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import type { AnimationCurve } from '@/lib/school/tacticalBoardSettings';
import { sportDef, type TacticalSport } from '@/lib/school/tacticalSports';
import {
  collectPlayerKeys, court3D, defaultMinFps, defaultViewerCamera, OVERLAY_COLOR, playerVisual,
  prefersReducedMotion, TEAM_COLOR, teamVisual, type CameraMode, type PlayerVisual,
} from '@/lib/school/tactical3d';
import type { TacticalTeamsConfig } from '@/lib/school/tacticalTeams';
import {
  AUTO_MOVING, CAMERA_KINDS, cameraKindLabel, resolveCameraKind, type CameraKind, type PlayerView,
} from '@/lib/school/tactical3dCameras';
import {
  frameIndexAt, REPLAY_SPEED, replayRange, stepFrame, VIEWER_SPEEDS, type ViewerSpeed,
} from '@/lib/school/tactical3dMotion';
import { minFpsOverride } from '@/lib/school/tactical3dLaunch';
import { exportFileName } from '@/lib/export/tacticalExportUtils';
import { Scene3D } from './Scene3D';
import { tactical3dStats } from './resources';
import { canRecordVideo, downloadBlob, startRecording3D, type Recording3D } from './record3d';

export type Tactical3DFallbackReason = 'webgl' | 'slow' | 'error';

export interface Tactical3DStats {
  fps: number;
  geometries: number;
  textures: number;
  programs: number;
}

export interface Tactical3DViewerProps {
  sport: TacticalSport | null | undefined;
  /** Cuadros de la jugada (al menos uno). */
  frames: TacticalFrame[];
  playerLabels?: Record<string, string>;
  playerJerseys?: Record<string, number | null>;
  /** Camiseta del equipo (el arquero va siempre en amarillo). */
  teamColor?: string;
  /** Segundo juego de cuadros encima, en otro color: el contraataque del rival
   *  que sugiere la IA (M3). Corre con el mismo reloj. */
  overlayFrames?: TacticalFrame[] | null;
  overlayColor?: string;
  overlayLabels?: Record<string, string>;
  overlayJerseys?: Record<string, number | null>;
  /** Leyenda de la superposición. */
  overlayName?: string;
  title?: string | null;
  onClose: () => void;
  onFallback: (reason: Tactical3DFallbackReason) => void;
  /** Piso de fps de los primeros 2 s (0 = no caer por lento; lo usan las pruebas). */
  minFps?: number;
  onStats?: (s: Tactical3DStats) => void;
  /** Cámara al abrir (por defecto Transmisión TV; en el celular vertical,
   *  Táctica alta, más cerca). Acepta las 3 de M4. */
  initialCamera?: CameraKind | CameraMode;
  /** M6b: colores y número de los dos equipos (sin ella, los de siempre). */
  teams?: TacticalTeamsConfig | null;
  initialTimeMs?: number;
  autoPlay?: boolean;
  /** Director automático encendido al abrir. */
  initialDirector?: boolean;
  /** Curva de velocidad de los Ajustes de la pizarra (M6g). */
  curve?: AnimationCurve;
  /** «Powered by SportMaps» en el video grabado (false solo con marca blanca). */
  watermark?: boolean;
}

/** Las cámaras de M4 con su nombre nuevo. */
function toKind(c: CameraKind | CameraMode): CameraKind {
  return c === 'tribuna' ? 'tactica' : c;
}

const speedLabel = (s: number) => `${String(s).replace('.', ',')}×`;

export default function Tactical3DViewer({
  sport, frames, playerLabels, playerJerseys, teamColor = TEAM_COLOR,
  overlayFrames = null, overlayColor = OVERLAY_COLOR, overlayLabels, overlayJerseys,
  overlayName = 'Contraataque del rival', title, onClose, onFallback, minFps = defaultMinFps(), onStats,
  initialCamera, initialTimeMs = 0, autoPlay = false, initialDirector = false, teams = null, curve, watermark = true,
}: Tactical3DViewerProps) {
  const court = useMemo(() => court3D(sport), [sport]);
  const def = sportDef(court.sport);
  const overlay = overlayFrames && overlayFrames.length > 0 ? overlayFrames : null;
  const totalMs = useMemo(() => Math.max(totalDurationMs(frames), overlay ? totalDurationMs(overlay) : 0), [frames, overlay]);
  const clock = useMemo(() => createPlaybackClock(Math.min(initialTimeMs, totalMs)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const debug = useMemo(() => minFpsOverride() !== undefined, []);
  const [playing, setPlaying] = useState(autoPlay && totalMs > 0);
  const [speed, setSpeed] = useState<ViewerSpeed>(1);
  const [cameraKind, setCameraKind] = useState<CameraKind>(() => {
    const aspect = typeof window !== 'undefined' ? window.innerWidth / Math.max(1, window.innerHeight) : 16 / 9;
    const k = toKind(initialCamera ?? defaultViewerCamera(aspect));
    return reducedMotion && AUTO_MOVING.has(k) ? 'tv' : k;
  });
  const [director, setDirector] = useState(initialDirector && !reducedMotion);
  const [onAir, setOnAir] = useState<CameraKind>(cameraKind);
  const [playerView, setPlayerView] = useState<PlayerView>('pov');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showTrails, setShowTrails] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [replay, setReplay] = useState<{ endMs: number; prevSpeed: ViewerSpeed } | null>(null);
  const replayRef = useRef(replay);
  replayRef.current = replay;
  // Canvas 2D que se graba (RecorderTap3D copia ahí cada cuadro). null = no se graba.
  const [recordTarget, setRecordTarget] = useState<HTMLCanvasElement | null>(null);
  const recording = recordTarget !== null;
  const [recError, setRecError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recRef = useRef<Recording3D | null>(null);
  const canRecord = useMemo(() => canRecordVideo(), []);

  const keys = useMemo(() => collectPlayerKeys(frames), [frames]);
  const overlayKeys = useMemo(() => collectPlayerKeys(overlay), [overlay]);
  const visuals = useMemo(() => {
    const out: Record<string, PlayerVisual> = {};
    for (const k of keys) {
      const v = playerVisual(k, { labels: playerLabels, jerseys: playerJerseys, color: teamColor, sport: court.sport });
      out[k] = teams ? teamVisual(v, teams.home) : v;
    }
    return out;
  }, [keys, playerLabels, playerJerseys, teamColor, court.sport, teams]);
  const overlayVisuals = useMemo(() => {
    const out: Record<string, PlayerVisual> = {};
    // El rival va todo del color de la superposición (sin amarillo de arquero).
    for (const k of overlayKeys) out[k] = { ...playerVisual(k, { labels: overlayLabels, jerseys: overlayJerseys, color: overlayColor, sport: 'generico' }), color: overlayColor };
    return out;
  }, [overlayKeys, overlayLabels, overlayJerseys, overlayColor]);

  const resolved = resolveCameraKind(cameraKind, selectedKey, keys);

  // ─── Caída a 2D ──
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; recRef.current?.cancel(); }; }, []);
  const fallbackRef = useRef(onFallback);
  fallbackRef.current = onFallback;
  const fallback = useCallback((reason: Tactical3DFallbackReason) => {
    if (mounted.current) fallbackRef.current(reason);
  }, []);
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  const onFpsVerdict = useCallback((verdict: 'ok' | 'slow', fps: number, info: Omit<Tactical3DStats, 'fps'>) => {
    statsRef.current?.({ fps, ...info });
    if (debug) (window as unknown as { __TACTICAL3D_FPS__?: number }).__TACTICAL3D_FPS__ = fps;
    if (verdict === 'slow') {
      console.info(`[3D] cayó a 2D: ${fps.toFixed(1)} fps medidos (piso ${minFps}), ${info.programs} programas, ${info.textures} texturas`);
      fallback('slow');
    }
  }, [fallback, debug, minFps]);

  const onShot = useCallback((k: CameraKind) => {
    setOnAir(k);
    if (debug) {
      const w = window as unknown as { __TACTICAL3D__?: Record<string, unknown> };
      const prev = w.__TACTICAL3D__ ?? {};
      const shots = Array.isArray(prev.shots) ? (prev.shots as string[]) : [];
      w.__TACTICAL3D__ = { ...prev, shot: k, shots: [...shots, k] };
    }
  }, [debug]);

  // ─── Reproducción ──
  const finishRecording = useCallback(async () => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return;
    try {
      const { blob, ext } = await rec.stop();
      downloadBlob(blob, exportFileName(title ?? undefined, ext, 'jugada-3d'));
    } catch (e) {
      setRecError(e instanceof Error ? e.message : 'No se pudo grabar el video.');
    } finally {
      if (mounted.current) setRecordTarget(null);
    }
  }, [title]);

  const onEnded = useCallback(() => {
    setPlaying(false);
    const r = replayRef.current;
    if (r) { setSpeed(r.prevSpeed); setReplay(null); }
    if (recRef.current) void finishRecording();
  }, [finishRecording]);

  const play = () => {
    setFrozen(false);
    if (clock.get() >= totalMs) clock.set(0);
    setPlaying(true);
  };
  const pause = () => setPlaying(false);
  const stopReplay = () => {
    if (replay) { setSpeed(replay.prevSpeed); setReplay(null); }
  };
  const togglePlay = () => (playing ? pause() : play());
  const step = (dir: -1 | 1) => {
    pause();
    stopReplay();
    clock.set(stepFrame(frames, clock.get(), dir));
  };
  const startReplay = () => {
    const r = replayRange(frames);
    setFrozen(false);
    setReplay({ endMs: r.endMs, prevSpeed: replay?.prevSpeed ?? speed });
    setSpeed(REPLAY_SPEED);
    clock.set(r.startMs);
    setPlaying(true);
  };
  const toggleFreeze = () => {
    if (frozen) { setFrozen(false); return; }
    pause();
    stopReplay();
    setFrozen(true);
  };
  const startRecording = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRecError(null);
    try {
      stopReplay();
      setFrozen(false);
      clock.set(0);
      // Proporción del canvas WebGL, con tope de ~400 mil píxeles (p. ej. 808×505): el
      // MP4 que elige pickVideoMime es H.264 nivel 3.0 (avc1.42E01E, ≤ 1620
      // macrobloques); más grande, Chromium entrega un video VACÍO (medido).
      // Lados pares para el códec.
      const k = Math.min(1, Math.sqrt(400_000 / Math.max(1, canvas.width * canvas.height)));
      const target = document.createElement('canvas');
      target.width = Math.max(2, Math.round((canvas.width * k) / 2) * 2);
      target.height = Math.max(2, Math.round((canvas.height * k) / 2) * 2);
      recRef.current = startRecording3D(target);
      setRecordTarget(target);
      setPlaying(true);
    } catch (e) {
      setRecError(e instanceof Error ? e.message : 'No se pudo grabar el video.');
    }
  };
  const chooseCamera = (k: CameraKind) => { setDirector(false); setCameraKind(k); };

  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  };

  // Mientras three arma la escena (texturas, cancha) se veía una pantalla azul
  // vacía: el aviso de carga se va con el primer cuadro dibujado.
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);

  const animated = frames.length > 1 || !!overlay;
  const fxLabel = def.label;
  const liveKind = director ? onAir : resolved.kind;

  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-950 text-white" data-testid="tactical-3d-viewer" data-camera={liveKind} onKeyDown={onKey}>
      <CanvasBoundary onError={() => fallback('error')}>
        <Canvas
          className="!absolute inset-0"
          dpr={[1, 1.5]}
          camera={{ fov: 45, near: 0.1, far: 3000, position: [0, court.lengthM, court.lengthM] }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ gl }) => {
            tactical3dStats.contextsCreated += 1;
            const canvas = gl.domElement;
            canvasRef.current = canvas;
            canvas.addEventListener('webglcontextlost', () => {
              tactical3dStats.contextsLost += 1;
              fallback('webgl');
            }, { once: true });
            if (!gl.capabilities.isWebGL2) fallback('webgl');
          }}
        >
          <Scene3D
            court={court}
            frames={frames}
            curve={curve}
            overlayFrames={overlay}
            overlayColor={overlayColor}
            keys={keys}
            overlayKeys={overlayKeys}
            visuals={visuals}
            overlayVisuals={overlayVisuals}
            clock={clock}
            playing={playing}
            speed={speed}
            totalMs={totalMs}
            stopAtMs={replay?.endMs ?? null}
            onEnded={onEnded}
            cameraKind={resolved.kind}
            director={director}
            playerKey={resolved.playerKey}
            playerView={playerView}
            selectedKey={selectedKey}
            onSelectPlayer={(k) => setSelectedKey(k)}
            onShot={onShot}
            showTrails={showTrails}
            frozen={frozen}
            recordTarget={recordTarget}
            watermark={watermark}
            reducedMotion={reducedMotion}
            minFps={minFps}
            onFpsVerdict={onFpsVerdict}
            debug={debug}
            teams={teams}
          />
          <FirstFrame onReady={onReady} />
        </Canvas>
      </CanvasBoundary>

      {!ready && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-950" role="status" aria-live="polite" data-testid="tactical-3d-loading">
          <div className="flex flex-col items-center gap-3 text-sm text-white/85">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-400" aria-hidden="true" />
            Cargando la cancha en 3D…
          </div>
        </div>
      )}

      {/* Arriba: título, cámaras y cerrar. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] bg-gradient-to-b from-black/70 to-transparent">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-words text-sm font-bold">{title || 'Jugada en 3D'}</p>
            <p className="text-xs text-white/75">
              {fxLabel} · {liveKind === 'libre' ? 'gira la cámara arrastrando con el dedo o el mouse' : 'toca un jugador para elegirlo'}
            </p>
          </div>
          <Button
            type="button"
            onClick={onClose}
            className="pointer-events-auto h-11 min-w-11 gap-1.5 bg-white/15 px-3 text-white hover:bg-white/25"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Volver a 2D
          </Button>
        </div>
        <div className="pointer-events-auto -mx-3 flex items-center gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none]" role="group" aria-label="Cámara">
          {animated && (
            <Button
              type="button"
              aria-pressed={director}
              disabled={reducedMotion}
              title={reducedMotion ? 'Desactivada: tu dispositivo pide reducir el movimiento' : 'Elige la cámara según la jugada'}
              onClick={() => setDirector((d) => !d)}
              className={cn('h-11 shrink-0 px-3 text-xs', director ? 'bg-amber-500 text-slate-950 hover:bg-amber-400' : 'bg-white/10 text-white hover:bg-white/20')}
            >
              Cámara automática
            </Button>
          )}
          {CAMERA_KINDS.map((k) => {
            const blocked = reducedMotion && AUTO_MOVING.has(k);
            return (
              <Button
                key={k}
                type="button"
                aria-pressed={!director && cameraKind === k}
                data-on-air={liveKind === k ? 'true' : undefined}
                disabled={blocked}
                title={blocked ? 'Desactivada: tu dispositivo pide reducir el movimiento' : undefined}
                onClick={() => chooseCamera(k)}
                className={cn(
                  'h-11 shrink-0 px-3 text-xs',
                  !director && cameraKind === k ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-white/10 text-white hover:bg-white/20',
                  director && liveKind === k && 'ring-2 ring-amber-400',
                )}
              >
                {cameraKindLabel(k, court.sport)}
              </Button>
            );
          })}
        </div>
        {!director && cameraKind === 'jugador' && keys.length > 0 && (
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 text-xs">
            <div className="flex items-center gap-1" role="group" aria-label="Vista del jugador">
              {(['pov', 'tercera'] as const).map((v) => (
                <Button
                  key={v}
                  type="button"
                  aria-pressed={playerView === v}
                  onClick={() => setPlayerView(v)}
                  className={cn('h-11 px-3 text-xs', playerView === v ? 'bg-white text-slate-900 hover:bg-white/90' : 'bg-white/10 text-white hover:bg-white/20')}
                >
                  {v === 'pov' ? 'Sus ojos' : 'Detrás de él'}
                </Button>
              ))}
            </div>
            <label className="flex items-center gap-1.5">
              <span className="sr-only sm:not-sr-only">Jugador</span>
              <select
                className="h-11 rounded-md border border-white/20 bg-slate-900 px-2 text-xs text-white"
                value={resolved.playerKey ?? ''}
                onChange={(e) => setSelectedKey(e.target.value)}
                aria-label="Jugador que sigue la cámara"
              >
                {keys.map((k, i) => (
                  <option key={k} value={k}>{playerOptionLabel(visuals[k], i)}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {director && (
          <p className="text-xs font-semibold text-amber-300" data-testid="director-on-air">
            Al aire: {cameraKindLabel(onAir, court.sport)}
          </p>
        )}
        {overlay && (
          <p className="flex items-center gap-1.5 text-xs text-white/85">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: overlayColor }} aria-hidden="true" />
            {overlayName}
          </p>
        )}
      </div>

      {/* Avisos de transmisión. */}
      <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 flex-col items-end gap-1.5">
        {replay && <Badge className="bg-sky-500 text-slate-950">Repetición · {speedLabel(REPLAY_SPEED)}</Badge>}
        {frozen && <Badge className="bg-amber-400 text-slate-950">Cuadro congelado</Badge>}
        {recording && <Badge className="bg-red-600 text-white"><Circle className="h-2.5 w-2.5 fill-current" aria-hidden="true" /> Grabando</Badge>}
      </div>

      {/* Abajo: reproducción. */}
      {animated && totalMs > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Timeline clock={clock} frames={frames} totalMs={totalMs} disabled={recording} onSeek={() => { pause(); stopReplay(); }} />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" onClick={() => step(-1)} disabled={recording} aria-label="Cuadro anterior" className="h-11 min-w-11 bg-white/10 px-2 text-white hover:bg-white/20">
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              onClick={togglePlay}
              disabled={recording}
              className="h-11 min-w-11 gap-1.5 bg-emerald-600 px-4 text-white hover:bg-emerald-500"
            >
              {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
              {playing ? 'Pausar' : 'Reproducir'}
            </Button>
            <Button type="button" onClick={() => step(1)} disabled={recording} aria-label="Cuadro siguiente" className="h-11 min-w-11 bg-white/10 px-2 text-white hover:bg-white/20">
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </Button>
            <div className="flex items-center gap-1" role="group" aria-label="Velocidad">
              {VIEWER_SPEEDS.map((s) => (
                <Button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  aria-label={`Velocidad ${String(s).replace('.', ',')} veces`}
                  disabled={recording}
                  onClick={() => { setReplay(null); setSpeed(s); }}
                  className={cn('h-11 min-w-11 px-2 text-xs', speed === s ? 'bg-white text-slate-900 hover:bg-white/90' : 'bg-white/10 text-white hover:bg-white/20')}
                >
                  {speedLabel(s)}
                </Button>
              ))}
            </div>
            <Button type="button" onClick={startReplay} disabled={recording || frames.length < 2} className="h-11 gap-1.5 bg-white/10 px-3 text-xs text-white hover:bg-white/20">
              <Repeat className="h-4 w-4" aria-hidden="true" /> Repetición
            </Button>
            <Button type="button" aria-pressed={frozen} onClick={toggleFreeze} disabled={recording} className={cn('h-11 gap-1.5 px-3 text-xs', frozen ? 'bg-amber-400 text-slate-950 hover:bg-amber-300' : 'bg-white/10 text-white hover:bg-white/20')}>
              <Snowflake className="h-4 w-4" aria-hidden="true" /> Congelar
            </Button>
            <Button type="button" aria-pressed={showTrails} onClick={() => setShowTrails((v) => !v)} className={cn('h-11 px-3 text-xs', showTrails ? 'bg-white text-slate-900 hover:bg-white/90' : 'bg-white/10 text-white hover:bg-white/20')}>
              Rastro
            </Button>
            {canRecord && (
              recording ? (
                <Button type="button" onClick={() => { pause(); void finishRecording(); }} className="h-11 gap-1.5 bg-red-600 px-3 text-xs text-white hover:bg-red-500">
                  <Square className="h-4 w-4 fill-current" aria-hidden="true" /> Terminar video
                </Button>
              ) : (
                <Button type="button" onClick={startRecording} className="h-11 gap-1.5 bg-white/10 px-3 text-xs text-white hover:bg-white/20">
                  <Video className="h-4 w-4" aria-hidden="true" /> Grabar video
                </Button>
              )
            )}
          </div>
          {frozen && <p className="text-xs text-white/85">Toca un jugador para ponerle el foco.</p>}
          {recError && <p role="alert" className="text-xs text-red-300">{recError}</p>}
        </div>
      )}
    </div>
  );
}

/** Avisa cuando la escena ya dibujó su primer cuadro (va dentro del Canvas,
 *  junto a la escena: si la escena suspende, esto también espera). */
function FirstFrame({ onReady }: { onReady: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    onReady();
  });
  return null;
}

function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide shadow', className)}>{children}</span>;
}

function playerOptionLabel(v: PlayerVisual | undefined, i: number) {
  if (!v) return `Jugador ${i + 1}`;
  const parts = [v.number, v.label].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : `Jugador ${i + 1}`;
}

function Timeline({ clock, frames, totalMs, onSeek, disabled }: {
  clock: ReturnType<typeof createPlaybackClock>; frames: TacticalFrame[]; totalMs: number; onSeek: () => void; disabled?: boolean;
}) {
  const t = useSyncExternalStore(clock.subscribe, clock.get);
  const index = frameIndexAt(frames, t);
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={0}
        max={totalMs}
        step={10}
        value={Math.round(t)}
        disabled={disabled}
        onChange={(e) => { onSeek(); clock.set(Number(e.target.value)); }}
        aria-label="Línea de tiempo de la jugada"
        className="h-8 flex-1 accent-emerald-500"
      />
      <span className="whitespace-nowrap text-xs tabular-nums text-white/85">
        Cuadro {index + 1} de {frames.length}
      </span>
    </div>
  );
}

/** Si three revienta (sin WebGL2, driver roto), se cae a 2D en vez de dejar
 *  la pantalla en negro. */
class CanvasBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}
