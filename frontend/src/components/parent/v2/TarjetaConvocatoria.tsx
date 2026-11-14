/**
 * «¿Va Tomás?» — respuesta del acudiente a la convocatoria de un partido (B1).
 *
 * El aviso de `save_match_roster` dice «Cuéntanos si va» y el profe ve «sin
 * responder», pero la V2 del acudiente no tenía dónde contestar. Sale en la
 * tarjeta de cada hijo en Inicio y en el detalle del partido del Calendario.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Trophy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { misConvocatorias, responderConvocatoria } from '@/lib/api/v2Contratos';
import {
  convocatoriasDeHijos,
  fraseRespuesta,
  preguntaConvocatoria,
  type ConvocatoriaHijo,
  type Respuesta,
} from './convocatoriasAcudiente';
import { fechaLocal } from './parentHomeLogic';
import { longDate } from './parentCalendarModel';

export const convocatoriasFamiliaKey = (userId: string | undefined) => ['parent-v2-callups', userId];

/**
 * Convocatorias de los hijos. Si la RPC aún no existe en la base, `null` sin
 * error: no se pinta nada (igual que en la app del deportista).
 */
export function useConvocatoriasFamilia(userId: string | undefined) {
  return useQuery({
    queryKey: convocatoriasFamiliaKey(userId),
    enabled: !!userId,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<ConvocatoriaHijo[] | null> => {
      const r = await misConvocatorias();
      if (r.noDisponible) return null;
      if (r.error) throw new Error(r.error);
      return convocatoriasDeHijos(r.data);
    },
  });
}

function detalle(c: ConvocatoriaHijo): string {
  const fecha = c.fecha && fechaLocal(c.fecha) ? longDate(c.fecha) : null;
  return [fecha, c.hora, c.lugar].filter(Boolean).join(' · ');
}

export function TarjetaConvocatoria({
  conv, userId, compacta = false,
}: { conv: ConvocatoriaHijo; userId: string | undefined; compacta?: boolean }) {
  const queryClient = useQueryClient();
  const [local, setLocal] = useState<Respuesta | null | undefined>(undefined);
  const [enviando, setEnviando] = useState(false);
  const resp = local !== undefined ? local : conv.respuesta;

  const elegir = async (r: Respuesta) => {
    const antes = resp;
    setLocal(r);
    setEnviando(true);
    try { navigator.vibrate?.(12); } catch { /* sin vibración */ }
    const res = await responderConvocatoria(conv.lineupId, { childId: conv.childId }, r);
    setEnviando(false);
    if (res.error || res.noDisponible) {
      setLocal(antes);
      toast.error('No pudimos avisarle al profe', { description: res.error ?? 'Inténtalo de nuevo.' });
      return;
    }
    toast.success(fraseRespuesta(conv, r));
    void queryClient.invalidateQueries({ queryKey: convocatoriasFamiliaKey(userId) });
  };

  const info = [detalle(conv), conv.nota].filter(Boolean).join('. ');

  return (
    <section
      aria-label={`Convocatoria de ${conv.nombre}`}
      data-testid="convocatoria-hijo"
      className={cn('flex flex-col gap-2.5', compacta ? '' : 'rounded-2xl border bg-card p-4')}
    >
      {!compacta && (
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          <Trophy className="h-4 w-4" aria-hidden /> Convocatoria
        </p>
      )}
      <div>
        <p className="text-base font-semibold leading-snug">{preguntaConvocatoria(conv)}</p>
        {info && <p className="mt-0.5 text-sm text-muted-foreground">{info}</p>}
      </div>
      {resp ? (
        <div
          className={cn(
            'flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold',
            resp === 'va' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {resp === 'va' ? <Check className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
          <span className="flex-1">{resp === 'va' ? `${conv.nombre} va al partido` : `${conv.nombre} no puede ir`}</span>
          <button
            type="button"
            disabled={enviando}
            className="min-h-touch text-xs font-semibold underline disabled:opacity-50"
            onClick={() => elegir(resp === 'va' ? 'no_va' : 'va')}
          >
            Cambiar
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button disabled={enviando} className="h-12 min-h-touch rounded-xl text-base font-semibold" onClick={() => elegir('va')}>
            Va
          </Button>
          <Button
            disabled={enviando}
            variant="outline"
            className="h-12 min-h-touch rounded-xl text-base font-semibold"
            onClick={() => elegir('no_va')}
          >
            No va
          </Button>
        </div>
      )}
    </section>
  );
}
