/**
 * Aviso a la familia cuando el staff excusa desde Mapi. Decisión del usuario
 * (2026-11-23): «por todo medio».
 *
 *   · App: fila en `notifications` (service_role). El despachador unificado la
 *     convierte en push web/nativo; él solo hace push, no WhatsApp ni correo.
 *   · Correo: plantilla de marca de la escuela por Resend (emailClient).
 *   · WhatsApp: texto libre SOLO si la ventana de 24 h está abierta (la familia
 *     escribió en las últimas 24 h). Fuera de ella Meta exige una plantilla
 *     aprobada por escuela, que todavía no existe: queda 'ventana_cerrada'.
 *
 * Nunca bloquea ni deshace la excusa: es best-effort y el resultado de cada
 * canal queda en el `result` del borrador para auditoría.
 */

import { supabase } from '../../config/supabase';
import { emailClient } from '../../utils/emailClient';
import { buildBrandedEmail } from '../../utils/emailLayout';
import { resolveSchoolBranding, escapeHtml } from '../../utils/schoolBrandingResolver';
import { sendTextMessage } from '../whatsapp.service';
import { aWaId, ventanaAbierta } from '../whatsapp-plantillas.service';
import { appPublica } from '../../utils/url-publica-familias';
import type { Deportista } from './deportistas';
import { rangoLegible } from './fechas';

export type EstadoCanal = 'enviado' | 'sin_destinatario' | 'sin_dato' | 'ventana_cerrada' | 'sin_integracion' | 'fallo';
export interface ResultadoAvisoFamilia { app: EstadoCanal; correo: EstadoCanal; whatsapp: EstadoCanal }

const MOTIVO: Record<string, string> = {
    enfermedad: 'enfermedad', cita_medica: 'cita médica', viaje: 'viaje', lesion: 'lesión',
    colegio: 'compromiso del colegio', familiar: 'asunto familiar', otro: 'otro motivo',
};

export function textoAvisoExcusa(p: { nombre: string; escuela: string; desde: string; hasta: string; motivo: string | null }): string {
    const porque = p.motivo && MOTIVO[p.motivo] ? ` (${MOTIVO[p.motivo]})` : '';
    return `${p.escuela} registró la excusa de ${p.nombre} ${rangoLegible(p.desde, p.hasta)}${porque}. ` +
        'Esos días no cuentan como falta. Si no es correcto, responde a este mensaje o escríbele a la escuela.';
}

async function enviarWhatsApp(schoolId: string, telefono: string | null, texto: string): Promise<EstadoCanal> {
    const waId = aWaId(telefono);
    if (!waId) return 'sin_dato';
    const { data: integraciones } = await supabase.from('school_whatsapp_integrations')
        .select('id, school_id, waba_id, phone_number_id, access_token_encrypted, status')
        .eq('school_id', schoolId).eq('status', 'active');
    const activas = ((integraciones as any[]) ?? []).filter((i) => i.waba_id && i.access_token_encrypted);
    if (activas.length !== 1) return 'sin_integracion'; // ninguna o ambigua: no se adivina
    const { data: conv } = await supabase.from('whatsapp_conversations')
        .select('last_inbound_at').eq('integration_id', activas[0].id).eq('contact_wa_id', waId)
        .order('last_inbound_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    if (!ventanaAbierta((conv as any)?.last_inbound_at ?? null)) return 'ventana_cerrada';
    const r = await sendTextMessage(activas[0], waId, texto);
    return r.ok ? 'enviado' : 'fallo';
}

export async function avisarFamiliaExcusa(p: {
    schoolId: string; deportista: Deportista; desde: string; hasta: string; motivo: string | null;
}): Promise<ResultadoAvisoFamilia> {
    const destinatario = p.deportista.tipo === 'child' ? p.deportista.parentId : p.deportista.tipo === 'adult' ? p.deportista.userId : null;
    if (!destinatario) return { app: 'sin_destinatario', correo: 'sin_destinatario', whatsapp: 'sin_destinatario' };

    const [{ data: perfil }, { data: escuela }] = await Promise.all([
        supabase.from('profiles').select('full_name, email, phone').eq('id', destinatario).maybeSingle(),
        supabase.from('schools').select('name').eq('id', p.schoolId).maybeSingle(),
    ]);
    const nombreEscuela = String((escuela as any)?.name || 'Tu escuela').replace(/&amp;/g, '&');
    const texto = textoAvisoExcusa({ nombre: p.deportista.nombre, escuela: nombreEscuela, desde: p.desde, hasta: p.hasta, motivo: p.motivo });

    const app = (async (): Promise<EstadoCanal> => {
        const { error } = await supabase.from('notifications').insert({
            user_id: destinatario,
            school_id: p.schoolId,
            title: `Excusa registrada: ${p.deportista.nombre}`,
            message: texto,
            type: 'info',
            category: 'calendar',
            link: '/calendar',
            data: { origen: 'mapi_excusa', deportista: p.deportista.clave, desde: p.desde, hasta: p.hasta, motivo: p.motivo },
        });
        return error ? 'fallo' : 'enviado';
    })();

    const correo = (async (): Promise<EstadoCanal> => {
        const email = (perfil as any)?.email;
        if (!email) return 'sin_dato';
        const branding = await resolveSchoolBranding(p.schoolId);
        const html = buildBrandedEmail({
            branding,
            title: 'Excusa registrada',
            greeting: `Hola ${escapeHtml(String((perfil as any)?.full_name || ''))},`.replace(' ,', ','),
            bodyHtml: `<p>${escapeHtml(texto)}</p>`,
            cta: { label: 'Ver calendario', url: `${appPublica()}/calendar` },
        });
        const r = await emailClient.send({ to: email, subject: `Excusa registrada: ${p.deportista.nombre}`, html });
        return r?.success ? 'enviado' : 'fallo';
    })();

    const whatsapp = enviarWhatsApp(p.schoolId, (perfil as any)?.phone ?? null, texto);

    const [rApp, rCorreo, rWa] = await Promise.allSettled([app, correo, whatsapp]);
    const valor = (r: PromiseSettledResult<EstadoCanal>): EstadoCanal => (r.status === 'fulfilled' ? r.value : 'fallo');
    return { app: valor(rApp), correo: valor(rCorreo), whatsapp: valor(rWa) };
}
