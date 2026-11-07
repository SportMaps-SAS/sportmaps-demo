/**
 * Captura de «¿Quién lo refirió?» en los altas («Agregar atleta» y «Por asignar
 * → Asignar»). Solo aparece con la campaña ACTIVA (GET /referidos/campaign).
 * El referido se registra DESPUÉS de crear la inscripción, con POST /referidos;
 * la ruta create-one no se toca. Un error aquí nunca deshace el alta.
 *
 * Uso:
 *   const referido = useReferidoAlta(schoolId);
 *   ...  {referido.campo}                                  // dentro del formulario
 *   ...  await referido.registrarTras({ tipo, id, ... })   // tras crear la inscripción
 *   ...  {referido.dialogo}                                // una vez, fuera del <Dialog> del alta
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { todayColombia } from '@/lib/dateUtils';
import {
  armarCuerpoReferido, buscarInscripcionReciente, codigoDeError, EDAD_MINIMA_REFERIDO,
  fechaNacimientoValida, guardarFechaNacimiento, mensajeErrorReferido, referidosApi,
  type ReferenteElegido, type TipoSujetoAlta,
} from '@/lib/api/referidos';
import { ReferenteBuscador } from './ReferenteBuscador';

export const CAMPANA_REFERIDOS_KEY = 'referidos-campana';

/** ¿La campaña está prendida? Cualquier error (403, 503, sin migración) = apagada. */
export function useCampanaReferidosActiva(schoolId: string | null | undefined) {
  const q = useQuery({
    queryKey: [CAMPANA_REFERIDOS_KEY, schoolId],
    queryFn: () => referidosApi.campana(schoolId as string),
    enabled: !!schoolId,
    retry: false,
    staleTime: 60_000,
  });
  return { activa: !!q.data?.campaign?.active, cargando: q.isLoading, data: q.data };
}

export interface SujetoAlta {
  tipo: TipoSujetoAlta;
  id: string;
  /** Si ya se conoce el id de la inscripción, se evita buscarlo. */
  enrollmentId?: string | null;
  nombre?: string;
}

export function useReferidoAlta(schoolId: string | null | undefined) {
  const { toast } = useToast();
  const { activa } = useCampanaReferidosActiva(schoolId);
  const [referente, setReferente] = useState<ReferenteElegido | null>(null);
  const [sinFecha, setSinFecha] = useState<{ sujeto: SujetoAlta; enrollmentId: string; terminar: () => void } | null>(null);

  const reiniciar = useCallback(() => { setReferente(null); setSinFecha(null); }, []);

  const intentar = useCallback(async (sujeto: SujetoAlta, enrollmentId: string, ref: ReferenteElegido, pedirFecha = true): Promise<void> => {
    try {
      const r = await referidosApi.registrar(schoolId as string, armarCuerpoReferido(enrollmentId, ref));
      if (r.ok === false) {
        toast({
          title: 'El referido no califica para el descuento',
          description: `Tiene ${r.edad} año${r.edad === 1 ? '' : 's'} y la campaña empieza a los ${EDAD_MINIMA_REFERIDO}. La inscripción quedó normal.`,
        });
        return;
      }
      toast({
        title: 'Referido registrado',
        description: ref.enrollmentId || ref.profileId
          ? `Quedó pendiente: el descuento se gana cuando ${sujeto.nombre ?? 'el deportista'} pague su primera mensualidad.`
          : 'Quedó sin confirmar: la administración debe ubicar a quien lo refirió.',
      });
    } catch (e) {
      if (pedirFecha && codigoDeError(e) === 'REF_SIN_FECHA_NACIMIENTO') {
        // Se espera a que la persona responda: así el alta que nos llamó no
        // cierra su ventana (y se lleva este diálogo) antes de tiempo.
        await new Promise<void>((terminar) => setSinFecha({ sujeto, enrollmentId, terminar }));
        return;
      }
      toast({
        title: 'El deportista quedó inscrito, pero no se registró el referido',
        description: `${mensajeErrorReferido(e)} Puedes registrarlo después desde su ficha.`,
        variant: 'destructive',
      });
    }
  }, [schoolId, toast]);

  const registrarTras = useCallback(async (sujeto: SujetoAlta): Promise<void> => {
    if (!activa || !referente || !schoolId) return;
    const enrollmentId = sujeto.enrollmentId || await buscarInscripcionReciente(schoolId, sujeto.tipo, sujeto.id);
    if (!enrollmentId) {
      toast({
        title: 'No se pudo registrar el referido',
        description: 'No encontramos la inscripción recién creada. Regístralo desde la ficha del deportista.',
        variant: 'destructive',
      });
      return;
    }
    await intentar(sujeto, enrollmentId, referente);
  }, [activa, referente, schoolId, toast, intentar]);

  const campo: ReactNode = activa && schoolId
    ? (
      <div data-testid="referido-campo" className="pt-3">
        <ReferenteBuscador schoolId={schoolId} valor={referente} onChange={setReferente} />
      </div>
    )
    : null;

  const dialogo: ReactNode = sinFecha && referente
    ? (
      <FechaNacimientoReferidoDialog
        nombre={sinFecha.sujeto.nombre ?? 'el deportista'}
        onCancelar={() => { const p = sinFecha; setSinFecha(null); p.terminar(); }}
        onGuardar={async (fecha) => {
          await guardarFechaNacimiento(sinFecha.sujeto.tipo, sinFecha.sujeto.id, fecha);
          const pendiente = sinFecha;
          setSinFecha(null);
          await intentar(pendiente.sujeto, pendiente.enrollmentId, referente, false);
          pendiente.terminar();
        }}
      />
    )
    : null;

  return { activa, referente, setReferente, reiniciar, campo, dialogo, registrarTras };
}

export function FechaNacimientoReferidoDialog({
  nombre, onGuardar, onCancelar,
}: { nombre: string; onGuardar: (fecha: string) => Promise<void>; onCancelar: () => void }) {
  const [fecha, setFecha] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hoy = todayColombia();
  const valida = fechaNacimientoValida(fecha, hoy);

  const guardar = async () => {
    setGuardando(true);
    setError(null);
    try {
      await onGuardar(fecha);
    } catch (e) {
      setError((e as Error)?.message || 'No se pudo guardar la fecha.');
      setGuardando(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !guardando && onCancelar()}>
      <DialogContent className="w-[95vw] max-w-sm">
        <DialogHeader>
          <DialogTitle>Falta la fecha de nacimiento</DialogTitle>
          <DialogDescription>
            Para calcular el descuento por referido necesitamos la edad de {nombre}. La inscripción ya quedó creada.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="ref-fecha-nac">Fecha de nacimiento</Label>
          <Input id="ref-fecha-nac" type="date" value={fecha} max={hoy} onChange={(e) => setFecha(e.target.value)} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onCancelar} disabled={guardando}>Registrar el referido después</Button>
          <Button onClick={() => void guardar()} disabled={!valida || guardando}>
            {guardando && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />} Guardar y registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
