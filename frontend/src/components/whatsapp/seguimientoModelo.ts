/**
 * Modelo de WhatsApp › Seguimiento: los tipos que devuelve el BFF
 * (GET /api/v1/whatsapp/:schoolId/seguimiento) y los textos que ve la escuela.
 * Puro, sin React. Las reglas (quién respondió, quién espera) viven en el BFF:
 * bff/src/services/whatsapp-seguimiento-conversaciones.service.ts.
 */

export type Autor = 'persona' | 'escuela' | 'bot' | 'campana' | 'automatico';
export type TipoTema = 'servicio' | 'clase_prueba' | 'familia' | 'otro';

export interface FilaSeguimiento {
    conversacionId: string;
    contacto: { nombre: string | null; telefono: string };
    tipoContacto: string | null;
    tema: { tipo: TipoTema; servicioId: string | null; nombre: string };
    primerMensaje: { fecha: string; texto: string };
    ultimoMensaje: { fecha: string; de: Autor; texto: string };
    mensajes: { persona: number; escuela: number; bot: number };
    respondioEscuela: boolean;
    respondioBot: boolean;
    esperandoDesde: string | null;
    esperandoMin: number | null;
    datosDePagoEnviados: boolean;
    comprobanteRecibido: boolean;
    comprobantes: number;
    comprobanteEstado: string | null;
    cobro: { monto: number; estado: string; tipo: string | null; concepto: string; fecha: string; cuantos: number } | null;
    pendientesEscuela: { texto: string; desde: string }[];
    alerta: boolean;
    tomada: boolean;
}

export interface ResumenSeguimiento {
    escribieron: number;
    respondioEscuela: number;
    respondioBot: number;
    nadieRespondio: number;
    sinResponder: number;
    esperandoMas2h: number;
    conPendientes: number;
    conDatosDePago: number;
    conComprobante: number;
    conCobro: number;
}

export interface RespuestaSeguimiento {
    rango: { desde: string; hasta: string };
    servicios: { id: string; nombre: string }[];
    resumen: ResumenSeguimiento;
    filas: FilaSeguimiento[];
    avisos: string[];
}

export const DIAS_MAXIMO = 31;

export const ETIQUETA_AUTOR: Record<Autor, string> = {
    persona: 'Persona', escuela: 'Escuela', bot: 'Bot', campana: 'Campaña', automatico: 'Automático',
};

export const AYUDA_AUTOR: Record<Autor, string> = {
    persona: 'Lo escribió la persona',
    escuela: 'Una persona de la escuela, desde el celular o el buzón',
    bot: 'El asistente (o la respuesta automática a un botón de campaña)',
    campana: 'La plantilla de una campaña',
    automatico: 'Saludo o respuesta rápida automática de WhatsApp Business, o un recordatorio de la app. No cuenta como respuesta',
};

export const TONO_AUTOR: Record<Autor, string> = {
    persona: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
    escuela: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
    bot: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200',
    campana: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    automatico: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-300',
};

const ESTADO_COBRO: Record<string, string> = {
    pending: 'Pendiente', awaiting_approval: 'Por validar', paid: 'Pagado', approved: 'Pagado', partial: 'Abono',
    overdue: 'Vencido', rejected: 'Rechazado', cancelled: 'Anulado', failed: 'Fallido', glosado: 'Glosado',
};
export const etiquetaEstadoCobro = (estado: string) => ESTADO_COBRO[estado] ?? estado;

const TIPO_COBRO: Record<string, string> = {
    mensualidad: 'Mensualidad', inscripcion: 'Inscripción', clase_prueba: 'Clase de prueba', clase_extra: 'Clase extra',
    torneo: 'Torneo', uniforme_gala: 'Uniforme', seguro: 'Seguro', reserva: 'Reserva', viaje: 'Viaje',
    articulos: 'Artículos', excedente: 'Excedente', otro: 'Otro',
};
export const etiquetaTipoCobro = (tipo: string | null) => (tipo ? TIPO_COBRO[tipo] ?? tipo : 'Cobro');

/** «45 min», «5 h», «3 días». Puro. */
export function haceCuanto(min: number | null | undefined): string {
    if (min === null || min === undefined || !Number.isFinite(min)) return '';
    if (min < 60) return `${Math.max(0, Math.round(min))} min`;
    const h = min / 60;
    if (h < 48) return `${Math.round(h)} h`;
    return `${Math.round(h / 24)} días`;
}

/** «+57 312 456 7890» para un celular colombiano; el resto con +. Puro. */
export function telefonoLegible(tel: string): string {
    const d = String(tel ?? '').replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('57')) return `+57 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
    return d ? `+${d}` : '';
}

/** «8 nov, 1:05 p. m.» en hora de Bogotá. Puro. */
export function fechaCorta(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Días del rango, ambos incluidos. Puro. */
export function diasDelRango(desde: string, hasta: string): number {
    return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
}

const ERRORES: Record<string, string> = {
    rango_demasiado_largo: `El rango puede tener hasta ${DIAS_MAXIMO} días.`,
    rango_invalido: 'La fecha «desde» va antes de «hasta».',
    fecha_invalida: 'Revisa las fechas.',
    servicio_invalido: 'Ese servicio no existe.',
};
/** El error del BFF en palabras de la escuela. Puro. */
export const textoDeError = (mensaje: string) => ERRORES[mensaje] ?? mensaje;
