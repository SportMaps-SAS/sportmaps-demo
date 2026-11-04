/**
 * Convocatoria de un partido (match_results), compartida por Equipos › Partidos
 * del entrenador V2 y por la pantalla del partido (/partidos/:id).
 *
 *   - sin convocatoria: cuadrícula para quitar/sumar (arranca con los del último
 *     partido, o con todos) y «Convocar…», que guarda con `save_match_roster`
 *     tras 8 s con Deshacer. Esa misma RPC avisa a las familias (B2).
 *   - con convocatoria: cuántos van / no van / sin responder (`callup_status`).
 *   - si la convocatoria ya tiene posiciones de la pizarra, NO se reescribe desde
 *     acá (save_match_roster borraría las posiciones): se cambia en la pizarra.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Search, UserPlus, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { InlineError, SectionSkeleton } from '@/components/parent/v2/hijos/parts';
import {
  armarConvocatoria,
  claveConvocado,
  contarRespuestas,
  diaLargo,
  horaDePartido,
  nombreCorto,
  refuerzosDe,
  sujetoDe,
  type ConvocadoPrevio,
  type Partido,
} from '../coachV2Logic';
import { useBuscarRefuerzos, useConvocatoria, useDeportistasEquipo, useNombresConvocados, useRespuestasConvocatoria } from '../useCoachV2Data';
import { useAccionConDeshacer } from '../useAccionConDeshacer';

/** Debounce simple (350ms): evita una consulta por tecla contra una escuela que
 *  puede tener cientos de deportistas. */
function useTextoDebounced(valor: string, demora = 350): string {
  const [debounced, setDebounced] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(valor), demora);
    return () => clearTimeout(t);
  }, [valor, demora]);
  return debounced;
}

