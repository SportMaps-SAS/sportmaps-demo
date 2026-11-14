import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCOP, type AvailabilitySlot } from './reservasApi';

interface SlotGridProps {
  slots: AvailabilitySlot[];
  selectedStartsAt: string | null;
  onSelect: (slot: AvailabilitySlot) => void;
  loading?: boolean;
  errorMessage?: string | null;
  emptyText?: string;
  showPrice?: boolean;
}

/** Grilla de franjas libres que devuelve la disponibilidad del BFF (precio real por franja). */
export function SlotGrid({
  slots, selectedStartsAt, onSelect, loading, errorMessage, emptyText, showPrice = true,
}: SlotGridProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Buscando horarios libres…
      </div>
    );
  }
  if (errorMessage) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
        {errorMessage}
      </div>
    );
  }
  if (slots.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {emptyText ?? 'No hay horarios libres ese día. Prueba con otra fecha o duración.'}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="slot-grid">
      {slots.map((s) => {
        const selected = s.starts_at === selectedStartsAt;
        return (
          <Button
            key={s.starts_at}
            type="button"
            variant={selected ? 'default' : 'outline'}
            onClick={() => onSelect(s)}
            className="h-auto flex-col gap-0.5 py-2"
            aria-pressed={selected}
          >
            <span className="text-sm font-semibold">{s.start_local} – {s.end_local}</span>
            {showPrice && (
              <span className={`text-[11px] ${selected ? 'opacity-90' : 'text-muted-foreground'}`}>
                {s.price > 0 ? formatCOP(s.price) : 'Sin costo'}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
