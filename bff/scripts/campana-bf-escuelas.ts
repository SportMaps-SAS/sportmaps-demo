/**
 * Campaña Black Friday 2026 a las escuelas: correo + aviso en la app.
 *
 *   cd bff
 *   npx tsx scripts/campana-bf-escuelas.ts                       # SIMULACRO: cuenta, excluye, escribe la vista previa. No envía ni escribe.
 *   npx tsx scripts/campana-bf-escuelas.ts --prueba <correo>     # manda UN correo de prueba a esa dirección (sin tocar la base)
 *   npx tsx scripts/campana-bf-escuelas.ts --aplicar             # envía de verdad: aviso en la app + correo
 *   opcional: --limite 20   (solo los primeros N destinatarios; útil para un primer lote)
 *
 * A QUIÉN: dueño (schools.owner_id) y administradores activos (owner/admin/school_admin) de las escuelas que NO son
 * demo. Una persona = un correo, aunque administre varias escuelas. Se excluyen: perfiles demo, correos inválidos y
 * direcciones de prueba (test/prueba/example/demo/qa); el simulacro las lista enmascaradas.
 *
 * QUÉ DICE LA PROMO: sale de CONFIG_COMERCIAL.promo (la misma que usa Mapi con los leads). Si no hay promo vigente,
 * el script se detiene: no se manda una oferta sin texto aprobado.
 *
 * IDEMPOTENCIA: cada persona deja UNA notificación con data.campana = CAMPANA. Si ya la tiene, no se repite el aviso;
 * y el correo solo sale a quien no tenga data.correo = 'enviado'. Volver a correrlo es seguro.
 *
 * LISTA DE CLUBES (prospectos del IDRD, otra audiencia):
 *   npx tsx scripts/campana-bf-escuelas.ts --lista <csv>             # simulacro (columnas: n,club,correo,deporte)
 *   npx tsx scripts/campana-bf-escuelas.ts --lista <csv> --aplicar   # envía hasta el tope diario (15; --tope N lo cambia)
 *   npx tsx scripts/campana-bf-escuelas.ts --prueba <correo> --club  # prueba con el texto para clubes
 *   Registro de enviados: C:/tmp/campana-bf-clubes-enviados.csv · bajas (un correo por línea): C:/tmp/campana-bf-clubes-bajas.txt
 *
 * ORIGEN: https://app.sportmaps.co fijo (NUNCA env.FRONTEND_URL: el .env local apunta a localhost).
 * BAJA: el correo dice «responde BAJA»; reply_to = contacto@sportmaps.co. No hay botón automático de baja todavía.
 */

import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { supabase } from '../src/config/supabase';
import { CONFIG_COMERCIAL, promoVigente } from '../src/services/plataforma-wa-leads.service';

const CAMPANA = 'bf-2026-escuelas';
const ORIGEN = 'https://app.sportmaps.co';
const NUMERO_SPORTMAPS = '573202683539';
const REPLY_TO = 'contacto@sportmaps.co';
const VISTA_PREVIA = 'C:/tmp/campana-bf-preview.html';
const LOTE = 100; // máximo de Resend por llamada

const args = process.argv.slice(2);
const APLICAR = args.includes('--aplicar');
const iPrueba = args.indexOf('--prueba');
const PRUEBA = iPrueba >= 0 ? (args[iPrueba + 1] ?? '') : '';
const iLista = args.indexOf('--lista');
const LISTA = iLista >= 0 ? (args[iLista + 1] ?? '') : '';
const iTope = args.indexOf('--tope');
const TOPE_DIARIO = iTope >= 0 ? Math.max(1, parseInt(args[iTope + 1] ?? '', 10) || 15) : 15;
const CLUB = args.includes('--club');
const iLimite = args.indexOf('--limite');
const LIMITE = iLimite >= 0 ? Math.max(1, parseInt(args[iLimite + 1] ?? '', 10) || 0) : 0;

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SOSPECHOSO = /(test|prueba|example|demo|qa)/i;
const NOMBRE_DE_PRUEBA = /(prueba|test|demo)/i;

