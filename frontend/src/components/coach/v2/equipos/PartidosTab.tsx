/**
 * Equipos › Partidos y convocatorias.
 *
 * «+ Partido» abre la pantalla del partido (/partidos/nuevo) para programar
 * uno o registrar uno que ya se jugó.
 * Próximo partido → convocatoria (ConvocatoriaPartido, compartida con la
 * pantalla del partido) y «Abrir partido» para el resto de pasos.
 * «Armar la alineación en la pizarra» abre el LineupModal de siempre.
 * Resultados: cada partido jugado abre su pantalla (resultado, evaluación, reporte).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LineupModal } from '@/components/school/LineupModal';
import { InlineError, SectionSkeleton, EmptyNote } from '@/components/parent/v2/hijos/parts';
import { diaLargo, isoDia, proximoPartido, resultadoDe, type Partido, type RutasCoachV2 } from '../coachV2Logic';
import { usePartidosEquipo } from '../useCoachV2Data';
import { ConvocatoriaPartido } from './ConvocatoriaPartido';

interface Props {
  schoolId: string;
  teamId: string;
  equipo: string;
  hoy: Date;
  rutas: RutasCoachV2;
}

const TONO_RES = {
  gana: 'bg-primary/10 text-primary',
  pierde: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  empata: 'bg-muted text-foreground',
} as const;

export function PartidosTab({ schoolId, teamId, equipo, hoy, rutas }: Props) {
  const partidos = usePartidosEquipo(teamId);
  const [pizarra, setPizarra] = useState<Partido | null>(null);

  if (partidos.isLoading) return <SectionSkeleton rows={4} label="Cargando partidos" />;
  if (partidos.isError) return <InlineError message="No pudimos traer los partidos." onRetry={() => partidos.refetch()} />;

  const lista = partidos.data ?? [];
  const prox = proximoPartido(lista, hoy);
  const jugados = lista.filter((p) => resultadoDe(p)).slice(0, 5);
  // Ya pasó la fecha y nadie registró el marcador: se ofrece cerrarlo.
  const porCerrar = lista.filter((p) => p.estado !== 'cancelled' && !resultadoDe(p) && p.fecha < isoDia(hoy)).slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      <Button asChild className="h-14 w-full rounded-2xl text-base font-semibold">
        <Link to={rutas.partidoNuevo(teamId)}><Plus className="mr-1 h-5 w-5" aria-hidden /> Partido</Link>
      </Button>

      {prox ? (
        <>
          <ConvocatoriaPartido schoolId={schoolId} teamId={teamId} partido={prox} todos={lista} />
          <Link
            to={rutas.partido(prox.id)}
            className="flex min-h-14 items-center gap-3 rounded-2xl border bg-card px-4 text-left"
          >
            <span className="flex-1 text-base font-medium">Abrir partido: resultado, evaluación y reporte</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          </Link>
          <button
            type="button"
            onClick={() => setPizarra(prox)}
            className="flex min-h-14 items-center gap-3 rounded-2xl border bg-card px-4 text-left active:scale-[0.97] motion-reduce:active:scale-100"
          >
            <span className="flex-1 text-base font-medium">Armar la alineación en la pizarra</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          </button>
        </>
      ) : (
        <EmptyNote>
          <p className="font-semibold text-foreground">No hay partidos programados.</p>
          <p className="mt-1">Toca «+ Partido» para programar uno. Ahí mismo convocas, registras el resultado y evalúas.</p>
        </EmptyNote>
      )}

      {porCerrar.length > 0 && (
        <>
          <span className="pl-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Falta el resultado</span>
          <ul className="overflow-hidden rounded-2xl border bg-card" data-testid="partidos-por-cerrar">
            {porCerrar.map((p) => (
              <li key={p.id} className="border-t first:border-t-0">
                <Link to={rutas.partido(p.id)} className="flex min-h-16 items-center gap-3 px-4 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base">Contra {p.rival}</span>
                    <span className="text-xs text-muted-foreground">{diaLargo(p.fecha)} · toca para registrar cómo quedó</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <span className="pl-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Resultados</span>
      {jugados.length === 0 ? (
        <EmptyNote>Todavía no hay resultados de {equipo}.</EmptyNote>
      ) : (
        <ul className="overflow-hidden rounded-2xl border bg-card">
          {jugados.map((p) => {
            const r = resultadoDe(p)!;
            return (
              <li key={p.id} className="border-t first:border-t-0">
                <Link to={rutas.partido(p.id)} className="flex min-h-16 items-center gap-3 px-4 py-2">
                  <span className={cn('flex h-9 min-w-14 items-center justify-center rounded-xl px-2 text-base font-bold', TONO_RES[r.tono])}>{r.marcador}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base">{r.frase}</span>
                    <span className="text-xs text-muted-foreground">{diaLargo(p.fecha)}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link to={rutas.resultados} className="flex min-h-touch items-center justify-between rounded-2xl border bg-card px-4 text-sm font-semibold text-primary">
        Ver todos los partidos <ChevronRight className="h-4 w-4" aria-hidden />
      </Link>

      {pizarra && (
        <LineupModal
          open
          onClose={() => setPizarra(null)}
          teamId={teamId}
          teamName={equipo}
          sourceType="team_match"
          sourceId={pizarra.id}
          matchLabel={`vs ${pizarra.rival} · ${diaLargo(pizarra.fecha)}`}
        />
      )}
    </div>
  );
}
