/**
 * wa-nombre-tardio — el nombre de quien asiste llega DESPUÉS del comprobante.
 *
 * Caso (Monster 2026-11-11, Aleja): mandó el comprobante, el cobro quedó con el nombre de su perfil de
 * WhatsApp («Clínica … — Aleja 💫») y la fila de la cola cerró como `payment_receipt` sin pasar por la pregunta
 * del nombre. Horas después escribió «María Alejandra Muñoz Hernández / Acompañante: Juan Sebastian Muñoz
 * Hernández»: no había ninguna fila `waiting_user` esperándolo, así que cayó al bot general y no se guardó
 * en ningún sitio.
 *
 * Regla: si llega un texto que `nombreDeAsistente` acepta, dentro de las 48 h de un comprobante cerrado
 * (`result_type = payment_receipt`, fila `done`) del MISMO contacto cuyo cobro tiene el concepto de relleno
 * (el nombre del perfil o ninguno), se actualiza el prospecto (`full_name`, `source_detail.asistente_servicio`
 * y `acompanante`) y el concepto del cobro — SIN tocar monto ni estado — y SOLO después de haberlo guardado se
 * responde. Si no hay un cobro reciente así, no hace nada y el texto sigue al bot general.
 *
 * Una lectura de la cola solo si el texto parece un nombre (el resto de los mensajes no cuesta nada).
 */
import { supabase } from '../config/supabase';
import { normalizarFrase } from './whatsapp-reglas-turno';
import { nombreDeAsistente } from './whatsapp-comprobante-de-ficha.service';
import { esNombreDeRelleno, hoyBogota } from './wa-cobro-desde-comprobante.service';
import { leerDatosDeRegistro, type DatoFaltante } from './whatsapp-datos-de-registro';
import { camposDeRegistro, faltantesDe, pedidoDeFaltantes, registroDeFicha, resumenDeAsistente, traeOtroDato } from './wa-registro-de-venta.service';
import { unirDatosDeRegistro } from './whatsapp-datos-de-registro';

/** Ventana desde el comprobante cerrado. */
export const HORAS_NOMBRE_TARDIO = 48;

const SEPARADOR = ' — ';

/** «Acompañante: Juan Sebastian Muñoz Hernández» → el nombre; null si no viene o no es un nombre. Pura. */
export function acompananteDelTexto(texto: string): string | null {
    const m = String(texto ?? '').match(/acompa[ñn]ante\s*:\s*([^\n\r]+)/i);
    return m ? nombreDeAsistente(m[1]) : null;
}

/** El nombre de quien asiste y, si lo trae, el acompañante. El texto sin la línea del acompañante. Pura. */
export function nombreYAcompanante(texto: string): { nombre: string; acompanante: string | null } | null {
    const t = String(texto ?? '');
    const sinAcomp = t.replace(/acompa[ñn]ante\s*:[^\n\r]*/gi, '');
    const primera = sinAcomp.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
    const nombre = nombreDeAsistente(primera);
    return nombre ? { nombre, acompanante: acompananteDelTexto(t) } : null;
}

/** El concepto del cobro dividido en servicio y nombre («Clínica … — Aleja 💫»). Pura. */
export function partesDelConcepto(concepto: string | null | undefined): { servicio: string; nombre: string } {
    const c = String(concepto ?? '').trim();
    const i = c.lastIndexOf(SEPARADOR);
    return i < 0 ? { servicio: c, nombre: '' } : { servicio: c.slice(0, i).trim(), nombre: c.slice(i + SEPARADOR.length).trim() };
}

export interface NombreTardioGuardado {
    nombre: string;
    acompanante: string | null;
    paymentId: string;
    servicio: string;
    /** (2026-11-16) No llegó un nombre sino la fecha de nacimiento o el acudiente de quien ya estaba registrado. */
    soloDatos?: boolean;
    /** Lo que sigue faltando para completar la inscripción. */
    faltan?: DatoFaltante[];
    /** (2026-11-18) Los datos se adjuntaron a un comprobante de venta que la cola escaló (no hay cobro ni ficha todavía). */
    aComprobanteEscalado?: boolean;
}

/**
 * Guarda el nombre tardío si corresponde. `null` = no corresponde (nada se tocó). Nunca lanza; ante un fallo de
 * escritura devuelve null SIN haber prometido nada (quien llama no responde).
 */
