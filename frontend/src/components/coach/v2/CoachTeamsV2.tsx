/**
 * Equipos del entrenador — V2 (lienzo «Entrenador · Equipos»).
 *
 * Lista «Mis equipos» y, adentro de cada uno, tres pestañas: Deportistas ·
 * Partidos y convocatorias · Evaluar. El equipo y la pestaña viven en la URL
 * (`?equipo=<id>&tab=deportistas|partidos|evaluar`) para que Hoy pueda llevar
 * directo a «Convocar» o «Publicar» y el botón atrás del celular funcione.
 *
 * Reemplaza en la V2: /teams (coach) · /students (Mis deportistas) · /results ·
 * la parte del profe de /informe-mensual y /coach-reports. Esas rutas siguen
 * vivas y se enlazan desde aquí: no se pierde ninguna función.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { cn } from '@/lib/utils';
import { InlineError, SectionSkeleton, EmptyNote } from '@/components/parent/v2/hijos/parts';
import {
  abreviaturaEquipo,
  conRutas,
  horarioDe,
  proximoDe,
  primerNombre,
  sujetoDe,
  type RutasCoachV2,
  type TabEquipo,
} from './coachV2Logic';
import { useDeportistasEquipo, useEquiposCoach, useFelicitarDisponible, type EquipoCoach } from './useCoachV2Data';
import { sujetoDesde } from '@/lib/api/v2Contratos';
import { useAccionConDeshacer } from './useAccionConDeshacer';
import { useAhora } from './useAhora';
import { FelicitarSheet } from './FelicitarSheet';
import { enviarFelicitacion, avisarResultadoFelicitacion, type ObjetivoFelicitar } from './felicitar';
import { DeportistasTab } from './equipos/DeportistasTab';
import { PartidosTab } from './equipos/PartidosTab';
import { EvaluarTab } from './equipos/EvaluarTab';
import { AgregarHorarioBoton } from './equipos/AgregarHorarioSheet';
import { BotonCrearEquipo } from './equipos/AltasDelProfe';
import { useEntitlements } from '@/hooks/useEntitlements';

const TABS: { id: TabEquipo; label: string }[] = [
  { id: 'deportistas', label: 'Deportistas' },
  { id: 'partidos', label: 'Partidos y convocatorias' },
  { id: 'evaluar', label: 'Evaluar' },
];

interface Props {
  nombreProfe?: string | null;
  rutas?: Partial<RutasCoachV2>;
  /** Para pruebas. */
  hoy?: Date;
}