interface Destinatario { profileId: string; email: string; nombre: string | null; escuelas: { id: string; name: string }[] }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const enmascarar = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function salir(msg: string): never { console.error(`✗ ${msg}`); process.exit(1); }

// ─── Contenido ───────────────────────────────────────────────────────────────

// Datos de la oferta. Cambiar AQUÍ (no en el HTML). `precioDesde` sale de la landing (Escuela Start).
export const OFERTA = {
    hastaFecha: '31 de diciembre',
    pedirHasta: 'lunes 30 de noviembre',
    cupos: 20,
    precioDesde: CONFIG_COMERCIAL.planes.find((p) => p.nombre === 'Escuela Start')?.mensual ?? 0,
};
const pesos = (n: number) => `$${n.toLocaleString('es-CO').replace(/,/g, '.')}`;

export function asuntoDelCorreo(): string {
    return `Black Friday: SportMaps gratis hasta el ${OFERTA.hastaFecha} (${OFERTA.cupos} cupos)`;
}
const PREHEADER = 'Pasamos tus datos por ti. Solo pagas desde enero.';

export function enlaceCupo(escuela: string | null): string {
    const texto = `Hola, quiero mi cupo Black Friday para ${escuela || 'mi escuela'}`;
    return `https://wa.me/${NUMERO_SPORTMAPS}?text=${encodeURIComponent(texto)}`;
}

export function enlaceAvisos(): string {
    return `${ORIGEN}/whatsapp?tab=config`;
}

// Mismo marco que los demás correos de SportMaps (logo del bucket avatars/correo/, verde #248223, naranja #FB9F1E),
// con más presencia: logo grande, banda naranja, titular en una banda verde y botón grande. Tablas y atributos bgcolor
// (no solo CSS) para que se vea igual en Outlook y en modo oscuro.
const LOGO_URL = 'https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/public/avatars/correo/logo-sportmaps.png';

