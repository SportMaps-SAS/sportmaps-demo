/**
 * wa-afiliado — ¿quien escribe es familia del club? Solo para PRECIO y SALUDO.
 *
 * Por qué existe (Monster 2026-10-30, plan maestro §2 M2): 145 de los 148
 * deportistas activos de Monster son `unregistered_athletes` sin cuenta. El bot
 * los trataba como desconocidos y no les podía dar el precio de afiliado de la
 * clínica ($250.000 en vez de $300.000) ni del vacacional. La RPC
 * `wa_es_afiliado(p_school_id, p_telefono)` (solo service_role) los reconoce por
 * el celular en cuentas, `children.parent_phone_temp` y `unregistered_athletes`, y
 * devuelve `{afiliado, fuente}` (20261030123549). Si algún día trae el nombre para
 * saludar, se lee de `nombre` / `primer_nombre`.
 *
 * Regla: el resultado sirve para elegir el precio y para saludar por el primer
 * nombre. Nunca se le muestra a nadie un dato privado (ni deportistas, ni
 * documentos, ni quién más tiene ese número). El precio que se COBRA lo decide la
 * base (`wa_crear_cobro_desde_comprobante` recibe el teléfono y vuelve a mirar).
 *
 * Nada lanza. Sin la RPC (migración sin aplicar) → no afiliado: el precio de
 * lista, que es lo que se cobra hoy.
 */
import { supabase } from '../config/supabase';
import { esMigracionPendiente } from './ventas-servicios.service';

export interface Afiliacion {
    afiliado: boolean;
    /** Solo el primer nombre, para saludar. null si no se sabe. */
    nombre: string | null;
}

export const NO_AFILIADO: Afiliacion = { afiliado: false, nombre: null };

/**
 * La respuesta de la RPC → Afiliacion. Acepta `true`, `{afiliado}` o
 * `{es_afiliado}`; del nombre se queda con la primera palabra. Pura.
 */
export function afiliacionDesdeRespuesta(data: unknown): Afiliacion {
    if (data === true) return { afiliado: true, nombre: null };
    if (!data || typeof data !== 'object') return NO_AFILIADO;
    const d = data as Record<string, unknown>;
    const afiliado = d.afiliado === true || d.es_afiliado === true;
    if (!afiliado) return NO_AFILIADO;
    const crudo = [d.nombre, d.primer_nombre].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    const nombre = crudo ? crudo.trim().split(/\s+/)[0].slice(0, 40) : null;
    return { afiliado: true, nombre };
}

/** ¿El celular es de una familia de la escuela? Nunca lanza. */
export async function esAfiliado(schoolId: string, telefono: string | null | undefined): Promise<Afiliacion> {
    const tel = String(telefono ?? '').replace(/\D/g, '');
    if (!schoolId || tel.length < 10) return NO_AFILIADO;
    try {
        const { data, error } = await supabase.rpc('wa_es_afiliado', { p_school_id: schoolId, p_telefono: tel });
        if (error) {
            if (!esMigracionPendiente(error)) {
                console.warn('[wa-afiliado] la RPC falló', { schoolId, code: error.code, msg: error.message });
            }
            return NO_AFILIADO;
        }
        return afiliacionDesdeRespuesta(data);
    } catch (e: any) {
        console.warn('[wa-afiliado] la RPC lanzó', { schoolId, error: e?.message });
        return NO_AFILIADO;
    }
}
