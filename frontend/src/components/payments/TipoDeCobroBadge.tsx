/**
 * Insignia «qué es este cobro» de Gestión de Pagos (Mensualidad, Clínica ·
 * <servicio>, Torneo, Clase de prueba…). Una sola pinta para Por validar,
 * Pagos recibidos, Operaciones y Glosas. La clasificación vive en
 * `lib/tipoDeCobro.ts`; aquí solo se dibuja.
 */
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { tipoDeCobro, textoDeTipo, type CobroParaTipo } from '@/lib/tipoDeCobro';

export function TipoDeCobroBadge({
    payment,
    className,
    /** false = solo el tipo («Clínica»), sin el nombre del servicio. */
    conServicio = true,
}: {
    payment: CobroParaTipo;
    className?: string;
    conServicio?: boolean;
}) {
    const t = tipoDeCobro(payment);
    const completo = textoDeTipo(t);
    return (
        <Badge
            variant="outline"
            title={completo}
            data-tipo-de-cobro={t.clave}
            // `block` + `truncate`: un nombre de servicio largo se corta con «…»
            // en vez de partir la pastilla en dos líneas (ver PaymentOriginBadge).
            className={cn('block w-fit max-w-[18rem] truncate text-[10px] leading-tight py-0.5 font-semibold', t.color, className)}
        >
            {conServicio ? completo : t.etiqueta}
        </Badge>
    );
}

/** Marca de quien paga sin ser del club (prospecto de un anuncio o del bot). */
export function ExternoBadge({ className }: { className?: string }) {
    return (
        <Badge
            variant="outline"
            title="Viene de un prospecto: no es deportista del club"
            className={cn(
                'w-fit whitespace-nowrap text-[10px] leading-tight py-0.5 font-semibold bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
                className,
            )}
        >
            Externo
        </Badge>
    );
}
