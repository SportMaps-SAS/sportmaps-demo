import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Template Types ───
type EmailType =
    | "payment_confirmation"
    | "enrollment_confirmation"
    | "welcome_school"
    | "parent_invitation"
    | "coach_invitation"
    | "athlete_invitation"
    | "staff_invitation"
    | "payment_reminder"
    // Avisos del bot (WhatsApp y Mapi). Los arma bff/src/services/avisos-correo.service.ts
    // y los jobs whatsapp-resumen-diario / bot-resumen-semanal.
    | "wa_escalamiento"
    | "wa_resumen_diario"
    // v2: + clases de cortesía de hoy/mañana y leads sin agendar (2026-10-06).
    | "wa_resumen_diario_v2"
    | "soporte_ticket_nuevo"
    | "bot_resumen_semanal";

interface EmailItem {
    type?: EmailType;
    to: string;
    data?: Record<string, string>;
    subject?: string;
    html?: string;
    // Nombre visible del remitente (escuela con marca blanca). La dirección
    // sigue siendo noreply@sportmaps.co: es el dominio verificado en Resend.
    from_name?: string;
    // A dónde llegan las respuestas. Solo se acepta un buzón @sportmaps.co
    // (contacto@, soporte@…): noreply no recibe, y cualquier otro dominio
    // convertiría esta función en un remitente de SportMaps para terceros.
    reply_to?: string;
}

const DEFAULT_FROM = "SportMaps <noreply@sportmaps.co>";

/** Remitente con el nombre de la escuela. Se limpian los caracteres que
 *  romperían el header (comillas, <>, saltos) y se limita el largo. */
