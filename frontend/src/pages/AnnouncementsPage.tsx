import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { announcementsApi } from '@/lib/api/announcements';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Bell, Plus, Send, Users, UserCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

/**
 * Quién puede CREAR anuncios. El acudiente y el deportista llegan aquí por URL
 * (o por un aviso) y pueden LEER los de los equipos de sus hijos, pero no
 * crear: antes veían «Nuevo Anuncio» y el envío moría en un 403 (B9).
 */
export const puedeCrearAnuncios = (role: string | null | undefined): boolean =>
  !!role && !['parent', 'athlete'].includes(role);

/** Anuncios para la familia: los de los equipos de sus hijos dirigidos a padres. */
async function anunciosDeLaFamilia(parentId: string) {
  const { data: hijos, error: e1 } = await supabase
    .from('children')
    .select('id, team_id')
    .eq('parent_id', parentId);
  if (e1) throw e1;
  const childIds = (hijos ?? []).map((h) => h.id);
  const teamIds = new Set((hijos ?? []).map((h) => h.team_id).filter(Boolean) as string[]);
  if (childIds.length > 0) {
    const { data: ins, error: e2 } = await supabase
      .from('enrollments')
      .select('team_id')
      .in('child_id', childIds)
      .eq('status', 'active');
    if (e2) throw e2;
    for (const i of ins ?? []) if (i.team_id) teamIds.add(i.team_id);
  }
  if (teamIds.size === 0) return [];
  const { data, error } = await supabase
    .from('announcements')
    .select('*, teams(name)')
    .in('team_id', [...teamIds])
    .in('audience', ['parents', 'both'])
    .order('sent_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export default function AnnouncementsPage() {
  const { user, profile } = useAuth();
  const puedeCrear = puedeCrearAnuncios(profile?.role);
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [audience, setAudience] = useState('parents');
  const [selectedTeamId, setSelectedTeamId] = useState('');

  // Check if user is demo account
  const isDemoUser = user?.email?.endsWith('@demo.sportmaps.com');

  // Demo teams data (only for demo users)
  const demoTeams = isDemoUser ? [
    {
      id: 'demo-team-1',
      coach_id: user?.id,
      name: 'Firesquad (Senior L3)',
      sport: 'Cheerleading',
      age_group: 'Senior',
      season: '2024',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ] : [];

  const { data: teamsData } = useQuery({
    queryKey: ['coach-teams', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('teams')
        .select('*')
        .eq('coach_id', user?.id);
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  const teams = teamsData && teamsData.length > 0 ? teamsData : (isDemoUser ? demoTeams : []);

  // Demo announcements data (only for demo users)
  const demoAnnouncements = isDemoUser ? [
    {
      id: 'ann-1',
      coach_id: user?.id,
      team_id: 'demo-team-1',
      subject: 'Competencia regional este sábado',
      message: 'Recordatorio: La competencia regional es este sábado a las 10:00 AM en el Coliseo Mayor. Por favor lleguen 1 hora antes para calentamiento.',
      audience: 'both',
      sent_at: '2024-10-29T10:00:00Z',
      teams: { name: 'Firesquad (Senior L3)' },
    },
    {
      id: 'ann-2',
      coach_id: user?.id,
      team_id: null,
      subject: 'Entrenamiento cancelado',
      message: 'El entrenamiento de mañana está cancelado por mantenimiento del gimnasio. Nos vemos el jueves en el horario habitual.',
      audience: 'parents',
      sent_at: '2024-10-27T18:30:00Z',
      teams: null,
    },
  ] : [];

  const { data: announcementsData, isLoading, refetch } = useQuery({
    queryKey: ['announcements', user?.id, puedeCrear],
    queryFn: () => (puedeCrear ? announcementsApi.getAnnouncements(user!.id) : anunciosDeLaFamilia(user!.id)),
    enabled: !!user?.id,
  });

  const announcements = announcementsData && announcementsData.length > 0 ? announcementsData : (isDemoUser ? demoAnnouncements : []);

  const handleSend = async () => {
    try {
      await announcementsApi.createAnnouncement({
        coach_id: user!.id,
        team_id: selectedTeamId || null,
        subject,
        message,
        audience: audience as any,
      });

      // Habia un `if (error) throw error;` con `error` sin declarar —resto de un
      // patron `{ data, error }`—: cualquier envio moria en ReferenceError antes
      // de llegar al toast. `createAnnouncement` ya lanza por dentro y el catch
      // de abajo lo recoge.

      toast({
        title: '📢 Anuncio enviado',
        description: 'Tu mensaje ha sido enviado exitosamente',
      });

      setDialogOpen(false);
      setSubject('');
      setMessage('');
      refetch();
    } catch (error) {
      toast({
        title: 'Error',
        description: 'No se pudo enviar el anuncio',
        variant: 'destructive',
      });
    }
  };

  const getAudienceLabel = (aud: string) => {
    switch (aud) {
      case 'parents':
        return 'Padres';
      case 'players':
        return 'Jugadores';
      case 'both':
        return 'Padres y Jugadores';
      default:
        return aud;
    }
  };

  const getAudienceIcon = (aud: string) => {
    switch (aud) {
      case 'parents':
        return <Users className="w-4 h-4" />;
      case 'players':
        return <UserCircle className="w-4 h-4" />;
      case 'both':
        return <Users className="w-4 h-4" />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Anuncios</h1>
          <p className="text-muted-foreground mt-1">
            {puedeCrear ? 'Comunícate con padres y jugadores' : 'Lo que la escuela y los profes les cuentan a las familias'}
          </p>
        </div>
        {puedeCrear && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              Nuevo Anuncio
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Bell className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <DialogTitle>Crear Nuevo Anuncio</DialogTitle>
                  <DialogDescription>
                    Comparte un mensaje con tu comunidad deportiva.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Equipo (Opcional)</Label>
                <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Todos mis equipos" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Todos mis equipos</SelectItem>
                    {teams?.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Audiencia</Label>
                <Select value={audience} onValueChange={setAudience}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parents">Padres</SelectItem>
                    <SelectItem value="players">Jugadores</SelectItem>
                    <SelectItem value="both">Padres y Jugadores</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Asunto</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Ej: Práctica cancelada por lluvia"
                />
              </div>

              <div>
                <Label>Mensaje</Label>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Escribe tu mensaje aquí..."
                  rows={5}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancelar
              </Button>
              <Button
                onClick={handleSend}
                disabled={!subject.trim() || !message.trim()}
                className="gap-2"
              >
                <Send className="w-4 h-4" />
                Enviar Anuncio
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="w-5 h-5 text-primary" />
            <CardTitle>{puedeCrear ? 'Historial de Anuncios' : 'Anuncios'}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {announcements?.map((announcement: any) => (
              <div
                key={announcement.id}
                className="p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <h3 className="font-semibold text-lg">{announcement.subject}</h3>
                    <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                      <span>
                        {new Date(announcement.sent_at).toLocaleDateString('es-CO', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {announcement.teams && (
                        <>
                          <span>•</span>
                          <span>{announcement.teams.name}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Badge variant="secondary" className="gap-1">
                    {getAudienceIcon(announcement.audience)}
                    {getAudienceLabel(announcement.audience)}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{announcement.message}</p>
              </div>
            ))}

            {announcements && announcements.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Bell className="w-12 h-12 mx-auto mb-2 opacity-20" />
                <p>{puedeCrear ? 'No has enviado anuncios aún' : 'Todavía no hay anuncios para tu familia'}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {isLoading && <LoadingSpinner text="Cargando anuncios..." />}
    </div>
  );
}
