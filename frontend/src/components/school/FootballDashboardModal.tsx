import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ClipboardList, Goal, Trophy, Calendar as CalendarIcon, Plus, ChevronRight, Trash2, Users } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  useTeamMatches,
  useFootballLineup,
  useFootballLineups,
  useDeleteTeamMatch,
  useTournamentMatches,
} from '@/hooks/useFootballData';
import { LineupModal } from './LineupModal';
import { MatchEventsModal } from './MatchEventsModal';
import { FootballSeasonStats } from './FootballSeasonStats';
import { TacticalBoard } from './TacticalBoard';
import { useTeamPerformanceRoster } from '@/hooks/usePerformanceData';
import { useSchoolContext } from '@/hooks/useSchoolContext';

interface FootballDashboardModalProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
}

export function FootballDashboardModal({ open, onClose, teamId, teamName }: FootballDashboardModalProps) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { currentUserRole } = useSchoolContext();
  // Programar, corregir el marcador y anotar goles de un partido de club se
  // hace en la pantalla del partido (/partidos/:id), la misma que usan
  // Resultados y Equipos › Partidos. Este panel solo enlaza.
  const abrirPartido = (id: string) => { onClose(); navigate(`/partidos/${encodeURIComponent(id)}`); };
  const nuevoPartido = () => { onClose(); navigate(`/partidos/nuevo?equipo=${encodeURIComponent(teamId)}`); };
  // match_results_delete (RLS) excluye a 'coach' -- mismo motivo que en
  // ResultsPage.tsx: sin este gate, un coach ve el botón y se encuentra con
  // un error de permisos al apretarlo.
  const DELETE_RESULTS_ROLES = ['owner', 'admin', 'staff', 'school_admin', 'super_admin'];
  const canDeleteResults = DELETE_RESULTS_ROLES.includes(currentUserRole || '');
  const { data: matches, isLoading: loadingMatches } = useTeamMatches(teamId);
  const { data: tournamentMatches, isLoading: loadingTournamentMatches } = useTournamentMatches(teamId);
  const deleteMatch = useDeleteTeamMatch();

  const [lineupMatch, setLineupMatch] = useState<{ id: string; label: string; sourceType: 'team_match' | 'tournament_match' } | null>(null);
  const [tacticalMatch, setTacticalMatch] = useState<{ id: string; label: string; sourceType: 'team_match' | 'tournament_match' } | null>(null);
  const [eventsMatch, setEventsMatch] = useState<{ id: string; label: string; sourceType: 'team_match' | 'tournament_match' } | null>(null);

  const eventsLineupList = useFootballLineups({
    source_type: eventsMatch?.sourceType ?? 'team_match',
    source_id: eventsMatch?.id,
  });
  const eventsLineupDetail = useFootballLineup(eventsLineupList.data?.[0]?.id);
  const { data: roster } = useTeamPerformanceRoster({ team_id: teamId });

  const lineupPlayersForEvents = (eventsLineupDetail.data?.players ?? []).map((p) => ({
    subject_type: p.subject_type,
    subject_id: p.subject_id,
    full_name: roster?.subjects.find(
      (s) => s.subject_type === p.subject_type && s.subject_id === p.subject_id
    )?.full_name ?? 'Jugador',
  }));

  const matchLabel = (m: { opponent: string; match_date: string }) =>
    `vs ${m.opponent} · ${format(new Date(m.match_date + 'T12:00:00'), 'PPP', { locale: es })}`;

  const tournamentMatchLabel = (m: any) =>
    `vs ${m.opponent} (Torneo: ${m.event_title}) · ${m.scheduled_at ? format(new Date(m.scheduled_at), 'PPP', { locale: es }) : 'Por definir'}`;

  const handleDeleteMatch = async (matchId: string) => {
    if (!window.confirm('¿Estás seguro de que deseas eliminar este partido? También se borrarán sus alineaciones y eventos asociados.')) {
      return;
    }
    try {
      await deleteMatch.mutateAsync({ id: matchId, team_id: teamId });
      toast({ title: 'Partido eliminado' });
    } catch (err: any) {
      toast({ title: 'Error al eliminar el partido', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Panorama de fútbol</DialogTitle>
            <DialogDescription>{teamName}</DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="matches" className="flex-1 overflow-hidden flex flex-col">
            <TabsList>
              <TabsTrigger value="matches" className="gap-1.5 text-xs">
                <CalendarIcon className="w-3.5 h-3.5" /> Partidos de Club
              </TabsTrigger>
              <TabsTrigger value="tournaments" className="gap-1.5 text-xs">
                <Trophy className="w-3.5 h-3.5" /> Torneos Oficiales
              </TabsTrigger>
              <TabsTrigger value="stats" className="gap-1.5 text-xs">
                <Trophy className="w-3.5 h-3.5" /> Temporada
              </TabsTrigger>
            </TabsList>

            <TabsContent value="matches" className="flex-1 overflow-y-auto mt-3 space-y-2">
              <div className="flex justify-between items-center mb-2 px-1">
                <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">Historial y próximos partidos</span>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-[11px] bg-primary text-primary-foreground"
                  onClick={nuevoPartido}
                >
                  <Plus className="w-3.5 h-3.5" /> Partido
                </Button>
              </div>

              {loadingMatches ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
                  <span className="text-sm text-muted-foreground">Cargando partidos...</span>
                </div>
              ) : !matches || matches.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <CalendarIcon className="h-8 w-8 text-muted-foreground opacity-40" />
                  <p className="text-sm text-muted-foreground max-w-xs">
                    Este equipo todavía no tiene partidos registrados. Toca «+ Partido» para programar uno o registrar uno que ya se jugó.
                  </p>
                </div>
              ) : (
                matches.map((m) => (
                  <Card key={m.id} className="border">
                    <CardContent className="p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {m.is_home === false ? 'Visitante' : 'Local'} vs {m.opponent}
                        </p>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                          <span>{format(new Date(m.match_date + 'T12:00:00'), 'PPP', { locale: es })}</span>
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-accent/20">
                            {m.match_type}
                          </Badge>
                          {(m.home_score !== null && m.away_score !== null) && (
                            <Badge variant="default" className="text-[10px] h-4 px-1.5 font-bold">
                              {m.home_score}-{m.away_score}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0 items-center">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => setLineupMatch({ id: m.id, label: matchLabel(m), sourceType: 'team_match' })}
                        >
                          <ClipboardList className="w-3 h-3" /> Alineación
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => setTacticalMatch({ id: m.id, label: matchLabel(m), sourceType: 'team_match' })}
                        >
                          <Users className="w-3 h-3" /> Tablero táctico
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => abrirPartido(m.id)}
                          title="Resultado, goles por jugadora, evaluación y reporte"
                        >
                          Abrir partido <ChevronRight className="w-3 h-3" />
                        </Button>
                        {canDeleteResults && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
                            onClick={() => handleDeleteMatch(m.id)}
                            disabled={deleteMatch.isPending}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            <TabsContent value="tournaments" className="flex-1 overflow-y-auto mt-3 space-y-2">
              <div className="flex justify-between items-center mb-2 px-1">
                <span className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider">Partidos de Torneo Oficial</span>
              </div>

              {loadingTournamentMatches ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
                  <span className="text-sm text-muted-foreground">Cargando partidos...</span>
                </div>
              ) : !tournamentMatches || tournamentMatches.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <Trophy className="h-8 w-8 text-muted-foreground opacity-40" />
                  <p className="text-sm text-muted-foreground max-w-xs">
                    Este equipo todavía no tiene partidos de torneo oficial registrados.
                  </p>
                </div>
              ) : (
                tournamentMatches.map((m) => (
                  <Card key={m.id} className="border">
                    <CardContent className="p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">
                          {m.is_home === false ? 'Visitante' : 'Local'} vs {m.opponent}
                        </p>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                          <span>
                            {m.scheduled_at ? format(new Date(m.scheduled_at), 'PPP', { locale: es }) : 'Por definir'}
                          </span>
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-accent/20">
                            {m.event_title} · Ronda {m.round}
                          </Badge>
                          {(m.home_score !== null && m.away_score !== null) && (
                            <Badge variant="default" className="text-[10px] h-4 px-1.5 font-bold">
                              {m.home_score}-{m.away_score}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0 items-center">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => setLineupMatch({ id: m.id, label: tournamentMatchLabel(m), sourceType: 'tournament_match' })}
                        >
                          <ClipboardList className="w-3 h-3" /> Alineación
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => setTacticalMatch({ id: m.id, label: tournamentMatchLabel(m), sourceType: 'tournament_match' })}
                        >
                          <Users className="w-3 h-3" /> Tablero táctico
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-[11px]"
                          onClick={() => setEventsMatch({ id: m.id, label: tournamentMatchLabel(m), sourceType: 'tournament_match' })}
                        >
                          <Goal className="w-3 h-3" /> Eventos
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>

            <TabsContent value="stats" className="flex-1 overflow-y-auto mt-3">
              <FootballSeasonStats teamId={teamId} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {lineupMatch && (
        <LineupModal
          open={!!lineupMatch}
          onClose={() => setLineupMatch(null)}
          teamId={teamId}
          teamName={teamName}
          sourceType={lineupMatch.sourceType}
          sourceId={lineupMatch.id}
          matchLabel={lineupMatch.label}
        />
      )}

      {tacticalMatch && (
        <TacticalBoard
          open={!!tacticalMatch}
          onClose={() => setTacticalMatch(null)}
          teamId={teamId}
          teamName={teamName}
          sourceType={tacticalMatch.sourceType}
          sourceId={tacticalMatch.id}
          contextLabel={tacticalMatch.label}
        />
      )}

      {eventsMatch && (
        <MatchEventsModal
          open={!!eventsMatch}
          onClose={() => setEventsMatch(null)}
          teamId={teamId}
          teamName={teamName}
          sourceType={eventsMatch.sourceType}
          sourceId={eventsMatch.id}
          matchLabel={eventsMatch.label}
          players={lineupPlayersForEvents}
        />
      )}
    </>
  );
}