function buildFrom(name?: string): string {
    const limpio = (name || "").replace(/[\u0000-\u001f"<>\\]/g, "").trim().slice(0, 80);
    return limpio ? `"${limpio}" <noreply@sportmaps.co>` : DEFAULT_FROM;
}

function replyToSeguro(v?: string): string | undefined {
    const limpio = (v || "").trim().toLowerCase();
    return /^[a-z0-9._%+-]+@sportmaps\.co$/.test(limpio) ? limpio : undefined;
}

/**
 * ¿La llamada viene del servidor (BFF / service_role)? El gateway ya verificó la
 * firma del JWT (verify_jwt = true); acá solo se lee el rol.
 *
 * Por qué (2026-10-27): con la llave PÚBLICA de la app —la que va en el bundle
 * del frontend— se podía mandar un correo con asunto y HTML libres desde
 * noreply@sportmaps.co a cualquier dirección. Phishing con nuestra marca y
 * cupo de Resend quemado. La app solo usa plantillas (`type`); el contenido
 * libre lo arma únicamente el BFF, que llama con la llave de servicio.
 */
function esLlamadaDeServidor(req: Request): boolean {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return false;
    const servicio = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (servicio && token === servicio) return true;
    // Llave secreta del formato nuevo: nunca sale del servidor.
    if (token.startsWith("sb_secret_")) return true;
    try {
        const parte = token.split(".")[1];
        if (!parte) return false;
        const json = JSON.parse(atob(parte.replace(/-/g, "+").replace(/_/g, "/")));
        return json?.role === "service_role";
    } catch {
        return false;
    }
}

const CONTENIDO_LIBRE_PROHIBIDO = "El contenido libre (subject/html sin 'type') solo se acepta desde el servidor";

interface EmailPayload extends Partial<EmailItem> {
    // Envío masivo: hasta 100 destinatarios en UNA sola llamada a Resend.
    // 394 invitaciones = 4 requests en vez de 394 (y sin chocar el rate limit).
    batch?: EmailItem[];
}

const RESEND_BATCH_LIMIT = 100;

// ─── Imágenes de los correos (bucket público avatars/correo/) ───
// Antes el encabezado usaba avatars/LOGO.jpg: el ícono cuadrado en JPG, que en
// el correo salía con las esquinas negras. LOGO.jpg sigue en el bucket por si
// algo que vive solo en Supabase lo usa todavía.
const LOGO_URL = "https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/public/avatars/correo/logo-sportmaps.png";
const MAPI_URL = "https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/public/avatars/correo/mapi.png";

// ─── Shared Layout (matches Supabase Auth templates) ───
const wrapTemplate = (body: string): string => `
<div style="font-family: 'Poppins', Arial, sans-serif; background-color: #f9f9f9; padding: 40px; text-align: center;">
  <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #e0e0e0;">
    <div style="padding: 20px; background-color: #ffffff;">
      <img src="${LOGO_URL}" alt="SportMaps" width="150" style="width: 150px; height: auto;">
    </div>
    <div style="padding: 30px; border-top: 3px solid #248223;">
      ${body}
    </div>
    <div style="background-color: #f1f1f1; padding: 15px; color: #888; font-size: 12px;">
      &copy; 2026 SportMaps Tech. Conectando el deporte.
    </div>
  </div>
</div>`;

const orangeButton = (href: string, text: string): string =>
    `<a href="${href}" style="display: inline-block; padding: 14px 30px; background-color: #FB9F1E; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px; box-shadow: 0 4px 10px rgba(251, 159, 30, 0.3);">${text}</a>`;

/** Presenta a Mapi en las invitaciones de familias y deportistas: es a quien
 *  pueden preguntarle apenas entren. Tabla y no flex: Outlook no soporta flex. */
const mapiBlock = (schoolName: string, ejemplos: string): string => `
          <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; margin-top: 26px; background-color: #eef7ee; border-radius: 10px; border-collapse: separate; text-align: left;">
            <tr>
              <td style="padding: 16px 0 16px 16px; vertical-align: middle; width: 80px;">
                <img src="${MAPI_URL}" alt="Mapi" width="80" height="80" style="display: block; width: 80px; height: 80px; border-radius: 50%;">
              </td>
              <td style="padding: 16px; vertical-align: middle; color: #4a4a4a; font-size: 14px; line-height: 1.5;">
                <strong style="color: #248223;">Te presentamos a Mapi</strong><br>
                Es el asistente virtual de <strong>${schoolName}</strong>. Cuando entres, toca su botón abajo a la derecha de la app y pregúntale ${ejemplos}.
              </td>
            </tr>
          </table>`;

// ─── Helpers de las plantillas del bot ───
// Estas plantillas muestran texto que escribió una familia por WhatsApp o un
// usuario en el chat de soporte: TODO lo que viene en `data` se escapa. Las
// plantillas anteriores interpolan sin escapar porque sus datos los pone la
// escuela; acá no.
const esc = (v: unknown): string =>
    String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Las listas viajan como JSON en un string (`data` es Record<string,string>). */
function parseLista<T>(raw: string | undefined): T[] {
    try {
        const v = JSON.parse(raw || "[]");
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

type MensajeCorto = { quien: string; texto: string; hora: string };

const bloqueMensajes = (mensajes: MensajeCorto[]): string =>
    mensajes.length
        ? `<div style="text-align: left; margin: 20px 0;">${mensajes.map((m) => `
            <div style="background: #f6f7f6; border-left: 3px solid #248223; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px;">
              <div style="color: #888; font-size: 12px;">${esc(m.quien)} · ${esc(m.hora)}</div>
              <div style="color: #4a4a4a; line-height: 1.5; white-space: pre-wrap;">${esc(m.texto)}</div>
            </div>`).join("")}</div>`
        : "";

/** Fila etiqueta/valor como las de payment_confirmation. `valor` llega SIN escapar. */
const filaDato = (label: string, valor: string, ultima = false): string => `
            <tr>
              <td style="padding: 10px; color: #888;${ultima ? "" : " border-bottom: 1px solid #eee;"}">${esc(label)}</td>
              <td style="padding: 10px; font-weight: 600; text-align: right;${ultima ? "" : " border-bottom: 1px solid #eee;"}">${esc(valor)}</td>
            </tr>`;

const seccion = (titulo: string, total: string | undefined, filas: string[]): string => {
    if (!filas.length) return "";
    const n = Number(total || filas.length);
    const extra = n > filas.length ? `<li style="color: #888;">y ${n - filas.length} más en la app</li>` : "";
    return `
          <h3 style="color: #248223; text-align: left; margin: 24px 0 8px;">${esc(titulo)} (${n})</h3>
          <ul style="text-align: left; color: #4a4a4a; line-height: 1.6; padding-left: 18px; margin: 0;">${filas.join("")}${extra}</ul>`;
};

// ─── Templates ───
function getSubjectAndHtml(type: EmailType, d: Record<string, string>): { subject: string; html: string } {
    switch (type) {
        case "payment_confirmation":
            return {
                subject: `Pago Aprobado: ${d.concept || "Mensualidad"}`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">¡Pago Aprobado!</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Hola <strong>${d.userName}</strong>, te confirmamos que <strong>${d.schoolName}</strong> ha validado exitosamente tu pago.
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; text-align: left;">
            <tr>
              <td style="padding: 10px; color: #888; border-bottom: 1px solid #eee;">Concepto</td>
              <td style="padding: 10px; font-weight: 600; text-align: right; border-bottom: 1px solid #eee;">${d.concept}</td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #888; border-bottom: 1px solid #eee;">Monto</td>
              <td style="padding: 10px; font-weight: 600; text-align: right; border-bottom: 1px solid #eee;">${d.amount}</td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #888; border-bottom: 1px solid #eee;">Referencia</td>
              <td style="padding: 10px; font-family: monospace; text-align: right; border-bottom: 1px solid #eee;">${d.reference}</td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #888;">Estado</td>
              <td style="padding: 10px; color: #248223; font-weight: 600; text-align: right;">Aprobado ✅</td>
            </tr>
          </table>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Puedes descargar tu recibo desde la sección "Mis Pagos" en la aplicación.
          </p>
        `),
            };

        case "enrollment_confirmation":
            return {
                subject: `Inscripción Confirmada: ${d.programName}`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">¡Inscripción Exitosa!</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Hola <strong>${d.userName}</strong>, tu inscripción en <strong>${d.programName}</strong> con <strong>${d.schoolName}</strong> ha sido confirmada.
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; text-align: left;">
            <tr>
              <td style="padding: 10px; color: #888; border-bottom: 1px solid #eee;">Programa</td>
              <td style="padding: 10px; font-weight: 600; text-align: right; border-bottom: 1px solid #eee;">${d.programName}</td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #888; border-bottom: 1px solid #eee;">Escuela</td>
              <td style="padding: 10px; font-weight: 600; text-align: right; border-bottom: 1px solid #eee;">${d.schoolName}</td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #888;">Horario</td>
              <td style="padding: 10px; font-weight: 600; text-align: right;">${d.schedule || "Por definir"}</td>
            </tr>
          </table>
          <p style="color: #4a4a4a; line-height: 1.6;">¡Nos vemos en el campo! 🏟️</p>
        `),
            };

        case "welcome_school":
            return {
                subject: "¡Bienvenido a SportMaps!",
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">¡Bienvenido al equipo!</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Hola <strong>${d.userName}</strong>, tu escuela <strong>${d.schoolName}</strong> ha sido creada exitosamente en SportMaps.
          </p>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Estás a un paso de revolucionar tu sistema deportivo. SportMaps conecta atletas, entrenadores y proveedores en tiempo real.
          </p>
          ${orangeButton(d.dashboardUrl || "https://app.sportmaps.co/dashboard", "Ir a mi Dashboard")}
          <p style="color: #4a4a4a; line-height: 1.6; margin-top: 20px;">
            Próximos pasos: configura tus programas, agrega entrenadores e invita a tus deportistas.
          </p>
        `),
            };

        case "parent_invitation":
            return {
                subject: `Te invitaron a unirte a ${d.schoolName} en SportMaps`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">¡Has sido invitado!</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            La escuela <strong>${d.schoolName}</strong> te ha invitado a unirte a SportMaps para gestionar la información deportiva de tu hijo(a) <strong>${d.childName || ""}</strong>.
          </p>
          ${orangeButton(d.registrationUrl || "https://app.sportmaps.co/register", "Crear mi Cuenta")}
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Si el botón no funciona, copia y pega este enlace:<br>
            <span style="color: #248223; word-break: break-all;">${d.registrationUrl || "https://app.sportmaps.co/register"}</span>
          </p>
          ${mapiBlock(d.schoolName, "cómo pagar la mensualidad, dónde subir el comprobante o cómo ver los horarios de tu hijo(a)")}
        `),
            };

        case "coach_invitation":
            return {
                subject: `${d.schoolName} te invita como Entrenador en SportMaps`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">Te necesitamos en el equipo</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Hola <strong>${d.coachName}</strong>, la academia <strong>${d.schoolName}</strong> te ha registrado como entrenador en SportMaps.
          </p>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Crea tu cuenta para gestionar tus equipos, planificar entrenamientos y llevar el control de asistencia.
          </p>
          ${orangeButton(d.registrationUrl || "https://app.sportmaps.co/register?role=coach", "Crear mi Cuenta")}
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Si el boton no funciona, copia y pega este enlace:<br>
            <span style="color: #248223; word-break: break-all;">${d.registrationUrl || "https://app.sportmaps.co/register?role=coach"}</span>
          </p>
        `),
            };

        // Atleta mayor de edad: se registra él mismo, no un acudiente. Antes le
        // llegaba parent_invitation hablándole de "tu hijo(a)".
        case "athlete_invitation":
            return {
                subject: `${d.schoolName} te invita a entrenar en SportMaps`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">¡Te esperamos en la cancha!</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Hola${d.athleteName ? ` <strong>${d.athleteName}</strong>` : ""}, la academia <strong>${d.schoolName}</strong> te invitó a unirte a SportMaps como deportista.
          </p>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Crea tu cuenta para ver tus horarios, tus pagos y tu evolución deportiva. Este registro es para ti: no necesitas un acudiente.
          </p>
          ${orangeButton(d.registrationUrl || "https://app.sportmaps.co/register?role=athlete", "Crear mi Cuenta")}
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Si el botón no funciona, copia y pega este enlace:<br>
            <span style="color: #248223; word-break: break-all;">${d.registrationUrl || "https://app.sportmaps.co/register?role=athlete"}</span>
          </p>
          ${mapiBlock(d.schoolName, "cómo ver tus horarios, pagar tu mensualidad o subir un comprobante")}
        `),
            };

        // Administrador de sede y súper usuario. `roleLabel` viene del llamador
        // para no tener una plantilla por cada rol administrativo.
        case "staff_invitation":
            return {
                subject: `${d.schoolName} te dio acceso como ${d.roleLabel || "miembro del equipo"}`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">Tienes un nuevo acceso</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Hola${d.staffName ? ` <strong>${d.staffName}</strong>` : ""}, la academia <strong>${d.schoolName}</strong> te dio acceso a SportMaps como <strong>${d.roleLabel || "miembro del equipo"}</strong>.
          </p>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Crea tu cuenta para entrar al panel de la academia.
          </p>
          ${orangeButton(d.registrationUrl || "https://app.sportmaps.co/register", "Crear mi Cuenta")}
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Si el botón no funciona, copia y pega este enlace:<br>
            <span style="color: #248223; word-break: break-all;">${d.registrationUrl || "https://app.sportmaps.co/register"}</span>
          </p>
        `),
            };

        case "payment_reminder":
            return {
                subject: `Recordatorio de Pago — ${d.schoolName}`,
                html: wrapTemplate(`
          <h2 style="color: #FB9F1E; margin-top: 0;">Recordatorio de Pago</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Hola <strong>${d.userName}</strong>, te recordamos que tienes un pago pendiente con <strong>${d.schoolName}</strong>.
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; text-align: left;">
            <tr>
              <td style="padding: 10px; color: #888; border-bottom: 1px solid #eee;">Concepto</td>
              <td style="padding: 10px; font-weight: 600; text-align: right; border-bottom: 1px solid #eee;">${d.concept}</td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #888; border-bottom: 1px solid #eee;">Monto</td>
              <td style="padding: 10px; font-weight: 600; text-align: right; border-bottom: 1px solid #eee;">${d.amount}</td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #888;">Vencimiento</td>
              <td style="padding: 10px; font-weight: 600; text-align: right;">${d.dueDate || "Próximamente"}</td>
            </tr>
          </table>
          ${orangeButton(d.paymentUrl || "https://app.sportmaps.co/my-payments", "Realizar Pago")}
        `),
            };

        // Una conversación de WhatsApp pasó a una persona. A owner + admins.
        case "wa_escalamiento":
            return {
                subject: `${d.titulo || "Te escribieron por WhatsApp"} — ${d.schoolName || "tu escuela"}`,
                html: wrapTemplate(`
          <h2 style="color: ${d.esProspecto === "true" ? "#FB9F1E" : "#248223"}; margin-top: 0;">${esc(d.titulo || "Alguien espera respuesta")}</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            El asistente de WhatsApp de <strong>${esc(d.schoolName)}</strong> pasó esta conversación a una persona del equipo.
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; text-align: left;">
            ${filaDato("Contacto", d.contactLabel || "")}
            ${filaDato("Motivo", d.motivo || "", true)}
          </table>
          ${bloqueMensajes(parseLista<MensajeCorto>(d.mensajesJson))}
          ${orangeButton(esc(d.conversationUrl || "https://app.sportmaps.co/whatsapp"), "Responder en SportMaps")}
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Si ya le respondiste desde el celular, no tienes que hacer nada más. Te avisamos máximo una vez cada 6 horas por la misma conversación.
          </p>
        `),
            };

        // Resumen de las 7 a. m. por escuela. El BFF solo lo manda si hay algo.
        case "wa_resumen_diario":
        case "wa_resumen_diario_v2": {
            const cortesias = parseLista<{ dia: string; nombre: string; paraQuien: string; grupo: string; hora: string; sede: string; telefono: string }>(d.cortesiasJson)
                .map((c) => `<li><strong>${esc(c.dia.toUpperCase())} ${esc(c.hora)}</strong> — ${esc(c.nombre)} (${esc(c.paraQuien)}) · ${esc(c.grupo)}${c.sede ? ` · ${esc(c.sede)}` : ""} · ${esc(c.telefono)}</li>`);
            const leads = parseLista<{ nombre: string; paraQuien: string; telefono: string; origen: string; hora: string }>(d.leadsJson)
                .map((l) => `<li><strong>${esc(l.nombre)}</strong> (${esc(l.paraQuien)}) · ${esc(l.telefono)} — por ${esc(l.origen)} (${esc(l.hora)})</li>`);
            const familias = parseLista<{ contacto: string; esperaDesde: string; horas: number }>(d.familiasJson)
                .map((f) => `<li><strong>${esc(f.contacto)}</strong> — escribió ${esc(f.esperaDesde)} (hace ${esc(f.horas)} h)</li>`);
            const comprobantes = parseLista<{ contacto: string; estado: string; hora: string }>(d.comprobantesJson)
                .map((c) => `<li><strong>${esc(c.contacto)}</strong> — ${esc(c.estado)} (${esc(c.hora)})</li>`);
            const prospectos = parseLista<{ contacto: string; conEnlace: boolean; respondido: boolean; hora: string }>(d.prospectosJson)
                .map((p) => `<li><strong>${esc(p.contacto)}</strong> — ${p.respondido ? "ya le respondieron" : "sin respuesta de la escuela"}${p.conEnlace ? "" : ", no había enlace de inscripción"} (${esc(p.hora)})</li>`);
            return {
                subject: `WhatsApp de ${d.schoolName || "tu escuela"}: ${d.resumen || "pendientes de hoy"}`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">Lo que quedó esperando en WhatsApp</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">
            Buenos días. Este es el resumen de <strong>${esc(d.schoolName)}</strong>: ${esc(d.resumen)}.
          </p>
          ${seccion("Clases de cortesía de HOY y MAÑANA", d.cortesiasTotal, cortesias)}
          ${seccion("Leads nuevos sin agendar (últimos 7 días)", d.leadsTotal, leads)}
          ${cortesias.length || leads.length ? orangeButton(esc(d.cortesiasUrl || "https://app.sportmaps.co/whatsapp?tab=cortesias"), "Ver clases de cortesía") : ""}
          ${seccion("Familias sin respuesta", d.familiasTotal, familias)}
          ${seccion("Comprobantes para revisar (últimas 24 h)", d.comprobantesTotal, comprobantes)}
          ${seccion("Prospectos (últimas 24 h)", d.prospectosTotal, prospectos)}
          ${orangeButton(esc(d.inboxUrl || "https://app.sportmaps.co/whatsapp"), "Abrir WhatsApp en SportMaps")}
          <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Este correo solo llega los días en que hay algo pendiente.
          </p>
        `),
            };
        }

        // Ticket de Mapi (nuevo, o escalado a una persona). A SportMaps.
        case "soporte_ticket_nuevo":
            return {
                subject: `${d.titulo || "Nuevo caso en Mapi"}: ${d.requesterName || "un usuario"}`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">${esc(d.titulo || "Nuevo caso en Mapi")}</h2>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; text-align: left;">
            ${filaDato("Usuario", d.requesterName || "")}
            ${d.requesterEmail ? filaDato("Correo", d.requesterEmail) : ""}
            ${d.rol ? filaDato("Rol", d.rol) : ""}
            ${filaDato("Escuela", d.escuela || "Sin escuela")}
            ${d.motivo ? filaDato("Motivo", d.motivo) : ""}
            ${filaDato("Estado", d.estado || "", true)}
          </table>
          ${bloqueMensajes(parseLista<MensajeCorto>(d.mensajesJson))}
          ${orangeButton(esc(d.adminUrl || "https://app.sportmaps.co/admin/support"), "Abrir la bandeja de soporte")}
        `),
            };

        // Lunes 7 a. m. a SportMaps: cómo les fue a los bots la semana anterior.
        case "bot_resumen_semanal": {
            const escuelas = parseLista<{
                nombre: string; conversaciones: number; familias: number; pctSinHumano: number | null;
                escaladas: number; medianaPrimeraRespuestaMin: number | null; sinResponder24h: number;
            }>(d.escuelasJson);
            let tk: Record<string, number | null> = {};
            try { tk = JSON.parse(d.ticketsJson || "{}"); } catch { tk = {}; }
            // Sin escapar: lo escapa filaDato, o se escapa abajo al pintar la celda.
            const n = (v: unknown, suf = "") => (v === null || v === undefined ? "—" : `${v}${suf}`);
            const th = `style="padding: 6px; color: #888; font-size: 12px; text-align: right; border-bottom: 1px solid #eee;"`;
            const td = `style="padding: 6px; text-align: right; border-bottom: 1px solid #eee;"`;
            const filas = escuelas.map((e) => `
            <tr>
              <td style="padding: 6px; text-align: left; font-weight: 600; border-bottom: 1px solid #eee;">${esc(e.nombre)}</td>
              <td ${td}>${esc(n(e.conversaciones))}</td>
              <td ${td}>${esc(n(e.pctSinHumano, "%"))}</td>
              <td ${td}>${esc(n(e.escaladas))}</td>
              <td ${td}>${esc(n(e.medianaPrimeraRespuestaMin, " min"))}</td>
              <td ${td}>${esc(n(e.sinResponder24h))}</td>
            </tr>`).join("");
            return {
                subject: `Resumen semanal de los bots (${d.semana || ""})`,
                html: wrapTemplate(`
          <h2 style="color: #248223; margin-top: 0;">Resumen semanal de los bots</h2>
          <p style="color: #4a4a4a; line-height: 1.6;">Semana del <strong>${esc(d.semana)}</strong>.</p>
          ${escuelas.length ? `
          <h3 style="color: #248223; text-align: left; margin: 24px 0 8px;">WhatsApp por escuela</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <tr>
              <td style="padding: 6px; color: #888; font-size: 12px; text-align: left; border-bottom: 1px solid #eee;">Escuela</td>
              <td ${th}>Conv.</td><td ${th}>Familias sin humano</td><td ${th}>Escaladas</td>
              <td ${th}>1.ª resp. humana (mediana)</td><td ${th}>Sin responder &gt; 24 h</td>
            </tr>${filas}
          </table>` : ""}
          <h3 style="color: #248223; text-align: left; margin: 24px 0 8px;">Mapi (soporte in-app)</h3>
          <table style="width: 100%; border-collapse: collapse; text-align: left;">
            ${filaDato("Tickets nuevos", n(tk.total))}
            ${filaDato("Resueltos por Mapi", n(tk.botHandled))}
            ${filaDato("Esperando a una persona", n(tk.waitingHuman))}
            ${filaDato("Con respuesta humana", n(tk.conRespuestaHumana))}
            ${filaDato("Mediana a la primera respuesta", n(tk.medianaPrimeraRespuestaMin, " min"), true)}
          </table>
          ${orangeButton(esc(d.adminUrl || "https://app.sportmaps.co/admin/support"), "Abrir la bandeja de soporte")}
        `),
            };
        }

        default:
            throw new Error(`Tipo de correo no soportado: ${type}`);
    }
}

// ─── Handler ───
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const payload: EmailPayload = await req.json();
        const { type, to, data, subject: rawSubject, html: rawHtml, batch, reply_to } = payload;
        const deServidor = esLlamadaDeServidor(req);

        // ── Envío masivo (POST /emails/batch) ──────────────────────────────
        if (Array.isArray(batch)) {
            if (batch.length === 0) {
                return new Response(
                    JSON.stringify({ error: "'batch' vacío" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            if (batch.length > RESEND_BATCH_LIMIT) {
                return new Response(
                    JSON.stringify({ error: `'batch' admite máximo ${RESEND_BATCH_LIMIT} destinatarios por llamada` }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            let emails;
            try {
                emails = batch.map((item) => {
                    if (!item.to) throw new Error("Falta 'to' en un elemento del batch");
                    if (!item.type && !deServidor) throw new Error(CONTENIDO_LIBRE_PROHIBIDO);
                    const built = item.type
                        ? getSubjectAndHtml(item.type, item.data || {})
                        : { subject: item.subject!, html: item.html! };
                    if (!built.subject || !built.html) {
                        throw new Error(`Elemento sin 'type' ni ('subject' y 'html'): ${item.to}`);
                    }
                    const replyTo = replyToSeguro(item.reply_to);
                    return {
                        from: buildFrom(item.from_name),
                        to: [item.to],
                        subject: built.subject,
                        html: built.html,
                        ...(replyTo ? { reply_to: replyTo } : {}),
                    };
                });
            } catch (buildErr) {
                const msg = (buildErr as Error).message;
                return new Response(
                    JSON.stringify({ error: msg }),
                    { status: msg === CONTENIDO_LIBRE_PROHIBIDO ? 403 : 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // Sin llave NO se envió nada: devolver 200 con success:true hacía que
            // el cliente contara los correos como enviados y la UI dijera
            // «✅ enviado» sin que saliera uno solo. Falla explícito.
            if (!RESEND_API_KEY) {
                console.error("RESEND_API_KEY not configured");
                return new Response(
                    JSON.stringify({ error: "RESEND_API_KEY no configurada: no se envió ningún correo", sent: 0 }),
                    { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            const batchRes = await fetch("https://api.resend.com/emails/batch", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${RESEND_API_KEY}`,
                },
                body: JSON.stringify(emails),
            });

            const batchText = await batchRes.text();

            if (!batchRes.ok) {
                console.error("Resend batch error:", batchRes.status, batchText);
                // 429 (rate limit) y 4xx de cuota se devuelven tal cual para que
                // el BFF distinga "reintentable" de "se acabó el plan".
                return new Response(
                    JSON.stringify({ error: `Resend error: ${batchRes.status}`, details: batchText }),
                    { status: batchRes.status === 429 ? 429 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }

            // Resend devuelve { data: [{ id }, ...] } en el MISMO orden del request.
            const parsed = JSON.parse(batchText);
            const ids: string[] = (parsed?.data || []).map((d: { id: string }) => d?.id);
            console.log(`Batch enviado: ${ids.length}/${emails.length}`);

            return new Response(
                JSON.stringify({
                    success: true,
                    count: ids.length,
                    results: batch.map((item, i) => ({ to: item.to, id: ids[i] ?? null })),
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (!to) {
            return new Response(
                JSON.stringify({ error: "Missing 'to' field" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        let subject: string;
        let html: string;

        if (type) {
            const template = getSubjectAndHtml(type, data || {});
            subject = template.subject;
            html = template.html;
        } else if (rawSubject && rawHtml) {
            if (!deServidor) {
                return new Response(
                    JSON.stringify({ error: CONTENIDO_LIBRE_PROHIBIDO }),
                    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            subject = rawSubject;
            html = rawHtml;
        } else {
            return new Response(
                JSON.stringify({ error: "Missing 'type' or ('subject' and 'html') fields" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Igual que en el batch: sin llave no hay envío, y decir que sí lo hubo
        // es peor que fallar (la escuela cree que avisó y nadie recibió nada).
        if (!RESEND_API_KEY) {
            console.error("RESEND_API_KEY not configured");
            return new Response(
                JSON.stringify({ error: "RESEND_API_KEY no configurada: no se envió el correo" }),
                { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${RESEND_API_KEY}`,
            },
            body: JSON.stringify({
                from: "SportMaps <noreply@sportmaps.co>",
                to: [to],
                subject,
                html,
                ...(replyToSeguro(reply_to) ? { reply_to: replyToSeguro(reply_to) } : {}),
            }),
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error("Resend API Error:", errorText);
            return new Response(
                JSON.stringify({ error: `Resend error: ${res.status}`, details: errorText }),
                { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const resendData = await res.json();
        console.log("Email sent successfully:", { type, to, id: resendData.id });

        return new Response(
            JSON.stringify({ success: true, id: resendData.id }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error("Error in send-email:", error);
        return new Response(
            JSON.stringify({ error: (error as Error).message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
