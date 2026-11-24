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
];

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
export function definicionesApi(hs: Herramienta[]): any[] {
    const strict = process.env.MAPI_AGENT_STRICT !== 'false';
    return hs.map((h) => ({
        name: h.nombre,
        description: h.descripcion,
        input_schema: h.esquema,
        ...(strict ? { strict: true } : {}),
    }));
}
