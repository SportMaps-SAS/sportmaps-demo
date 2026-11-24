/**
 * Tarjeta de acción de Mapi (docs/specs/mapi-agente-plan.md §10 y §15).
 *
 * Mapi nunca ejecuta en su turno: prepara la acción y esta tarjeta la muestra
 * con la vista previa que escribió el SERVIDOR (no el modelo). Confirmar llama
 * al BFF, que vuelve a verificar permisos y datos antes de ejecutar; si algo
 * cambió, llega una tarjeta nueva para confirmar otra vez.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, X, Loader2, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";

export interface VistaAccion {
    titulo: string;
    lineas: string[];
    aviso?: string | null;
    detalle?: { etiqueta: string; items: string[] } | null;
    botonConfirmar: string;
}

export interface AccionMapi {
    id: string;
    herramienta: string;
    estado: string;
    vista: VistaAccion;
    expiraEn: string;
    mensajeId: string | null;
    reemplazadaPor: string | null;
    motivo: string | null;
    creadaEn: string;
}

const ESTADO: Record<string, { texto: string; clase: string }> = {
    executed: { texto: "Hecho", clase: "text-emerald-700 dark:text-emerald-400" },
    partial: { texto: "Hecho en parte", clase: "text-amber-700 dark:text-amber-400" },
    failed: { texto: "No se hizo", clase: "text-destructive" },
    cancelled: { texto: "Cancelada", clase: "text-muted-foreground" },
    expired: { texto: "Venció. Pídesela otra vez a Mapi.", clase: "text-muted-foreground" },
    superseded: { texto: "Reemplazada por una propuesta nueva", clase: "text-muted-foreground" },
    executing: { texto: "En curso… el resultado llega aquí al terminar.", clase: "text-muted-foreground" },
};

/** ¿Sigue pendiente y sin vencer? Puro (se prueba sin DOM). */
export function accionVigente(a: Pick<AccionMapi, "estado" | "expiraEn">, ahora: number = Date.now()): boolean {
    return a.estado === "draft" && new Date(a.expiraEn).getTime() > ahora;
}

export function MapiAccionCard({
    accion,
    ocupado,
    onConfirmar,
    onCancelar,
}: {
    accion: AccionMapi;
    ocupado: boolean;
    onConfirmar: (id: string) => void;
    onCancelar: (id: string) => void;
}) {
    const [verDetalle, setVerDetalle] = useState(false);
    // La tarjeta se muestra vencida al llegar la hora, sin recargar (§10.4).
    const [ahora, setAhora] = useState(() => Date.now());
    useEffect(() => {
        if (accion.estado !== "draft") return;
        const t = setInterval(() => setAhora(Date.now()), 15_000);
        return () => clearInterval(t);
    }, [accion.estado]);

    const vigente = accionVigente(accion, ahora);
    const estado = accion.estado === "draft" && !vigente ? ESTADO.expired : ESTADO[accion.estado];
    const v = accion.vista;

    return (
        <div
            className={`mt-2 rounded-xl border bg-background p-3 text-sm shadow-sm ${vigente ? "border-primary/40" : "border-border opacity-90"}`}
            aria-live="polite"
        >
            <p className="font-semibold leading-snug">{v.titulo}</p>
            <ul className="mt-1.5 space-y-1 text-muted-foreground">
                {v.lineas.map((l, i) => (
                    <li key={i} className="leading-snug">{l}</li>
                ))}
            </ul>
            {v.aviso && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {v.aviso}
                </p>
            )}
            {v.detalle && v.detalle.items.length > 0 && (
                <div className="mt-2">
                    <button
                        type="button"
                        className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        onClick={() => setVerDetalle((x) => !x)}
                        aria-expanded={verDetalle}
                    >
                        {verDetalle ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {v.detalle.etiqueta}
                    </button>
                    {verDetalle && (
                        <ul className="mt-1 max-h-40 overflow-y-auto rounded-md bg-muted/50 p-2 text-xs">
                            {v.detalle.items.map((it, i) => <li key={i}>{it}</li>)}
                        </ul>
                    )}
                </div>
            )}

            {vigente ? (
                <div className="mt-3 flex gap-2">
                    <Button type="button" size="sm" className="h-9 flex-1 gap-1" disabled={ocupado} onClick={() => onConfirmar(accion.id)}>
                        {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        {v.botonConfirmar || "Confirmar"}
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="h-9 gap-1" disabled={ocupado} onClick={() => onCancelar(accion.id)}>
                        <X className="h-4 w-4" /> Cancelar
                    </Button>
                </div>
            ) : (
                estado && (
                    <p className={`mt-2 text-xs font-medium ${estado.clase}`}>
                        {estado.texto}
                        {accion.estado === "failed" && accion.motivo ? `: ${accion.motivo}` : ""}
                    </p>
                )
            )}
        </div>
    );
}