export async function registrarNombreTardio(i: {
    integrationId: string; schoolId: string; contactWaId: string; texto: string; ahora?: number;
}): Promise<NombreTardioGuardado | null> {
    const ahora = i.ahora ?? Date.now();
    const hoy = hoyBogota(ahora);
    const dicho = nombreYAcompanante(i.texto);
    // (2026-11-16) También llegan tarde la fecha de nacimiento y la persona responsable (se piden con el comprobante).
    const datos = leerDatosDeRegistro(i.texto, { hoy, fuente: 'chat' });
    if (!dicho) {
        if (!datos.fechaNacimiento && !datos.acudiente) return null;
        return registrarDatosTardios({ ...i, ahora }, { ...datos, nombre: null }, hoy);
    }
    try {
        const { data: filas } = await supabase.from('whatsapp_inbound_queue')
            .select('id, result_ref_id')
            .eq('integration_id', i.integrationId).eq('wa_phone_number', i.contactWaId)
            .eq('status', 'done').eq('result_type', 'payment_receipt')
            .gte('created_at', new Date(ahora - HORAS_NOMBRE_TARDIO * 3600_000).toISOString())
            .order('created_at', { ascending: false }).limit(5);
        const ids = ((Array.isArray(filas) ? filas : []) as any[]).map((f) => f.result_ref_id).filter(Boolean);
        // (2026-11-18) Sin comprobante cerrado con cobro: ¿el comprobante de una venta quedó ESCALADO a la escuela?
        if (!ids.length) return adjuntarAComprobanteEscalado(i, dicho, datos, hoy, ahora);

        const [{ data: pagos }, { data: conv }] = await Promise.all([
            supabase.from('payments').select('id, concept, signup_lead_id, school_id')
                .eq('school_id', i.schoolId).in('id', ids).not('signup_lead_id', 'is', null),
            supabase.from('whatsapp_conversations').select('contact_name')
                .eq('integration_id', i.integrationId).eq('contact_wa_id', i.contactWaId).maybeSingle(),
        ]);
        const perfil = ((conv as any)?.contact_name as string | undefined) ?? null;
        // El más reciente de los cobros cuyo concepto es de relleno (el orden de `ids` es el de la cola).
        const porId = new Map(((pagos ?? []) as any[]).map((p) => [String(p.id), p]));
        const pago = ids.map((id) => porId.get(String(id))).find((p) => p && esNombreDeRelleno(partesDelConcepto(p.concept).nombre, perfil));
        if (!pago || !partesDelConcepto(pago.concept).servicio) return adjuntarAComprobanteEscalado(i, dicho, datos, hoy, ahora);
        if (normalizarFrase(partesDelConcepto(pago.concept).nombre) === normalizarFrase(dicho.nombre)) return null;

        const { data: lead } = await supabase.from('school_signup_leads')
            .select('id, full_name, source_detail').eq('school_id', i.schoolId).eq('id', pago.signup_lead_id).maybeSingle();
        if (!(lead as any)?.id) return null;
        const sd = (((lead as any).source_detail && typeof (lead as any).source_detail === 'object') ? (lead as any).source_detail : {}) as Record<string, any>;
        const actual = String((lead as any).full_name ?? '').trim();
        const iso = new Date(ahora).toISOString();
        // La fecha, el acudiente o la posición que vinieron con el nombre también quedan en la ficha.
        const conNombre = { ...datos, nombre: dicho.nombre };
        const extra = traeOtroDato(conNombre)
            ? camposDeRegistro({ source_detail: sd }, conNombre, { servicioId: String(sd.asistente_servicio?.servicio_id ?? ''), ahora: iso, hoy })
            : null;
        const { source_detail: sdExtra, ...columnas } = extra ?? { source_detail: null };
        const { error: eLead } = await supabase.from('school_signup_leads').update({
            full_name: dicho.nombre,
            ...columnas,
            source_detail: {
                ...sd,
                ...(actual && normalizarFrase(actual) !== normalizarFrase(dicho.nombre) && !sd.contacto ? { contacto: actual } : {}),
                asistente_servicio: {
                    ...(sd.asistente_servicio ?? {}), ...(((sdExtra as any)?.asistente_servicio ?? {}) as Record<string, unknown>),
                    ...(sd.asistente_servicio?.servicio_id ? { servicio_id: sd.asistente_servicio.servicio_id } : {}),
                    nombre: dicho.nombre, at: iso, tardio: true,
                },
                ...(dicho.acompanante ? { acompanante: dicho.acompanante } : {}),
            },
            updated_at: iso,
        }).eq('id', (lead as any).id);
        if (eLead) {
            console.warn('[wa-nombre-tardio] no se pudo actualizar el prospecto', { leadId: (lead as any).id, msg: eLead.message });
            return null;
        }
        const { servicio } = partesDelConcepto(pago.concept);
        // Solo el concepto: ni el monto ni el estado.
        const { error: ePago } = await supabase.from('payments')
            .update({ concept: `${servicio}${SEPARADOR}${dicho.nombre}`.slice(0, 200) })
            .eq('school_id', i.schoolId).eq('id', pago.id);
        if (ePago) {
            console.warn('[wa-nombre-tardio] no se pudo actualizar el concepto', { paymentId: pago.id, msg: ePago.message });
            return null;
        }
        return { nombre: dicho.nombre, acompanante: dicho.acompanante, paymentId: String(pago.id), servicio };
    } catch {
        return null;
    }
}

