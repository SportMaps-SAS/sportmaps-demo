/**
 * Monto de una fila de Gestión de Pagos: lo recibido en un abono («$175.000 de
 * $300.000») o el abono que declara un comprobante por validar. La regla vive
 * en `lib/montoMostrado.ts`; aquí solo se dibuja.
 */
import { cn, formatCurrency } from '@/lib/utils';
import { montoMostrado, type CobroParaMonto } from '@/lib/montoMostrado';

export function MontoRecibido({
    payment,
    cola = false,
    className,
}: {
    payment: CobroParaMonto;
    /** En la cola «Por validar» no se recorta a lo recibido: allí ya hay «Abonado X · saldo Y». */
    cola?: boolean;
    className?: string;
}) {
    const m = montoMostrado(payment, { cola });
    return (
        <span className={cn('inline-flex flex-col gap-0.5', className)}>
            <span>{formatCurrency(m.principal)}</span>
            {m.deCobro != null && (
                <span className="text-[10px] font-normal text-muted-foreground whitespace-nowrap">de {formatCurrency(m.deCobro)}</span>
            )}
            {m.declarado != null && (
                <span className="text-[10px] font-normal text-amber-700 whitespace-nowrap">
                    Comprobante por {formatCurrency(m.declarado)}
                </span>
            )}
        </span>
    );
}
