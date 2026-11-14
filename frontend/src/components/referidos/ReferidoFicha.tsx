/**
 * Ficha del deportista: «Referido por <nombre>» con su estado y el mes del
 * descuento; acciones vincular / cambiar inscripción / anular
 * (PATCH /referidos/:id). Con la campaña apagada y sin renglón, no pinta nada.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import {
  armarCuerpoReferido, ESTADO_REFERIDO_AYUDA, ESTADO_REFERIDO_LABEL, fmtPct, mensajeErrorReferido,
  mesDelDescuento, nombreReferente, referidosApi, type AccionReferido, type ReferenteElegido, type ReferidoRow,
} from '@/lib/api/referidos';
import { ReferenteBuscador } from './ReferenteBuscador';
import { useCampanaReferidosActiva } from './ReferidoAlta';

const FINALES = new Set(['aplicado', 'anulado', 'vencido']);
export const REFERIDO_FICHA_KEY = 'referido-ficha';

const TONO: Record<string, string> = {
  sin_confirmar: 'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-400',
  pendiente: 'border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950/20 dark:text-sky-400',
  ganado: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-400',
  aplicado: 'border-emerald-400 bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  anulado: 'text-muted-foreground',
  vencido: 'text-muted-foreground',
};

export function EstadoReferidoBadge({ estado }: { estado: ReferidoRow['status'] }) {
  return <Badge variant="outline" className={TONO[estado] ?? ''}>{ESTADO_REFERIDO_LABEL[estado] ?? estado}</Badge>;
}

export function ReferidoFicha({
  schoolId, enrollmentId, puedeEditar,
}: { schoolId: string; enrollmentId: string | null | undefined; puedeEditar: boolean }) {
  const { activa } = useCampanaReferidosActiva(schoolId);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [modo, setModo] = useState<'vincular' | 'cambiar' | 'anular' | 'nuevo' | null>(null);
  const [referente, setReferente] = useState<ReferenteElegido | null>(null);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const q = useQuery({
    queryKey: [REFERIDO_FICHA_KEY, schoolId, enrollmentId],
    queryFn: () => referidosApi.porInscripcion(schoolId, enrollmentId as string),
    enabled: !!schoolId && !!enrollmentId,
    retry: false,
  });

  if (!enrollmentId || q.isError) return null;
  const fila: ReferidoRow | undefined = q.data?.rows?.[0];
  if (!fila && !activa) return null;
  if (q.isLoading) {
    return <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Cargando referido…</p>;
  }

  const cerrar = () => { setModo(null); setReferente(null); setMotivo(''); };
  const refrescar = () => {
    qc.invalidateQueries({ queryKey: [REFERIDO_FICHA_KEY, schoolId, enrollmentId] });
    qc.invalidateQueries({ queryKey: ['referidos-informe', schoolId] });
  };

  const ejecutar = async (accion: AccionReferido | 'registrar') => {
    setGuardando(true);
    try {
      if (accion === 'registrar') {
        if (!referente) return;
        const r = await referidosApi.registrar(schoolId, armarCuerpoReferido(enrollmentId, referente));
        if (r.ok === false) {
          toast({ title: 'No califica para el descuento', description: `Tiene ${r.edad} años y la campaña empieza a los 4.` });
        } else toast({ title: 'Referido registrado' });
      } else {
        await referidosApi.actualizar(schoolId, (fila as ReferidoRow).id, {
          action: accion,
          ...(accion === 'anular'
            ? { reason: motivo.trim() || undefined }
            : referente ? armarCuerpoPatch(referente) : {}),
        });
        toast({ title: accion === 'anular' ? 'Referido anulado' : 'Referido actualizado' });
      }
      cerrar();
      refrescar();
    } catch (e) {
      toast({ title: 'No se pudo guardar', description: mensajeErrorReferido(e), variant: 'destructive' });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section aria-label="Referido" data-testid="referido-ficha">
      <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
        <Gift className="w-4 h-4" aria-hidden /> Referido
      </h3>

      {!fila ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">No tiene un referente registrado.</p>
          {puedeEditar && modo !== 'nuevo' && (
            <Button type="button" size="sm" variant="outline" onClick={() => setModo('nuevo')}>Registrar quién lo refirió</Button>
          )}
          {puedeEditar && modo === 'nuevo' && (
            <div className="space-y-2">
              <ReferenteBuscador schoolId={schoolId} valor={referente} onChange={setReferente} etiqueta="¿Quién lo refirió?" idCampo="ficha-ref-nuevo" />
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={!referente || guardando} onClick={() => void ejecutar('registrar')}>
                  {guardando && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />} Registrar
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={cerrar} disabled={guardando}>Cancelar</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Referido por <strong>{nombreReferente(fila)}</strong></span>
            <EstadoReferidoBadge estado={fila.status} />
            {fila.pct > 0 && <Badge variant="secondary">{fmtPct(fila.pct)}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{ESTADO_REFERIDO_AYUDA[fila.status]}</p>
          {mesDelDescuento(fila.apply_year, fila.apply_month) && (
            <p className="text-sm">Descuento en la mensualidad de <strong>{mesDelDescuento(fila.apply_year, fila.apply_month)}</strong>.</p>
          )}
          {fila.status_reason && <p className="text-xs text-muted-foreground">Motivo: {fila.status_reason}</p>}

          {puedeEditar && !FINALES.has(fila.status) && !modo && (
            <div className="flex flex-wrap gap-2 pt-1">
              {fila.status === 'sin_confirmar' && <Button type="button" size="sm" onClick={() => setModo('vincular')}>Vincular</Button>}
              {fila.status !== 'sin_confirmar' && <Button type="button" size="sm" variant="outline" onClick={() => setModo('cambiar')}>Cambiar inscripción</Button>}
              <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => setModo('anular')}>Anular</Button>
            </div>
          )}

          {(modo === 'vincular' || modo === 'cambiar') && (
            <div className="space-y-2 pt-1">
              <ReferenteBuscador
                schoolId={schoolId}
                valor={referente}
                onChange={setReferente}
                etiqueta={modo === 'vincular' ? '¿Quién es? Elige a la persona de la escuela' : 'Nueva inscripción donde se aplica el descuento'}
                idCampo="ficha-ref-editar"
                excluirEnrollmentId={enrollmentId}
              />
              <div className="flex gap-2">
                <Button
                  type="button" size="sm"
                  disabled={!referente || guardando}
                  onClick={() => void ejecutar(modo === 'vincular' ? 'vincular' : 'cambiar_inscripcion')}
                >
                  {guardando && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />} Guardar
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={cerrar} disabled={guardando}>Cancelar</Button>
              </div>
            </div>
          )}

          {modo === 'anular' && (
            <div className="space-y-2 pt-1">
              <label htmlFor="ref-anular-motivo" className="text-sm font-medium">Motivo — opcional</label>
              <Textarea id="ref-anular-motivo" rows={2} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="destructive" disabled={guardando} onClick={() => void ejecutar('anular')}>
                  {guardando && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />} Anular referido
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={cerrar} disabled={guardando}>Cancelar</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function armarCuerpoPatch(r: ReferenteElegido) {
  if (r.enrollmentId) return { referrer_enrollment_id: r.enrollmentId };
  if (r.profileId) return { referrer_profile_id: r.profileId };
  return { referrer_name_text: r.texto?.trim() };
}
