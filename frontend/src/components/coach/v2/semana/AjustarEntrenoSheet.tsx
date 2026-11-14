/**
 * Hoja «⋯» de un entreno en la Semana del profe: Cancelar este día · Mover
 * (hora o lugar) · Entreno extra · Deshacer. Cambia SOLO esa fecha: el horario
 * fijo del equipo sigue igual (team_schedule_exceptions).
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarPlus, CloudRain, Loader2, MoveRight, Undo2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { fechaHumana, capitalizar } from '../asistenciaModel';
import { finCorrido, horarioTexto, type AccionAjuste, type EntrenoAjustado } from './semanaAjustesModel';
import type { ResultadoAccion } from './useSemanaAjustes';

type Modo = 'menu' | 'cancelar' | 'mover' | 'extra';

export interface AbrirAjuste {
  /** null = «Entreno extra» sin partir de un entreno. */
  entreno: EntrenoAjustado | null;
  fecha: string;
}

interface Props {
  abierto: AbrirAjuste | null;
  /** Equipos del profe (para el entreno extra). */
  equipos: { id: string; name: string }[];
  /** Lugares que ya usa el horario, para sugerir. */
  lugares?: string[];
  guardando: boolean;
  onAplicar: (a: AccionAjuste) => Promise<ResultadoAccion>;
  onClose: () => void;
}

interface Form { fecha: string; teamId: string; inicio: string; fin: string; lugar: string; lluvia: boolean; finTocado: boolean }

const formDe = (a: AbrirAjuste | null, equipos: { id: string }[]): Form => ({
  fecha: a?.fecha ?? '',
  teamId: a?.entreno?.teamId ?? equipos[0]?.id ?? '',
  inicio: a?.entreno?.hora ?? '',
  fin: a?.entreno?.horaFin ?? '',
  lugar: a?.entreno?.lugar ?? '',
  lluvia: false,
  finTocado: false,
});

