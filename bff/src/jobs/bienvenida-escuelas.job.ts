/**
 * bienvenida-escuelas.job — correo de bienvenida a cada escuela o entrenador
 * que se registra, y aviso interno a SportMaps.
 *
 * Por qué (2026-10-27): la bienvenida la mandaba el navegador desde
 * `AuthContext.signUp`, y solo si el registro era con correo + contraseña Y con
 * rol 'school'. No salía con Google, ni para entrenadores personales, ni si la
 * escuela se creaba después en el onboarding. Las dos altas reales del 26-oct
 * (un entrenador personal y una escuela de taekwondo que entró con Google) no
 * recibieron nada, y SportMaps se enteró mirando la tabla de admin.
 *
 * Este job observa el RESULTADO —la fila en `schools`— que es común a todos los
 * caminos de alta:
 *
 *   · Escuelas reales (`account_type = 'real'`, no demo) creadas en las últimas
 *     VENTANA_HORAS. La ventana es el freno contra un envío masivo a escuelas
 *     viejas si algún día se borra el log.
 *   · Un correo al dueño con la plantilla de su tipo (escuela o entrenador
 *     personal). Responder llega a contacto@sportmaps.co.
 *   · Un aviso interno a contacto@ con los datos para llamarlo.
 *
 * Idempotencia entre los 3 BFF: `enviarConReserva` (avisos-correo.service)
 * reserva en `email_sends` con un id derivado de `welcome_school:<school_id>`;
 * el PK hace de candado. Si Resend falla, la fila queda 'failed' y NO se
 * reintenta (mejor un correo menos que una bienvenida repetida): el aviso
 * interno dice que falló para que alguien lo contacte a mano.
 */

import { supabase } from '../config/supabase';
import { correosDeSoporte, enviarConReserva, escaparHtml, horaColombia, uuidDeClave } from '../services/avisos-correo.service';

export const VENTANA_HORAS = 72;
export const TIPO_BIENVENIDA = 'welcome_school';
export const TIPO_AVISO_INTERNO = 'alta_escuela_aviso';
const LIMITE = 50;
const WHATSAPP = '573202683539';
const WHATSAPP_VISIBLE = '+57 320 268 3539';
const LOGO = 'https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/public/avatars/correo/logo-sportmaps.png';

const appUrl = () => (process.env.FRONTEND_URL || 'https://app.sportmaps.co').replace(/\/$/, '');
const buzon = () => correosDeSoporte()[0] || 'contacto@sportmaps.co';

export const claveBienvenida = (schoolId: string) => `${TIPO_BIENVENIDA}:${schoolId}`;
export const claveAvisoInterno = (schoolId: string) => `${TIPO_AVISO_INTERNO}:${schoolId}`;

export interface Alta {
    schoolId: string;
    escuela: string;
    tipoEscuela: string | null;
    ciudad: string | null;
    creada: string;
    nombreDueno: string | null;
    correo: string | null;
    telefono: string | null;
}

export const esEntrenadorPersonal = (tipo: string | null) => tipo === 'personal_trainer';

/**
 * «Hola Cristian:» si el nombre parece de persona (dos palabras o más, antes de
 * un « - »); si no —«Tkdsantalucia», o el nombre de la escuela repetido—,
 * «Hola, equipo de <escuela>:». Pura.
 */
export function saludo(nombre: string | null, escuela: string): string {
    const base = (nombre ?? '').split(' - ')[0].trim();
    const palabras = base.split(/\s+/).filter(Boolean);
    if (palabras.length >= 2 && !/\d/.test(palabras[0])) {
        const p = palabras[0];
        return `Hola ${p.charAt(0).toUpperCase()}${p.slice(1).toLowerCase()}:`;
    }
    return `Hola, equipo de ${escuela.trim()}:`;
}

/** Firma del equipo: mismo diseño que la del CEO (docs/alianzas/firma-sportmaps.png), en HTML. */
export function firmaEquipo(): string {
    return `
<table cellpadding="0" cellspacing="0" style="margin-top:28px;border-collapse:collapse;text-align:left;">
  <tr>
    <td style="padding-right:16px;vertical-align:middle;"><img src="${LOGO}" alt="SportMaps" width="96" style="display:block;width:96px;height:auto;"></td>
    <td style="border-left:3px solid #FB9F1E;padding-left:16px;vertical-align:middle;font-family:'Poppins',Arial,sans-serif;">
      <div style="font-size:16px;font-weight:700;color:#1f1f1f;">Equipo SportMaps</div>
      <div style="font-size:13px;color:#248223;margin-top:2px;">Gestión deportiva para escuelas y entrenadores</div>
      <div style="font-size:13px;color:#555;margin-top:6px;">
        <a href="mailto:contacto@sportmaps.co" style="color:#555;text-decoration:none;">contacto@sportmaps.co</a>
        &nbsp;·&nbsp;
        <a href="https://wa.me/${WHATSAPP}" style="color:#555;text-decoration:none;">${WHATSAPP_VISIBLE}</a>
      </div>
      <div style="width:56px;height:3px;background:#FB9F1E;margin-top:8px;"></div>
    </td>
  </tr>
</table>`;
}

