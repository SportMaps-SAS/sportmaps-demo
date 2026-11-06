/**
 * Pantalla de cancha del Partido en vivo (F2-b) para quien lleva el partido desde el celular.
 * Spec: docs/specs/partido-en-vivo-sustituciones.md §6–§8. Flujo de toques:
 *  · Cambio en 2 toques: toca quien SALE (en cancha) y luego quien ENTRA (banca) — o al revés. El minuto lo pone el reloj.
 *  · Gol / Amarilla / Roja: toca el botón de abajo y luego el jugador. Gol en contra: un toque, sin jugador.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Clock, Flag, Goal, Loader2, Play, Square, StopCircle, Undo2, UserPlus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineError, SectionSkeleton } from '@/components/parent/v2/hijos/parts';
import { cn } from '@/lib/utils';
import { useLiveMatch } from './useLiveMatch';
import { keyOfRef, plannedSecondsOf, type LivePlayer, type SubjectRef } from './liveMatchLogic';
import { PreStartPanel } from './PreStartPanel';
import {
  CallupSheet, ConnectionBadge, EventLog, FinishDialog, MinutesSheet, PendingSheet, PlayerButton, Scoreboard, minutosDeFila,
} from './LiveMatchParts';

type Mode = null | 'goal' | 'yellow' | 'red';

const MODE_HELP: Record<Exclude<Mode, null>, string> = {
  goal: 'Toca quién hizo el gol',
  yellow: 'Toca a quién se le sacó la amarilla',
  red: 'Toca a quién se le sacó la roja',
};

export function LiveMatchScreen({ matchId }: { matchId: string }) {
  const navigate = useNavigate();
  const live = useLiveMatch(matchId);
  const { server, proj, clock, actions } = live;

  const [mode, setMode] = useState<Mode>(null);
  const [selOut, setSelOut] = useState<SubjectRef | null>(null);
  const [selIn, setSelIn] = useState<SubjectRef | null>(null);
  const [pendOpen, setPendOpen] = useState(false);
  const [minOpen, setMinOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);

  const lineup = useMemo(() => server?.lineup ?? [], [server]);
  const enCancha = useMemo(() => lineup.filter((p) => proj.onField.has(keyOfRef(p))), [lineup, proj.onField]);
  const banca = useMemo(() => lineup.filter((p) => !proj.onField.has(keyOfRef(p)) && !proj.sentOff.has(keyOfRef(p))), [lineup, proj.onField, proj.sentOff]);
  const expulsados = useMemo(() => lineup.filter((p) => proj.sentOff.has(keyOfRef(p))), [lineup, proj.sentOff]);

  const nameOf = (r: SubjectRef | null) => {
    const p = r ? lineup.find((x) => keyOfRef(x) === keyOfRef(r)) : null;
    return p ? `${p.jersey_number ?? '—'} ${p.name}` : 'Jugador';
  };
  const reportRows = (live.report?.lineup as Array<{ subject_type: string; subject_id: string; minutes?: number; minutes_live?: number; seconds?: number }> | undefined) ?? [];
  const minutosDe = (p: LivePlayer) => {
    const r = reportRows.find((x) => x.subject_type === p.subject_type && x.subject_id === p.subject_id);
    return r ? `${minutosDeFila(r as never)}′` : undefined;
  };

  const resetSel = () => { setSelOut(null); setSelIn(null); setMode(null); };

  const onPlayer = (p: LivePlayer, zona: 'field' | 'bench') => {
    if (live.readOnly || live.finished) return;
    if (proj.sentOff.has(keyOfRef(p))) return;
    if (mode === 'goal') {
      if (zona !== 'field') return;
      actions.goal(p); resetSel(); return;
    }
    if (mode === 'yellow' || mode === 'red') {
      actions.card(mode, p); resetSel(); return;
    }
    if (zona === 'field') {
      if (selIn) { actions.sub(p, selIn); resetSel(); return; }
      setSelOut(selOut && keyOfRef(selOut) === keyOfRef(p) ? null : p);
    } else {
      if (selOut) { actions.sub(selOut, p); resetSel(); return; }
      setSelIn(selIn && keyOfRef(selIn) === keyOfRef(p) ? null : p);
    }
  };

  // ── estados de carga / error ──
  if (live.phase === 'loading') return <div className="p-4"><SectionSkeleton rows={5} label="Cargando el partido en vivo" /></div>;
  if (live.phase === 'error' || !live.header) {
    return <div className="p-4"><InlineError message={live.loadError ?? 'No pudimos abrir el partido en vivo.'} onRetry={() => window.location.reload()} /></div>;
  }
  const h = live.header;
  const volver = () => navigate(`/partidos/${encodeURIComponent(h.id)}`);

  const encabezado = (
    <header className="flex items-center gap-2">
      <Button variant="ghost" size="icon" className="h-12 w-12 shrink-0 rounded-xl" onClick={volver} aria-label="Volver al partido"><ArrowLeft className="h-5 w-5" /></Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-bold">Contra {h.opponent}</h1>
        <p className="truncate text-xs text-muted-foreground">Partido en vivo</p>
      </div>
      <ConnectionBadge offline={live.offline} pendientes={live.pendientes} onOpen={() => setPendOpen(true)} />
    </header>
  );

  const hojas = (
    <>
      <PendingSheet open={pendOpen} onOpenChange={setPendOpen} items={live.pendientesItems} rejected={live.rechazados} blocked={live.bloqueada}
        offline={live.offline} onDismiss={live.dismissRejected} onRetry={() => { void actions.flush(); }} />
      <MinutesSheet open={minOpen} onOpenChange={setMinOpen} report={live.report} onRefresh={() => { void actions.fetchReport(); }} />
      <CallupSheet open={callOpen} onOpenChange={setCallOpen} teamId={h.team_id} lineup={lineup} busy={live.busy} onAdd={actions.addCallup} />
      <FinishDialog open={finishOpen} onOpenChange={setFinishOpen} initialFor={proj.scoreFor} initialAgainst={proj.scoreAgainst}
        pendientes={live.pendientes} busy={live.busy}
        onConfirm={async (f, a) => { if (await actions.finish(f, a)) setFinishOpen(false); }} />
    </>
  );

  // ── antes de iniciar ──
  if (!server) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-3 pb-28">
        {encabezado}
        <PreStartPanel matchId={h.id} periodos={h.live_periods_count} minutos={h.live_period_minutes} busy={live.busy} onStart={actions.start} />
        {hojas}
      </div>
    );
  }

  // ── terminado ──
  if (live.finished) {
    const score = (live.report?.score as { for?: number; against?: number } | undefined) ?? {};
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-3 pb-28">
        {encabezado}
        <section className="rounded-2xl bg-slate-900 p-4 text-center text-white">
          <p className="text-sm text-slate-300">Partido terminado</p>
          <p className="text-5xl font-bold tabular-nums">{score.for ?? proj.scoreFor} – {score.against ?? proj.scoreAgainst}</p>
          <p className="mt-1 text-sm text-slate-300">Contra {h.opponent}</p>
        </section>
        <section className="rounded-xl border bg-card p-3">
          <h2 className="mb-2 text-sm font-bold text-muted-foreground">Minutos por jugador</h2>
          {reportRows.length === 0 ? (
            <Button variant="outline" className="h-12 w-full rounded-xl" onClick={() => { void actions.fetchReport(); }}>Ver minutos</Button>
          ) : (
            <ul className="divide-y">
              {lineup.map((p) => (
                <li key={keyOfRef(p)} className="flex min-h-[44px] items-center gap-3 py-1">
                  <span className="w-8 text-center font-bold">{p.jersey_number ?? '—'}</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="font-bold tabular-nums">{minutosDe(p) ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Button className="h-14 rounded-xl text-base" onClick={volver}>Volver al partido (informe y evaluación)</Button>
        {live.esAdmin && <Button variant="outline" className="h-12 rounded-xl" disabled={live.busy} onClick={() => { void actions.reopen(); }}>Reabrir partido (administración)</Button>}
        {hojas}
      </div>
    );
  }

  // ── en juego ──
  const enJuego = proj.status === 'in_period';
  const descanso = proj.status === 'on_break';
  const ultimoTiempo = proj.currentPeriod >= (server.periods_planned || 1);
  const statusText = enJuego ? 'En juego' : descanso ? 'Descanso' : 'Listo';
  const bloqueado = live.readOnly;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-3 pb-48">
      {encabezado}
      {bloqueado && <p role="status" className="rounded-xl border border-amber-500 bg-amber-100 p-3 text-sm font-medium text-amber-900">Solo lectura: otra persona lleva este partido. Pídele a la administración que te reasigne.</p>}
      {live.bloqueada && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive">{live.bloqueada}. Tus eventos siguen guardados en este celular.</p>}

      <Scoreboard opponent={h.opponent} scoreFor={proj.scoreFor} scoreAgainst={proj.scoreAgainst} label={clock.label} addedLabel={clock.addedLabel}
        running={clock.running} planned={plannedSecondsOf(server, proj.currentPeriod || 1)} periodNo={proj.currentPeriod}
        periods={server.periods_planned} statusText={statusText} />

      {/* Pitazos */}
      {!bloqueado && (
        <div className="grid grid-cols-1 gap-2">
          {enJuego ? (
            <Button className="h-16 rounded-xl bg-red-600 text-lg text-white hover:bg-red-700" onClick={actions.endPeriod}>
              <StopCircle className="mr-2 h-6 w-6" />Terminar tiempo {proj.currentPeriod}
            </Button>
          ) : (descanso && ultimoTiempo) ? null : (
            <Button className="h-16 rounded-xl text-lg" onClick={actions.startPeriod}>
              <Play className="mr-2 h-6 w-6" />Pitazo inicial · tiempo {proj.currentPeriod + 1}
            </Button>
          )}
        </div>
      )}

      {/* Ayuda del modo / selección */}
      {(mode || selOut || selIn) && (
        <div role="status" className="flex items-center justify-between rounded-xl border-2 border-primary bg-primary/10 px-3 py-2 text-sm font-semibold">
          <span>
            {mode ? MODE_HELP[mode]
              : selOut ? `Sale ${nameOf(selOut)}: toca quién entra`
                : `Entra ${nameOf(selIn)}: toca quién sale`}
          </span>
          <Button variant="outline" className="h-11 rounded-lg" onClick={resetSel}>Cancelar</Button>
        </div>
      )}

      {!enJuego && !descanso && proj.currentPeriod === 0 && <p className="text-center text-sm text-muted-foreground">Da el pitazo inicial para empezar el reloj. Los titulares ya están en cancha.</p>}

      <section aria-label="En cancha" className="space-y-1.5">
        <h2 className="text-sm font-bold text-muted-foreground">En cancha ({enCancha.length})</h2>
        {enCancha.length === 0 && <p className="text-sm text-muted-foreground">Nadie en cancha todavía.</p>}
        {enCancha.map((p) => (
          <PlayerButton key={keyOfRef(p)} p={p} tone="field" minutes={minutosDe(p)} disabled={bloqueado}
            selected={!!selOut && keyOfRef(selOut) === keyOfRef(p)} onClick={() => onPlayer(p, 'field')} />
        ))}
      </section>

      <section aria-label="Banca" className="space-y-1.5">
        <h2 className="text-sm font-bold text-muted-foreground">Banca ({banca.length})</h2>
        {banca.map((p) => (
          <PlayerButton key={keyOfRef(p)} p={p} tone="bench" minutes={minutosDe(p)} disabled={bloqueado}
            selected={!!selIn && keyOfRef(selIn) === keyOfRef(p)} onClick={() => onPlayer(p, 'bench')} />
        ))}
        {expulsados.map((p) => <PlayerButton key={keyOfRef(p)} p={p} tone="off" disabled onClick={() => {}} />)}
      </section>

      <EventLog items={live.log} server={server} nameOf={nameOf} />

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" className="h-14 rounded-xl text-base" onClick={() => setMinOpen(true)}><Clock className="mr-2 h-5 w-5" />Minutos</Button>
        <Button variant="outline" className="h-14 rounded-xl text-base" disabled={bloqueado} onClick={() => setCallOpen(true)}><UserPlus className="mr-2 h-5 w-5" />Sumar convocado</Button>
        <Button variant="outline" className="h-14 rounded-xl text-base" disabled={bloqueado || live.busy} onClick={() => { void actions.undoLast(); }}><Undo2 className="mr-2 h-5 w-5" />Anular último</Button>
        <Button variant="outline" className="h-14 rounded-xl border-red-300 text-base text-red-700" disabled={bloqueado || proj.currentPeriod === 0} onClick={() => setFinishOpen(true)}>
          {live.busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Square className="mr-2 h-5 w-5" />}Terminar partido
        </Button>
      </div>

      {/* Barra de acciones fija (pulgar) */}
      {!bloqueado && (
        <nav aria-label="Acciones de cancha" className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto grid max-w-xl grid-cols-4 gap-2">
            <Button className={cn('h-16 flex-col gap-0.5 rounded-xl text-sm', mode === 'goal' && 'ring-4 ring-primary/40')} disabled={!enJuego}
              onClick={() => { setSelOut(null); setSelIn(null); setMode(mode === 'goal' ? null : 'goal'); }}>
              <Goal className="h-5 w-5" />Gol
            </Button>
            <Button variant="outline" className="h-16 flex-col gap-0.5 rounded-xl border-2 border-slate-400 text-sm" disabled={!enJuego} onClick={actions.goalAgainst}>
              <Goal className="h-5 w-5" />En contra
            </Button>
            <Button className={cn('h-16 flex-col gap-0.5 rounded-xl bg-yellow-400 text-sm text-black hover:bg-yellow-500', mode === 'yellow' && 'ring-4 ring-yellow-400/50')} disabled={!enJuego && !descanso}
              onClick={() => { setSelOut(null); setSelIn(null); setMode(mode === 'yellow' ? null : 'yellow'); }}>
              <Flag className="h-5 w-5" />Amarilla
            </Button>
            <Button className={cn('h-16 flex-col gap-0.5 rounded-xl bg-red-600 text-sm text-white hover:bg-red-700', mode === 'red' && 'ring-4 ring-red-500/50')} disabled={!enJuego && !descanso}
              onClick={() => { setSelOut(null); setSelIn(null); setMode(mode === 'red' ? null : 'red'); }}>
              <Users className="h-5 w-5" />Roja
            </Button>
          </div>
        </nav>
      )}
      {hojas}
    </div>
  );
}
