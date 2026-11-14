/**
 * Cortesía «semana por la app» (ajuste `wa_modo_cortesia = 'semana_app'`,
 * spec docs/specs/whatsapp-ajustes-por-escuela.md).
 *
 * Besser no agenda clases de prueba sueltas: el deportista nuevo entra a la app
 * por un enlace de inscripción SIN cobro inicial y entrena una semana; después
 * la escuela le pone plan y mensualidad. El bot le manda el paso a paso con ese
 * enlace y los horarios reales de los equipos.
 *
 * DETERMINISTA: el texto sale de la base (QR, equipos, dirección); el modelo no
 * redacta horarios ni promete gratuidad.
 *
 * El QR se valida en cada uso (misma escuela, activo, sin vencer y SIN cobro
 * inicial). Si no pasa, `mensajeSemanaDeCortesia` devuelve null y quien llama
 * sigue con el comportamiento de siempre: nunca se manda un enlace que cobra
 * diciendo que es gratis.
 */
import { supabase } from '../config/supabase';
import { conMarca, sufijoMarcaEscuela } from '../utils/tenantLink';
import type { AjustesWhatsAppEscuela } from './whatsapp-ajustes-escuela.service';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.sportmaps.co';
const DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export interface QrDeCortesia {
    id: string;
    school_id: string;
    slug: string | null;
    active: boolean;
    expires_at: string | null;
    require_first_payment: boolean;
}

/** ¿Este QR sirve como enlace de cortesía para esta escuela? */
export function qrSirveParaCortesia(qr: QrDeCortesia | null | undefined, schoolId: string, ahora = new Date()): boolean {
    if (!qr || !qr.slug) return false;
    if (qr.school_id !== schoolId) return false;
    if (!qr.active) return false;
    if (qr.expires_at && new Date(qr.expires_at).getTime() <= ahora.getTime()) return false;
    // Un QR que cobra la mensualidad al registrarse NO es una cortesía.
    if (qr.require_first_payment) return false;
    return true;
}

