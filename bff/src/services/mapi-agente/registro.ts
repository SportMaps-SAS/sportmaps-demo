/**
 * registro — catálogo de herramientas del agente (plan §3.1).
 *
 * Cada herramienta declara sus roles y, si aplica, el flag de la escuela que
 * la habilita. Se filtra lo que se le OFRECE al modelo y se vuelve a chequear
 * al EJECUTAR y al CONFIRMAR: ofrecerla no es autorizarla.
 *
 * Regla del spec: una herramienta por acción de pantalla, sobre el MISMO
 * servicio de la pantalla. Si la pantalla no lo deja, Mapi tampoco.
 */

import { buscarDeportista, resumenDeportista, cartera, buscarAyuda } from './herramientas/consultas';
import { excusarAusencia, quitarExcusa } from './herramientas/excusas';
import { HERRAMIENTAS_PAGOS } from './herramientas/pagos';
import { HERRAMIENTAS_ENTRENADOR } from './herramientas/entrenador';
import { HERRAMIENTAS_ESCUELA } from './herramientas/escuela';
import { HERRAMIENTAS_INFORMES } from './herramientas/informes';
import { HERRAMIENTAS_OPERACION } from './herramientas/operacion';
import { enviarRecordatorioPago } from './herramientas/recordatorio';
import type { Alcance, Herramienta } from './tipos';

/**
 * Oleada 1. `enviar_recordatorio_pago` se ofrece solo con MAPI_RECORDATORIO_MANUAL=true:
 * registra notice_type='recordatorio_manual', que la base acepta desde la migración
 * 20261123120036. Orden: desplegar el BFF, aplicar esa migración y recién ahí prender
 * la variable. Prendida antes, cada envío choca con el CHECK y no sale nada.
 */
export const CATALOGO: Herramienta[] = [
    buscarDeportista,
    resumenDeportista,
    cartera,
    buscarAyuda,
    excusarAusencia,
    quitarExcusa,
    { ...enviarRecordatorioPago, habilitada: () => process.env.MAPI_RECORDATORIO_MANUAL === 'true' },
    // Oleadas 2–5 (2026-11-24). Cada módulo trae sus propios gates en `habilitada`:
    // las que mueven plata nacen apagadas por variable de entorno, y las que llaman
    // RPC con auth.uid() solo se ofrecen si el alcance trae la sesión.
    ...HERRAMIENTAS_PAGOS,
    ...HERRAMIENTAS_ENTRENADOR,
    ...HERRAMIENTAS_ESCUELA,
    ...HERRAMIENTAS_INFORMES,
    ...HERRAMIENTAS_OPERACION,
];

// Un nombre repetido haría que el modelo llame una y el servidor ejecute otra.
{
    const vistos = new Set<string>();
    for (const h of CATALOGO) {
        if (vistos.has(h.nombre)) throw new Error(`[mapi-agente] herramienta repetida en el catálogo: ${h.nombre}`);
        vistos.add(h.nombre);
    }
}

export function disponiblePara(h: Herramienta, a: Alcance): boolean {
    return h.roles.includes(a.rol) && (h.habilitada ? h.habilitada(a) : true);
}

export function herramientasPara(a: Alcance): Herramienta[] {
    return CATALOGO.filter((h) => disponiblePara(h, a));
}

/** La herramienta por nombre SOLO si este alcance la puede usar ahora. */
export function buscarHerramienta(nombre: string, a: Alcance): Herramienta | null {
    const h = CATALOGO.find((x) => x.nombre === nombre);
    return h && disponiblePara(h, a) ? h : null;
}

/**
 * Definiciones para la API. `strict: true` hace que la entrada del modelo
 * cumpla el esquema; el servidor igual valida (`validar`). Se puede apagar con
 * MAPI_AGENT_STRICT=false si la API rechazara algún esquema.
 */
/**
 * La API rechaza (400, «Enum value 'x' does not match declared type
 * ['string','null']») un `enum` con `type` en arreglo. Un enum que admite null
 * se manda como `anyOf: [{type:'string', enum:[…]}, {type:'null'}]`. Se hace
 * aquí para todas: hallado al medir el catálogo el 2026-11-24 (tres herramientas
 * lo traían y habrían tumbado cada turno del admin a modo soporte). Pura.
 */
export function normalizarEsquema<T>(nodo: T): T {
    if (Array.isArray(nodo)) return nodo.map(normalizarEsquema) as unknown as T;
    if (!nodo || typeof nodo !== 'object') return nodo;
    const o: Record<string, any> = {};
    for (const [k, v] of Object.entries(nodo as Record<string, unknown>)) o[k] = normalizarEsquema(v);
    if (Array.isArray(o.enum) && Array.isArray(o.type)) {
        const { type, enum: valores, description, ...resto } = o;
        const tipos = (type as string[]).filter((t) => t !== 'null');
        const noNulos = (valores as unknown[]).filter((v) => v !== null);
        const admiteNull = (type as string[]).includes('null') || (valores as unknown[]).includes(null);
        const base = { ...resto, type: tipos.length === 1 ? tipos[0] : tipos, enum: noNulos };
        return (admiteNull
            ? { ...(description ? { description } : {}), anyOf: [base, { type: 'null' }] }
            : { ...(description ? { description } : {}), ...base }) as unknown as T;
    }
    return o as T;
}

export function definicionesApi(hs: Herramienta[]): any[] {
    const strict = process.env.MAPI_AGENT_STRICT !== 'false';
    return hs.map((h) => ({
        name: h.nombre,
        description: h.descripcion,
        input_schema: normalizarEsquema(h.esquema),
        ...(strict ? { strict: true } : {}),
    }));
}
