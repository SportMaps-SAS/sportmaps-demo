/**
 * Filtro por tipo de cobro con conteo (Mensualidad (12), Clínica (1)…). En
 * chips para la cola «Por validar», que es corta y se trabaja a la vista, y
 * como lista desplegable en «Pagos recibidos», donde ya hay varios filtros en
 * fila. Solo ofrece los tipos que aparecen; el elegido se mantiene aunque se
 * quede en 0 para que no se «suelte» solo al buscar.
 */
import { cn } from '@/lib/utils';
import {
    COLOR_TIPO_DE_COBRO,
    ORDEN_TIPOS_DE_COBRO,
    etiquetaDeFiltro,
    type ClaveTipoDeCobro,
} from '@/lib/tipoDeCobro';

export const TODOS_LOS_TIPOS = 'all';

interface Opcion {
    clave: ClaveTipoDeCobro;
    n: number;
}

function opciones(conteos: Partial<Record<ClaveTipoDeCobro, number>>, valor: string): Opcion[] {
    return ORDEN_TIPOS_DE_COBRO
        .filter((k) => (conteos[k] ?? 0) > 0 || k === valor)
        .map((k) => ({ clave: k, n: conteos[k] ?? 0 }));
}

export function FiltroTipoDeCobro({
    conteos,
    valor,
    onChange,
    variante = 'chips',
    className,
}: {
    conteos: Partial<Record<ClaveTipoDeCobro, number>>;
    /** `TODOS_LOS_TIPOS` o una clave de tipo. */
    valor: string;
    onChange: (valor: string) => void;
    variante?: 'chips' | 'select';
    className?: string;
}) {
    const lista = opciones(conteos, valor);
    const total = Object.values(conteos).reduce<number>((s, n) => s + (n ?? 0), 0);

    if (variante === 'select') {
        return (
            <select
                aria-label="Tipo de cobro"
                className={cn(
                    'flex h-9 w-full sm:w-48 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    className,
                )}
                value={valor}
                onChange={(e) => onChange(e.target.value)}
            >
                <option value={TODOS_LOS_TIPOS}>Todos los tipos ({total})</option>
                {lista.map((o) => (
                    <option key={o.clave} value={o.clave}>{etiquetaDeFiltro(o.clave)} ({o.n})</option>
                ))}
            </select>
        );
    }

    const chip = 'inline-flex items-center gap-1 rounded-full border px-2.5 h-7 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
    return (
        <div role="group" aria-label="Tipo de cobro" className={cn('flex flex-wrap gap-1.5', className)}>
            <button
                type="button"
                aria-pressed={valor === TODOS_LOS_TIPOS}
                onClick={() => onChange(TODOS_LOS_TIPOS)}
                className={cn(
                    chip,
                    valor === TODOS_LOS_TIPOS
                        ? 'bg-foreground text-background border-foreground'
                        : 'bg-background text-muted-foreground hover:bg-muted',
                )}
            >
                Todos <span className="tabular-nums">({total})</span>
            </button>
            {lista.map((o) => {
                const activo = valor === o.clave;
                return (
                    <button
                        key={o.clave}
                        type="button"
                        aria-pressed={activo}
                        // Tocar el tipo activo lo suelta (vuelve a «Todos»).
                        onClick={() => onChange(activo ? TODOS_LOS_TIPOS : o.clave)}
                        className={cn(
                            chip,
                            COLOR_TIPO_DE_COBRO[o.clave],
                            activo ? 'ring-2 ring-offset-1 ring-current font-semibold' : 'opacity-80 hover:opacity-100',
                        )}
                    >
                        {etiquetaDeFiltro(o.clave)} <span className="tabular-nums">({o.n})</span>
                    </button>
                );
            })}
        </div>
    );
}
