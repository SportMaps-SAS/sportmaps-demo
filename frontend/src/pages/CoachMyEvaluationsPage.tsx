/**
 * «Mis evaluaciones» del entrenador (spec evaluacion-de-entrenadores, D5):
 * solo las que el dueño/admin PUBLICÓ (la RLS no le deja ver los borradores).
 * Solo lectura.
 */
import { useQuery } from '@tanstack/react-query';
import { Award, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { listEvaluations } from '@/components/coach-evaluation/api';
import { EvaluationHistory } from '@/components/coach-evaluation/EvaluationHistory';

export default function CoachMyEvaluationsPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-coach-evaluations'],
    queryFn: async () => {
      // Fichas de school_staff de esta cuenta (una por escuela donde entrena).
      const { data: ids, error } = await (supabase as any).rpc('my_coach_staff_ids');
      if (error) throw error;
      return listEvaluations((ids as string[] | null) ?? []);
    },
  });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-4 sm:px-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Award className="h-6 w-6 text-primary" /> Mis evaluaciones
        </h1>
        <p className="text-sm text-muted-foreground">
          Cómo te calificó la escuela en cada período. Aparecen cuando la administración las publica.
        </p>
      </header>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : isError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-6 text-center text-sm">No se pudieron cargar tus evaluaciones.</p>
      ) : (
        <EvaluationHistory evaluations={data ?? []} emptyText="Todavía no tienes evaluaciones publicadas." />
      )}
    </div>
  );
}
