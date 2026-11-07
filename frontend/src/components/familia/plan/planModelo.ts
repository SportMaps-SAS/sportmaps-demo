/**
 * Pausa, retiro y reactivación (familia) — validaciones y textos puros.
 * Los topes y la aprobación los decide el BFF; acá solo se evita mandar lo que seguro se rechaza.
 */
import type { EstadoSolicitud, RespuestaPausa, SolicitudPlan, TipoSolicitud } from '@/lib/api/planRequestsFamilia';

export const MAX_MESES_PAUSA = 12;

/** Cantidad de meses completos entre dos `AAAA-MM`, ambos incluidos. */
export function mesesEntre(desde: string, hasta: string): number {
    const [ay, am] = desde.split('-').map(Number);
    const [by, bm] = hasta.split('-').map(Number);
    return (by * 12 + bm) - (ay * 12 + am) + 1;
}

/** Los próximos `cantidad` meses como opciones `AAAA-MM`, desde el mes de `hoy` (`AAAA-MM-DD`). */
export function opcionesMes(hoy: string, cantidad = 13): { value: string; label: string }[] {
    const [y, m] = hoy.split('-').map(Number);
    return Array.from({ length: cantidad }, (_, i) => {
        const d = new Date(Date.UTC(y, m - 1 + i, 1));
        const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        return { value, label: mesLegible(value) };
    });
}

const NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** `2026-07` a `julio 2026`. */
export function mesLegible(ym: string): string {
    const [y, m] = ym.slice(0, 7).split('-').map(Number);
    return `${NOMBRES_MES[m - 1] ?? ''} ${y}`;
}

export function validarPausa(desde: string, hasta: string, hoy: string): string | null {
    if (!/^\d{4}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}$/.test(hasta)) return 'Elige desde qué mes y hasta qué mes.';
    if (desde < hoy.slice(0, 7)) return 'El mes de inicio no puede ser un mes que ya pasó.';
    if (hasta < desde) return 'El mes final no puede ser anterior al inicial.';
    if (mesesEntre(desde, hasta) > MAX_MESES_PAUSA) return `Puedes pausar hasta ${MAX_MESES_PAUSA} meses seguidos.`;
    return null;
}

export function validarRetiro(fechaSalida: string, hoy: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaSalida)) return 'Elige la fecha de salida.';
    if (fechaSalida < hoy) return 'La fecha de salida no puede ser anterior a hoy.';
    return null;
}

export function validarReactivacion(mes: string, hoy: string): string | null {
    if (!/^\d{4}-\d{2}$/.test(mes)) return 'Elige el mes en que vuelves.';
    if (mes < hoy.slice(0, 7)) return 'El mes de regreso no puede ser un mes que ya pasó.';
    return null;
}

/** Qué le decimos a la familia después de pedir la pausa. */
export function resultadoPausa(r: Pick<RespuestaPausa, 'auto_aprobada' | 'fuera_de_tope' | 'tope' | 'usados'>): string {
    if (r.auto_aprobada) {
        return 'Tu pausa quedó aprobada. En esos meses no se generan cobros.';
    }
    if (r.fuera_de_tope) {
        const cupo = r.tope ? ` (el cupo es de ${r.tope} mes${r.tope === 1 ? '' : 'es'} al año)` : '';
        return `Pediste más meses de los que la escuela aprueba sola${cupo}. Quedó pendiente: la escuela la revisa y te avisa. Mientras tanto tus cobros siguen igual.`;
    }
    return 'Tu solicitud quedó pendiente: la escuela la revisa y te avisa. Mientras tanto tus cobros siguen igual.';
}

export const TEXTO_RETIRO =
    'La escuela revisa tu solicitud de retiro. No se cancela nada hasta que la apruebe; mientras tanto el plan sigue como está.';

export const ETIQUETA_TIPO: Record<TipoSolicitud, string> = {
    pausa: 'Pausa del plan',
    retiro: 'Retiro del plan',
    reactivacion: 'Reactivar el plan',
};

export const ETIQUETA_ESTADO: Record<EstadoSolicitud, string> = {
    solicitado: 'En revisión',
    aprobado: 'Aprobada',
    rechazado: 'No aprobada',
    cancelado: 'Cancelada',
};

/** Una solicitud abierta es la que todavía se puede cancelar. */
export const esAbierta = (s: Pick<SolicitudPlan, 'estado'>) => s.estado === 'solicitado';

/** Detalle en una línea: «julio 2026 a septiembre 2026», «salida el 20/12/2026», «regresa en…». */
export function detalleSolicitud(s: SolicitudPlan): string {
    if (s.tipo === 'pausa' && s.desde) {
        const a = mesLegible(s.desde);
        const b = s.hasta ? mesLegible(s.hasta) : a;
        return a === b ? a : `${a} a ${b}`;
    }
    if (s.tipo === 'retiro' && s.desde) {
        const [y, m, d] = s.desde.slice(0, 10).split('-');
        return `Salida el ${d}/${m}/${y}`;
    }
    if (s.tipo === 'reactivacion' && s.desde) return `Regreso en ${mesLegible(s.desde)}`;
    return '';
}

/**
 * Estados de inscripción desde los que se puede pedir reactivar. Todo lo que no es activo
 * ni un alta en trámite.
 */
export function puedeReactivar(status: string | null | undefined): boolean {
    const s = (status ?? '').toLowerCase();
    if (!s) return false;
    if (['active', 'activo'].includes(s)) return false;
    return !/pending|pendiente|trial|prueba/.test(s);
}

export const esActiva = (status: string | null | undefined) => ['active', 'activo'].includes((status ?? '').toLowerCase());