/** Asunto + HTML de la bienvenida según el tipo de cuenta. Pura. */
export function correoBienvenida(a: Alta): { subject: string; html: string } {
    const trainer = esEntrenadorPersonal(a.tipoEscuela);
    const escuela = a.escuela.trim();
    const pasos = trainer
        ? [
            ['Invite a sus alumnos', 'cada uno recibe su acceso y queda conectado a usted.'],
            ['Agende sus sesiones', 'horarios fijos o por cita, con asistencia en un toque.'],
            ['Cobre sin perseguir a nadie', 'mensualidades o paquetes de sesiones, con recordatorios automáticos.'],
        ]
        : [
            ['Cargue a sus deportistas', 'uno por uno o todos de una vez desde Excel.'],
            ['Arme sus grupos y horarios', 'y tome asistencia desde el celular.'],
            ['Configure los cobros a las familias', 'mensualidades, recordatorios y comprobantes en un solo lugar.'],
        ];
    const subject = trainer
        ? 'Bienvenido a SportMaps: su espacio de entrenador ya está listo'
        : `Bienvenidos a SportMaps: ${escuela} ya tiene su espacio`;
    const intro = trainer
        ? 'Su espacio de entrenador en SportMaps ya está creado. Desde ahí va a llevar a sus alumnos, sus sesiones y sus pagos en un solo lugar.'
        : `La cuenta de <strong>${escaparHtml(escuela)}</strong> en SportMaps ya está creada. Desde ahí van a llevar deportistas, asistencia y cobros en un solo lugar.`;

    const lista = pasos.map(([t, d], i) => `
      <tr>
        <td style="vertical-align:top;padding:8px 12px 8px 0;"><div style="width:26px;height:26px;border-radius:13px;background:#248223;color:#fff;font-weight:700;font-size:13px;line-height:26px;text-align:center;">${i + 1}</div></td>
        <td style="padding:8px 0;color:#4a4a4a;line-height:1.5;"><strong style="color:#1f1f1f;">${t}</strong>: ${d}</td>
      </tr>`).join('');

    const html = `
<div style="font-family:'Poppins',Arial,sans-serif;background:#f9f9f9;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
    <div style="padding:20px;text-align:center;"><img src="${LOGO}" alt="SportMaps" style="width:150px;height:auto;"></div>
    <div style="padding:28px;border-top:3px solid #248223;font-size:15px;">
      <p style="margin:0 0 14px;color:#1f1f1f;">${escaparHtml(saludo(a.nombreDueno, escuela))}</p>
      <p style="margin:0 0 14px;color:#4a4a4a;line-height:1.6;">¡Gracias por registrarse! ${intro}</p>
      <p style="margin:18px 0 6px;color:#1f1f1f;font-weight:600;">Para arrancar, tres pasos:</p>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${lista}</table>
      <div style="text-align:center;margin:26px 0 8px;">
        <a href="${appUrl()}/dashboard" style="display:inline-block;padding:14px 30px;background:#FB9F1E;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Entrar a SportMaps</a>
      </div>
      <p style="margin:22px 0 0;color:#4a4a4a;line-height:1.6;">
        <strong>¿Le ayudamos a dejarlo listo?</strong> Responda este correo o escríbanos por
        <a href="https://wa.me/${WHATSAPP}" style="color:#248223;font-weight:600;">WhatsApp al ${WHATSAPP_VISIBLE}</a>
        y en una videollamada corta lo configuramos con usted.
      </p>
      ${firmaEquipo()}
    </div>
    <div style="background:#f1f1f1;padding:14px;color:#888;font-size:12px;text-align:center;">
      Recibe este correo porque creó una cuenta en SportMaps con ${escaparHtml(a.correo ?? '')}.
    </div>
  </div>
</div>`;
    return { subject, html };
}

