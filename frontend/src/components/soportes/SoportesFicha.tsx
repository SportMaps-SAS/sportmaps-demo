/**
 * Los soportes de UN deportista: lista con estado y botón de subir/reemplazar.
 * No pinta nada si la función está apagada para la escuela. Sin lenguaje de
 * cobro ni de mora: son documentos de la ficha.
 */
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  aceptaArchivo, etiquetaSoporte, leerBase64, mensajeErrorSoporte, soportesApi, validarArchivoSoporte,
  type SoportesDeportista, type TipoSujetoSoporte,
} from '@/lib/api/soportes';
import { SOPORTES_ESTADO_KEY } from './useSoportesEstado';

export const SOPORTES_FICHA_KEY = 'soportes-deportista';

export interface SoportesFichaProps {
  schoolId: string;
  tipoSujeto: TipoSujetoSoporte;
  sujetoId: string;
  /** Un deportista completo o sin permiso de subir: solo lectura. */
  puedeSubir?: boolean;
  titulo?: string;
  onCambio?: (r: { completo: boolean; faltan: string[] }) => void;
}

export function SoportesFicha({
  schoolId, tipoSujeto, sujetoId, puedeSubir = true, titulo = 'Soportes', onCambio,
}: SoportesFichaProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [subiendo, setSubiendo] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const q = useQuery<SoportesDeportista>({
    queryKey: [SOPORTES_FICHA_KEY, schoolId, tipoSujeto, sujetoId],
    queryFn: () => soportesApi.deportista(schoolId, tipoSujeto, sujetoId),
    enabled: !!schoolId && !!sujetoId,
    retry: false,
  });

  // Función apagada, sin permiso o sin la migración: no se muestra nada.
  if (q.isError || (q.data && !q.data.activo)) return null;

  const presentes = q.data ? q.data.requeridos.length - q.data.faltan.length : 0;

  const subir = async (tipo: string, file: File | undefined) => {
    if (!file) return;
    const invalido = validarArchivoSoporte(tipo, file);
    if (invalido) {
      toast({ title: 'No se pudo subir', description: invalido, variant: 'destructive' });
      return;
    }
    setSubiendo(tipo);
    try {
      const b64 = await leerBase64(file);
      const r = await soportesApi.subir(schoolId, tipoSujeto, sujetoId, tipo, b64, file.name);
      toast({ title: 'Soporte guardado', description: etiquetaSoporte(tipo) });
      await qc.invalidateQueries({ queryKey: [SOPORTES_FICHA_KEY, schoolId, tipoSujeto, sujetoId] });
      qc.invalidateQueries({ queryKey: [SOPORTES_ESTADO_KEY, schoolId] });
      onCambio?.({ completo: r.completo, faltan: r.faltan });
    } catch (e) {
      toast({ title: 'No se pudo subir', description: mensajeErrorSoporte(e), variant: 'destructive' });
    } finally {
      setSubiendo(null);
      const el = inputs.current[tipo];
      if (el) el.value = '';
    }
  };

  return (
    <section aria-label={titulo} data-testid="soportes-ficha">
      <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center justify-between gap-2">
        <span>{titulo}</span>
        {q.data && (
          <span className="normal-case tracking-normal text-xs font-medium" aria-live="polite">
            {presentes}/{q.data.requeridos.length}
          </span>
        )}
      </h3>

      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Cargando soportes…
        </div>
      ) : q.data ? (
        <>
          <p className="text-sm text-muted-foreground mb-2">
            {q.data.completo
              ? 'Tiene todos los soportes.'
              : `Faltan ${q.data.faltan.length} de ${q.data.requeridos.length}. Puedes subirlos aquí o la familia los envía desde la app.`}
          </p>
          <ul className="space-y-2">
            {q.data.requeridos.map((tipo) => {
              const falta = q.data!.faltan.includes(tipo);
              const ocupado = subiendo === tipo;
              return (
                <li key={tipo} className="flex items-center gap-3 rounded-lg border bg-card p-3">
                  {falta
                    ? <Circle className="h-5 w-5 shrink-0 text-amber-500" aria-hidden />
                    : <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />}
                  <span className="flex-1 min-w-0 text-sm">
                    <span className="block truncate">{etiquetaSoporte(tipo)}</span>
                    <span className="block text-xs text-muted-foreground">{falta ? 'Falta' : 'Cargado'}</span>
                  </span>
                  {puedeSubir && (
                    <>
                      <input
                        ref={(el) => { inputs.current[tipo] = el; }}
                        type="file"
                        className="sr-only"
                        accept={aceptaArchivo(tipo)}
                        aria-label={`Elegir archivo para ${etiquetaSoporte(tipo)}`}
                        onChange={(e) => void subir(tipo, e.target.files?.[0])}
                        tabIndex={-1}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant={falta ? 'default' : 'outline'}
                        disabled={!!subiendo}
                        onClick={() => inputs.current[tipo]?.click()}
                        aria-label={`${falta ? 'Subir' : 'Reemplazar'} ${etiquetaSoporte(tipo)}`}
                        className="gap-1.5 shrink-0"
                      >
                        {ocupado ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
                        {falta ? 'Subir' : 'Reemplazar'}
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">JPG, PNG o WEBP; PDF solo en los documentos. Máximo 4 MB. Fotos y firmas, solo imagen.</p>
        </>
      ) : null}
    </section>
  );
}
