/**
 * Configuración de la campaña de referidos de la escuela: prender/apagar,
 * tramos por edad (50 % y 25 % por defecto), fechas y tope. Sección para una
 * página de configuración existente (Pagos → Config).
 *
 * Visible solo si la escuela ya tiene campaña (aunque esté apagada) o si quien
 * mira puede crearla (`puedeCrear`, p. ej. administración de plataforma): así
 * ninguna otra escuela ve una tarjeta nueva.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  describirTramo, mensajeErrorReferido, referidosApi, TRAMOS_POR_DEFECTO, validarFechasCampana, validarTramos,
  type Campana, type Tramo,
} from '@/lib/api/referidos';
import { CAMPANA_REFERIDOS_KEY } from './ReferidoAlta';

export const CAMPANA_NUEVA: Campana = {
  name: 'Referidos',
  active: false,
  tiers: TRAMOS_POR_DEFECTO,
  starts_on: null,
  ends_on: null,
  max_pending: 12,
  require_referrer_current: true,
};

const aNumero = (s: string): number | null => (s.trim() === '' ? null : Number(s));

export function CampanaReferidosConfig({
  schoolId, puedeCrear = false, puedeEditar = true,
}: { schoolId: string; puedeCrear?: boolean; puedeEditar?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: [CAMPANA_REFERIDOS_KEY, schoolId],
    queryFn: () => referidosApi.campana(schoolId),
    enabled: !!schoolId,
    retry: false,
  });
  const [c, setC] = useState<Campana>(CAMPANA_NUEVA);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setC(q.data.campaign ?? { ...CAMPANA_NUEVA, tiers: q.data.tramos_por_defecto?.length ? q.data.tramos_por_defecto : TRAMOS_POR_DEFECTO });
  }, [q.data]);

  // Sin migración, sin permiso o sin campaña (y sin poder crearla): nada.
  if (q.isError) return null;
  if (q.isLoading) return null;
  if (!q.data?.campaign && !puedeCrear) return null;

  const setTramo = (i: number, patch: Partial<Tramo>) =>
    setC((x) => ({ ...x, tiers: x.tiers.map((t, k) => (k === i ? { ...t, ...patch } : t)) }));

  const guardar = async () => {
    const e1 = validarTramos(c.tiers) ?? validarFechasCampana(c.starts_on, c.ends_on);
    if (e1) { setError(e1); return; }
    if (!c.name.trim()) { setError('Ponle un nombre a la campaña.'); return; }
    if (!(c.max_pending >= 1)) { setError('El tope de referidos pendientes debe ser al menos 1.'); return; }
    setError(null);
    setGuardando(true);
    try {
      await referidosApi.guardarCampana(schoolId, { ...c, name: c.name.trim() });
      toast({ title: 'Campaña guardada', description: c.active ? 'Los referidos ya se pueden registrar.' : 'Quedó apagada: nadie ve los referidos.' });
      await qc.invalidateQueries({ queryKey: [CAMPANA_REFERIDOS_KEY, schoolId] });
    } catch (e) {
      setError(mensajeErrorReferido(e));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Card data-testid="campana-referidos-config">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Gift className="h-5 w-5" aria-hidden /> Descuento por referidos</CardTitle>
        <CardDescription>
          Quien refiere a un deportista nuevo gana un porcentaje en una mensualidad, cuando el referido paga la suya.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
          <div className="min-w-0">
            <Label htmlFor="ref-activa" className="font-medium">Campaña activa</Label>
            <p className="text-xs text-muted-foreground">Apagada, la escuela no ve nada de referidos.</p>
          </div>
          <Switch id="ref-activa" checked={c.active} disabled={!puedeEditar} onCheckedChange={(v) => setC({ ...c, active: v })} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ref-nombre">Nombre</Label>
          <Input id="ref-nombre" value={c.name} maxLength={80} disabled={!puedeEditar} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </div>

        <fieldset className="space-y-2" disabled={!puedeEditar}>
          <legend className="text-sm font-medium">Porcentaje según la edad del referido</legend>
          <ul className="space-y-2">
            {c.tiers.map((t, i) => (
              <li key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end rounded-lg border p-2">
                <div>
                  <Label htmlFor={`t-min-${i}`} className="text-xs">Desde (años)</Label>
                  <Input id={`t-min-${i}`} type="number" min={0} inputMode="numeric" value={t.age_min}
                    onChange={(e) => setTramo(i, { age_min: Number(e.target.value) })} />
                </div>
                <div>
                  <Label htmlFor={`t-max-${i}`} className="text-xs">Hasta (años)</Label>
                  <Input id={`t-max-${i}`} type="number" min={0} inputMode="numeric" placeholder="Sin tope" value={t.age_max ?? ''}
                    onChange={(e) => setTramo(i, { age_max: aNumero(e.target.value) })} />
                </div>
                <div>
                  <Label htmlFor={`t-pct-${i}`} className="text-xs">Descuento %</Label>
                  <Input id={`t-pct-${i}`} type="number" min={1} max={100} inputMode="decimal" value={t.pct}
                    onChange={(e) => setTramo(i, { pct: Number(e.target.value) })} />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={`Quitar el tramo ${describirTramo(t)}`}
                  onClick={() => setC({ ...c, tiers: c.tiers.filter((_, k) => k !== i) })} disabled={c.tiers.length <= 1}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" className="gap-1.5"
              onClick={() => setC({ ...c, tiers: [...c.tiers, { age_min: (c.tiers.at(-1)?.age_max ?? c.tiers.at(-1)?.age_min ?? 0) + 1, age_max: null, pct: 25 }] })}>
              <Plus className="h-4 w-4" aria-hidden /> Agregar tramo
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setC({ ...c, tiers: TRAMOS_POR_DEFECTO })}>
              Restablecer 50 % y 25 %
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Quien queda fuera de todos los tramos (por ejemplo, menores de 4 años) no califica.</p>
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="ref-desde">Empieza (opcional)</Label>
            <Input id="ref-desde" type="date" value={c.starts_on ?? ''} disabled={!puedeEditar}
              onChange={(e) => setC({ ...c, starts_on: e.target.value || null })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ref-hasta">Termina (opcional)</Label>
            <Input id="ref-hasta" type="date" value={c.ends_on ?? ''} disabled={!puedeEditar}
              onChange={(e) => setC({ ...c, ends_on: e.target.value || null })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ref-tope">Referidos pendientes por persona (tope)</Label>
            <Input id="ref-tope" type="number" min={1} inputMode="numeric" value={c.max_pending} disabled={!puedeEditar}
              onChange={(e) => setC({ ...c, max_pending: Number(e.target.value) })} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3 sm:self-end">
            <Label htmlFor="ref-vigente" className="text-sm">Quien refiere debe estar inscrito</Label>
            <Switch id="ref-vigente" checked={c.require_referrer_current} disabled={!puedeEditar}
              onCheckedChange={(v) => setC({ ...c, require_referrer_current: v })} />
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {puedeEditar && (
          <Button type="button" onClick={() => void guardar()} disabled={guardando}>
            {guardando && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />} Guardar campaña
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
