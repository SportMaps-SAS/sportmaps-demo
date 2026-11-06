/**
 * Piezas de la pantalla de cancha (móvil primero: objetivos táctiles ≥ 56 px, alto contraste, una mano).
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Cloud, CloudOff, Loader2, Minus, Plus, Square, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useDeportistasEquipo } from '@/components/coach/v2/useCoachV2Data';
import { sujetoDe } from '@/components/coach/v2/coachV2Logic';
import { keyOfRef, minuteLabel, plannedSecondsOf, type LiveState, type LogItem, type LivePlayer, type SubjectRef } from './liveMatchLogic';
import type { QueuedItem, RejectedItem } from './liveQueue';

// ── Conexión y cola ──────────────────────────────────────────────────────────

export function ConnectionBadge({ offline, pendientes, onOpen }: { offline: boolean; pendientes: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={offline ? 'Sin conexión; ver pendientes' : 'Conectado; ver pendientes'}
      className={cn(
        'flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 text-sm font-semibold',
        offline ? 'border-amber-500 bg-amber-100 text-amber-900' : 'border-emerald-600/40 bg-emerald-50 text-emerald-900',
      )}
    >
      {offline ? <CloudOff className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
      {offline ? 'Sin conexión' : 'En línea'}
      {pendientes > 0 && (
        <span className="ml-1 rounded-full bg-foreground px-2 py-0.5 text-xs text-background">{pendientes} pendiente{pendientes === 1 ? '' : 's'}</span>
      )}
    </button>
  );
}

export function PendingSheet({
  open, onOpenChange, items, rejected, blocked, offline, onDismiss, onRetry,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; items: readonly QueuedItem[]; rejected: readonly RejectedItem[];
  blocked: string | null; offline: boolean; onDismiss: (id: string) => void; onRetry: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Eventos pendientes</SheetTitle>
          <SheetDescription>
            {offline ? 'Sin conexión: se guardan en este celular y se envían solos al volver la señal.' : 'Se envían en orden; no se duplican si se reintenta.'}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-3 space-y-2">
          {blocked && <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive">{blocked}. Los eventos siguen guardados.</p>}
          {items.length === 0 && rejected.length === 0 && <p className="text-sm text-muted-foreground">Todo está enviado.</p>}
          {items.map((i) => (
            <div key={i.event.client_event_id} className="flex items-center justify-between rounded-xl border p-3 text-sm">
              <span className="font-medium">{i.label}</span>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">pendiente</span>
            </div>
          ))}
          {rejected.map((r) => (
            <div key={r.event.client_event_id} className="space-y-1 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium">{r.label}</p>
              <p className="text-destructive">No se pudo aplicar: {r.reason}</p>
              <Button variant="outline" className="h-11 rounded-xl" onClick={() => onDismiss(r.event.client_event_id)}>Entendido, descartar</Button>
            </div>
          ))}
          {items.length > 0 && <Button className="h-14 w-full rounded-xl text-base" onClick={onRetry}>Reintentar ahora</Button>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Reloj y marcador ─────────────────────────────────────────────────────────

export function Scoreboard({
  opponent, scoreFor, scoreAgainst, label, addedLabel, running, planned, periodNo, periods, statusText,
}: {
  opponent: string; scoreFor: number; scoreAgainst: number; label: string; addedLabel: string | null; running: boolean;
  planned: number; periodNo: number; periods: number; statusText: string;
}) {
  return (
    <section aria-label="Reloj y marcador" className="rounded-2xl bg-slate-900 p-4 text-white">
      <div className="flex items-center justify-between text-sm text-slate-300">
        <span>{periodNo > 0 ? `Tiempo ${periodNo} de ${periods}` : `${periods} tiempo${periods === 1 ? '' : 's'}`} · {Math.round(planned / 60)}′</span>
        <span className="font-semibold uppercase tracking-wide">{statusText}</span>
      </div>
      <div className="mt-1 flex items-end justify-center gap-2" aria-live="off">
        <span className={cn('font-mono text-6xl font-bold tabular-nums', running ? 'text-white' : 'text-slate-300')}>{label}</span>
        {addedLabel && <span className="mb-2 font-mono text-2xl font-bold text-amber-300">{addedLabel}</span>}
      </div>
      <div className="mt-2 flex items-center justify-center gap-4 text-center">
        <div><p className="text-xs text-slate-300">Nosotros</p><p className="text-4xl font-bold tabular-nums">{scoreFor}</p></div>
        <span className="text-2xl text-slate-400">–</span>
        <div><p className="max-w-[9rem] truncate text-xs text-slate-300">{opponent}</p><p className="text-4xl font-bold tabular-nums">{scoreAgainst}</p></div>
      </div>
    </section>
  );
}

// ── Jugadores ────────────────────────────────────────────────────────────────

export function PlayerButton({
  p, minutes, selected, tone, disabled, onClick,
}: {
  p: LivePlayer; minutes?: string; selected?: boolean; tone: 'field' | 'bench' | 'off'; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={!!selected}
      className={cn(
        'flex min-h-[56px] w-full items-center gap-3 rounded-xl border-2 px-3 text-left transition-colors active:scale-[0.99]',
        tone === 'field' && 'border-emerald-600/50 bg-emerald-50',
        tone === 'bench' && 'border-border bg-card',
        tone === 'off' && 'border-red-300 bg-red-50 opacity-70',
        selected && 'border-primary bg-primary/15 ring-2 ring-primary',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-lg font-bold text-white">{p.jersey_number ?? '—'}</span>
      <span className="min-w-0 flex-1 truncate text-base font-semibold">{p.name}</span>
      {minutes && <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{minutes}</span>}
      {tone === 'off' && <span className="shrink-0 text-xs font-bold text-red-700">Expulsado</span>}
    </button>
  );
}

// ── Registro de eventos ──────────────────────────────────────────────────────

const TIPO: Record<string, string> = {
  period_start: 'Pitazo inicial', period_end: 'Fin del tiempo', sub: 'Cambio', goal: 'Gol', goal_against: 'Gol en contra',
  yellow: 'Amarilla', red: 'Roja', callup: 'Convocado', clock_adjust: 'Ajuste de reloj',
};

export function EventLog({ items, server, nameOf }: { items: LogItem[]; server: LiveState | null; nameOf: (r: SubjectRef | null) => string }) {
  const ultimos = [...items].reverse().slice(0, 6);
  if (ultimos.length === 0) return null;
  return (
    <section aria-label="Últimos eventos" className="space-y-1.5">
      <h2 className="text-sm font-bold text-muted-foreground">Últimos eventos</h2>
      {ultimos.map((e) => {
        const min = e.type === 'period_start' || e.type === 'period_end' ? `T${e.periodNo}` : minuteLabel(e.periodSecond, plannedSecondsOf(server, e.periodNo), e.inBreak);
        const detalle = e.type === 'sub' ? `entra ${nameOf(e.subject)}, sale ${nameOf(e.related)}` : e.subject ? nameOf(e.subject) : '';
        return (
          <div key={e.clientEventId} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
            <span className="w-14 shrink-0 font-mono font-semibold tabular-nums">{min}</span>
            <span className="min-w-0 flex-1 truncate"><b>{TIPO[e.type] ?? e.type}</b>{detalle && ` · ${detalle}`}</span>
            {e.pending && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">pendiente</span>}
          </div>
        );
      })}
    </section>
  );
}

// ── Minutos por jugador (en vivo) ────────────────────────────────────────────

interface ReportRow { subject_type: string; subject_id: string; name: string; jersey_number: number | null; role: string; seconds?: number; minutes?: number; minutes_live?: number; pct?: number; sent_off?: boolean }

export const minutosDeFila = (r: ReportRow): number => r.minutes_live ?? r.minutes ?? Math.round((r.seconds ?? 0) / 60);

export function MinutesSheet({
  open, onOpenChange, report, onRefresh,
}: { open: boolean; onOpenChange: (v: boolean) => void; report: Record<string, unknown> | null; onRefresh: () => void }) {
  useEffect(() => {
    if (!open) return;
    onRefresh();
    const t = setInterval(onRefresh, 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const rows = ((report?.lineup as ReportRow[] | undefined) ?? []).slice().sort((a, b) => minutosDeFila(b) - minutosDeFila(a));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Minutos por jugador</SheetTitle>
          <SheetDescription>Con lo ya enviado al servidor. Se actualiza solo.</SheetDescription>
        </SheetHeader>
        <ul className="mt-3 divide-y">
          {rows.length === 0 && <li className="py-3 text-sm text-muted-foreground">Aún no hay minutos.</li>}
          {rows.map((r) => (
            <li key={`${r.subject_type}:${r.subject_id}`} className="flex min-h-[48px] items-center gap-3 py-1.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white">{r.jersey_number ?? '—'}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <span className="text-base font-bold tabular-nums">{minutosDeFila(r)}′</span>
              <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">{r.pct != null ? `${Math.round(r.pct)}%` : ''}</span>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

// ── Sumar convocado en vivo (D-V7) ───────────────────────────────────────────

export function CallupSheet({
  open, onOpenChange, teamId, lineup, busy, onAdd,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; teamId: string | null; lineup: LivePlayer[]; busy: boolean;
  onAdd: (s: SubjectRef, jersey: number) => Promise<boolean>;
}) {
  const { schoolId } = useSchoolContext();
  const roster = useDeportistasEquipo(schoolId, teamId);
  const [sel, setSel] = useState<{ ref: SubjectRef; nombre: string } | null>(null);
  const [jersey, setJersey] = useState('');
  const dentro = useMemo(() => new Set(lineup.map(keyOfRef)), [lineup]);
  const usados = useMemo(() => new Set(lineup.map((p) => p.jersey_number).filter((n): n is number => n != null)), [lineup]);
  const candidatos = (roster.data ?? []).map((d) => ({ ref: sujetoDe(d) as SubjectRef, nombre: d.nombre })).filter((c) => !dentro.has(keyOfRef(c.ref)));
  const n = Number(jersey);
  const valido = jersey !== '' && Number.isInteger(n) && n >= 0 && n <= 999 && !usados.has(n);

  return (
    <Sheet open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setSel(null); setJersey(''); } }}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>Sumar convocado</SheetTitle>
          <SheetDescription>Entra a la banca con su dorsal. Necesita conexión.</SheetDescription>
        </SheetHeader>
        {!sel ? (
          <ul className="mt-3 space-y-2">
            {roster.isLoading && <li className="text-sm text-muted-foreground">Cargando el equipo…</li>}
            {!roster.isLoading && candidatos.length === 0 && <li className="text-sm text-muted-foreground">Todo el equipo ya está convocado.</li>}
            {candidatos.map((c) => (
              <li key={keyOfRef(c.ref)}>
                <button type="button" onClick={() => setSel(c)} className="flex min-h-[56px] w-full items-center gap-2 rounded-xl border-2 px-3 text-left text-base font-semibold">
                  <UserPlus className="h-5 w-5 text-primary" />{c.nombre}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-base font-semibold">{sel.nombre}</p>
            <label className="block text-sm font-medium" htmlFor="pv-callup-jersey">Dorsal</label>
            <Input id="pv-callup-jersey" type="number" inputMode="numeric" min={0} max={999} className="h-14 text-2xl" value={jersey} onChange={(e) => setJersey(e.target.value)} autoFocus />
            {jersey !== '' && !valido && <p role="alert" className="text-sm text-destructive">{usados.has(n) ? 'Ese dorsal ya está en uso.' : 'Dorsal entre 0 y 999.'}</p>}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="h-14 rounded-xl text-base" onClick={() => setSel(null)}>Atrás</Button>
              <Button className="h-14 rounded-xl text-base" disabled={!valido || busy}
                onClick={async () => { if (await onAdd(sel.ref, n)) { setSel(null); setJersey(''); onOpenChange(false); } }}>
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="mr-1 h-5 w-5" />}Sumar a la banca
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Terminar partido ─────────────────────────────────────────────────────────

export function FinishDialog({
  open, onOpenChange, initialFor, initialAgainst, pendientes, busy, onConfirm,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; initialFor: number; initialAgainst: number; pendientes: number; busy: boolean;
  onConfirm: (f: number, a: number) => void;
}) {
  const [f, setF] = useState(initialFor);
  const [a, setA] = useState(initialAgainst);
  useEffect(() => { if (open) { setF(initialFor); setA(initialAgainst); } }, [open, initialFor, initialAgainst]);
  const Stepper = ({ label, v, set }: { label: string; v: number; set: (n: number) => void }) => (
    <div className="flex flex-col items-center gap-2">
      <span className="text-sm font-semibold text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" className="h-14 w-14 rounded-xl" aria-label={`Restar a ${label}`} onClick={() => set(Math.max(0, v - 1))}><Minus className="h-5 w-5" /></Button>
        <span className="w-12 text-center text-4xl font-bold tabular-nums">{v}</span>
        <Button variant="outline" size="icon" className="h-14 w-14 rounded-xl" aria-label={`Sumar a ${label}`} onClick={() => set(v + 1)}><Plus className="h-5 w-5" /></Button>
      </div>
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle>Terminar el partido</DialogTitle>
          <DialogDescription>Confirma el marcador final. Está precargado con los goles registrados.</DialogDescription>
        </DialogHeader>
        <div className="flex justify-around py-2"><Stepper label="A favor" v={f} set={setF} /><Stepper label="En contra" v={a} set={setA} /></div>
        {pendientes > 0 && <p role="alert" className="rounded-lg bg-amber-100 p-2 text-sm text-amber-900">Hay {pendientes} evento(s) sin enviar; se enviarán antes de cerrar.</p>}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" className="h-14 rounded-xl text-base" onClick={() => onOpenChange(false)}>Seguir jugando</Button>
          <Button className="h-14 rounded-xl text-base" disabled={busy} onClick={() => onConfirm(f, a)}>
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Square className="mr-1 h-5 w-5" />}Terminar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
