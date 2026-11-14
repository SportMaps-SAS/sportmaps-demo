/**
 * Conecta el número de SportMaps (+57 320 268 3539) como CANAL de la plataforma (avisos a los administradores de
 * las escuelas) sin pasar por el asistente de registro de Meta (Embedded Signup).
 *
 * Cuándo: el número ya está «Conectado» en el Administrador de WhatsApp del portafolio de SportMaps, pero el
 * asistente falla en el último paso («… no es un identificador comercial válido», #1690130) y nunca devuelve el
 * código que el BFF canjea. Con un TOKEN DE USUARIO DEL SISTEMA se llega al mismo resultado.
 *
 *   # PowerShell (la sesión actual; no queda en ningún archivo):
 *   $env:PLATFORM_WA_TOKEN = '<token del usuario del sistema>'
 *   $env:PLATFORM_WA_WABA_ID = '<id de la cuenta de WhatsApp Business de SportMaps>'   # opcional: si se omite, se detecta desde el token
 *   $env:PLATFORM_WA_PHONE_NUMBER_ID = '<id del número>'        # opcional: si se omite, el único de la cuenta
 *   cd bff
 *   npx tsx scripts/wa-conectar-canal.ts            # simula: verifica el token, la cuenta y el número; NO guarda nada
 *   npx tsx scripts/wa-conectar-canal.ts --aplicar  # guarda el canal (token cifrado) y suscribe los webhooks
 *   Remove-Item Env:PLATFORM_WA_TOKEN               # al terminar
 *
 * El token NUNCA se imprime. El canal queda con habilitado=false: prenderlo y registrar las plantillas va aparte
 * (/admin/whatsapp), con su propio OK.
 */
import 'dotenv/config';
import { conectarCanalConToken, enmascarar, NUMERO_COMERCIAL } from '../src/services/plataforma-wa-admin.service';
import { resolverActivos } from '../src/services/whatsapp-onboarding.service';

const SUPER_ADMIN = 'bcb88976-5998-440f-ba9b-803571bfb46f';
const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`;

/**
 * Las cuentas de WhatsApp Business a las que el token tiene acceso. Dos caminos, y cuenta lo que diga el primero que
 * encuentre algo: (1) los permisos granulares del token (`debug_token`); (2) las cuentas asignadas al usuario del sistema.
 * Imprime un diagnóstico SIN credenciales (nombres de permisos y cuántas cuentas ve cada camino).
 */
async function wabasDelToken(token: string): Promise<string[]> {
    const h = { Authorization: `Bearer ${token}` };
    const ids = new Set<string>();
    const r = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`, { headers: h });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) console.log(`  · debug_token: ${j?.error?.message ?? r.status}`);
    const d = j?.data ?? {};
    console.log(`  · tipo de token: ${d.type ?? '?'} · app: ${d.application ?? '?'} · permisos: ${(d.scopes ?? []).join(', ') || '(ninguno)'}`);
    for (const g of (d.granular_scopes ?? []) as any[]) {
        const n = (g?.target_ids ?? []).length;
        console.log(`  · permiso granular ${g?.scope}: ${n} cuenta(s)`);
        if (/^whatsapp_business_(management|messaging)$/.test(String(g?.scope))) for (const id of g?.target_ids ?? []) ids.add(String(id));
    }
    if (ids.size === 0 && d.user_id) {
        for (const edge of ['assigned_whatsapp_business_accounts', 'owned_whatsapp_business_accounts']) {
            const e = await fetch(`${GRAPH}/${d.user_id}/${edge}?fields=id,name&limit=25`, { headers: h });
            const ej: any = await e.json().catch(() => ({}));
            console.log(`  · ${edge}: ${e.ok ? (ej.data ?? []).length + ' cuenta(s)' : (ej?.error?.message ?? e.status)}`);
            if (e.ok) for (const w of ej.data ?? []) ids.add(String(w.id));
        }
    }
    return [...ids];
}

(async () => {
    const token = process.env.PLATFORM_WA_TOKEN?.trim();
    let wabaId = process.env.PLATFORM_WA_WABA_ID?.trim();
    const phoneNumberId = process.env.PLATFORM_WA_PHONE_NUMBER_ID?.trim();
    if (!token) {
        console.error('Falta PLATFORM_WA_TOKEN (variable de entorno de esta sesión). Ver el encabezado del script.');
        process.exit(1);
    }
    if (!wabaId) {
        const wabas = await wabasDelToken(token);
        if (wabas.length !== 1) {
            console.error(wabas.length === 0
                ? '✗ el token no tiene ninguna cuenta de WhatsApp asignada: asigna «Sportmaps» al usuario del sistema (Cuentas de WhatsApp → Asignar personas) y genera el token de nuevo.'
                : `✗ el token alcanza ${wabas.length} cuentas de WhatsApp; indica cuál con PLATFORM_WA_WABA_ID (terminan en: ${wabas.map((w) => w.slice(-5)).join(', ')}).`);
            process.exit(1);
        }
        wabaId = wabas[0];
        console.log(`✓ cuenta de WhatsApp detectada desde el token (termina en ${wabaId.slice(-5)})`);
    }
    const sesion = { waba_id: wabaId, ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}) };

    // 1. Verificación (sin guardar): el token debe alcanzar la cuenta y el número tiene que ser el comercial.
    const activos = await resolverActivos(token, sesion);
    if ('error' in activos) { console.error('✗', activos.error); process.exit(1); }
    const digitos = String(activos.display ?? '').replace(/\D/g, '');
    console.log(`✓ el token alcanza la cuenta ${wabaId.slice(-5)} · número ${enmascarar(digitos)} · id ${activos.phoneNumberId.slice(-5)}`);
    if (digitos !== NUMERO_COMERCIAL) {
        console.error(`✗ ese número NO es el de SportMaps (${enmascarar(NUMERO_COMERCIAL)}): me detengo. Revisa PLATFORM_WA_PHONE_NUMBER_ID.`);
        process.exit(1);
    }
    if (!process.argv.includes('--aplicar')) { console.log('SIMULACIÓN: no se guardó nada. Con --aplicar queda conectado.'); return; }

    // 2. Guardar (token cifrado) y suscribir webhooks.
    const r = await conectarCanalConToken(token, sesion, SUPER_ADMIN);
    if (!r.ok) { console.error('✗', r.error); process.exit(1); }
    console.log(`✓ canal conectado · número ${enmascarar(r.numero)} · webhooks suscritos: ${r.webhooksSuscritos ? 'sí' : 'NO (revisar permisos del token)'}`);
    console.log('El canal queda APAGADO (habilitado=false). Siguiente: registrar plantillas y prenderlo desde /admin/whatsapp.');
})().catch((e) => { console.error('✗', e?.message ?? e); process.exit(1); });
