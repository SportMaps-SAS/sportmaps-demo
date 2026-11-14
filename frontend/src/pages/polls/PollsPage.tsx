import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { Plus, ChevronRight, Lock, Clock, Trash2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { usePolls, useClosePoll, useDeletePoll } from '@/hooks/usePolls';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { AttendancePoll } from '@/lib/api/polls.api';
import { CreatePollDialog } from '@/pages/polls/components/CreatePollDialog';
import { toast } from 'sonner';

export default function PollsPage() {
  const navigate                      = useNavigate();
  const { currentUserRole }           = useSchoolContext();
  const { data: polls, isLoading }    = usePolls();
  const { mutate: closePoll }         = useClosePoll();
  const { mutate: deletePoll }        = useDeletePoll();
  const [showCreate, setShowCreate]   = useState(false);
  const [pollToDelete, setPollToDelete] = useState<AttendancePoll | null>(null);

  const isAdmin = ['owner', 'admin', 'school_admin'].includes(currentUserRole ?? '');

  const handleShare = (poll: AttendancePoll) => {
    const url = `${window.location.origin}/polls/v/${poll.id}`;
    navigator.clipboard.writeText(url);
    toast.success('Link copiado al portapapeles');
  };

  if (isLoading) return <PollsSkeleton />;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Encuestas de asistencia</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isAdmin
              ? 'Crea la encuesta del día y compártela por WhatsApp'
              : 'Las encuestas de asistencia de tu escuela'}
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Nueva encuesta
          </Button>
        )}
      </div>

      {!polls?.length && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3">
            <p className="text-muted-foreground text-sm">{isAdmin ? 'No hay encuestas creadas aún' : 'No hay encuestas por ahora'}</p>
            {isAdmin && (
              <Button variant="outline" onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Crear el primero
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {polls?.map((poll) => (
          <Card
            key={poll.id}
            className="cursor-pointer hover:border-border/80 transition-colors"
            onClick={() => navigate(`/dashboard/polls/${poll.id}/results`)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base font-medium">{poll.title}</CardTitle>
                    <Badge variant={poll.status === 'open' ? 'default' : 'secondary'}>
                      {poll.status === 'open' ? 'Abierta' : 'Cerrada'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {format(new Date(poll.poll_date), "EEEE d 'de' MMMM", { locale: es })}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground mt-1 flex-shrink-0" />
              </div>
            </CardHeader>

            <CardContent className="pt-0">
              <div className="flex flex-wrap gap-2 mb-4">
                {poll.attendance_sessions.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-1.5 text-xs bg-secondary px-2.5 py-1 rounded-md"
                  >
                    <Clock className="w-3 h-3" />
                    <span>{s.title}</span>
                    <span className="text-muted-foreground">· {s.current_bookings} van</span>
                  </div>
                ))}
              </div>

              {isAdmin && (
                <div
                  className="flex gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleShare(poll)}
                  >
                    <Share2 className="w-3.5 h-3.5 mr-1.5" />
                    Copiar link
                  </Button>

                  {poll.status === 'open' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => closePoll(poll.id)}
                    >
                      <Lock className="w-3.5 h-3.5 mr-1.5" />
                      Cerrar
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setPollToDelete(poll)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {isAdmin && (
        <CreatePollDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
        />
      )}

      <AlertDialog open={!!pollToDelete} onOpenChange={() => setPollToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar encuesta?</AlertDialogTitle>
            <AlertDialogDescription>
              Solo puedes eliminar encuestas sin confirmaciones. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => {
                if (pollToDelete) deletePoll(pollToDelete.id);
                setPollToDelete(null);
              }}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PollsSkeleton() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <Skeleton className="h-8 w-48" />
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-32 w-full rounded-lg" />
      ))}
    </div>
  );
}
