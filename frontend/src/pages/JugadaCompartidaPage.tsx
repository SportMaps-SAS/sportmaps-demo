/**
 * /jugada/:token — jugada de la pizarra compartida por WhatsApp, sin login.
 *
 * Solo lectura: la cancha con la jugada (y su animación si tiene cuadros) y la
 * invitación «Crea la tuya gratis» (→ registro). Los datos salen de la RPC
 * get_tactical_shared_play (recibe el token; la tabla está cerrada). No hay
 * nombres de deportistas: dorsal o iniciales (lib/school/tacticalSharedPlay.ts).
 * Mobile first: se abre desde WhatsApp.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, Loader2, Pause, Play, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TacticalStaticSvg, type TacticalStaticPlayer } from '@/components/school/TacticalStaticSvg';
import { interpolateFrames, framesDuration } from '@/lib/export/tacticalInterpolation';
import { WATERMARK_TEXT } from '@/lib/export/tacticalWatermark';
import { fetchSharedPlay } from '@/lib/school/tacticalSharedPlayApi';
import type { SharedPlay } from '@/lib/school/tacticalSharedPlay';
import { sportDef } from '@/lib/school/tacticalSports';
import type { TacticalArrow } from '@/lib/school/footballQueries';

type Estado = { tipo: 'cargando' } | { tipo: 'error'; mensaje: string } | { tipo: 'no_existe' } | { tipo: 'ok'; jugada: SharedPlay };

export default function JugadaCompartidaPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });

  useEffect(() => {
    let vivo = true;
    setEstado({ tipo: 'cargando' });
    fetchSharedPlay(token)
      .then((j) => { if (vivo) setEstado(j ? { tipo: 'ok', jugada: j } : { tipo: 'no_existe' }); })
      .catch((e: unknown) => { if (vivo) setEstado({ tipo: 'error', mensaje: e instanceof Error ? e.message : 'No se pudo abrir la jugada.' }); });
    return () => { vivo = false; };
  }, [token]);

  useEffect(() => {
    const t = estado.tipo === 'ok' ? estado.jugada.title : '';
    document.title = t ? `${t} · Jugada en SportMaps` : 'Jugada en SportMaps';
  }, [estado]);

  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-white">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between gap-3">
          <Link to="/" className="text-lg font-black tracking-tight text-emerald-400">SportMaps</Link>
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/80">Pizarra táctica</span>
        </header>

        {estado.tipo === 'cargando' && (
          <div className="flex flex-col items-center gap-3 py-24 text-sm text-white/75" role="status">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-400" aria-hidden="true" />
            Abriendo la jugada…
          </div>
        )}

        {(estado.tipo === 'no_existe' || estado.tipo === 'error') && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-center" role="alert">
            <AlertCircle className="mx-auto mb-2 h-8 w-8 text-amber-400" aria-hidden="true" />
            <p className="font-semibold">
              {estado.tipo === 'no_existe' ? 'Este enlace no existe o ya no está disponible.' : estado.mensaje}
            </p>
            <p className="mt-1 text-sm text-white/70">Pídele a quien te lo mandó que lo comparta otra vez.</p>
          </div>
        )}

        {estado.tipo === 'ok' && <VistaJugada jugada={estado.jugada} />}

        <CreaLaTuya />

        <p className="text-center text-xs text-white/55">{WATERMARK_TEXT}</p>
      </div>
    </div>
  );
}

function VistaJugada({ jugada }: { jugada: SharedPlay }) {
  const { payload } = jugada;
  const frames = payload.frames;
  const animada = frames.length > 1;
  const total = useMemo(() => framesDuration(frames), [frames]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);

  // Ancho real de la cancha: lo que da la pantalla, topado.
  const [ancho, setAncho] = useState(320);
  const roRef = useRef<ResizeObserver | null>(null);
  const caja = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setAncho(Math.max(220, Math.min(520, Math.floor(e.contentRect.width)))));
    ro.observe(el);
    roRef.current = ro;
  }, []);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      setT((prev) => {
        const next = prev + (now - last);
        if (next >= total) { setPlaying(false); return total; }
        return next;
      });
      last = now;
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, total]);

  const estado = useMemo(() => interpolateFrames(frames, t), [frames, t]);
  const players: TacticalStaticPlayer[] = estado.players
    .filter((p) => p.opacity > 0.05)
    .map((p) => {
      const jersey = payload.jerseys[p.key] ?? null;
      return { x: p.x, y: p.y, jersey, label: jersey == null ? (payload.labels[p.key] || undefined) : undefined, role: 'starter' as const };
    });
  const arrows: TacticalArrow[] = estado.ball
    ? [...estado.arrows, { type: 'ball', x1: estado.ball.x, y1: estado.ball.y, x2: estado.ball.x, y2: estado.ball.y }]
    : estado.arrows;
  const cuadro = Math.min(frames.length, estado.toIndex + 1);

  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    if (t >= total) setT(0);
    setPlaying(true);
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Jugada">
      <div>
        <h1 className="text-xl font-bold leading-tight break-words">{jugada.title || 'Jugada'}</h1>
        <p className="text-xs text-white/65">{sportDef(jugada.sport).label}{animada ? ` · ${frames.length} cuadros` : ''}</p>
      </div>
      <div ref={caja} className="w-full">
        <div className="mx-auto overflow-hidden rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10" style={{ width: ancho }}>
          <TacticalStaticSvg players={players} arrows={arrows} width={ancho} sport={jugada.sport} teams={payload.teams} />
        </div>
      </div>
      {animada && (
        <div className="flex flex-col gap-2">
          <input
            type="range" min={0} max={Math.max(1, total)} step={10} value={Math.round(t)}
            onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
            aria-label="Línea de tiempo de la jugada" className="h-8 w-full accent-emerald-500"
          />
          <div className="flex items-center gap-2">
            <Button type="button" onClick={togglePlay} className="min-h-11 gap-2 bg-emerald-600 px-5 text-white hover:bg-emerald-500">
              {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : t >= total && total > 0 ? <RotateCcw className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
              {playing ? 'Pausar' : t >= total && total > 0 ? 'Ver otra vez' : 'Reproducir'}
            </Button>
            <span className="text-xs tabular-nums text-white/70">Cuadro {cuadro} de {frames.length}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function CreaLaTuya() {
  return (
    <aside className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
      <p className="flex items-center gap-2 text-base font-bold">
        <Sparkles className="h-5 w-5 text-emerald-400" aria-hidden="true" />
        Crea la tuya gratis
      </p>
      <p className="mt-1 text-sm text-white/80">
        Arma jugadas en la pizarra de SportMaps, anímalas por cuadros, míralas en 3D y compártelas con tu equipo.
      </p>
      <Button asChild className="mt-3 min-h-11 w-full bg-emerald-600 font-bold text-white hover:bg-emerald-500">
        <Link to="/register?origen=jugada">Crear mi cuenta gratis</Link>
      </Button>
    </aside>
  );
}