export function AjustarEntrenoSheet({ abierto, equipos, lugares = [], guardando, onAplicar, onClose }: Props) {
  const en = abierto?.entreno ?? null;
  const [modo, setModo] = useState<Modo>('menu');
  const [f, setF] = useState<Form>(() => formDe(abierto, equipos));
  const [error, setError] = useState<string | null>(null);

  // Cada vez que se abre sobre otro entreno, arranca de cero.
  useEffect(() => {
    setModo(abierto && !abierto.entreno ? 'extra' : 'menu');
    setF(formDe(abierto, equipos));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al abrir
  }, [abierto]);

  const aplicar = async (accion: AccionAjuste, listo: string) => {
    setError(null);
    const r = await onAplicar(accion);
    if (!r.ok) { setError(r.error ?? 'No se pudo guardar.'); return; }
    toast.success(listo);
    onClose();
  };

  const movida = en?.ajustes.find((a) => a.tipo === 'movida') ?? null;
  const extra = en?.estado === 'extra' ? en.ajustes[0] : null;
  const cancelada = en?.estado === 'cancelada' ? en.ajustes.find((a) => a.tipo === 'cancelada') ?? null : null;

  const guardarMover = () => {
    if (!en) return;
    const comun = { teamId: en.teamId, fecha: en.fecha, horaInicio: f.inicio, horaFin: f.fin || null, lugar: f.lugar.trim() || null };
    if (extra) void aplicar({ tipo: 'extra', ajusteId: extra.id, ...comun }, 'Entreno extra actualizado.');
    else void aplicar({ tipo: 'mover', horaOriginal: en.horaBase ?? '', ajusteId: movida?.id, ...comun }, `${en.nombre}: entreno cambiado.`);
  };

  const guardarExtra = () => {
    const nombre = equipos.find((e) => e.id === f.teamId)?.name ?? 'el equipo';
    void aplicar({ tipo: 'extra', teamId: f.teamId, fecha: f.fecha, horaInicio: f.inicio, horaFin: f.fin || null, lugar: f.lugar.trim() || null },
      `Entreno extra de ${nombre} agregado.`);
  };

  const cambiarInicio = (inicio: string) => setF((p) => ({
    ...p, inicio, fin: p.finTocado ? p.fin : (finCorrido(en?.hora ?? null, en?.horaFin ?? null, inicio) || p.fin),
  }));

  const titulo = modo === 'extra' ? 'Entreno extra' : en ? en.nombre : '';
  const subtitulo = modo === 'extra'
    ? 'Un entreno que el horario no tiene, solo ese día.'
    : en ? `${capitalizar(fechaHumana(en.fecha))} · ${horarioTexto(en)}` : '';

  return (
    <Drawer open={!!abierto} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DrawerContent className="max-h-sheet font-poppins">
        <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-4 overflow-y-auto px-gutter pb-6" data-testid="ajustar-entreno">
          <DrawerHeader className="px-0 text-left">
            <DrawerTitle className="text-xl font-bold">{titulo}</DrawerTitle>
            <DrawerDescription className="text-sm">{subtitulo}</DrawerDescription>
          </DrawerHeader>

          {modo === 'menu' && en && (
            <div className="flex flex-col gap-2">
              {cancelada ? (
                <Opcion icono={Undo2} texto="Deshacer la cancelación" detalle="El entreno vuelve a ir."
                  onClick={() => void aplicar({ tipo: 'deshacer', teamId: en.teamId, ajusteIds: [cancelada.id] }, `${en.nombre}: el entreno vuelve a ir.`)} disabled={guardando} />
              ) : (
                <>
                  {!extra && <Opcion icono={XCircle} texto="Cancelar este día" detalle="Solo esta fecha. El horario fijo no cambia." onClick={() => setModo('cancelar')} />}
                  <Opcion icono={MoveRight} texto={movida ? 'Cambiar otra vez' : 'Mover hora o lugar'} detalle="Solo esta fecha." onClick={() => setModo('mover')} />
                  {movida && (
                    <Opcion icono={Undo2} texto="Deshacer el cambio" detalle="Vuelve a la hora y el lugar de siempre."
                      onClick={() => void aplicar({ tipo: 'deshacer', teamId: en.teamId, ajusteIds: [movida.id] }, `${en.nombre}: vuelve al horario de siempre.`)} disabled={guardando} />
                  )}
                  {extra ? (
                    <Opcion icono={Undo2} texto="Quitar este entreno extra"
                      onClick={() => void aplicar({ tipo: 'deshacer', teamId: en.teamId, ajusteIds: [extra.id] }, 'Entreno extra quitado.')} disabled={guardando} />
                  ) : (
                    <Opcion icono={CalendarPlus} texto="Entreno extra" detalle="Otro entreno de este equipo, solo un día." onClick={() => setModo('extra')} />
                  )}
                </>
              )}
            </div>
          )}

          {modo === 'cancelar' && en && (
            <div className="flex flex-col gap-3">
              <p className="text-sm">¿Por qué se cancela? <span className="text-muted-foreground">(opcional)</span></p>
              <button type="button" aria-pressed={f.lluvia} onClick={() => setF((p) => ({ ...p, lluvia: !p.lluvia }))}
                className={cn('flex min-h-touch items-center gap-2 self-start rounded-xl border-2 px-4 text-sm font-semibold',
                  f.lluvia ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground')}>
                <CloudRain className="h-4 w-4" aria-hidden /> Por lluvia
              </button>
              <Button variant="destructive" className="h-14 rounded-2xl text-base font-semibold" disabled={guardando}
                onClick={() => void aplicar({ tipo: 'cancelar', teamId: en.teamId, fecha: en.fecha, horaOriginal: en.horaBase, motivo: f.lluvia ? 'lluvia' : null },
                  `${en.nombre}: entreno cancelado.`)}>
                {guardando && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
                Cancelar el entreno de este día
              </Button>
            </div>
          )}

          {(modo === 'mover' || modo === 'extra') && (
            <div className="flex flex-col gap-3">
              {modo === 'extra' && (
                <>
                  <label className="flex flex-col gap-1 text-sm font-semibold">
                    Día
                    <Input type="date" value={f.fecha} onChange={(e) => setF((p) => ({ ...p, fecha: e.target.value }))} className="min-h-touch rounded-xl" />
                  </label>
                  {equipos.length > 1 && (
                    <label className="flex flex-col gap-1 text-sm font-semibold">
                      Equipo
                      <select value={f.teamId} onChange={(e) => setF((p) => ({ ...p, teamId: e.target.value }))}
                        className="min-h-touch rounded-xl border bg-background px-3 text-sm font-normal">
                        {equipos.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                    </label>
                  )}
                </>
              )}
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm font-semibold">
                  Empieza
                  <Input type="time" value={f.inicio} onChange={(e) => (modo === 'mover' ? cambiarInicio(e.target.value) : setF((p) => ({ ...p, inicio: e.target.value })))} className="min-h-touch rounded-xl" />
                </label>
                <label className="flex flex-col gap-1 text-sm font-semibold">
                  Termina
                  <Input type="time" value={f.fin} onChange={(e) => setF((p) => ({ ...p, fin: e.target.value, finTocado: true }))} className="min-h-touch rounded-xl" />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm font-semibold">
                Dónde (opcional)
                <Input value={f.lugar} maxLength={120} list="semana-lugares" placeholder="Ej.: Cancha 2"
                  onChange={(e) => setF((p) => ({ ...p, lugar: e.target.value }))} className="min-h-touch rounded-xl" />
                <datalist id="semana-lugares">{lugares.map((l) => <option key={l} value={l} />)}</datalist>
              </label>
              <Button className="h-14 rounded-2xl text-base font-semibold" disabled={guardando || !f.inicio || (modo === 'extra' && (!f.fecha || !f.teamId))}
                onClick={modo === 'mover' ? guardarMover : guardarExtra}>
                {guardando && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
                {modo === 'mover' ? 'Guardar el cambio' : 'Agregar el entreno'}
              </Button>
            </div>
          )}

          {error && <p role="alert" className="rounded-xl bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

          {modo !== 'menu' && en && (
            <Button variant="ghost" className="min-h-touch" onClick={() => { setModo('menu'); setError(null); }}>Volver</Button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function Opcion({ icono: Icono, texto, detalle, onClick, disabled }: {
  icono: typeof Undo2; texto: string; detalle?: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex min-h-touch items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted disabled:opacity-60">
      <Icono className="h-5 w-5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{texto}</span>
        {detalle && <span className="block text-sm text-muted-foreground">{detalle}</span>}
      </span>
    </button>
  );
}
