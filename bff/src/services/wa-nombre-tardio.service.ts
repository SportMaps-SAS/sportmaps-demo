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
import { esNombreDeRelleno } from './wa-cobro-desde-comprobante.service';

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
}

/**
 * Guarda el nombre tardío si corresponde. `null` = no corresponde (nada se tocó). Nunca lanza; ante un fallo de
 * escritura devuelve null SIN haber prometido nada (quien llama no responde).
 */
export async function registrarNombreTardio(i: {
    integrationId: string; schoolId: string; contactWaId: string; texto: string; ahora?: number;
}): Promise<NombreTardioGuardado | null> {
    const dicho = nombreYAcompanante(i.texto);
    if (!dicho) return null;
    const ahora = i.ahora ?? Date.now();
    try {
        const { data: filas } = await supabase.from('whatsapp_inbound_queue')
            .select('id, result_ref_id')
            .eq('integration_id', i.integrationId).eq('wa_phone_number', i.contactWaId)
            .eq('status', 'done').eq('result_type', 'payment_receipt')
            .gte('created_at', new Date(ahora - HORAS_NOMBRE_TARDIO * 3600_000).toISOString())
            .order('created_at', { ascending: false }).limit(5);
        const ids = ((Array.isArray(filas) ? filas : []) as any[]).map((f) => f.result_ref_id).filter(Boolean);
        if (!ids.length) return null;

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
        if (!pago || !partesDelConcepto(pago.concept).servicio) return null;
        if (normalizarFrase(partesDelConcepto(pago.concept).nombre) === normalizarFrase(dicho.nombre)) return null;

        const { data: lead } = await supabase.from('school_signup_leads')
            .select('id, full_name, source_detail').eq('school_id', i.schoolId).eq('id', pago.signup_lead_id).maybeSingle();
        if (!(lead as any)?.id) return null;
        const sd = (((lead as any).source_detail && typeof (lead as any).source_detail === 'object') ? (lead as any).source_detail : {}) as Record<string, any>;
        const actual = String((lead as any).full_name ?? '').trim();
        const iso = new Date(ahora).toISOString();
        const { error: eLead } = await supabase.from('school_signup_leads').update({
            full_name: dicho.nombre,
            source_detail: {
                ...sd,
                ...(actual && normalizarFrase(actual) !== normalizarFrase(dicho.nombre) && !sd.contacto ? { contacto: actual } : {}),
                asistente_servicio: { ...(sd.asistente_servicio ?? {}), nombre: dicho.nombre, at: iso, tardio: true },
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

/** Lo que se le dice cuando YA se guardó. Pura. */
export function textoNombreTardioGuardado(g: Pick<NombreTardioGuardado, 'nombre' | 'acompanante'>): string {
    return `Gracias 🙏 Quedó registrado a nombre de *${g.nombre}*`
        + `${g.acompanante ? ` (acompañante: *${g.acompanante}*)` : ''}. La escuela te confirma el cupo por aquí.`;
}
