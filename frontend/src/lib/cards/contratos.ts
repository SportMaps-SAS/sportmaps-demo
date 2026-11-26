/**
 * Contratos del carnet 3D entre fases (spec docs/specs/carnet-3d-club.md).
 * CONTRATO COMPARTIDO: lo usan F2 (identidad), F3/F4 (carnet y reverso),
 * F5 (habilitación) y la pantalla V2 del dueño. No cambiar sin avisar.
 */
import type { ClubIdentidad } from './clubIdentity';

/** Respuesta de la RPC card_back_data(p_qr_token) (migración 20261126095105). */
export interface CardBackData {
  found: boolean;
  estado?: 'active' | 'revoked' | 'expired';
  deporte?: 'futbol' | 'generico' | string;
  deporte_nombre?: string | null;
  zona_de_juego?: {
    posicion: string | null;
    numero: number | null;
    origen: 'inscripcion' | 'alineacion' | 'alineaciones' | null;
  };
  estadisticas?: Array<{ clave: string; etiqueta: string; valor: string | null; detalle: string | null }>;
  /** 'generico' hoy; F4 agrega 'futbol' con estadisticas del partido. */
  origen?: 'generico' | 'futbol' | string;
}

/** Respuesta de verificar_carnet_por_codigo(p_codigo). */
export interface VerificacionPorCodigo {
  found: boolean;
  motivo?: 'formato' | 'no_existe';
  codigo?: string;
  estado?: 'active' | 'revoked' | 'expired';
  valido?: boolean;
  nombre?: string | null;
  club?: { name: string; logo_url: string | null };
}

/** Lo que pinta el frente del carnet 3D. */
export interface Carnet3DDatos {
  nombre: string;
  fotoUrl: string | null;
  numero: number | null;
  posicion: string | null;
  categoria: string | null;
  codigo: string | null;
  /** Token del QR (uuid). null en vistas previas de ejemplo. */
  qrToken: string | null;
  identidad: ClubIdentidad;
  /** Reverso: si no viene, el carnet muestra solo QR y código. */
  reverso?: CardBackData | null;
}

/** Props de components/cards/AthleteCard3D.tsx (F3). */
export interface AthleteCard3DProps {
  datos: Carnet3DDatos;
  /** 'interactivo' = inclinación/giro; 'plano' = exportación (sin efectos). */
  modo?: 'interactivo' | 'plano';
  /** Ancho en px; mantiene proporción ID-1 vertical (340 × 540 base). */
  ancho?: number;
  /** Arranca mostrando el reverso. */
  reversoInicial?: boolean;
  className?: string;
}

/** Props de components/cards/IdentidadClubDialog.tsx (F2): «Datos y marca» ampliada. */
export interface IdentidadClubDialogProps {
  schoolId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Se llama tras guardar con la identidad nueva (para refrescar la vista previa). */
  onGuardado?: () => void;
}

/** Props de components/cards/ReglasParaEntrar.tsx (F5): criterios del semáforo por club. */
export interface ReglasParaEntrarProps {
  schoolId: string;
}

/** Props de components/cards/EstadoHabilitacionPanel.tsx (F5): vista del personal en /c/:token. */
export interface EstadoHabilitacionPanelProps {
  qrToken: string;
  /** Evento opcional («Verificar para: <torneo/evento>»). */
  eventId?: string | null;
}