/** Ventana para adjuntar los datos a un comprobante escalado. */
export const HORAS_DATOS_A_COMPROBANTE_ESCALADO = 48;
const MAX_ERROR_MESSAGE = 1500;

/**
 * (2026-11-18, Monster, María José Zabala) El comprobante de una VENTA (vacacional, clínica…) no cuadró y la cola lo
 * escaló a «Por clasificar» (`ignored / escalated / venta_*`, sin cobro ni ficha todavía, «asiste: sin nombre»). Minutos
 * después la clienta mandó el texto con quien asiste, la fecha de nacimiento y las semanas, tal como se le pidió, y no
 * había ninguna fila a la que pegarlo: cayó al bot general sin respuesta y la escuela tuvo que unirlo a mano.
 *
 * Se adjunta a ESA fila, con lo que ya existe: `pregunta_ocr.datos_tardios` (jsonb, junto a las huellas del comprobante) y
 * el `error_message` que la bandeja muestra (se le agrega la línea «Datos que llegaron después…»). No toca montos, cobros
 * ni estado: la escuela decide. null = no corresponde o no se pudo guardar (no se promete nada). Nunca lanza.
 */
async function adjuntarAComprobanteEscalado(
    i: { integrationId: string; contactWaId: string; texto: string },
    dicho: { nombre: string; acompanante: string | null },
    datos: ReturnType<typeof leerDatosDeRegistro>, hoy: string, ahora: number,
): Promise<NombreTardioGuardado | null> {
    try {
        const { data: filas } = await supabase.from('whatsapp_inbound_queue')
            .select('id, error_message, pregunta_ocr, created_at')
            .eq('integration_id', i.integrationId).eq('wa_phone_number', i.contactWaId)
            .eq('status', 'ignored').eq('result_type', 'escalated')
            .gte('created_at', new Date(ahora - HORAS_DATOS_A_COMPROBANTE_ESCALADO * 3600_000).toISOString())
            .order('created_at', { ascending: false }).limit(5);
        const fila = ((Array.isArray(filas) ? filas : []) as any[])
            .find((f) => String(f.error_message ?? '').startsWith('venta_'));
        if (!fila) return null;
        const previo = (fila.pregunta_ocr && typeof fila.pregunta_ocr === 'object' ? fila.pregunta_ocr : {}) as Record<string, any>;
        // El mismo texto otra vez (o el mismo nombre ya adjunto): no se duplica ni se vuelve a acusar.
        if (previo.datos_tardios && normalizarFrase(String(previo.datos_tardios.nombre ?? '')) === normalizarFrase(dicho.nombre)
            && normalizarFrase(String(previo.datos_tardios.texto ?? '')) === normalizarFrase(String(i.texto ?? '').slice(0, 400))) return null;

        const registro = { ...datos, nombre: dicho.nombre };
        const resumen = resumenDeAsistente(registro, hoy);
        const iso = new Date(ahora).toISOString();
        const dijo = String(i.texto ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 400);
        const linea = `Datos que llegaron después del comprobante → asiste: ${resumen}`
            + `${dicho.acompanante ? ` · acompañante: ${dicho.acompanante}` : ''} · dijo: «${dijo}»`;
        const motivo = String(fila.error_message ?? '').replace(/ \| Datos que llegaron después del comprobante.*$/s, '');
        const { error } = await supabase.from('whatsapp_inbound_queue').update({
            error_message: `${motivo} | ${linea}`.slice(0, MAX_ERROR_MESSAGE),
            pregunta_ocr: {
                ...previo,
                datos_tardios: {
                    nombre: dicho.nombre, acompanante: dicho.acompanante, fecha_nacimiento: datos.fechaNacimiento,
                    acudiente: datos.acudiente, texto: String(i.texto ?? '').slice(0, 400), at: iso,
                },
            },
        }).eq('id', fila.id).eq('integration_id', i.integrationId);
        if (error) {
            console.warn('[wa-nombre-tardio] no se pudieron adjuntar los datos al comprobante escalado', { queueId: fila.id, msg: error.message });
            return null;
        }
        return {
            nombre: dicho.nombre, acompanante: dicho.acompanante, paymentId: '', servicio: '',
            aComprobanteEscalado: true, faltan: faltantesDe(registro, hoy),
        };
    } catch {
        return null;
    }
}

