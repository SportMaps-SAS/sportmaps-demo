/**
 * Hijos del acudiente (V2) — lectura de datos.
 *
 * Todo sale de fuentes que ya usa el resto de la app; aquí no hay endpoints ni
 * tablas nuevas:
 *   · Progreso   → BFF /api/v1/athlete/performance/{entries,evolution}?child_id
 *                  (performance_entries; el BFF valida children.parent_id)
 *                  + último informe mensual publicado (athlete_reports, RLS de familia)
 *   · Asistencia → attendance_records por child_id (RLS «Parents can view…»)
 *   · Informes   → athlete_reports publicados (getAthleteReports)
 *   · Documentos → bucket identity-documents, carpeta children/{padre}/{hijo}/docs
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { tipoDeArchivo, type TipoDocumento } from '@/lib/documentosDeportista';
import { useAuth } from '@/contexts/AuthContext';
import {
  getAthletePerformanceEntries,
  getAthletePerformanceEvolution,
} from '@/lib/school/performanceQueries';
import { getAthleteReportDetail } from '@/lib/school/reportsQueries';
import { useAthleteReports } from '@/hooks/useAthleteReports';
import { carpetaDocsFamilia, type AttendanceRecord } from './hijosUtils';

export function useChildPerformanceEntries(childId: string | undefined) {
  return useQuery({
    queryKey: ['athlete-performance-entries', childId],
    queryFn: () => getAthletePerformanceEntries(childId),
    enabled: !!childId,
    retry: 1,
  });
}

export function useChildPerformanceEvolution(childId: string | undefined) {
  return useQuery({
    queryKey: ['athlete-performance-evolution', childId, 365],
    queryFn: () => getAthletePerformanceEvolution(childId, 365),
    enabled: !!childId,
    retry: 1,
  });
}

export function useChildReports(childId: string | undefined) {
  return useAthleteReports('child', childId);
}

/**
 * Detalle del informe más reciente, SIN marcarlo como visto (por eso no usa
 * useAthleteReportDetail): leer el consejo del profe en Progreso no es abrir
 * el informe.
 */
export function useLatestReportSnapshot(reportId: string | undefined) {
  return useQuery({
    queryKey: ['athlete-report-snapshot', reportId],
    queryFn: () => getAthleteReportDetail(reportId!),
    enabled: !!reportId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useChildAttendance(childId: string | undefined) {
  return useQuery({
    queryKey: ['hijos-v2-attendance', childId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance_records')
        .select('attendance_date, status')
        .eq('child_id', childId!)
        .order('attendance_date', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as AttendanceRecord[];
    },
    enabled: !!childId,
  });
}

export interface ArchivoDocumento {
  nombre: string;
  ruta: string;
}

/** Por tipo de documento, los archivos que la familia ya subió (catálogo en lib/documentosDeportista). */
export type ChildDocsState = Partial<Record<TipoDocumento, ArchivoDocumento[]>>;

// La misma carpeta que lee la escuela (SchoolStudentsManagementPage → carpetasDocumentosDeportista).
export const childDocsFolder = (userId: string, childId: string) => carpetaDocsFamilia(userId, childId);

export function useChildDocuments(childId: string | undefined, idDocumentUrl: string | null | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['hijos-v2-docs', user?.id, childId],
    queryFn: async (): Promise<ChildDocsState> => {
      const folder = childDocsFolder(user!.id, childId!);
      const { data, error } = await supabase.storage.from('identity-documents').list(folder, { limit: 100 });
      if (error) throw error;
      const out: ChildDocsState = {};
      for (const f of data ?? []) {
        const tipo = tipoDeArchivo(f.name);
        if (!tipo) continue;
        (out[tipo] ??= []).push({ nombre: f.name, ruta: `${folder}/${f.name}` });
      }
      // El documento que se pidió al agregar al hijo (children.id_document_url) cuenta como el del deportista.
      if (idDocumentUrl && !out.athlete_id_front) out.athlete_id_front = [{ nombre: 'Documento cargado al registrarlo', ruta: '' }];
      return out;
    },
    enabled: !!childId && !!user?.id,
  });
}
