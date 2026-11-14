/**
 * «Soportes del deportista» — lo que la escuela exige y todavía falta, con «Subir» por cada uno.
 * Spec: docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6b.
 *
 * Solo se ve si la escuela los exige (`activo`). Sin lenguaje de cobro.
 * Sube por el BFF (base64, JPG/PNG/WEBP/PDF hasta 4 MB; fotos y firmas solo imagen).
 *
 * Punto de enganche: un solo `<SoportesDelDeportista ... />` en la ficha del hijo o del adulto.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { DOCUMENTOS_DEPORTISTA } from '@/lib/documentosDeportista';
import {
    archivoABase64, estadoSoportes, mensajeErrorSoportes, SOLO_IMAGEN, subirSoporte, validarSoporte,
    type TipoSujeto,
} from '@/lib/api/soportesFamilia';

interface Props {
    schoolId: string | null | undefined;
    tipoSujeto: TipoSujeto;
    sujetoId: string | null | undefined;
    nombre: string;
}

export const etiquetaSoporte = (tipo: string) =>
    DOCUMENTOS_DEPORTISTA.find((d) => d.tipo === tipo)?.label ?? tipo;

export function SoportesDelDeportista({ schoolId, tipoSujeto, sujetoId, nombre }: Props) {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const inputRef = useRef<HTMLInputElement>(null);
    const [tipoElegido, setTipoElegido] = useState<string | null>(null);
    const clave = ['soportes', schoolId, tipoSujeto, sujetoId];

    const q = useQuery({
        queryKey: clave,
        queryFn: () => estadoSoportes(schoolId!, tipoSujeto, sujetoId!),
        enabled: !!schoolId && !!sujetoId,
        retry: false,
        staleTime: 60_000,
    });

    const subir = useMutation({
        mutationFn: async ({ tipo, archivo }: { tipo: string; archivo: File }) => {
            const base64 = await archivoABase64(archivo);
            return subirSoporte(schoolId!, tipoSujeto, sujetoId!, tipo, base64, archivo.name);
        },
        onSuccess: (_r, v) => {
            toast({ title: 'Listo', description: `${etiquetaSoporte(v.tipo)}: recibido.` });
            void queryClient.invalidateQueries({ queryKey: clave });
        },
        onError: (e) => toast({ title: 'No se pudo subir', description: mensajeErrorSoportes(e), variant: 'destructive' }),
        onSettled: () => setTipoElegido(null),
    });

    // Sin escuela que los exija (o sin permiso para verlos): no se muestra nada.
    if (!q.data || !q.data.activo) return null;
    const { faltan, requeridos } = q.data;
    const primerNombre = nombre.split(' ')[0] || 'el deportista';

    const elegir = (tipo: string) => {
        setTipoElegido(tipo);
        if (inputRef.current) {
            inputRef.current.accept = SOLO_IMAGEN.includes(tipo) ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,application/pdf';
            inputRef.current.click();
        }
    };

    const alElegirArchivo = (e: React.ChangeEvent<HTMLInputElement>) => {
        const archivo = e.target.files?.[0];
        e.target.value = '';
        const tipo = tipoElegido;
        if (!archivo || !tipo) { setTipoElegido(null); return; }
        const problema = validarSoporte(archivo, tipo);
        if (problema) {
            toast({ title: 'No se pudo subir', description: problema, variant: 'destructive' });
            setTipoElegido(null);
            return;
        }
        subir.mutate({ tipo, archivo });
    };

    return (
        <section className="space-y-3 rounded-xl border bg-card p-3" aria-label={`Soportes de ${nombre}`}>
            <div>
                <h4 className="text-sm font-semibold">Soportes del deportista</h4>
                <p className="text-sm text-muted-foreground" role="status">
                    {faltan.length === 0
                        ? `Los soportes de ${primerNombre} están completos.`
                        : `Faltan ${faltan.length} de ${requeridos.length || faltan.length} soportes de ${primerNombre}.`}
                </p>
            </div>

            <input ref={inputRef} type="file" className="hidden" aria-hidden="true" tabIndex={-1} onChange={alElegirArchivo} />

            {faltan.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Todo recibido, gracias.
                </p>
            ) : (
                <ul className="divide-y rounded-lg border">
                    {faltan.map((tipo) => {
                        const cargando = subir.isPending && tipoElegido === tipo;
                        return (
                            <li key={tipo} className="flex min-h-touch items-center justify-between gap-2 px-3 py-2">
                                <span className="min-w-0 flex-1 text-sm">
                                    {etiquetaSoporte(tipo)}
                                    <span className="block text-xs text-muted-foreground">
                                        {SOLO_IMAGEN.includes(tipo) ? 'Foto JPG, PNG o WEBP' : 'PDF o foto'} · máx. 4 MB
                                    </span>
                                </span>
                                <Button
                                    variant="outline" size="sm" className="min-h-touch shrink-0"
                                    aria-label={`Subir ${etiquetaSoporte(tipo)}`}
                                    disabled={subir.isPending}
                                    onClick={() => elegir(tipo)}
                                >
                                    {cargando
                                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                        : <><Upload className="mr-1 h-4 w-4" aria-hidden="true" />Subir</>}
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
