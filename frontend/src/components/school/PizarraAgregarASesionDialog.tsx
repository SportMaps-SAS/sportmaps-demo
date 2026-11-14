/**
 * Pizarra libre (/pizarra) → «Agregar a una sesión»: elegir un bloque de las
 * próximas sesiones del equipo (o uno nuevo «Pizarra» al final). La jugada se
 * guarda como la pizarra de ese bloque, la misma que se abre desde la sesión.
 * Lógica pura en lib/school/pizarraSesiones.ts.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Loader2, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { todayColombia } from '@/lib/dateUtils';
import { capitalizar, fechaHumana, sumarDias } from '@/components/coach/v2/asistenciaModel';
import { blockIdPatch, destinosDeSesiones, type DestinoBloque, type SesionParaPizarra } from '@/lib/school/pizarraSesiones';

/** Cuántos días hacia adelante se ofrecen. */
const DIAS = 21;

export function PizarraAgregarASesionDialog({ open, onOpenChange, teamId, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  onPick: (blockId: string, label: string) => void;
}) {
  const queryClient = useQueryClient();
  const hoy = todayColombia();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['pizarra-libre-sesiones', teamId, hoy],
    enabled: open && !!teamId,
    queryFn: async () => {
      const { data, error: err } = await supabase
        .from('training_sessions')
        .select('id, session_date, session_blocks, warmup, drills')
        .eq('team_id', teamId)
        .gte('session_date', hoy)
        .lte('session_date', sumarDias(hoy, DIAS))
        .order('session_date', { ascending: true });
      if (err) throw err;
      const rows = (data ?? []) as SesionParaPizarra[];
      // session_blocks de cada sesión: para asignarle id a un bloque que no lo tiene.
      return { destinos: destinosDeSesiones(rows), raw: new Map(rows.map((r) => [r.id, r.session_blocks])) };
    },
  });
  const destinos = q.data?.destinos ?? [];
  const rawOf = (id: string) => q.data?.raw.get(id);

  async function elegir(dest: DestinoBloque, sessionBlocks: unknown) {
    const key = `${dest.sessionId}:${dest.blockIndex ?? 'new'}`;
    setBusy(key);
    setError(null);
    try {
      let blockId = dest.blockId;
      if (!blockId) {
        const patch = blockIdPatch(sessionBlocks, dest.blockIndex, crypto.randomUUID());
        const { error: err } = await supabase.from('training_sessions').update({ session_blocks: patch.blocks as never }).eq('id', dest.sessionId);
        if (err) throw err;
        blockId = patch.blockId;
        void queryClient.invalidateQueries({ queryKey: ['v2-ses-rango'] });
        void queryClient.invalidateQueries({ queryKey: ['training-sessions', teamId] });
      }
      onPick(blockId, `la sesión del ${fechaHumana(dest.date)} (${dest.name})`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'No se pudo preparar el bloque.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] w-[calc(100vw-1rem)] max-w-md overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle>Agregar a una sesión</DialogTitle>
          <DialogDescription>
            Elige el bloque donde va esta jugada. Queda como la pizarra de ese bloque.
          </DialogDescription>
        </DialogHeader>

        {q.isPending ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : q.isError ? (
          <p className="text-sm text-destructive">No se pudieron cargar las sesiones. Revisa tu conexión.</p>
        ) : destinos.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">
            Este equipo no tiene sesiones en los próximos {DIAS} días. Créala en Sesiones y vuelve a la pizarra,
            o guarda la jugada en Mis jugadas.
          </p>
        ) : (
          <ul className="space-y-3">
            {destinos.map((s) => (
              <li key={s.sessionId} className="rounded-xl border p-3">
                <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  {capitalizar(fechaHumana(s.date))}
                </p>
                {s.legacyOnly && (
                  <p className="text-xs text-muted-foreground">Esta sesión no tiene bloques. Ábrela en Sesiones para agregarlos.</p>
                )}
                <div className="flex flex-col gap-1.5">
                  {s.blocks.map((b) => {
                    const key = `${b.sessionId}:${b.blockIndex}`;
                    return (
                      <Button key={key} variant="outline" className="min-h-11 justify-start text-left" disabled={!!busy}
                        onClick={() => void elegir(b, rawOf(s.sessionId))}>
                        {busy === key ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {b.name}
                      </Button>
                    );
                  })}
                  {s.canAppend && (
                    <Button variant="ghost" className="min-h-11 justify-start gap-2 text-left text-emerald-700 dark:text-emerald-400" disabled={!!busy}
                      onClick={() => void elegir({ sessionId: s.sessionId, date: s.date, blockIndex: null, blockId: null, name: 'Pizarra' }, rawOf(s.sessionId))}>
                      {busy === `${s.sessionId}:new` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      Bloque nuevo «Pizarra»
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
