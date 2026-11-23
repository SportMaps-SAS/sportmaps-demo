/**
 * Sincronizador global de listas guardadas sin señal (opcional).
 *
 * La pantalla de Asistencia ya sube sola lo pendiente mientras está abierta.
 * Montando este componente (no pinta nada) en el layout del entrenador, la
 * lista también sube cuando el profe ya se fue a otra pestaña de la app.
 * Usa la misma cola (obtenerCola) que la pantalla: no hay doble envío.
 *
 * Modo offline: además, con señal, deja en el teléfono el roster y la lista de HOY de cada
 * equipo del profe (lib/offline/precargaDelDia.ts), para que existan cuando se vaya la señal.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { precargarDiaDelEntrenador } from '@/lib/offline/precargaDelDia';
import { useColaAsistencia } from './useCoachV2Senal';
import { useEquiposCoach } from './useCoachV2Data';
import { isoDia } from './coachV2Logic';

export function CoachListasSync() {
  const { user } = useAuth();
  const { schoolId } = useSchoolContext();
  const qc = useQueryClient();
  useColaAsistencia(user?.id);

  // Mismos equipos que ve el entrenador en su inicio (lista blanca offline: ['coach-v2','equipos']).
  const equiposQ = useEquiposCoach(schoolId);
  const equipos = equiposQ.data;
  const hoy = isoDia(new Date());

  useEffect(() => {
    if (!user?.id || !equipos || equipos.length === 0) return;
    let activo = true;
    // Un respiro: no compite con las primeras consultas de la pantalla en la que acaba de entrar.
    const t = setTimeout(() => {
      void precargarDiaDelEntrenador(qc, equipos.map((e) => ({ id: e.id, nombre: e.nombre })), hoy, { seguir: () => activo });
    }, 4000);
    const alVolverLaRed = () => {
      // Con jitter: muchos entrenadores recuperan señal a la vez (la base es una sola).
      setTimeout(() => {
        if (activo) void precargarDiaDelEntrenador(qc, equipos.map((e) => ({ id: e.id, nombre: e.nombre })), hoy, { seguir: () => activo });
      }, 2000 + Math.floor(Math.random() * 5000));
    };
    window.addEventListener('online', alVolverLaRed);
    return () => { activo = false; clearTimeout(t); window.removeEventListener('online', alVolverLaRed); };
  }, [user?.id, equipos, hoy, qc]);

  return null;
}
