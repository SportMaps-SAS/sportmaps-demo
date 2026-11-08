/**
 * Aviso de WhatsApp › Configuración: el texto que la escuela le escribió al
 * asistente (o la descripción de un servicio) contradice su catálogo.
 *
 * Plan docs/specs/whatsapp-ventas-de-servicio-blindaje.md, frente B. Caso
 * Monster 2026-11-08: el texto para el asistente decía «preventa hasta el 9 de
 * noviembre» y el catálogo de la clínica, «hasta el 10». La IA repitió el 9 a 12
 * personas. Ahora Mapi usa siempre el catálogo, pero la escuela tiene que ver la
 * contradicción para corregirla.
 *
 * GET /api/v1/whatsapp/:schoolId/coherencia-ficha. Sin contradicciones, o si la
 * llamada falla (p. ej. un coach: 403), no se muestra nada.
 */
import { useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';

export interface ContradiccionFicha {
    fuente: 'ficha' | 'descripcion';
    linea: number;
    dice: string;
    servicioId: string;
    servicio: string;
    tipo: 'fecha_de_precio' | 'monto';
    catalogo: string;
    mensaje: string;
}

export interface RespuestaCoherencia {
    servicios: number;
    ficha: boolean;
    contradicciones: ContradiccionFicha[];
}

export function CoherenciaFicha({ schoolId }: { schoolId: string }) {
    const [contradicciones, setContradicciones] = useState<ContradiccionFicha[]>([]);

    useEffect(() => {
        let vivo = true;
        bffClient.get<RespuestaCoherencia>(`/api/v1/whatsapp/${schoolId}/coherencia-ficha`)
            .then((r) => { if (vivo) setContradicciones(Array.isArray(r?.contradicciones) ? r.contradicciones : []); })
            .catch(() => { if (vivo) setContradicciones([]); });
        return () => { vivo = false; };
    }, [schoolId]);

    if (!contradicciones.length) return null;

    return (
        <Alert variant="warning" data-testid="coherencia-ficha">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Tu texto para el asistente no coincide con tu catálogo</AlertTitle>
            <AlertDescription>
                <ul className="mt-2 space-y-1.5">
                    {contradicciones.map((c) => (
                        <li key={`${c.fuente}-${c.servicioId}-${c.linea}-${c.tipo}`}>{c.mensaje}</li>
                    ))}
                </ul>
                <p className="mt-2 text-xs">
                    Mapi responde con lo que dice el catálogo. Corrige el texto (o el catálogo) para que digan lo mismo.
                </p>
            </AlertDescription>
        </Alert>
    );
}
