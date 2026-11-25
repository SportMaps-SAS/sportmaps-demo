/**
 * Constancias del acudiente (V2) — palabras de la pantalla, sin React.
 * Nunca se muestra el estado técnico (pending_payment, pending_review…).
 */
import type { TonoEstado } from '@/components/common/ChipEstado';

export function estadoConstancia(status: string): { label: string; tono: TonoEstado; detalle: string | null } {
  switch (status) {
    case 'issued':
      return { label: 'Lista', tono: 'ok', detalle: null };
    // 'pending_payment' es heredado: desde 2026-11-24 no se cobran constancias.
    case 'pending_review':
    case 'pending_payment':
      return { label: 'En revisión', tono: 'info', detalle: 'La escuela la está revisando. Te avisamos cuando esté lista.' };
    case 'revoked':
      return { label: 'Anulada', tono: 'neutro', detalle: 'La escuela la anuló. Si la necesitas, pide una nueva.' };
    default:
      return { label: 'En proceso', tono: 'neutro', detalle: null };
  }
}

export function fraseConstancias(items: Array<{ status: string }>): { titulo: string; subtitulo: string } {
  if (items.length === 0) {
    return {
      titulo: 'Aún no tienes constancias',
      subtitulo: 'Pide una constancia de estudio o de deportista y la escuela te la entrega aquí.',
    };
  }
  const listas = items.filter((i) => i.status === 'issued').length;
  const enCamino = items.filter((i) => i.status === 'pending_review' || i.status === 'pending_payment').length;
  const titulo = listas === 1
    ? '1 constancia lista'
    : listas > 1
      ? `${listas} constancias listas`
      : enCamino === 1 ? 'Tu constancia está en camino' : `${enCamino} constancias en camino`;
  const subtitulo = listas > 0
    ? (enCamino > 0 ? `Y ${enCamino === 1 ? '1 más en camino' : `${enCamino} más en camino`}. Descárgalas cuando quieras.` : 'Descárgalas cuando quieras.')
    : 'Te avisamos cuando la escuela la tenga lista.';
  // Solo anuladas: ni listas ni en camino.
  if (listas === 0 && enCamino === 0) return { titulo: 'No tienes constancias vigentes', subtitulo: 'Si necesitas una, pídela de nuevo.' };
  return { titulo, subtitulo };
}