/**
 * La fecha de nacimiento o la persona responsable llegan DESPUÉS del comprobante, sin nombre: se guardan en la
 * ficha del prospecto del cobro más reciente (48 h) SOLO si esa ficha ya tiene a quien asiste; el cobro no se toca.
 * null = no corresponde (nada se tocó). Nunca lanza.
 */
async function registrarDatosTardios(
    i: { integrationId: string; schoolId: string; contactWaId: string; ahora: number },
    datos: ReturnType<typeof leerDatosDeRegistro>, hoy: string,
): Promise<NombreTardioGuardado | null> {
    try {
        const { data: filas } = await supabase.from('whatsapp_inbound_queue')
            .select('id, result_ref_id')
            .eq('integration_id', i.integrationId).eq('wa_phone_number', i.contactWaId)
            .eq('status', 'done').eq('result_type', 'payment_receipt')
            .gte('created_at', new Date(i.ahora - HORAS_NOMBRE_TARDIO * 3600_000).toISOString())
            .order('created_at', { ascending: false }).limit(5);
        const ids = ((Array.isArray(filas) ? filas : []) as any[]).map((f) => f.result_ref_id).filter(Boolean);
        if (!ids.length) return null;
        const { data: pagos } = await supabase.from('payments').select('id, concept, signup_lead_id, school_id')
            .eq('school_id', i.schoolId).in('id', ids).not('signup_lead_id', 'is', null);
        const porId = new Map(((pagos ?? []) as any[]).map((p) => [String(p.id), p]));
        const pago = ids.map((id) => porId.get(String(id))).find(Boolean);
        if (!pago) return null;
        const { data: lead } = await supabase.from('school_signup_leads')
            .select('id, full_name, birth_date, guardian_name, respuestas, source_detail')
            .eq('school_id', i.schoolId).eq('id', pago.signup_lead_id).maybeSingle();
        const l = lead as any;
        const nombre = typeof l?.source_detail?.asistente_servicio?.nombre === 'string' ? String(l.full_name ?? '').trim() : '';
        if (!l?.id || !nombre) return null;
        const previo = registroDeFicha(l, { hoy, conocido: true });
        const total = unirDatosDeRegistro({ ...datos, nombre: null }, previo);
        const iso = new Date(i.ahora).toISOString();
        const { error } = await supabase.from('school_signup_leads').update({
            ...camposDeRegistro(l, total, { servicioId: String(l.source_detail?.asistente_servicio?.servicio_id ?? ''), ahora: iso, hoy }),
            updated_at: iso,
        }).eq('id', l.id);
        if (error) {
            console.warn('[wa-nombre-tardio] no se pudieron guardar los datos de registro', { leadId: l.id, msg: error.message });
            return null;
        }
        return {
            nombre, acompanante: null, paymentId: String(pago.id), servicio: partesDelConcepto(pago.concept).servicio,
            soloDatos: true, faltan: faltantesDe(total, hoy),
        };
    } catch {
        return null;
    }
}

/** Lo que se le dice cuando YA se guardó. Pura. */
export function textoNombreTardioGuardado(g: Pick<NombreTardioGuardado, 'nombre' | 'acompanante' | 'soloDatos' | 'faltan' | 'servicio' | 'aComprobanteEscalado'>): string {
    if (g.aComprobanteEscalado) {
        const pedido = pedidoDeFaltantes(g.faltan ?? [], null, 'el servicio');
        return `Recibí los datos de *${g.nombre}*${g.acompanante ? ` (acompañante: *${g.acompanante}*)` : ''} 🙏 `
            + `Ya se los pasé a la escuela junto con tu comprobante; ella confirma el cupo por aquí.${pedido ? ` ${pedido}` : ''}`;
    }
    if (g.soloDatos) {
        const pedido = pedidoDeFaltantes(g.faltan ?? [], null, g.servicio || 'el servicio');
        return pedido
            ? `Gracias 🙏 Guardé ese dato de *${g.nombre}*. ${pedido}`
            : `Gracias 🙏 Con eso quedan completos los datos de *${g.nombre}*. La escuela te confirma el cupo por aquí.`;
    }
    return `Gracias 🙏 Quedó registrado a nombre de *${g.nombre}*`
        + `${g.acompanante ? ` (acompañante: *${g.acompanante}*)` : ''}. La escuela te confirma el cupo por aquí.`;
}
