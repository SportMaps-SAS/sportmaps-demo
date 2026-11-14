/**
 * Antes del pitazo: titulares/banca con dorsal (obligatorio en vivo) y botón «Iniciar partido».
 * Lee la convocatoria con los hooks que ya usa PartidoFlujo; los dorsales se guardan en match_lineup_players
 * (antes de iniciar no hay `match_live`, así que set_live_jersey aún no aplica).
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useConvocatoria, useNombresConvocados } from '@/components/coach/v2/useCoachV2Data';
import { supabase } from '@/integrations/supabase/client';
import { EmptyNote, SectionSkeleton } from '@/components/parent/v2/hijos/parts';
import { cn } from '@/lib/utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Valida dorsales: faltantes y repetidos (el servidor revalida con JERSEY_REQUIRED / JERSEY_DUPLICATE). */
export function validarDorsales(filas: Array<{ id: string; dorsal: string }>): { faltan: string[]; repetidos: string[] } {
  const faltan = filas.filter((f) => f.dorsal.trim() === '' || !Number.isInteger(Number(f.dorsal)) || Number(f.dorsal) < 0 || Number(f.dorsal) > 999).map((f) => f.id);
  const cuenta = new Map<string, number>();
  for (const f of filas) if (f.dorsal.trim() !== '') cuenta.set(String(Number(f.dorsal)), (cuenta.get(String(Number(f.dorsal))) ?? 0) + 1);
  const repetidos = filas.filter((f) => f.dorsal.trim() !== '' && (cuenta.get(String(Number(f.dorsal))) ?? 0) > 1).map((f) => f.id);
  return { faltan, repetidos };
}

export function PreStartPanel({
  matchId, periodos, minutos, busy, onStart,
}: { matchId: string; periodos: number | null; minutos: number | null; busy: boolean; onStart: () => Promise<boolean> }) {
  const { schoolId } = useSchoolContext();
  const qc = useQueryClient();
  const conv = useConvocatoria(matchId);
  const players = useMemo(() => conv.data?.players ?? [], [conv.data]);
  const nombres = useNombresConvocados(schoolId, players);
  const [editados, setEditados] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);

  if (conv.isLoading) return <SectionSkeleton rows={4} label="Cargando la convocatoria" />;
  if (!conv.data || players.length === 0) {
    return <EmptyNote><p className="font-semibold text-foreground">Falta la convocatoria.</p><p className="mt-1">Convoca a los jugadores (con titulares) antes de llevar el partido en vivo.</p></EmptyNote>;
  }

  const filas = players.map((p) => ({
    id: p.id, p, nombre: nombres.data?.get(`${p.subject_type}:${p.subject_id}`) ?? 'Deportista',
    dorsal: editados[p.id] ?? (p.jersey_number != null ? String(p.jersey_number) : ''),
  }));
  const { faltan, repetidos } = validarDorsales(filas.map((f) => ({ id: f.id, dorsal: f.dorsal })));
  const titulares = filas.filter((f) => f.p.role === 'starter').length;
  const listo = faltan.length === 0 && repetidos.length === 0 && titulares > 0;

  const iniciar = async () => {
    setGuardando(true);
    try {
      for (const f of filas) {
        if (editados[f.id] === undefined) continue;
        const { error } = await db.from('match_lineup_players').update({ jersey_number: Number(f.dorsal) }).eq('id', f.id);
        if (error) { toast.error('No pudimos guardar un dorsal. Revisa la conexión.'); return; }
      }
      setEditados({});
      qc.invalidateQueries({ queryKey: ['coach-v2', 'convocatoria', matchId] });
      await onStart();
    } finally { setGuardando(false); }
  };

  const Grupo = ({ titulo, rol }: { titulo: string; rol: 'starter' | 'bench' }) => (
    <section className="space-y-2">
      <h2 className="text-sm font-bold text-muted-foreground">{titulo}</h2>
      {filas.filter((f) => (f.p.role === 'starter') === (rol === 'starter')).map((f) => {
        const mal = faltan.includes(f.id) || repetidos.includes(f.id);
        return (
          <div key={f.id} className="flex min-h-[56px] items-center gap-3 rounded-xl border bg-card px-3">
            <span className="min-w-0 flex-1 truncate text-base font-semibold">{f.nombre}</span>
            <label className="sr-only" htmlFor={`pv-d-${f.id}`}>Dorsal de {f.nombre}</label>
            <Input id={`pv-d-${f.id}`} type="number" inputMode="numeric" min={0} max={999} placeholder="N.º" aria-invalid={mal}
              className={cn('h-12 w-20 text-center text-xl font-bold', mal && 'border-destructive')}
              value={f.dorsal} onChange={(e) => setEditados((m) => ({ ...m, [f.id]: e.target.value }))} />
          </div>
        );
      })}
    </section>
  );

  return (
    <div className="space-y-4">
      <p className="rounded-xl border bg-card p-3 text-sm">
        Formato: <b>{periodos ?? 2} tiempo{(periodos ?? 2) === 1 ? '' : 's'} de {minutos ?? 45}′</b>
        {periodos == null && ' (por defecto; se cambia al programar el partido)'}. Todos necesitan dorsal para llevar el partido en vivo.
      </p>
      <Grupo titulo={`Titulares (${titulares})`} rol="starter" />
      <Grupo titulo="Banca" rol="bench" />
      {faltan.length > 0 && <p role="alert" className="text-sm text-destructive">Falta el dorsal de {faltan.length} jugador(es).</p>}
      {repetidos.length > 0 && <p role="alert" className="text-sm text-destructive">Hay dorsales repetidos.</p>}
      {titulares === 0 && <p role="alert" className="text-sm text-destructive">Marca al menos un titular en la convocatoria.</p>}
      <Button className="h-16 w-full rounded-xl text-lg" disabled={!listo || busy || guardando} onClick={iniciar}>
        {busy || guardando ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Play className="mr-2 h-5 w-5" />}Iniciar partido
      </Button>
      <p className="text-center text-xs text-muted-foreground">Quedas como director: solo tú registras los eventos.</p>
    </div>
  );
}
