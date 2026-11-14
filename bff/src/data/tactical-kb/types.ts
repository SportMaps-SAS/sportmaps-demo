/**
 * Base táctica propia de la IA de la pizarra (RAG ligero, 2026-10-27).
 *
 * Datos VERSIONADOS en el repo (un archivo por familia de deporte). El BFF
 * elige por deporte + formación lo que entra al prompt (services/
 * tactical-ai-knowledge.ts) con un tope de caracteres: nada de mandar la base
 * entera. Cambiar el texto = subir `version` del deporte (entra al hash de la
 * caché de análisis vía PROMPT_VERSION + versión de la base).
 *
 * Contenido: principios por MOMENTO DE JUEGO y fortalezas/debilidades por
 * FORMACIÓN, escritos para entrenadores de escuelas (no para profesionales):
 * frases cortas, accionables, vocabulario del deporte. Fuentes: manuales de
 * formación de entrenadores (momentos del juego de la periodización táctica,
 * principios de juego de base), y la descripción de cada formación del catálogo
 * de la pizarra (frontend/src/lib/school/tacticalFormations.ts y
 * tacticalSports.ts).
 */
import type { AiSport } from '../../routes/school/tacticalAiShapes';

export const MOMENTS = ['ataque_organizado', 'transicion_def_atq', 'defensa_organizada', 'transicion_atq_def', 'balon_parado'] as const;
export type Moment = (typeof MOMENTS)[number];

export interface FormationKnowledge {
  /** Clave del catálogo de la pizarra ('4-3-3', 'f7-2-3-1', 'vb-recepcion-w'…). */
  key: string;
  /** Cómo se nombra en el texto. */
  label: string;
  /** Jugadores de campo por línea, de atrás hacia adelante (sin arquero), para
   *  reconocer la formación por posiciones. Sin líneas = no se infiere. */
  lines?: number[];
  fortalezas: string[];
  debilidades: string[];
}

export interface SportKnowledge {
  sport: AiSport;
  /** Subir al cambiar cualquier texto de este deporte. */
  version: string;
  /** Nombre del momento en ESTE deporte (en voleibol no hay «balón parado»). */
  momentLabels: Record<Moment, string>;
  momentos: Record<Moment, string[]>;
  formaciones: FormationKnowledge[];
}

export const DEFAULT_MOMENT_LABELS: Record<Moment, string> = {
  ataque_organizado: 'Ataque organizado',
  transicion_def_atq: 'Transición defensa→ataque',
  defensa_organizada: 'Defensa organizada',
  transicion_atq_def: 'Transición ataque→defensa',
  balon_parado: 'Balón parado',
};