export function ConvocatoriaPartido({ schoolId, teamId, partido, todos, etiqueta = 'Próximo partido' }: {
  schoolId: string; teamId: string; partido: Partido; todos: Partido[];
  /** Texto pequeño sobre el rival («Próximo partido», «Partido»…). */
  etiqueta?: string;
}) {
  const qc = useQueryClient();
  const deportistas = useDeportistasEquipo(schoolId, teamId);
  const conv = useConvocatoria(partido.id);
  const respuestas = useRespuestasConvocatoria(conv.data?.id ?? null);
  // Base para arrancar: los convocados del último partido jugado.
  const anterior = todos.find((p) => p.id !== partido.id && p.fecha < partido.fecha) ?? null;
  const convAnterior = useConvocatoria(conv.data === null ? anterior?.id ?? null : null);
  const { programar } = useAccionConDeshacer();

  const [editando, setEditando] = useState(false);
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [enviada, setEnviada] = useState(false);
  // Refuerzos sumados por búsqueda en ESTA sesión (todavía no guardados). Se
  // fusionan con los que ya traía la convocatoria para que armarConvocatoria
  // los incluya al guardar. El nombre se guarda acá mismo (ya lo trajo la
  // búsqueda): no hace falta esperar a useNombresConvocados para mostrarlo.
  const [nuevos, setNuevos] = useState<Array<ConvocadoPrevio & { nombre: string }>>([]);
  const [busqueda, setBusqueda] = useState('');
  const [buscando, setBuscando] = useState(false);
  const textoBuscado = useTextoDebounced(busqueda);

  const roster = useMemo(() => deportistas.data ?? [], [deportistas.data]);
  const claveSujeto = claveConvocado;
  // Convocados de ESTE partido que no están en el roster activo (refuerzos de otra
  // categoría o inactivos sumados desde el buscador de acá abajo o desde la
  // pantalla clásica): se conservan y se muestran aparte; solo salen si el
  // profe los quita.
  const refuerzosPrevios = useMemo(() => refuerzosDe(roster, conv.data?.players ?? []), [roster, conv.data]);
  const refuerzos = useMemo(() => {
    const vistas = new Set(refuerzosPrevios.map(claveSujeto));
    return [...refuerzosPrevios, ...nuevos.filter((n) => !vistas.has(claveSujeto(n)))];
  }, [refuerzosPrevios, nuevos, claveSujeto]);
  const nombres = useNombresConvocados(schoolId, refuerzosPrevios);
  const nombreDe = (r: { subject_type: string; subject_id: string }): string | undefined => {
    const k = claveSujeto(r);
    return nombres.data?.get(k) ?? nuevos.find((n) => claveSujeto(n) === k)?.nombre;
  };

  const resultadosBusqueda = useBuscarRefuerzos(schoolId, teamId, textoBuscado);
  const refuerzosKeys = useMemo(() => new Set(refuerzos.map(claveSujeto)), [refuerzos, claveSujeto]);
  const sugerencias = useMemo(
    () => (resultadosBusqueda.data ?? []).filter((r) => !refuerzosKeys.has(claveSujeto(r))),
    [resultadosBusqueda.data, refuerzosKeys, claveSujeto],
  );

  const sumarRefuerzo = (r: { subject_type: 'child' | 'profile' | 'unregistered'; subject_id: string; nombre: string }) => {
    const k = claveSujeto(r);
    setNuevos((prev) => (prev.some((p) => claveSujeto(p) === k) ? prev : [...prev, { subject_type: r.subject_type, subject_id: r.subject_id, nombre: r.nombre }]));
    setSel((s) => new Set(s ?? []).add(k));
    setBusqueda('');
    setBuscando(false);
  };

  // Selección inicial: convocatoria actual (con refuerzos) > la del partido anterior (solo roster) > todos.
  useEffect(() => {
    if (sel || !deportistas.data || conv.isLoading) return;
    if (conv.data === null && anterior && convAnterior.isLoading) return;
    const todosKeys = roster.map((d) => claveSujeto(sujetoDe(d)));
    const actual = conv.data?.players ?? [];
    if (actual.length) { setSel(new Set(actual.map(claveSujeto))); return; }
    const base = convAnterior.data?.players ?? null;
    const set = base?.length ? new Set(base.map(claveSujeto).filter((k) => todosKeys.includes(k))) : new Set(todosKeys);
    setSel(set);
  }, [sel, deportistas.data, conv.isLoading, conv.data, convAnterior.data, convAnterior.isLoading, anterior, roster, claveSujeto]);

  const tienePizarra = (conv.data?.players ?? []).some((p) => p.x != null || p.y != null || !!p.slot_label);
  const hayConvocatoria = !!conv.data && (conv.data.players?.length ?? 0) > 0;
  const avisaFamilias = respuestas.data?.disponible === true;
  const n = sel?.size ?? 0;
  const hora = horaDePartido(partido);

  const convocar = () => {
    if (!sel || n === 0) return;
    const p_players = armarConvocatoria(roster, sel, conv.data?.players ?? [], nuevos);
    const familias = p_players.length;
    setEnviada(true);
    setEditando(false);
    programar(
      `convocar:${partido.id}`,
      avisaFamilias ? `Vas a convocar a ${familias}. Avisaremos a sus familias.` : `Vas a convocar a ${familias}.`,
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any).rpc('save_match_roster', { p_match: partido.id, p_players });
        if (error) {
          setEnviada(false);
          console.error('[convocatoria] save_match_roster', error);
          toast.error('No pudimos guardar la convocatoria. Revisa tu conexión e inténtalo de nuevo.');
          return;
        }
        toast.success(avisaFamilias ? `Avisamos a ${familias} familias. Pueden responder «Va» o «No va».` : `Convocaste a ${familias} deportistas.`);
        setNuevos([]);
        qc.invalidateQueries({ queryKey: ['coach-v2', 'convocatoria', partido.id] });
        qc.invalidateQueries({ queryKey: ['coach-v2', 'partidos-proximos'] });
      },
      () => setEnviada(false),
    );
  };

  const mostrarCuadricula = !tienePizarra && (editando || (!hayConvocatoria && !enviada));
  const cuenta = respuestas.data?.disponible ? contarRespuestas(respuestas.data.filas) : null;

  return (
    <section className="overflow-hidden rounded-2xl border bg-card" aria-label={etiqueta}>
      <div className="flex flex-col gap-1 bg-foreground px-4 py-3.5 text-background">
        <span className="text-xs opacity-75">{etiqueta}{partido.tipo ? ` · ${partido.tipo}` : ''}</span>
        <span className="text-lg font-bold">Contra {partido.rival}</span>
        <span className="text-sm opacity-90">{[diaLargo(partido.fecha), hora, partido.lugar].filter(Boolean).join(' · ')}</span>
      </div>

      {deportistas.isLoading || conv.isLoading ? (
        <div className="p-4"><SectionSkeleton rows={2} label="Cargando la convocatoria" /></div>
      ) : deportistas.isError || conv.isError ? (
        <div className="p-4"><InlineError message="No pudimos traer la convocatoria." onRetry={() => { deportistas.refetch(); conv.refetch(); }} /></div>
      ) : mostrarCuadricula ? (
        <>
          <div className="flex flex-col gap-0.5 px-4 pb-1.5 pt-3">
            <span className="text-base font-semibold">Convocados: {n} de {roster.length + refuerzos.length}</span>
            <span className="text-xs text-muted-foreground">
              {hayConvocatoria ? 'Así quedó la convocatoria.' : convAnterior.data?.players?.length ? 'Arranca con los del último partido.' : 'Arranca con todos.'} Toca para quitar o sumar.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-2 pb-2 md:grid-cols-3">
            {roster.map((d) => {
              const k = claveSujeto(sujetoDe(d));
              const on = !!sel?.has(k);
              return (
                <button
                  key={d.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => setSel((s) => { const x = new Set(s ?? []); if (on) x.delete(k); else x.add(k); return x; })}
                  className={cn(
                    'flex min-h-touch items-center gap-2 rounded-xl border-2 px-2.5 text-left text-sm font-medium',
                    on ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground',
                  )}
                >
                  <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border-2', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                    {on && <Check className="h-3 w-3" aria-hidden />}
                  </span>
                  <span className="truncate">{nombreCorto(d.nombre)}</span>
                </button>
              );
            })}
            {refuerzos.map((r) => {
              const k = claveSujeto(r);
              const on = !!sel?.has(k);
              const nombre = nombreDe(r);
              return (
                <button
                  key={k}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  data-testid="convocado-refuerzo"
                  onClick={() => setSel((s) => { const x = new Set(s ?? []); if (on) x.delete(k); else x.add(k); return x; })}
                  className={cn(
                    'flex min-h-touch items-center gap-2 rounded-xl border-2 border-dashed px-2.5 text-left text-sm font-medium',
                    on ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground',
                  )}
                >
                  <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border-2', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                    {on && <Check className="h-3 w-3" aria-hidden />}
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate">{nombre ? nombreCorto(nombre) : 'Deportista'}</span>
                    <span className="text-[11px] font-normal opacity-80">Refuerzo</span>
                  </span>
                </button>
              );
            })}
          </div>
          {refuerzos.length > 0 && (
            <p className="px-4 pb-1 text-xs text-muted-foreground">
              Los refuerzos no son de este equipo (otra categoría o inactivos). Siguen convocados salvo que los quites.
            </p>
          )}
          <div className="px-4 pb-2">
            {!buscando ? (
              <button
                type="button"
                onClick={() => setBuscando(true)}
                className="flex min-h-touch w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-2.5 text-sm font-medium text-muted-foreground hover:border-primary/50 hover:text-primary"
              >
                <UserPlus className="h-4 w-4" aria-hidden /> Convocar de otra categoría
              </button>
            ) : (
              <div className="rounded-xl border-2 border-dashed p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    placeholder="Buscar por nombre en toda la escuela..."
                    value={busqueda}
                    onChange={(e) => setBusqueda(e.target.value)}
                    className="h-9 pl-8 pr-8 text-sm"
                  />
                  <button
                    type="button"
                    aria-label="Cerrar búsqueda"
                    onClick={() => { setBuscando(false); setBusqueda(''); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {textoBuscado.trim().length >= 2 && (
                  <div className="mt-1.5 max-h-48 overflow-y-auto">
                    {resultadosBusqueda.isLoading ? (
                      <p className="px-1 py-2 text-xs text-muted-foreground">Buscando...</p>
                    ) : sugerencias.length === 0 ? (
                      <p className="px-1 py-2 text-xs italic text-muted-foreground">Sin resultados en la escuela.</p>
                    ) : (
                      sugerencias.map((r) => (
                        <button
                          key={claveSujeto(r)}
                          type="button"
                          onClick={() => sumarRefuerzo(r)}
                          className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="truncate">{nombreCorto(r.nombre)}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{r.equipo ?? 'Sin equipo'}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {partido.nota && (
            <p className="mx-4 mb-2 rounded-xl bg-muted px-3 py-2.5 text-sm text-muted-foreground">{partido.nota}</p>
          )}
          <div className="px-4 pb-4 pt-2">
            <Button className="h-14 w-full rounded-2xl text-base font-semibold" disabled={n === 0} onClick={convocar}>
              {avisaFamilias ? `Convocar y avisar a ${n} familias` : `Convocar a ${n}`}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <p className="flex items-center gap-2 text-base font-semibold text-primary">
            <Check className="h-5 w-5" aria-hidden />
            {conv.data?.players.length ?? n} convocados{avisaFamilias ? ' · familias avisadas' : ''}
          </p>
          {cuenta && (
            <div className="grid grid-cols-3 gap-2" data-testid="respuestas-convocatoria">
              <Cifra n={cuenta.van} txt="van" tono="bg-primary/10 text-primary" />
              <Cifra n={cuenta.noVan} txt="no van" tono="bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300" />
              <Cifra n={cuenta.sinResponder} txt="sin responder" tono="bg-muted text-foreground" />
            </div>
          )}
          {tienePizarra ? (
            <p className="text-xs text-muted-foreground">Esta convocatoria tiene posiciones en la pizarra: cámbiala desde la pizarra para no perderlas.</p>
          ) : (
            <Button variant="outline" className="h-12 rounded-xl" onClick={() => { setSel(new Set((conv.data?.players ?? []).map((p) => claveSujeto(p)))); setEditando(true); }}>
              Cambiar convocatoria{avisaFamilias ? ' (avisa el cambio)' : ''}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function Cifra({ n, txt, tono }: { n: number; txt: string; tono: string }) {
  return (
    <div className={cn('flex flex-col rounded-xl p-2.5', tono)}>
      <span className="text-lg font-bold">{n}</span>
      <span className="text-xs">{txt}</span>
    </div>
  );
}
