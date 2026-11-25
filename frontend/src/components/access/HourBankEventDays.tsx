import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bffClient, BFFError } from '@/lib/api/bffClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CalendarOff, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatHourBankMinutes } from '@/lib/hourBank';

/**
 * Días de evento: la escuela marca un día (Halloween, competencia interna) y
 * ese día el torniquete registra el ingreso pero NO descuenta horas del plan.
 * Si el día ya pasó, al guardarlo se devuelven las horas que se descontaron.
 *
 * Solo owner y solo escuelas con banco de horas: reusa la consulta de ajustes
 * de `HourBankOverageCharges` (misma queryKey) y no pinta nada si no aplica.
 * Migración 20261123083815; la regla la hace cumplir un trigger en la base.
 */

export interface DiaDeEvento {
  id: string;
  exempt_date: string;
  time_from: string | null;
  time_to: string | null;
  reason: string;
}

interface ResultadoCrear {
  duplicated: boolean;
  visits_waived: number;
  minutes_returned: number;
  athletes: string[];
  overage_confirmed: number;
}

/** Hoy en Bogotá, 'YYYY-MM-DD' (la escuela opera en esa hora, no en la del navegador). */
export function hoyEnBogota(ahora: Date = new Date()): string {
  return ahora.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

export function fechaLarga(fecha: string): string {
  return new Date(`${fecha}T12:00:00Z`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Lo que se le dice a la escuela al guardar, según lo que pasó en la base. */
export function mensajeAlGuardar(fecha: string, r: ResultadoCrear): string {
  if (r.duplicated) return `El ${fechaLarga(fecha)} ya estaba marcado como evento.`;
  if (r.visits_waived === 0) return `El ${fechaLarga(fecha)} no se descuentan horas a nadie.`;
  const quienes = r.athletes.length === 1 ? r.athletes[0] : `${r.athletes.length} deportistas`;
  const cobro = r.overage_confirmed > 0
    ? ` Ojo: ${r.overage_confirmed === 1 ? 'hay un cobro' : `hay ${r.overage_confirmed} cobros`} de horas de más ya generado; revísalo en Cobros.`
    : '';
  return `Se devolvieron ${formatHourBankMinutes(r.minutes_returned)} a ${quienes}.${cobro}`;
}

export function HourBankEventDays() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [abierto, setAbierto] = useState(false);
  const [fecha, setFecha] = useState(hoyEnBogota());
  const [motivo, setMotivo] = useState('');
  const [conFranja, setConFranja] = useState(false);
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);

  const ajustes = useQuery({
    queryKey: ['hour-bank-overage-settings'],
    queryFn: () => bffClient.get<{ hours_plan_enabled: boolean }>('/api/v1/access/hour-bank-overage-settings'),
    staleTime: 60_000,
    retry: false,
  });
  const activo = !!ajustes.data?.hours_plan_enabled;

  const dias = useQuery({
    queryKey: ['hour-bank-exempt-days'],
    queryFn: () => bffClient.get<{ days: DiaDeEvento[] }>('/api/v1/access/hour-bank-exempt-days'),
    staleTime: 30_000,
    retry: false,
    enabled: activo,
  });

  if (!activo || dias.isError) return null;

  const abrir = () => {
    setFecha(hoyEnBogota());
    setMotivo('');
    setConFranja(false);
    setDesde('');
    setHasta('');
    setAbierto(true);
  };

  const falta = motivo.trim().length < 3
    ? 'Escribe el motivo'
    : !fecha
      ? 'Elige el día'
      : conFranja && (!desde || !hasta)
        ? 'Completa la franja'
        : conFranja && hasta <= desde
          ? 'La hora de fin debe ser posterior'
          : null;

  const refrescar = () => {
    queryClient.invalidateQueries({ queryKey: ['hour-bank-exempt-days'] });
    queryClient.invalidateQueries({ queryKey: ['hour-bank-balances'] });
    queryClient.invalidateQueries({ queryKey: ['hour-bank-overage-charges'] });
    queryClient.invalidateQueries({ queryKey: ['student-report'] });
  };

  const guardar = async () => {
    if (falta) return;
    setGuardando(true);
    try {
      const r = await bffClient.post<ResultadoCrear>('/api/v1/access/hour-bank-exempt-days', {
        date: fecha,
        reason: motivo.trim(),
        time_from: conFranja ? desde : null,
        time_to: conFranja ? hasta : null,
      });
      toast({ title: 'Evento guardado', description: mensajeAlGuardar(fecha, r) });
      setAbierto(false);
      refrescar();
    } catch (err) {
      toast({ title: 'No se pudo guardar', description: err instanceof BFFError ? err.message : 'Intenta de nuevo', variant: 'destructive' });
    } finally {
      setGuardando(false);
    }
  };

  const quitar = async (d: DiaDeEvento) => {
    setQuitando(d.id);
    try {
      await bffClient.delete(`/api/v1/access/hour-bank-exempt-days/${d.id}`);
      toast({ title: 'Evento quitado', description: `El ${fechaLarga(d.exempt_date)} ya no es evento: los ingresos nuevos descuentan horas. Lo que ya se devolvió no se vuelve a descontar.` });
      refrescar();
    } catch (err) {
      toast({ title: 'No se pudo quitar', description: err instanceof BFFError ? err.message : 'Intenta de nuevo', variant: 'destructive' });
    } finally {
      setQuitando(null);
    }
  };

  const lista = dias.data?.days ?? [];

  return (
    <Card data-testid="hb-eventos">
      <CardContent className="py-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            ¿Hay una actividad en la que no se deben gastar horas del plan?
          </p>
          <Button size="sm" variant="outline" className="gap-2" onClick={abrir}>
            <CalendarOff className="h-3.5 w-3.5" />
            Evento: no descontar horas
          </Button>
        </div>

        {lista.length > 0 && (
          <ul className="space-y-1">
            {lista.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-xs">
                <span>
                  <span className="font-semibold capitalize">{fechaLarga(d.exempt_date)}</span>
                  {d.time_from && d.time_to ? ` · ${d.time_from}–${d.time_to}` : ''}
                  <span className="text-muted-foreground"> · {d.reason}</span>
                </span>
                <Button
                  size="sm" variant="ghost" className="h-7 px-2 gap-1 text-muted-foreground"
                  disabled={quitando === d.id}
                  aria-label={`Quitar el evento del ${fechaLarga(d.exempt_date)}`}
                  onClick={() => quitar(d)}
                >
                  <X className="h-3.5 w-3.5" /> Quitar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Evento: no descontar horas</DialogTitle>
            <DialogDescription>
              Ese día los ingresos se registran igual, pero no gastan horas del plan. Si el día ya pasó, se devuelven las horas que se descontaron.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="hb-evento-fecha">Día</Label>
              <Input id="hb-evento-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hb-evento-motivo">Motivo</Label>
              <Input
                id="hb-evento-motivo" value={motivo} maxLength={120} placeholder="Ej.: Competencia interna"
                onChange={(e) => setMotivo(e.target.value)}
              />
            </div>

            {!conFranja ? (
              <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setConFranja(true)}>
                Solo unas horas del día
              </button>
            ) : (
              <div className="space-y-1">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="hb-evento-desde">Desde</Label>
                    <Input id="hb-evento-desde" type="time" value={desde} onChange={(e) => setDesde(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="hb-evento-hasta">Hasta</Label>
                    <Input id="hb-evento-hasta" type="time" value={hasta} onChange={(e) => setHasta(e.target.value)} />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">No descuenta a quien entre dentro de esa franja.</p>
                <button type="button" className="text-xs text-primary underline underline-offset-2" onClick={() => setConFranja(false)}>
                  Todo el día
                </button>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row sm:items-center gap-2">
            {falta && <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 sm:mr-auto" role="alert">Falta: {falta}</p>}
            <Button variant="outline" onClick={() => setAbierto(false)}>Cancelar</Button>
            <Button disabled={!!falta || guardando} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
