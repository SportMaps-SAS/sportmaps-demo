import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { MINUTOS_MAX, MINUTOS_MIN, PERIODOS_MAX, PERIODOS_MIN, validarFormatoVivo, type FormatoVivoForm } from './partidoVivoAgenda';

/** Bloque «Formato del partido» (Partido en vivo, solo con flag). Móvil primero, táctiles ≥44px. */
export function FormatoVivoCampos({ value, onChange }: { value: FormatoVivoForm; onChange: (v: FormatoVivoForm) => void }) {
  const error = validarFormatoVivo(value);
  const set = (p: Partial<FormatoVivoForm>) => onChange({ ...value, ...p });
  return (
    <div className="col-span-2 space-y-3 rounded-xl border p-3" aria-label="Formato del partido en vivo">
      <span className="text-base font-medium">Formato del partido</span>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="pf-tiempos" className="text-sm">Tiempos ({PERIODOS_MIN} a {PERIODOS_MAX})</Label>
          <Input id="pf-tiempos" type="number" inputMode="numeric" min={PERIODOS_MIN} max={PERIODOS_MAX} className="h-12 text-base" value={value.periodos} onChange={(e) => set({ periodos: Number(e.target.value) })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pf-minutos" className="text-sm">Minutos por tiempo ({MINUTOS_MIN} a {MINUTOS_MAX})</Label>
          <Input id="pf-minutos" type="number" inputMode="numeric" min={MINUTOS_MIN} max={MINUTOS_MAX} className="h-12 text-base" value={value.minutos} onChange={(e) => set({ minutos: Number(e.target.value) })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Oficial o de práctica">
        {([{ v: 'official', t: 'Oficial' }, { v: 'practice', t: 'De práctica' }] as const).map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={value.clase === o.v} onClick={() => set({ clase: o.v })}
            className={cn('h-12 rounded-xl border-2 text-base font-semibold', value.clase === o.v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}>
            {o.t}
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-arbitro" className="text-sm">Árbitro <span className="font-normal text-muted-foreground">(opcional)</span></Label>
        <Input id="pf-arbitro" className="h-12 text-base" maxLength={120} value={value.arbitro} onChange={(e) => set({ arbitro: e.target.value })} />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}
