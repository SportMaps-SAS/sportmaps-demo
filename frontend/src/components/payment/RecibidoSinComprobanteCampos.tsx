/**
 * Campos de la constancia de un pago SIN comprobante: cómo se recibió, cuándo y
 * quién lo recibió (ver lib/payments/constanciaDeRecibido). Controlado.
 *
 * `mostrarMetodo` / `mostrarFecha` se apagan donde el formulario ya los pide
 * (registrar pago manual, Cobros y pagos): ahí solo falta «quién recibió».
 */
import { AlertTriangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MEDIOS_RECIBIDO, MAX_RECIBIDO_POR, type MedioRecibido } from '@/lib/payments/constanciaDeRecibido';

export interface RecibidoDraft {
  metodo: MedioRecibido | '';
  fecha: string;
  por: string;
}

export function RecibidoSinComprobanteCampos({
  value, onChange, hoy, mostrarMetodo = true, mostrarFecha = true, idPrefix = 'recibido', error,
}: {
  value: RecibidoDraft;
  onChange: (next: RecibidoDraft) => void;
  hoy: string;
  mostrarMetodo?: boolean;
  mostrarFecha?: boolean;
  idPrefix?: string;
  /** Mensaje de lo que falta; se pinta solo cuando el padre quiere mostrarlo. */
  error?: string | null;
}) {
  const set = (patch: Partial<RecibidoDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50/60 p-3" data-testid="recibido-sin-comprobante">
      <p className="flex items-start gap-1.5 text-xs font-semibold text-amber-800">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Este pago no tiene comprobante. Deja constancia de cómo lo recibiste.
      </p>
      {(mostrarMetodo || mostrarFecha) && (
        <div className="grid grid-cols-2 gap-2">
          {mostrarMetodo && (
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-metodo`} className="text-xs">¿Cómo lo recibiste?</Label>
              <select
                id={`${idPrefix}-metodo`}
                value={value.metodo}
                onChange={(e) => set({ metodo: e.target.value as MedioRecibido | '' })}
                className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Elige…</option>
                {MEDIOS_RECIBIDO.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          )}
          {mostrarFecha && (
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-fecha`} className="text-xs">¿Cuándo lo recibiste?</Label>
              <Input id={`${idPrefix}-fecha`} type="date" max={hoy} value={value.fecha} onChange={(e) => set({ fecha: e.target.value })} className="h-10" />
            </div>
          )}
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-por`} className="text-xs">¿Quién lo recibió?</Label>
        <Input
          id={`${idPrefix}-por`}
          value={value.por}
          maxLength={MAX_RECIBIDO_POR}
          placeholder="Nombre de quien lo recibió (equipo de la escuela)"
          onChange={(e) => set({ por: e.target.value })}
          className="h-10"
        />
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
