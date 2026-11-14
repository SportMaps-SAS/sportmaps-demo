/**
 * Informe «Soportes pendientes»: a cada deportista, lo que le falta. Solo se ve
 * si la función está activa en la escuela. Lenguaje de documentos, nunca de cobro.
 */
import { useState } from 'react';
import { ChevronDown, ChevronUp, FileWarning } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { etiquetaSoporte, type EstadoSoportes } from '@/lib/api/soportes';
import { useSoportesEstado } from './useSoportesEstado';

/** Incompletos primero los que más les falta; luego por nombre. */
export function ordenarPendientes(e: EstadoSoportes) {
  return e.deportistas
    .filter((d) => !d.complete)
    .sort((a, b) => b.missing.length - a.missing.length || a.full_name.localeCompare(b.full_name, 'es'));
}

export function SoportesPendientesInforme({ schoolId }: { schoolId: string }) {
  const { activo, estado, cargando } = useSoportesEstado(schoolId);
  const [abierto, setAbierto] = useState(false);

  if (!activo || !estado) {
    // Cargando la primera vez: nada visible (la función puede estar apagada).
    return cargando ? <span className="sr-only" aria-live="polite">Cargando soportes…</span> : null;
  }

  const pendientes = ordenarPendientes(estado);

  return (
    <Card data-testid="soportes-informe">
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          aria-expanded={abierto}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="flex items-center gap-2 min-w-0">
            <FileWarning className="h-5 w-5 text-amber-600 shrink-0" aria-hidden />
            <span className="font-semibold">Soportes pendientes</span>
            <Badge variant={pendientes.length > 0 ? 'default' : 'secondary'}>{pendientes.length}</Badge>
          </span>
          {abierto ? <ChevronUp className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />}
        </button>
      </CardHeader>
      {abierto && (
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {estado.resumen.completos} de {estado.resumen.total} deportistas tienen los {estado.requeridos.length} soportes.
            {estado.resumen.sin_cuenta_incompletos > 0 && (
              <> {estado.resumen.sin_cuenta_incompletos} sin cuenta en la app: a ellos se les pide por WhatsApp.</>
            )}
          </p>
          {pendientes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay soportes pendientes. Todos los deportistas están completos.</p>
          ) : (
            <ul className="space-y-2">
              {pendientes.map((d) => (
                <li key={`${d.subject_type}:${d.subject_id}`} className="rounded-lg border p-3 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium leading-tight break-words min-w-0">{d.full_name}</p>
                    <div className="flex gap-1">
                      <Badge variant="outline">{d.present_total}/{d.required_total}</Badge>
                      {!d.has_account && <Badge variant="secondary">Sin cuenta</Badge>}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Falta: {d.missing.map(etiquetaSoporte).join(', ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
