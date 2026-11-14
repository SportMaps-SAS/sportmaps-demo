/**
 * Clase de prueba → Configurar → «Cómo agenda el bot» (mig.
 * embudo_y_agenda_clase_prueba): días con clase de prueba, cómo la llama el
 * bot, horas que se guarda el cupo mientras llega el comprobante, cupos por
 * clase y aviso al entrenador. Todo en blanco = como funciona hoy.
 *
 * Sin las columnas en la base, la sección no aparece.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useAgendaClasePrueba } from '@/hooks/useClasePrueba';
import { DIAS_AGENDA, agendaDe, borradorDe, hayCambios, type BorradorAgenda } from './agendaClasePruebaModel';

export function AjustesAgendaClasePrueba({ schoolId }: { schoolId: string | null | undefined }) {
  const { toast } = useToast();
  const { disponible, agenda, guardar } = useAgendaClasePrueba(schoolId);
  const [b, setB] = useState<BorradorAgenda>(() => borradorDe(agenda));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setB(borradorDe(agenda)); }, [agenda]);

  if (!disponible) return null;

  const cambios = hayCambios(b, agenda);
  const alternarDia = (day: number) =>
    setB((p) => ({ ...p, dias: p.dias.includes(day) ? p.dias.filter((d) => d !== day) : [...p.dias, day] }));

  const onGuardar = () => {
    const r = agendaDe(b, agenda);
    if ('error' in r) { setError(r.error); return; }
    setError(null);
    guardar.mutate(r.agenda, {
      onSuccess: () => toast({ title: 'Listo: el bot ya agenda así' }),
      onError: (e: Error) => setError(e.message || 'No se pudo guardar.'),
    });
  };

  return (
    <div className="space-y-3 border-t border-border/40 pt-3" data-testid="agenda-clase-prueba">
      <div>
        <p className="text-xs font-semibold">Cómo agenda el bot</p>
        <p className="text-[11px] text-muted-foreground">En blanco, el bot sigue como hoy.</p>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-xs font-semibold">Días con clase de prueba</legend>
        <div className="grid grid-cols-7 gap-1">
          {DIAS_AGENDA.map((d) => {
            const activo = b.dias.includes(d.day);
            return (
              <button key={d.day} type="button" aria-pressed={activo} aria-label={d.largo} onClick={() => alternarDia(d.day)}
                className={cn('min-h-touch rounded-lg border-2 text-xs font-semibold',
                  activo ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground')}>
                {d.corto}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <p className="text-xs font-semibold">¿Cómo se llama?</p>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Cómo se llama la clase">
          {([['prueba', 'Clase de prueba'], ['cortesia', 'Clase de cortesía']] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={b.nombre === v} onClick={() => setB((p) => ({ ...p, nombre: v }))}
              className={cn('min-h-touch rounded-md px-2 text-xs', b.nombre === v ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground')}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold">
          Horas para separar el cupo
          <Input inputMode="numeric" placeholder="Sin separar" value={b.separar} className="h-8 bg-background text-xs"
            onChange={(e) => setB((p) => ({ ...p, separar: e.target.value.replace(/\D/g, '') }))} />
          <span className="font-normal text-muted-foreground">Si la clase tiene valor, el cupo se guarda mientras llega el comprobante.</span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold">
          Cupos por clase
          <Input inputMode="numeric" placeholder="Sin límite" value={b.cupos} className="h-8 bg-background text-xs"
            onChange={(e) => setB((p) => ({ ...p, cupos: e.target.value.replace(/\D/g, '') }))} />
          <span className="font-normal text-muted-foreground">Cuántos interesados caben en cada entreno.</span>
        </label>
      </div>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span>
          <strong>Avisar al entrenador</strong>
          <span className="block text-muted-foreground">Le llega un aviso cuando se agenda una clase de prueba en su grupo.</span>
        </span>
        <Switch checked={b.avisar} onCheckedChange={(v) => setB((p) => ({ ...p, avisar: v }))} aria-label="Avisar al entrenador" />
      </label>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {cambios && (
        <Button size="sm" className="h-8 text-xs" onClick={onGuardar} disabled={guardar.isPending}>
          {guardar.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Guardar cómo agenda el bot
        </Button>
      )}
    </div>
  );
}