export function htmlDelCorreo(nombre: string | null, escuela: string | null, variante: 'escuela' | 'club' = 'escuela'): string {
    const primerNombre = nombre ? nombre.trim().split(/\s+/)[0] : '';
    const saludo = variante === 'club'
        ? `Hola, equipo de ${esc(escuela?.trim() || 'tu club')} 👋`
        : (primerNombre ? `Hola, ${esc(primerNombre)} 👋` : 'Hola 👋');
    const laEscuela = esc(escuela?.trim() || 'tu escuela');
    const postData = variante === 'club'
        ? '¿Quieres verlo antes de decidir? Escríbenos y te lo mostramos en una demo de 20 minutos.'
        : '¿Ya usas SportMaps? Activa los avisos por WhatsApp (comprobantes por revisar, casos urgentes y resumen del día) en la app, en <strong>WhatsApp → Configuración</strong>.';
    const pie = variante === 'club'
        ? 'Te escribimos porque tu club figura en el registro público de clubes con reconocimiento deportivo del IDRD. Si no quieres recibir más correos nuestros, responde BAJA a este mensaje y te sacamos de la lista.'
        : 'Recibes este correo porque tu escuela tiene una cuenta en SportMaps. Si no quieres recibir ofertas, responde BAJA a este mensaje.';
    const check = (t: string) => `<tr><td width="30" valign="top" style="padding:7px 0;font-size:18px;line-height:22px">✅</td><td valign="top" style="padding:7px 0;font-size:16px;line-height:24px;color:#2b2b2b">${t}</td></tr>`;
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background-color:#f2f5f2;font-family:'Poppins',Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#f2f5f2">${esc(PREHEADER)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f2f5f2" style="background-color:#f2f5f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:100%;max-width:560px;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e0e6e0">
<tr><td align="center" bgcolor="#ffffff" style="padding:26px 20px 18px"><img src="${LOGO_URL}" alt="SportMaps" width="210" style="display:block;width:210px;max-width:70%;height:auto;border:0"></td></tr>
<tr><td height="6" bgcolor="#FB9F1E" style="height:6px;line-height:6px;font-size:0;background-color:#FB9F1E">&nbsp;</td></tr>
<tr><td align="center" bgcolor="#248223" style="background-color:#248223;padding:32px 24px">
  <div style="display:inline-block;background-color:#FB9F1E;color:#1c1c1c;font-size:13px;font-weight:bold;letter-spacing:1px;padding:7px 16px;border-radius:20px">BLACK FRIDAY · SOLO ${OFERTA.cupos} CUPOS</div>
  <div style="color:#ffffff;font-size:32px;line-height:38px;font-weight:bold;margin-top:16px">SportMaps gratis<br>hasta el ${OFERTA.hastaFecha}</div>
  <div style="color:#e3f4e2;font-size:16px;line-height:24px;margin-top:10px">con todas las funciones</div>
</td></tr>
<tr><td style="padding:30px 30px 8px">
  <p style="margin:0 0 14px;font-size:17px;line-height:26px;color:#2b2b2b"><strong>${saludo}</strong></p>
  <p style="margin:0 0 18px;font-size:16px;line-height:25px;color:#2b2b2b">¿Todavía cobras y llevas la asistencia de <strong>${laEscuela}</strong> en Excel o en papel? Esta Black Friday te damos SportMaps gratis para que la organices sin pagar estos meses.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
    ${check('<strong>Pasamos tus datos por ti:</strong> nos envías tu Excel y nosotros lo cargamos.')}
    ${check('<strong>Cobros, comprobantes y asistencia</strong> en un solo lugar.')}
    ${check('<strong>Mapi, tu asistente de IA,</strong> te ayuda en el día a día.')}
  </table>
  <p style="margin:18px 0 6px;font-size:15px;line-height:24px;color:#4a4a4a">Desde enero pagas tu plan normal, desde <strong>${pesos(OFERTA.precioDesde)} al mes</strong>.</p>
  <p style="margin:0 0 26px;font-size:16px;line-height:24px;color:#b3261e"><strong>Solo ${OFERTA.cupos} cupos. Pide el tuyo hasta el ${OFERTA.pedirHasta}.</strong></p>
</td></tr>
<tr><td align="center" style="padding:0 30px 34px">
  <a href="${enlaceCupo(escuela)}" style="display:inline-block;background-color:#FB9F1E;color:#1c1c1c;text-decoration:none;font-size:18px;font-weight:bold;padding:17px 34px;border-radius:10px;box-shadow:0 4px 12px rgba(251,159,30,0.4)">Quiero mi cupo por WhatsApp</a>
</td></tr>
<tr><td style="padding:0 30px 26px"><p style="margin:0;font-size:13px;line-height:20px;color:#6b6b6b;border-top:1px solid #e8ece8;padding-top:18px"><strong>P. D.</strong> ${postData}</p></td></tr>
<tr><td align="center" bgcolor="#f1f1f1" style="background-color:#f1f1f1;padding:16px 24px;font-size:12px;line-height:18px;color:#888888">${pie}<br>&copy; 2026 SportMaps Tech. Conectando el deporte.</td></tr>
</table></td></tr></table></body></html>`;
}

// ─── Audiencia ───────────────────────────────────────────────────────────────

async function leerTodo<T>(armar: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
    const out: T[] = [];
    for (let desde = 0; ; desde += 1000) {
        const { data, error } = await armar(desde, desde + 999);
        if (error) salir(`Lectura fallida: ${error.message}`);
        out.push(...(data ?? []));
        if (!data || data.length < 1000) break;
    }
    return out;
}

async function audiencia(): Promise<{ destinatarios: Destinatario[]; excluidos: { email: string; motivo: string }[] }> {
    const escuelas = await leerTodo<{ id: string; name: string; owner_id: string | null }>((a, b) =>
        supabase.from('schools').select('id, name, owner_id').or('is_demo.is.null,is_demo.eq.false').range(a, b));
    const porId = new Map(escuelas.map((s) => [s.id, s]));
    const ids = escuelas.map((s) => s.id);

    const miembros: { school_id: string; profile_id: string }[] = [];
    for (let i = 0; i < ids.length; i += 150) {
        const lote = await leerTodo<{ school_id: string; profile_id: string }>((a, b) =>
            supabase.from('school_members').select('school_id, profile_id')
                .in('school_id', ids.slice(i, i + 150)).eq('status', 'active').in('role', ['owner', 'admin', 'school_admin']).range(a, b));
        miembros.push(...lote);
    }

    const vinculos = new Map<string, Set<string>>(); // profile → escuelas
    const agregar = (p: string | null, s: string) => { if (!p) return; (vinculos.get(p) ?? vinculos.set(p, new Set()).get(p)!).add(s); };
    for (const s of escuelas) agregar(s.owner_id, s.id);
    for (const m of miembros) agregar(m.profile_id, m.school_id);

    const perfiles: { id: string; email: string | null; full_name: string | null; is_demo: boolean | null }[] = [];
    const pids = [...vinculos.keys()];
    for (let i = 0; i < pids.length; i += 150) {
        const { data, error } = await supabase.from('profiles').select('id, email, full_name, is_demo').in('id', pids.slice(i, i + 150));
        if (error) salir(`Lectura de perfiles fallida: ${error.message}`);
        perfiles.push(...((data ?? []) as any[]));
    }

    // Estado de suscripción: la oferta es para escuelas EN PRUEBA o con la prueba vencida. Quien ya es cliente
    // (status 'active') no la recibe: «gratis hasta el 31 de dic» a quien ya pagó noviembre genera reclamos.
    const estadoEscuela = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase.from('school_subscriptions').select('school_id, status').in('school_id', ids.slice(i, i + 150));
        if (error) salir(`Lectura de suscripciones fallida: ${error.message}`);
        for (const r of (data ?? []) as any[]) estadoEscuela.set(r.school_id, r.status);
    }

    const excluidos: { email: string; motivo: string }[] = [];
    const vistos = new Set<string>();
    const destinatarios: Destinatario[] = [];
    for (const p of perfiles) {
        const email = (p.email ?? '').trim().toLowerCase();
        const suyas = [...(vinculos.get(p.id) ?? [])];
        if (!EMAIL_OK.test(email)) { excluidos.push({ email: email || '(sin correo)', motivo: 'correo inválido' }); continue; }
        if (p.is_demo) { excluidos.push({ email, motivo: 'perfil demo' }); continue; }
        if (SOSPECHOSO.test(email)) { excluidos.push({ email, motivo: 'correo de prueba' }); continue; }
        if (suyas.some((id) => estadoEscuela.get(id) === 'active')) { excluidos.push({ email, motivo: 'CLIENTE activo: no recibe esta oferta' }); continue; }
        const reales = suyas.map((id) => ({ id, name: porId.get(id)?.name ?? '' })).filter((e) => e.name && !NOMBRE_DE_PRUEBA.test(e.name));
        if (reales.length === 0) { excluidos.push({ email, motivo: 'escuela de prueba' }); continue; }
        if (vistos.has(email)) { excluidos.push({ email, motivo: 'correo repetido' }); continue; }
        vistos.add(email);
        destinatarios.push({ profileId: p.id, email, nombre: p.full_name, escuelas: reales });
    }
    return { destinatarios, excluidos };
}

// ─── Envío ───────────────────────────────────────────────────────────────────

async function enviarLote(items: { to: string; subject: string; html: string }[]): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.functions.invoke('send-email', {
        body: { batch: items.map((i) => ({ ...i, reply_to: REPLY_TO, from_name: 'SportMaps' })) },
    });
    if (error) return { ok: false, error: String((error as any).message ?? error) };
    if ((data as any)?.error) return { ok: false, error: String((data as any).error) };
    return { ok: true };
}

// ─── Lista de clubes (prospectos del registro público del IDRD) ──────────────

const LOG_CLUBES = 'C:/tmp/campana-bf-clubes-enviados.csv'; // correo,fecha  → idempotencia y tope diario
const BAJAS_CLUBES = 'C:/tmp/campana-bf-clubes-bajas.txt';  // un correo por línea: quien respondió BAJA

function leerCsv(ruta: string): Record<string, string>[] {
    const t = readFileSync(ruta, 'utf8').replace(/^\uFEFF/, '');
    const filas: string[][] = [];
    let campo = '', fila: string[] = [], comillas = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (comillas) {
            if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') comillas = false; else campo += c;
        } else if (c === '"') comillas = true;
        else if (c === ',') { fila.push(campo); campo = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; fila.push(campo); campo = ''; if (fila.some((x) => x !== '')) filas.push(fila); fila = []; }
        else campo += c;
    }
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    const [cab, ...resto] = filas;
    return resto.map((f) => Object.fromEntries(cab.map((h, i) => [h.trim(), (f[i] ?? '').trim()])));
}

async function enviarAClubes(): Promise<void> {
    if (!existsSync(LISTA)) salir(`No existe la lista: ${LISTA}`);
    const todos = leerCsv(LISTA).filter((r) => EMAIL_OK.test(r.correo ?? ''));
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const log = existsSync(LOG_CLUBES) ? readFileSync(LOG_CLUBES, 'utf8').split('\n').filter(Boolean).map((l) => l.split(',')) : [];
    const yaEnviados = new Set(log.map((l) => l[0]));
    const enviadosHoy = log.filter((l) => l[1] === hoy).length;
    const bajas = new Set(existsSync(BAJAS_CLUBES) ? readFileSync(BAJAS_CLUBES, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean) : []);

    const pendientes = todos.filter((r) => !yaEnviados.has(r.correo.toLowerCase()) && !bajas.has(r.correo.toLowerCase()));
    const cupoHoy = Math.max(0, TOPE_DIARIO - enviadosHoy);
    const hoyVan = pendientes.slice(0, Math.min(cupoHoy, LIMITE || cupoHoy));

    console.log(`Lista: ${todos.length} clubes con correo válido · ya enviados: ${yaEnviados.size} · bajas: ${bajas.size} · pendientes: ${pendientes.length}`);
    console.log(`Tope diario: ${TOPE_DIARIO} · enviados hoy (${hoy}): ${enviadosHoy} · van ahora: ${hoyVan.length}`);
    console.log(`Muestra: ${hoyVan.slice(0, 5).map((r) => `${enmascarar(r.correo)} → ${r.club}`).join(' | ')}`);
    if (hoyVan[0]) writeFileSync(VISTA_PREVIA, htmlDelCorreo(null, hoyVan[0].club, 'club'), 'utf8');
    console.log(`Vista previa: ${VISTA_PREVIA}`);
    if (!APLICAR) { console.log('\nSIMULACRO: no se envió nada. Para enviar: --aplicar'); return; }
    if (hoyVan.length === 0) { console.log('Nada que enviar hoy (tope diario alcanzado o lista agotada).'); return; }

    const r = await enviarLote(hoyVan.map((c) => ({ to: c.correo.toLowerCase(), subject: asuntoDelCorreo(), html: htmlDelCorreo(null, c.club, 'club') })));
    if (!r.ok) salir(`El envío no salió: ${r.error}. No se registró nada.`);
    appendFileSync(LOG_CLUBES, hoyVan.map((c) => `${c.correo.toLowerCase()},${hoy}`).join('\n') + '\n', 'utf8');
    console.log(`✓ ${hoyVan.length} correos enviados y registrados en ${LOG_CLUBES}.`);
}

async function main() {
    const promo = promoVigente(CONFIG_COMERCIAL);
    if (!promo) salir('No hay promo vigente en CONFIG_COMERCIAL.promo: no se manda una oferta sin texto aprobado.');
    console.log(`Origen: ${ORIGEN} · promo: «${promo}»`);

    if (LISTA && !PRUEBA) return enviarAClubes();

    if (PRUEBA) {
        if (!EMAIL_OK.test(PRUEBA)) salir('--prueba necesita un correo válido.');
        const r = await enviarLote([{ to: PRUEBA, subject: `[PRUEBA] ${asuntoDelCorreo()}`, html: htmlDelCorreo('Brayan', CLUB ? 'Club Ejemplo FC' : 'tu escuela', CLUB ? 'club' : 'escuela') }]);
        console.log(r.ok ? `✓ Correo de prueba enviado a ${enmascarar(PRUEBA)}.` : `✗ No salió: ${r.error}`);
        return;
    }

    const { destinatarios, excluidos } = await audiencia();
    const { data: previas, error: errPrev } = await supabase.from('notifications')
        .select('user_id, data').eq('data->>campana', CAMPANA);
    if (errPrev) salir(`No pude leer las notificaciones previas: ${errPrev.message}`);
    const estado = new Map<string, string>(((previas ?? []) as any[]).map((n) => [n.user_id, n.data?.correo ?? 'pendiente']));

    let lista = destinatarios;
    if (LIMITE) lista = lista.slice(0, LIMITE);
    const sinAviso = lista.filter((d) => !estado.has(d.profileId));
    const sinCorreo = lista.filter((d) => estado.get(d.profileId) !== 'enviado');

    console.log(`\nEscuelas no demo con destinatarios: ${new Set(destinatarios.flatMap((d) => d.escuelas.map((e) => e.id))).size}`);
    console.log(`Destinatarios (1 por correo): ${destinatarios.length}${LIMITE ? ` · con --limite: ${lista.length}` : ''}`);
    console.log(`  · avisos en la app por crear: ${sinAviso.length}  · correos por enviar: ${sinCorreo.length}  · ya enviados antes: ${lista.length - sinCorreo.length}`);
    console.log(`Excluidos: ${excluidos.length}`);
    for (const e of excluidos.slice(0, 25)) console.log(`  - ${enmascarar(e.email)} (${e.motivo})`);
    if (excluidos.length > 25) console.log(`  … y ${excluidos.length - 25} más`);
    console.log(`Muestra: ${lista.slice(0, 5).map((d) => `${enmascarar(d.email)} → ${d.escuelas[0]?.name ?? ''}`).join(' | ')}`);

    const muestra = lista[0];
    writeFileSync(VISTA_PREVIA, htmlDelCorreo(muestra?.nombre ?? 'Nombre', muestra?.escuelas[0]?.name ?? null), 'utf8');
    console.log(`Vista previa del correo: ${VISTA_PREVIA}`);

    if (!APLICAR) { console.log('\nSIMULACRO: no se envió ni se escribió nada. Para enviar: --aplicar'); return; }

    // 1) Aviso en la app (también es el registro de idempotencia de la campaña)
    for (let i = 0; i < sinAviso.length; i += 200) {
        const filas = sinAviso.slice(i, i + 200).map((d) => ({
            user_id: d.profileId,
            school_id: d.escuelas[0]?.id ?? null,
            title: 'Black Friday: SportMaps gratis hasta el 31 de diciembre',
            message: `SportMaps gratis hasta el ${OFERTA.hastaFecha}, con todas las funciones y tus datos cargados por nosotros. Solo ${OFERTA.cupos} cupos: pídelo hasta el ${OFERTA.pedirHasta}.`,
            type: 'info',
            category: 'system',
            link: '/whatsapp?tab=config',
            data: { campana: CAMPANA, correo: 'pendiente' },
        }));
        const { error } = await supabase.from('notifications').insert(filas);
        if (error) salir(`No pude crear los avisos en la app: ${error.message}. Nada de correo se envió todavía.`);
    }
    console.log(`✓ Avisos en la app creados: ${sinAviso.length}`);

    // 2) Correo por lotes de 100; se marca 'enviado' solo si el lote salió
    let enviados = 0;
    for (let i = 0; i < sinCorreo.length; i += LOTE) {
        const lote = sinCorreo.slice(i, i + LOTE);
        const r = await enviarLote(lote.map((d) => ({
            to: d.email, subject: asuntoDelCorreo(), html: htmlDelCorreo(d.nombre, d.escuelas[0]?.name ?? null),
        })));
        if (!r.ok) salir(`El lote ${i / LOTE + 1} no salió (${r.error}). Van ${enviados} correos; volver a correr sigue desde aquí.`);
        const { error } = await supabase.from('notifications')
            .update({ data: { campana: CAMPANA, correo: 'enviado' } })
            .eq('data->>campana', CAMPANA).in('user_id', lote.map((d) => d.profileId));
        if (error) console.warn(`⚠ El lote salió pero no pude marcarlo: ${error.message} (un reintento duplicaría esos correos).`);
        enviados += lote.length;
        console.log(`✓ Lote ${i / LOTE + 1}: ${lote.length} correos`);
        await dormir(1000);
    }
    console.log(`\nListo: ${enviados} correos y ${sinAviso.length} avisos en la app.`);
}

main().catch((e) => salir(e?.message ?? String(e)));