/** Aviso interno a contacto@: quién se registró y cómo llamarlo. Pura. */
export function correoAvisoInterno(a: Alta, bienvenida: 'enviado' | 'fallo' | 'sin_correo'): { subject: string; html: string } {
    const tipo = esEntrenadorPersonal(a.tipoEscuela) ? 'Entrenador personal' : 'Escuela / academia';
    const tel = (a.telefono ?? '').replace(/[^\d+]/g, '');
    const estado = bienvenida === 'enviado' ? 'Enviada ✅'
        : bienvenida === 'fallo' ? 'FALLÓ ❌ (contactar a mano)'
            : 'Sin correo del dueño ❌';
    const fila = (k: string, v: string) => `
      <tr><td style="padding:8px 10px;color:#888;border-bottom:1px solid #eee;">${k}</td>
      <td style="padding:8px 10px;font-weight:600;border-bottom:1px solid #eee;">${v}</td></tr>`;
    const html = `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border-top:3px solid #248223;">
  <h2 style="color:#248223;margin-top:0;">Nueva cuenta en SportMaps</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    ${fila('Escuela', escaparHtml(a.escuela.trim()))}
    ${fila('Tipo', tipo)}
    ${fila('Ciudad', escaparHtml(a.ciudad || '—'))}
    ${fila('Dueño', escaparHtml(a.nombreDueno || '—'))}
    ${fila('Correo', a.correo ? `<a href="mailto:${escaparHtml(a.correo)}">${escaparHtml(a.correo)}</a>` : '—')}
    ${fila('Teléfono', tel ? `<a href="https://wa.me/${tel.replace('+', '')}">${escaparHtml(a.telefono!)}</a> (no verificado)` : 'No lo dejó')}
    ${fila('Creada', escaparHtml(horaColombia(a.creada)))}
    ${fila('Bienvenida', estado)}
  </table>
</div>`;
    return { subject: `Nueva cuenta: ${a.escuela.trim()} (${tipo})`, html };
}

/** Una corrida. Nunca lanza por una escuela: sigue con las demás. */
export async function runBienvenidaEscuelas(ahora = Date.now()): Promise<{ enviadas: number; fallos: number }> {
    const desde = new Date(ahora - VENTANA_HORAS * 3600_000).toISOString();
    const { data: escuelas, error } = await supabase.from('schools')
        .select('id, name, school_type, city, created_at, owner_id')
        .eq('account_type', 'real')
        .eq('is_demo', false)
        .gte('created_at', desde)
        .order('created_at', { ascending: true })
        .limit(LIMITE);
    if (error) throw new Error(`schools: ${error.message}`);
    const lista = (escuelas ?? []) as any[];
    if (!lista.length) return { enviadas: 0, fallos: 0 };

    // Las que ya tienen la reserva de bienvenida (enviada o fallida) se saltan
    // sin intentar el INSERT: una lectura por corrida, no una por escuela.
    const ids = lista.map((e) => uuidDeClave(claveBienvenida(e.id)));
    const { data: hechas, error: errHechas } = await supabase.from('email_sends').select('id').in('id', ids);
    if (errHechas) throw new Error(`email_sends: ${errHechas.message}`);
    const yaHechas = new Set(((hechas ?? []) as any[]).map((h) => h.id));
    const pendientes = lista.filter((e) => !yaHechas.has(uuidDeClave(claveBienvenida(e.id))));
    if (!pendientes.length) return { enviadas: 0, fallos: 0 };

    const duenos = [...new Set(pendientes.map((e) => e.owner_id).filter(Boolean))];
    const { data: perfiles } = duenos.length
        ? await supabase.from('profiles').select('id, full_name, email, phone').in('id', duenos)
        : { data: [] as any[] };
    const porId = new Map(((perfiles ?? []) as any[]).map((p) => [p.id, p]));

    let enviadas = 0;
    let fallos = 0;
    for (const e of pendientes) {
        const p = porId.get(e.owner_id) ?? {};
        const correo = String(p.email ?? '').trim().toLowerCase();
        const alta: Alta = {
            schoolId: e.id,
            escuela: e.name || 'Escuela sin nombre',
            tipoEscuela: e.school_type ?? null,
            ciudad: e.city ?? null,
            creada: e.created_at,
            nombreDueno: p.full_name ?? null,
            correo: correo.includes('@') ? correo : null,
            telefono: p.phone ?? null,
        };

        let resultado: 'enviado' | 'fallo' | 'sin_correo' | 'duplicado' = 'sin_correo';
        if (alta.correo) {
            const c = correoBienvenida(alta);
            resultado = await enviarConReserva({
                clave: claveBienvenida(e.id), tipo: TIPO_BIENVENIDA, schoolId: e.id, refId: null,
                destinos: [alta.correo], data: {}, plantilla: null, replyTo: buzon(),
                respaldo: { subject: c.subject, titulo: '', lineas: [], html: c.html },
            });
        }
        // Otro BFF ya la tomó: él manda también el aviso interno.
        if (resultado === 'duplicado') continue;
        if (resultado === 'enviado') enviadas++;
        if (resultado === 'fallo') fallos++;

        const aviso = correoAvisoInterno(alta, resultado);
        await enviarConReserva({
            clave: claveAvisoInterno(e.id), tipo: TIPO_AVISO_INTERNO, schoolId: e.id, refId: null,
            destinos: correosDeSoporte(), data: {}, plantilla: null,
            respaldo: { subject: aviso.subject, titulo: '', lineas: [], html: aviso.html },
        });
    }
    return { enviadas, fallos };
}
