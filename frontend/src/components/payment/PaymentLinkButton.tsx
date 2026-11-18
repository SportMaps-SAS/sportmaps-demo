/**
 * <PaymentLinkButton> — botón al link de pago genérico de la escuela
 * (payment_accounts type 'payment_link', p.ej. el Wompi de Dynasty,
 * https://checkout.wompi.co/l/Hj5s7R, 2026-10-06).
 *
 * Va dentro del bloque de transferencia a propósito: el link NO sabe a qué
 * cobro corresponde (el acudiente escribe el valor en Wompi), así que el cierre
 * es el mismo que el de una transferencia — subir el comprobante para que la
 * escuela lo aplique. Abre en pestaña nueva para no perder el checkout.
 */

import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { textoBotonLinkDePago, PAYMENT_LINK_NOTICE } from '@/lib/payment-accounts';

interface Props {
    url: string;
    className?: string;
}

export function PaymentLinkButton({ url, className }: Props) {
    return (
        <div className={`rounded border bg-background/80 p-3 font-sans ${className ?? ''}`}>
            <Button asChild className="w-full">
                {/* stopPropagation: el bloque padre es una tarjeta clicable que cambia el método. */}
                <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                    <ExternalLink className="mr-2 h-4 w-4" /> {textoBotonLinkDePago(url)}
                </a>
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">{PAYMENT_LINK_NOTICE}</p>
        </div>
    );
}