export function CoachTeamsV2({ nombreProfe, rutas: rutasProp, hoy }: Props) {
  const rutas = conRutas(rutasProp);
  const ahora = useAhora(hoy);
  const { schoolId, schoolName, activeBranchId, loading: cargandoEscuela } = useSchoolContext();
  const equipos = useEquiposCoach(schoolId);
  const puedeCrearEquipo = useEntitlements().coachCanCreateTeams === true;
  const [params, setParams] = useSearchParams();
  const equipoId = params.get('equipo');
  const tabParam = params.get('tab') as TabEquipo | null;
  const tab: TabEquipo = TABS.some((t) => t.id === tabParam) ? (tabParam as TabEquipo) : 'deportistas';

  // Felicitar: se prueba una vez con un deportista real del equipo abierto (misma consulta que la pestaña).
  const deportistasSel = useDeportistasEquipo(schoolId, equipoId);
  const primero = deportistasSel.data?.[0];
  const sujetoPrueba = useMemo(() => {
    if (!primero) return null;
    const s = sujetoDe(primero);
    return sujetoDesde(s.subject_type, s.subject_id);
  }, [primero]);
  const felicitarOk = useFelicitarDisponible(sujetoPrueba);
  const { programar } = useAccionConDeshacer();
  const [hoja, setHoja] = useState<ObjetivoFelicitar | null>(null);
  const [felicitados, setFelicitados] = useState<Set<string>>(new Set());

  const abrir = (id: string | null, t?: TabEquipo) => {
    const p = new URLSearchParams(params);
    if (id) p.set('equipo', id); else p.delete('equipo');
    if (id && t) p.set('tab', t); else p.delete('tab');
    setParams(p, { replace: false });
  };

  const enviarKudo = (o: ObjetivoFelicitar, mensaje: string) => {
    setHoja(null);
    if (!schoolId) return;
    setFelicitados((s) => new Set(s).add(o.clave));
    programar(
      `kudo:${o.clave}`,
      `Le avisamos a la familia de ${primerNombre(o.nombre)}.`,
      async () => {
        const r = await enviarFelicitacion(schoolId, o, mensaje);
        avisarResultadoFelicitacion(r, o.nombre);
        if (r === 'error') setFelicitados((s) => { const n = new Set(s); n.delete(o.clave); return n; });
      },
      () => setFelicitados((s) => { const n = new Set(s); n.delete(o.clave); return n; }),
    );
  };

  const lista = equipos.data ?? [];
  const sel = equipoId ? lista.find((e) => e.id === equipoId) ?? null : null;

  return (
    <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-4 pb-nav-safe font-poppins md:max-w-page">
      {!schoolId && !cargandoEscuela ? (
        <EmptyNote>
          <p className="font-semibold text-foreground">Todavía no tienes equipos asignados.</p>
          <p className="mt-1">Pídele a la escuela que te asigne a tus equipos.</p>
        </EmptyNote>
      ) : equipos.isLoading || !schoolId ? (
        <SectionSkeleton rows={3} label="Cargando tus equipos" />
      ) : equipos.isError ? (
        <InlineError message="No pudimos traer tus equipos. Revisa tu conexión." onRetry={() => equipos.refetch()} />
      ) : sel ? (
        <Detalle
          equipo={sel}
          tab={tab}
          onTab={(t) => abrir(sel.id, t)}
          onVolver={() => abrir(null)}
          schoolId={schoolId}
          ahora={ahora}
          rutas={rutas}
          nombreProfe={nombreProfe}
          puedeFelicitar={!!felicitarOk.data}
          felicitados={felicitados}
          onFelicitar={setHoja}
        />
      ) : (
        <>
          <header className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h1 className="text-2xl font-bold tracking-tight">Mis equipos</h1>
              <span className="text-xs text-muted-foreground">
                {[schoolName, `${lista.length} ${lista.length === 1 ? 'equipo' : 'equipos'}`, `${lista.reduce((a, e) => a + e.deportistas, 0)} deportistas`].filter(Boolean).join(' · ')}
              </span>
            </div>
            {/* Solo si la escuela deja al profe crear equipos (coach_can_create_teams, Carmel). */}
            <BotonCrearEquipo schoolId={schoolId} branchId={activeBranchId} className="shrink-0" />
          </header>
          {lista.length === 0 ? (
            <EmptyNote>
              <p className="font-semibold text-foreground">Todavía no tienes equipos asignados.</p>
              <p className="mt-1">
                {puedeCrearEquipo
                  ? 'Crea tu primer equipo con «Crear equipo», o pídele a la administración que te asigne.'
                  : 'La escuela te asigna a tus equipos. Pídeselo a la administración.'}
              </p>
            </EmptyNote>
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {lista.map((e) => (
                <li key={e.id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => abrir(e.id, 'deportistas')}
                    className="flex w-full flex-col gap-3 rounded-2xl border bg-card p-4 text-left transition-transform active:scale-[0.97] motion-reduce:active:scale-100"
                    data-testid="tarjeta-equipo"
                  >
                    <span className="flex w-full items-center gap-3">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-bold text-primary">
                        {abreviaturaEquipo(e.nombre)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-lg font-semibold">{e.nombre}</span>
                        <span className="truncate text-xs text-muted-foreground">{horarioDe(e)}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </span>
                    <span className="grid w-full grid-cols-2 gap-2">
                      <span className="flex flex-col"><span className="text-lg font-bold">{e.deportistas}</span><span className="text-xs text-muted-foreground">deportistas</span></span>
                      <span className="flex flex-col"><span className="text-lg font-bold">{proximoDe(e, ahora)}</span><span className="text-xs text-muted-foreground">próximo entreno</span></span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <FelicitarSheet objetivo={hoja} onClose={() => setHoja(null)} onEnviar={enviarKudo} />
    </div>
  );
}

function Detalle({
  equipo, tab, onTab, onVolver, schoolId, ahora, rutas, nombreProfe, puedeFelicitar, felicitados, onFelicitar,
}: {
  equipo: EquipoCoach; tab: TabEquipo; onTab: (t: TabEquipo) => void; onVolver: () => void;
  schoolId: string; ahora: Date; rutas: RutasCoachV2; nombreProfe?: string | null;
  puedeFelicitar: boolean; felicitados: Set<string>; onFelicitar: (o: ObjetivoFelicitar) => void;
}) {
  return (
    <>
      <div className="sticky top-0 z-10 -mx-gutter flex flex-col gap-2 bg-background/95 px-gutter pb-2 pt-1 backdrop-blur md:mx-0 md:px-0">
        <div className="flex items-center gap-1">
          <button type="button" onClick={onVolver} aria-label="Mis equipos" className="-ml-3 flex h-touch w-touch items-center justify-center rounded-full hover:bg-muted">
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-xl font-bold">{equipo.nombre}</h1>
            <span className="truncate text-xs text-muted-foreground">{horarioDe(equipo)}</span>
          </div>
        </div>
        {/* Sin horario fijo: agregarlo (si la escuela lo permite) o pedírselo a la administración. */}
        {equipo.franjas.length === 0 && <AgregarHorarioBoton equipo={equipo} className="self-start" />}
        <div role="tablist" aria-label="Secciones del equipo" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => onTab(t.id)}
              className={cn(
                'min-h-touch rounded-lg px-1 text-xs leading-tight sm:text-sm',
                tab === t.id ? 'bg-background font-semibold shadow-sm' : 'font-medium text-muted-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel">
        {tab === 'deportistas' && (
          <DeportistasTab
            schoolId={schoolId}
            teamId={equipo.id}
            nombreProfe={nombreProfe}
            puedeFelicitar={puedeFelicitar}
            felicitados={felicitados}
            onFelicitar={onFelicitar}
            rutas={rutas}
            equipo={{ nombre: equipo.nombre, deporte: equipo.deporte, deportistas: equipo.deportistas }}
          />
        )}
        {tab === 'partidos' && <PartidosTab schoolId={schoolId} teamId={equipo.id} equipo={equipo.nombre} hoy={ahora} rutas={rutas} />}
        {tab === 'evaluar' && <EvaluarTab schoolId={schoolId} teamId={equipo.id} equipo={equipo.nombre} hoy={ahora} rutas={rutas} />}
      </div>
    </>
  );
}

export default CoachTeamsV2;
