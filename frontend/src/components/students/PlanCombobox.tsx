import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCOP } from '@/lib/prorationUtils';
import { coincide } from '@/lib/planes/ordenPlanes';

export interface PlanComboboxOption {
  id: string;
  name: string;
  offering_name?: string | null;
  price?: number | null;
}

interface PlanComboboxProps {
  /** Ya en el orden en que se muestran (ver porOrdenDeCreacion). */
  plans: PlanComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  /** Valor de «Sin plan» en el formulario que lo usa ('none' o '__none__'). */
  noneValue: string;
  showPrice?: boolean;
  disabled?: boolean;
}

/**
 * Selector de plan con buscador para crear y editar deportistas. Con muchas
 * tarifas (Dreamers tiene 27) el Select plano obligaba a recorrer la lista entera.
 * Agrupa por programa, conserva el orden de creación y busca sin tildes en el
 * nombre del plan y del programa. Filtra él mismo (shouldFilter=false) porque el
 * filtro de cmdk reordena por relevancia.
 */
export function PlanCombobox({ plans, value, onChange, noneValue, showPrice = false, disabled = false }: PlanComboboxProps) {
  const [open, setOpen] = useState(false);
  const [busqueda, setBusqueda] = useState('');

  const etiqueta = (p: PlanComboboxOption) =>
    `${p.offering_name ? `${p.offering_name} — ` : ''}${p.name}${showPrice && p.price != null ? ` (${formatCOP(p.price)})` : ''}`;
  const elegido = plans.find((p) => p.id === value);

  const grupos = useMemo(() => {
    const out: { programa: string; planes: PlanComboboxOption[] }[] = [];
    for (const p of plans) {
      if (!coincide(`${p.name} ${p.offering_name ?? ''}`, busqueda)) continue;
      const programa = p.offering_name || 'Otros';
      const g = out.find((x) => x.programa === programa);
      if (g) g.planes.push(p); else out.push({ programa, planes: [p] });
    }
    return out;
  }, [plans, busqueda]);

  const elegir = (v: string) => {
    onChange(v);
    setOpen(false);
    setBusqueda('');
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setBusqueda(''); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between font-normal bg-background border-input hover:bg-muted/50', !elegido && 'text-muted-foreground')}
        >
          <span className="truncate">{elegido ? etiqueta(elegido) : 'Sin plan'}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[280px] p-0" align="start" side="bottom" sideOffset={4}>
        <Command shouldFilter={false}>
          <CommandInput placeholder="Buscar plan..." value={busqueda} onValueChange={setBusqueda} className="text-sm h-10 w-full" />
          <CommandList className="max-h-72 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
            <CommandEmpty>No hay planes con ese nombre.</CommandEmpty>
            {!busqueda && (
              <CommandItem value={noneValue} onSelect={() => elegir(noneValue)}>
                <Check className={cn('mr-2 h-4 w-4', !elegido ? 'opacity-100' : 'opacity-0')} />
                Sin plan
              </CommandItem>
            )}
            {grupos.map((g) => (
              <CommandGroup key={g.programa} heading={g.programa}>
                {g.planes.map((p) => (
                  <CommandItem key={p.id} value={p.id} onSelect={() => elegir(p.id)}>
                    <Check className={cn('mr-2 h-4 w-4 shrink-0', value === p.id ? 'opacity-100' : 'opacity-0')} />
                    <span className="flex-1 truncate">{p.name}</span>
                    {showPrice && p.price != null && <span className="ml-2 text-xs text-muted-foreground">{formatCOP(p.price)}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
