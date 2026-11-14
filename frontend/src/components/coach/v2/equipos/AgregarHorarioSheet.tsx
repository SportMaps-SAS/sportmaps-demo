/**
 * Hoja «Agregar horario» para un equipo sin horario fijo (ítem 31).
 * Si la base no deja guardar (la escuela no le da ese permiso al entrenador),
 * se lo dice y le pide que lo configure la administración.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import type { Franja } from '@/components/parent/v2/parentHomeLogic';
import { AVISO_SIN_PERMISO_HORARIO, DIAS_SEMANA, agregarFranjas, errorHorario, esSinPermiso, type FormHorario } from '../horarioModel';

interface Props {
  equipo: { id: string; nombre: string; franjas: Franja[] } | null;
  onClose: () => void;
  /** La base no dejó guardar: la pantalla cambia el botón por el aviso. */
  onSinPermiso?: () => void;
}

const VACIO: FormHorario = { dias: [], inicio: '', fin: '', lugar: '' };

export function AgregarHorarioSheet({ equipo, onClose, onSinPermiso }: Props) {
  const qc = useQueryClient();
  const [f, setF] = useState<FormHorario>(VACIO);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cerrar = () => { setF(VACIO); setError(null); onClose(); };

  const guardar = async () => {
    if (!equipo) return;
    const e = errorHorario(f);
    if (e) { setError(e); return; }
    setGuardando(true);
    setError(null);
    const schedule = agregarFranjas(equipo.franjas, f);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: err } = await (supabase as any)
      .from('teams')
      .update({ schedule })
      .eq('id', equipo.id)
      .select('id');
    setGuardando(false);
    if (esSinPermiso(err, (data ?? []).length)) {
      setError(`No tienes permiso para cambiar el horario. ${AVISO_SIN_PERMISO_HORARIO}`);
      onSinPermiso?.();
      return;
    }
    if (err) {
      console.error('[horario] update teams.schedule', err);
      setError('No pudimos guardar el horario. Revisa tu conexión e inténtalo de nuevo.');
      return;
    }
    toast.success(`Horario de ${equipo.nombre} guardado.`);
    void qc.invalidateQueries({ queryKey: ['coach-v2'] });
    cerrar();
  };

  const alternarDia = (day: number) =>
    setF((p) => ({ ...p, dias: p.dias.includes(day) ? p.dias.filter((d) => d !== day) : [...p.dias, day] }));

  return (
    <Drawer open={!!equipo} onOpenChange={(o) => { if (!o) cerrar(); }}>
      <DrawerContent className="max-h-sheet font-poppins">
        <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-4 overflow-y-auto px-gutter pb-6">
          <DrawerHeader className="px-0 text-left">
            <DrawerTitle className="text-xl font-bold">Horario de {equipo?.nombre}</DrawerTitle>
            <DrawerDescription className="text-xs">
              Con el horario, Hoy te dice cuándo entrenas y la lista se arma sola.
            </DrawerDescription>
          </DrawerHeader>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">¿Qué días?</legend>
            <div className="grid grid-cols-7 gap-1.5">
              {DIAS_SEMANA.map((d) => {
                const activo = f.dias.includes(d.day);
                return (
                  <button
                    key={d.day}
                    type="button"
                    aria-pressed={activo}
                    aria-label={d.largo}
                    onClick={() => alternarDia(d.day)}
                    className={cn(
                      'min-h-touch rounded-xl border-2 text-sm font-semibold',
                      activo ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground',
                    )}
                  >
                    {d.corto}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm font-semibold">
              Empieza
              <Input type="time" value={f.inicio} onChange={(e) => setF((p) => ({ ...p, inicio: e.target.value }))} className="min-h-touch rounded-xl" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold">
              Termina
              <Input type="time" value={f.fin} onChange={(e) => setF((p) => ({ ...p, fin: e.target.value }))} className="min-h-touch rounded-xl" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Dónde (opcional)
            <Input value={f.lugar} maxLength={120} placeholder="Ej.: Cancha 2" onChange={(e) => setF((p) => ({ ...p, lugar: e.target.value }))} className="min-h-touch rounded-xl" />
          </label>

          {error && <p role="alert" className="rounded-xl bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

          <Button className="h-14 rounded-2xl text-base font-semibold" disabled={guardando || !equipo} onClick={() => void guardar()}>
            {guardando && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
            Guardar horario
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Botón «Agregar horario» o, si la base ya dijo que no, el aviso para la
 * administración. Guarda la respuesta por equipo mientras la pantalla vive.
 */
export function AgregarHorarioBoton({ equipo, className }: { equipo: { id: string; nombre: string; franjas: Franja[] }; className?: string }) {
  const [abierto, setAbierto] = useState(false);
  const [sinPermiso, setSinPermiso] = useState(false);
  return (
    <>
      {sinPermiso ? (
        <p className={cn('text-sm text-muted-foreground', className)} data-testid="aviso-horario">{AVISO_SIN_PERMISO_HORARIO}</p>
      ) : (
        <Button variant="outline" className={cn('min-h-touch rounded-xl', className)} onClick={() => setAbierto(true)} data-testid="agregar-horario">
          Agregar horario
        </Button>
      )}
      <AgregarHorarioSheet
        equipo={abierto ? equipo : null}
        onClose={() => setAbierto(false)}
        onSinPermiso={() => setSinPermiso(true)}
      />
    </>
  );
}
