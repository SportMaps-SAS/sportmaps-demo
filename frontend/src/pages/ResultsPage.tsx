import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Trophy, Plus, TrendingUp, Minus, Equal, Trash2, ChevronRight } from 'lucide-react';
import { CompetitionResultFormDialog } from '@/components/coach/CompetitionResultFormDialog';
import { CompetitionResultsList } from '@/components/coach/CompetitionResultsList';
import { LevelProgressionPanel } from '@/components/coach/LevelProgressionPanel';
import { useMatchReports } from '@/hooks/useMatchReports';
import { useToast } from '@/hooks/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useSchoolContext } from '@/hooks/useSchoolContext';

export default function ResultsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const navigate = useNavigate();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [competitionDialogOpen, setCompetitionDialogOpen] = useState(false);
  // Cada partido se programa, convoca, cierra, evalúa y reporta en UNA
  // pantalla (/partidos/:id). Esta lista solo lista y abre.
  const abrirPartido = (id: string) => navigate(`/partidos/${encodeURIComponent(id)}`);
  const nuevoPartido = () => navigate(`/partidos/nuevo?equipo=${encodeURIComponent(selectedTeamId)}`);

  const { schoolId, activeBranchId, currentUserRole } = useSchoolContext();
  // Editar/registrar partidos: lo decide la pantalla del partido (PartidoFlujo),
  // con el mismo criterio de roles que tenía esta página.
  // match_results_delete (RLS) excluye a 'coach' a propósito -- a diferencia
  // de insert/update, que sí lo incluyen. Sin este gate, un coach veía el
  // botón de borrar y se encontraba con un error de permisos sin explicación
  // al apretarlo (RLS lo bloqueaba en silencio, la UI no sabía que era un
  // caso distinto a editar).
  const DELETE_RESULTS_ROLES = ['owner', 'admin', 'staff', 'school_admin', 'super_admin'];
  const canDeleteResults = DELETE_RESULTS_ROLES.includes(currentUserRole || '');

  // Fetch teams
  const { data: teams } = useQuery({
    queryKey: ['coach-teams', user?.id, schoolId, activeBranchId],
    queryFn: async () => {
      if (!schoolId) return [];

      let staffId = null;
      if (currentUserRole === 'coach' && user?.email) {
        const { data: staffData } = await supabase
          .from('school_staff')
          .select('id')
          .eq('email', user.email)
          .single();

        if (staffData) {
          staffId = staffData.id;
        }
      }

      const query = (supabase as any)
        .from('teams')
        .select(`
          id,
          name,
          sport,
          age_group,
          coach_id,
          branch_id,
          team_coaches(coach_id)
        `)
        .eq('school_id', schoolId)
        .eq('status', 'active');

      const { data, error } = await query;
      if (error) throw error;

      let validTeams = data || [];

      // Filter logic
      const isAdminRole = ['owner', 'admin', 'school_admin', 'super_admin'].includes(currentUserRole || '');

      if (isAdminRole) {
        if (activeBranchId) {
          validTeams = validTeams.filter((t: any) => t.branch_id === activeBranchId || !t.branch_id);
        }
      } else if (currentUserRole === 'coach' && staffId) {
        validTeams = validTeams.filter((t: any) =>
          t.coach_id === staffId ||
          t.team_coaches?.some((tc: any) => tc.coach_id === staffId)
        );
      } else {
        validTeams = [];
      }

      return validTeams;
    },
    enabled: !!schoolId && !!user?.id,
  });

  const selectedTeam = teams?.find((t: any) => t.id === selectedTeamId);

  const { data: setsSportsData } = useQuery({
    queryKey: ['sports-with-sets-scoring'],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await (supabase as any)
        .from('sports_categories')
        .select('name')
        .eq('uses_sets_scoring', true);
      if (error) throw error;
      return (data || []).map((s: any) => s.name as string);
    },
    staleTime: 1000 * 60 * 60, // 1h — el catálogo de deportes casi no cambia
  });

  const usesSets = selectedTeam
    ? (setsSportsData ?? []).some((name) => name.toLowerCase() === selectedTeam.sport?.toLowerCase())
    : false;

  // Fetch match results
  const { data: results, isLoading } = useQuery({
    queryKey: ['match-results', selectedTeamId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('match_results')
        .select('*')
        .eq('team_id', selectedTeamId)
        .order('match_date', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!selectedTeamId && !usesSets,
  });

  // Delete result mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('match_results')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['match-results', selectedTeamId] });
      toast({ title: 'Partido eliminado' });
      setDeleteId(null);
    },
  });

  // Reportes de los partidos del historial (para el distintivo y el diálogo).
  const { data: reportsByMatch } = useMatchReports((results ?? []).map((m: any) => m.id));

  // 'scheduled' = partido cargado sin marcador todavía (ahora se puede dejar
  // en blanco al registrar/editar, ver MatchResultFormDialog) -- sin esto,
  // `null > null` y `null < null` son ambos false y caía en 'draw' por
  // defecto, contando un partido sin jugar como empate en el récord.
  const getMatchResult = (match: any) => {
    if (match.home_score == null || match.away_score == null) return 'scheduled';
    const ourScore = match.is_home ? match.home_score : match.away_score;
    const theirScore = match.is_home ? match.away_score : match.home_score;
    if (ourScore > theirScore) return 'win';
    if (ourScore < theirScore) return 'loss';
    return 'draw';
  };

  const getResultIcon = (result: string) => {
    switch (result) {
      case 'win': return <TrendingUp className="w-5 h-5 text-green-500" />;
      case 'loss': return <Minus className="w-5 h-5 text-red-500" />;
      case 'draw': return <Equal className="w-5 h-5 text-yellow-500" />;
      default: return null;
    }
  };

  const getResultLabel = (result: string) => {
    switch (result) {
      case 'scheduled': return 'Por jugar';
      case 'win': return 'Victoria';
      case 'loss': return 'Derrota';
      case 'draw': return 'Empate';
      default: return '';
    }
  };

  const stats = results ? {
    wins: results.filter((m) => getMatchResult(m) === 'win').length,
    draws: results.filter((m) => getMatchResult(m) === 'draw').length,
    losses: results.filter((m) => getMatchResult(m) === 'loss').length,
  } : null;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Resultados</h1>
          <p className="text-muted-foreground mt-1">
            Registra y consulta resultados de partidos
          </p>
        </div>
        <Button
          className="gap-2"
          onClick={() => {
            if (usesSets) {
              setCompetitionDialogOpen(true);
            } else {
              nuevoPartido();
            }
          }}
          disabled={!selectedTeamId}
        >
          <Plus className="w-4 h-4" />
          {usesSets ? 'Registrar Resultado' : 'Partido'}
        </Button>
      </div>

      {/* Ascensos por puntaje (F-F): no depende del equipo seleccionado. */}
      <LevelProgressionPanel />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Seleccionar Equipo</CardTitle>
        </CardHeader>
        <CardContent>
          <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
            <SelectTrigger>
              <SelectValue placeholder="Selecciona tu equipo" />
            </SelectTrigger>
            <SelectContent>
              {teams?.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name} - {team.age_group || team.sport}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {selectedTeamId && !usesSets && stats && (
        <>
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-4">
                <Trophy className="w-6 h-6 text-primary" />
                <h3 className="text-xl font-bold">Récord de la Temporada</h3>
              </div>
              <div className="flex items-center justify-center gap-8 text-center">
                <div>
                  <p className="text-4xl font-bold text-green-500">{stats.wins}</p>
                  <p className="text-sm text-muted-foreground">Victorias</p>
                </div>
                <div className="text-2xl text-muted-foreground">-</div>
                <div>
                  <p className="text-4xl font-bold text-yellow-500">{stats.draws}</p>
                  <p className="text-sm text-muted-foreground">Empates</p>
                </div>
                <div className="text-2xl text-muted-foreground">-</div>
                <div>
                  <p className="text-4xl font-bold text-red-500">{stats.losses}</p>
                  <p className="text-sm text-muted-foreground">Derrotas</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {isLoading && <LoadingSpinner text="Cargando resultados..." />}

          <Card>
            <CardHeader>
              <CardTitle>Historial de Partidos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {results?.map((match) => {
                  const result = getMatchResult(match);
                  const ourScore = match.is_home ? match.home_score : match.away_score;
                  const theirScore = match.is_home ? match.away_score : match.home_score;

                  return (
                    <div
                      key={match.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => abrirPartido(match.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') abrirPartido(match.id); }}
                      className="flex cursor-pointer flex-wrap items-center justify-between gap-3 p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        {getResultIcon(result)}
                        <div>
                          <p className="font-semibold">vs {match.opponent}</p>
                          <p className="text-sm text-muted-foreground">
                            {new Date(match.match_date).toLocaleDateString('es-CO', {
                              weekday: 'short',
                              day: 'numeric',
                              month: 'short',
                            })}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-2xl font-bold">
                            {result === 'scheduled' ? '— vs —' : `${ourScore} - ${theirScore}`}
                          </p>
                          <Badge
                            variant={
                              result === 'win' ? 'default' :
                                result === 'draw' ? 'secondary' :
                                  result === 'scheduled' ? 'outline' : 'destructive'
                            }
                          >
                            {getResultLabel(result)}
                          </Badge>
                        </div>
                        <Badge variant="outline">{match.match_type}</Badge>
                        {reportsByMatch?.[match.id] && (
                          <Badge variant={reportsByMatch[match.id].published_at ? 'default' : 'secondary'}>
                            {reportsByMatch[match.id].published_at ? 'Publicado' : 'Con reporte'}
                          </Badge>
                        )}
                        {canDeleteResults && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Eliminar partido"
                            onClick={(e) => { e.stopPropagation(); setDeleteId(match.id); }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                      </div>
                    </div>
                  );
                })}

                {results && results.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <Trophy className="w-12 h-12 mx-auto mb-2 opacity-20" />
                    <p>No hay resultados registrados aún</p>
                    <Button
                      className="mt-4 gap-2"
                      onClick={nuevoPartido}
                    >
                      <Plus className="w-4 h-4" />
                      Programar o registrar un partido
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {selectedTeamId && usesSets && (
        <CompetitionResultsList teamId={selectedTeamId} />
      )}

      {!selectedTeamId && teams && teams.length > 0 && (
        <Card>
          <CardContent className="pt-6 text-center">
            <Trophy className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">Selecciona tu equipo</h3>
            <p className="text-muted-foreground">
              Elige un equipo del menú superior para ver sus resultados
            </p>
          </CardContent>
        </Card>
      )}

      {teams && teams.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-center">
            <Trophy className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No tienes equipos</h3>
            <p className="text-muted-foreground">
              Primero debes crear un equipo en la sección de Equipos
            </p>
          </CardContent>
        </Card>
      )}

      {selectedTeamId && usesSets && (
        <CompetitionResultFormDialog
          open={competitionDialogOpen}
          onOpenChange={setCompetitionDialogOpen}
          teamId={selectedTeamId}
        />
      )}

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar partido?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borra el partido con su resultado. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground"
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