/** '16:00' | '16:00:00' → '4:00 pm'. */
export function horaLegible(h: string): string {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(h ?? '').trim());
    if (!m) return String(h ?? '');
    const hh = Number(m[1]);
    const sufijo = hh >= 12 ? 'pm' : 'am';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${m[2]} ${sufijo}`;
}

/** [2,3,4,5] → 'martes a viernes'; [2,4] → 'martes y jueves'; [1,3,5] → 'lunes, miércoles y viernes'. */
export function diasLegibles(dias: number[]): string {
    const orden = (d: number) => (d === 0 ? 7 : d); // la semana colombiana empieza el lunes
    const lista = [...new Set(dias.filter((d) => d >= 0 && d <= 6))].sort((a, b) => orden(a) - orden(b));
    if (!lista.length) return '';
    const consecutivos = lista.every((d, i) => i === 0 || orden(d) === orden(lista[i - 1]) + 1);
    if (lista.length >= 3 && consecutivos) return `${DIA[lista[0]]} a ${DIA[lista[lista.length - 1]]}`;
    if (lista.length === 1) return DIA[lista[0]];
    return `${lista.slice(0, -1).map((d) => DIA[d]).join(', ')} y ${DIA[lista[lista.length - 1]]}`;
}

export interface EquipoConHorario { name: string | null; schedule: unknown }

interface Franja { day: number; time: string; end: string | null; place: string | null }

function franjasDe(schedule: unknown): Franja[] {
    let crudo: unknown = schedule;
    if (typeof crudo === 'string') {
        try { crudo = JSON.parse(crudo); } catch { return []; }
    }
    if (!Array.isArray(crudo)) return [];
    return crudo
        .filter((f: any) => f && typeof f.day === 'number' && typeof f.time === 'string' && f.time)
        .map((f: any) => ({
            day: f.day,
            time: f.time,
            end: typeof f.end === 'string' && f.end ? f.end : null,
            place: typeof f.place === 'string' && f.place.trim() ? f.place.trim() : null,
        }));
}

/**
 * Bloque de horarios para el prospecto. Si todos los equipos entrenan a la
 * misma hora y en el mismo lugar (Besser), un encabezado y los días por
 * categoría; si no, cada categoría con su día y hora. null = ningún equipo
 * tiene horario cargado.
 */
export function bloqueDeHorarios(equipos: EquipoConHorario[]): string | null {
    const conFranjas = equipos
        .map((e) => ({ nombre: String(e.name ?? '').trim(), franjas: franjasDe(e.schedule) }))
        .filter((e) => e.nombre && e.franjas.length);
    if (!conFranjas.length) return null;

    const todas = conFranjas.flatMap((e) => e.franjas);
    const firma = (f: Franja) => `${f.time}|${f.end ?? ''}|${f.place ?? ''}`;
    const unaSola = new Set(todas.map(firma)).size === 1;

    if (unaSola) {
        const f = todas[0];
        const hora = f.end ? `de *${horaLegible(f.time)} a ${horaLegible(f.end)}*` : `desde las *${horaLegible(f.time)}*`;
        const lugar = f.place ? ` en *${f.place}*` : '';
        const lineas = conFranjas.map((e) => `• ${e.nombre}: ${diasLegibles(e.franjas.map((x) => x.day))}`);
        return `🕓 Entrenamos ${hora}${lugar}:\n${lineas.join('\n')}`;
    }

    const lineas = conFranjas.map((e) => {
        const porHora = new Map<string, Franja[]>();
        for (const f of e.franjas) porHora.set(firma(f), [...(porHora.get(firma(f)) ?? []), f]);
        const partes = [...porHora.values()].map((grupo) => {
            const f = grupo[0];
            const hora = f.end ? `${horaLegible(f.time)} a ${horaLegible(f.end)}` : horaLegible(f.time);
            return `${diasLegibles(grupo.map((x) => x.day))} ${hora}${f.place ? ` (${f.place})` : ''}`;
        });
        return `• ${e.nombre}: ${partes.join(' · ')}`;
    });
    return `🕓 Horarios por categoría:\n${lineas.join('\n')}`;
}

export function textoDeLaCortesia(dias: number): string {
    if (dias === 7) return 'una semana';
    if (dias === 14) return 'dos semanas';
    return dias === 1 ? '1 día' : `${dias} días`;
}

/** El paso a paso. Los nombres de los botones son los de /join/:slug. */
export function textoSemanaDeCortesia(p: {
    enlace: string; dias: number; horarios: string | null;
    /** false = la escuela cobra la clase de prueba (`trial_price > 0`): nunca «gratis» (B3). */
    gratis?: boolean;
}): string {
    const periodo = textoDeLaCortesia(p.dias);
    return [
        p.gratis === false ? `¡Tu hijo/a puede entrenar *durante ${periodo}* para conocernos! 🙌`
            : `¡Tu hijo/a puede entrenar *gratis durante ${periodo}*! 🙌`,
        '',
        'Así lo inscribes en la app para tomar la cortesía:',
        `1️⃣ Abre este enlace: ${p.enlace}`,
        '2️⃣ Toca *«Inscribir a un menor de edad»* y luego *«Mi hijo/a no está registrado aún»*.',
        '3️⃣ Elige su *categoría* y toca *«Continuar»*.',
        '4️⃣ Toca *«Soy nuevo»* y crea tu cuenta: tu nombre, tu WhatsApp, tu correo y una contraseña.',
        '5️⃣ Llena los datos del deportista: nombre, fecha de nacimiento y documento.',
        '✅ ¡Listo! Ya puede venir a entrenar.',
        ...(p.horarios ? ['', p.horarios] : []),
        '',
        `Al terminar ${periodo === 'una semana' ? 'la semana' : 'la cortesía'}, la escuela te confirma el plan y la mensualidad. ` +
            'Si tienes alguna duda, escríbela por aquí.',
    ].join('\n');
}

/** El enlace de cortesía de la escuela, o null si el QR configurado no sirve. Nunca lanza. */
export async function enlaceDeCortesia(schoolId: string, qrId: string | null): Promise<string | null> {
    if (!qrId) return null;
    try {
        const { data, error } = await supabase
            .from('school_join_qr_codes')
            .select('id, school_id, slug, active, expires_at, require_first_payment')
            .eq('id', qrId)
            .maybeSingle();
        if (error || !qrSirveParaCortesia(data as QrDeCortesia | null, schoolId)) {
            console.warn('[whatsapp-cortesia-semana] el QR de cortesía no sirve; se responde como antes',
                { schoolId, qrId, error: error?.message });
            return null;
        }
        const marca = await sufijoMarcaEscuela(schoolId);
        return conMarca(`${FRONTEND_URL.replace(/\/$/, '')}/join/${(data as QrDeCortesia).slug}`, marca);
    } catch {
        return null;
    }
}

/**
 * El mensaje completo de la semana de cortesía, o null si no aplica (modo
 * 'clase' o QR que no sirve). Nunca lanza.
 */
export async function mensajeSemanaDeCortesia(
    schoolId: string,
    ajustes: Pick<AjustesWhatsAppEscuela, 'modoCortesia' | 'cortesiaQrId' | 'cortesiaDias'>,
): Promise<string | null> {
    if (ajustes.modoCortesia !== 'semana_app') return null;
    const enlace = await enlaceDeCortesia(schoolId, ajustes.cortesiaQrId);
    if (!enlace) return null;
    let horarios: string | null = null;
    try {
        const { data } = await supabase
            .from('teams')
            .select('name, schedule')
            .eq('school_id', schoolId)
            .eq('active', true)
            .order('name', { ascending: true });
        horarios = bloqueDeHorarios((data ?? []) as EquipoConHorario[]);
    } catch {
        horarios = null;
    }
    // Con valor de la clase de prueba (B3) no se dice «gratis»; sin ajustes, el texto de siempre.
    const { textosClaseDeEscuela } = await import('./textos-clase-prueba');
    const t = await textosClaseDeEscuela(schoolId);
    return textoSemanaDeCortesia({ enlace, dias: ajustes.cortesiaDias, horarios, gratis: t.gratis });
}
