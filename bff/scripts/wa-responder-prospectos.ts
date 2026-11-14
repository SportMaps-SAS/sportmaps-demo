/**
 * Ponerse al día con los PROSPECTOS de WhatsApp que quedaron sin respuesta.
 *
 *   cd bff
 *   npx tsx scripts/wa-responder-prospectos.ts --escuela <school_id>            # simulación (NO escribe ni envía)
 *   npx tsx scripts/wa-responder-prospectos.ts --escuela <school_id> --aplicar  # registra leads y contesta
 *   opcional: --dias 7 (cuántos días mirar para leads)
 *
 * QUÉ TOMA
 *
 * Conversaciones de la escuela con algún entrante en los últimos `--dias`,
 * que NO son familia/staff/personal (contact_kind desconocido o sin
 * clasificar), y cuyos entrantes pasan la regla de prospecto
 * (`intencionDeProspecto`, whatsapp-atencion.service).
 *
 *   1. LEADS: todas ellas se registran en `school_signup_leads` (una fila por
 *      teléfono; ver whatsapp-prospecto-lead.service). Con ventana cerrada
 *      también: que ninguno se pierda.
 *   2. RESPUESTA: solo las que cumplen TODO:
 *        - el ÚLTIMO mensaje es entrante (nadie le contestó después),
 *        - la ventana de 24 h de Meta sigue abierta (desde el último entrante),
 *        - no está tomada desde el buzón,
 *        - ninguna persona de la escuela escribió en las últimas 24 h.
 *      Se ordenan por la que se le acaba antes la ventana.
 *
 * EN SIMULACIÓN la respuesta se genera de verdad con el mismo camino del bot
 * (`atenderDesconocido`, el que usa el webhook con el desconocido), pero
 * dentro de `simularEnvios`: `deliver` anota en vez de enviar, el buzón y el
 * lead no se tocan. Con --aplicar corre el turno real y registra los leads.
 */

import 'dotenv/config';
import type { WhatsAppIntegration } from '../src/services/whatsapp.service';

// El enlace de inscripción sale de FRONTEND_URL. El .env local apunta a
// localhost; un prospecto real tiene que recibir el de producción.
if (!process.env.FRONTEND_URL || /localhost|127\.0\.0\.1/.test(process.env.FRONTEND_URL)) {
    process.env.FRONTEND_URL = 'https://app.sportmaps.co';
}

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const ESCUELA = arg('--escuela');
const APLICAR = process.argv.includes('--aplicar');
const DIAS = Number(arg('--dias') ?? 7) || 7;
const VENTANA_MS = 24 * 60 * 60 * 1000;
const TIPOS_NO = new Set(['familia', 'familia_sin_cuenta', 'ambiguo', 'staff', 'personal']);

const enmascarar = (tel: string) => {
    const d = String(tel || '').replace(/\D/g, '');
    return d.length > 4 ? `${'•'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : d;
};
const horas = (ms: number) => `${Math.floor(ms / 3_600_000)}h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`;
const sangria = (t: string, n = 6) => t.split('\n').map((l) => ' '.repeat(n) + l).join('\n');

async function main(): Promise<void> {
    // Imports dinámicos: tienen que leer FRONTEND_URL ya corregido.
    const { supabase } = await import('../src/config/supabase');
    const { atenderDesconocido, simularEnvios } = await import('../src/services/whatsapp-bot.service');
    const { intencionDeProspecto, puertaDeProspecto, ajustesDeAtencion } = await import('../src/services/whatsapp-atencion.service');
    const { registrarLeadDeProspecto, resumirProspecto } = await import('../src/services/whatsapp-prospecto-lead.service');
    if (!ESCUELA) {
        console.error('Uso: npx tsx scripts/wa-responder-prospectos.ts --escuela <school_id> [--aplicar] [--dias 7]');
        process.exit(1);
    }

    const { data: integ, error: errInteg } = await supabase
        .from('school_whatsapp_integrations')
        .select('id, school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted, verify_token, status')
        .eq('school_id', ESCUELA)
        .maybeSingle();
    if (errInteg || !integ) throw new Error(`Sin integración de WhatsApp para ${ESCUELA}: ${errInteg?.message ?? ''}`);
    const integration = integ as unknown as WhatsAppIntegration;
    const ajustes = await ajustesDeAtencion(integration.id);

    const ahora = Date.now();
    const desde = new Date(ahora - DIAS * VENTANA_MS).toISOString();

    const { data: convs, error: errConv } = await supabase
        .from('whatsapp_conversations')
        .select('id, contact_wa_id, contact_name, contact_kind, last_inbound_at, tomada_hasta')
        .eq('school_id', ESCUELA)
        .gte('last_inbound_at', desde)
        .order('last_inbound_at', { ascending: true })
        .limit(1000);
    if (errConv) throw errConv;

    type Fila = {
        conv: any; textos: string[]; ultimoTexto: string | null; ultimoEsEntrante: boolean;
        restanteMs: number; humano24h: boolean; tomada: boolean; motivoNo: string | null;
    };
    const filas: Fila[] = [];

    for (const c of (convs ?? []) as any[]) {
        if (TIPOS_NO.has(c.contact_kind)) continue;
        const { data: msgs } = await supabase
            .from('whatsapp_messages')
            .select('direction, type, text_body, ai_generated, payload, created_at, wa_timestamp')
            .eq('conversation_id', c.id)
            .gte('created_at', desde)
            .order('created_at', { ascending: true })
            .limit(500);
        // Sin lo importado del historial de Coexistence (`payload.historial`): es
        // de antes del alta, Meta no abre la ventana con eso y no se le contesta
        // ni se registra lead por un mensaje viejo (el lead dispararía el
        // seguimiento de 20 h).
        const lista = ((msgs ?? []) as any[]).filter((m) => m.payload?.historial !== true);
        const entrantes = lista.filter((m) => m.direction === 'inbound');
        const textos = entrantes.map((m) => (m.text_body || '').trim()).filter(Boolean);
        if (!textos.some((t) => intencionDeProspecto(t))) continue;

        const ultimo = lista[lista.length - 1];
        const ultimoEntrante = entrantes[entrantes.length - 1];
        const tUltimoEntrante = new Date(ultimoEntrante?.wa_timestamp || ultimoEntrante?.created_at || c.last_inbound_at).getTime();
        const restanteMs = tUltimoEntrante + VENTANA_MS - ahora;
        const humano24h = lista.some((m) => m.direction === 'outbound' && m.ai_generated === false
            && !(m.payload?.automatico === true || m.payload?.automatico === 'true')
            && new Date(m.created_at).getTime() >= ahora - VENTANA_MS);
        const tomada = !!c.tomada_hasta && new Date(c.tomada_hasta).getTime() > ahora;
        const ultimoTexto = [...entrantes].reverse().map((m) => (m.text_body || '').trim()).find(Boolean) ?? null;

        let motivoNo: string | null = null;
        if (ultimo?.direction !== 'inbound') motivoNo = 'ya tiene respuesta después del último entrante';
        else if (restanteMs <= 0) motivoNo = 'ventana de 24 h cerrada';
        else if (tomada) motivoNo = 'tomada desde el buzón';
        else if (humano24h) motivoNo = 'la escuela le escribió en las últimas 24 h';
        else if (!ultimoTexto) motivoNo = 'sin texto que leer';
        else if (!puertaDeProspecto(ultimoTexto, textos)) motivoNo = 'el último texto no abre la puerta (saludo/cortesía)';

        filas.push({ conv: c, textos, ultimoTexto, ultimoEsEntrante: ultimo?.direction === 'inbound',
            restanteMs, humano24h, tomada, motivoNo });
    }

    const aResponder = filas.filter((f) => !f.motivoNo).sort((a, b) => a.restanteMs - b.restanteMs);
    const soloLead = filas.filter((f) => f.motivoNo);

    console.log(`\n${APLICAR ? 'APLICANDO' : 'SIMULACIÓN (no se envía ni se escribe nada)'} — escuela ${ESCUELA}`);
    console.log(`Ajustes: bot=${ajustes.botEncendido ? 'prendido' : 'APAGADO'} · responder_desconocidos=${ajustes.responderDesconocidos} · responder_prospectos=${ajustes.responderProspectos}`);
    console.log(`Prospectos en los últimos ${DIAS} días: ${filas.length} · a responder ahora: ${aResponder.length} · solo registrar lead: ${soloLead.length}\n`);

    console.log('═══ A RESPONDER (ordenadas por la ventana que vence antes) ═══');
    let n = 0;
    for (const f of aResponder) {
        n++;
        const r = resumirProspecto(f.textos);
        console.log(`\n${n}. ${f.conv.contact_name ?? '(sin nombre)'} · ${enmascarar(f.conv.contact_wa_id)} · ventana: quedan ${horas(f.restanteMs)}`);
        console.log(`   intereses: ${r.intereses.join(', ')}${r.adulto ? ' · ADULTO' : ''}${r.edad ? ` · edad ${r.edad}` : ''}`);
        console.log(`   texto:\n${sangria(f.textos.slice(-6).join('\n'))}`);
        if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(f.ultimoTexto!) || /\b\d{6}\b/.test(f.ultimoTexto!)) {
            console.log('   respuesta: [trae correo o código → flujo OTP; no se simula porque escribe]');
            continue;
        }
        if (!APLICAR) {
            const { resultado, salidas } = await simularEnvios(() =>
                atenderDesconocido(integration, f.conv.id, f.conv.contact_wa_id, f.ultimoTexto, null));
            console.log(`   flujo: ${resultado}`);
            if (!salidas.length) console.log('   respuesta: (ninguna)');
            for (const s of salidas) {
                console.log(`   respuesta [${s.step ?? '-'}]:\n${sangria(s.texto)}`);
                if (s.botones.length) console.log(`      botones: ${s.botones.join(' | ')}`);
            }
        } else {
            const resultado = await atenderDesconocido(integration, f.conv.id, f.conv.contact_wa_id, f.ultimoTexto, null)
                .catch((e) => `error: ${e?.message ?? e}`);
            console.log(`   turno real: ${resultado}`);
        }
    }

    console.log('\n═══ SOLO LEAD (no se les responde) ═══');
    for (const f of soloLead) {
        const r = resumirProspecto(f.textos);
        const ventana = f.restanteMs > 0 ? `quedan ${horas(f.restanteMs)}` : `cerrada hace ${horas(-f.restanteMs)}`;
        console.log(`\n- ${f.conv.contact_name ?? '(sin nombre)'} · ${enmascarar(f.conv.contact_wa_id)} · ${f.motivoNo} · ventana ${ventana}`);
        console.log(`  intereses: ${r.intereses.join(', ')}${r.adulto ? ' · ADULTO' : ''}${r.edad ? ` · edad ${r.edad}` : ''}`);
        console.log(`  texto:\n${sangria(f.textos.slice(-4).join('\n'), 4)}`);
    }

    if (APLICAR) {
        let creados = 0; let actualizados = 0; let fallidos = 0;
        for (const f of filas) {
            const r = await registrarLeadDeProspecto({
                schoolId: ESCUELA, conversationId: f.conv.id, contactWaId: f.conv.contact_wa_id,
                nombre: f.conv.contact_name && /[a-zA-ZÀ-ÿ]{2}/.test(f.conv.contact_name) && !f.conv.contact_name.includes('@')
                    ? f.conv.contact_name : null,
                textos: f.textos, estado: f.ultimoEsEntrante ? 'nuevo' : 'respondido',
            });
            if (!r) fallidos++; else if (r.creado) creados++; else actualizados++;
        }
        console.log(`\nLeads: ${creados} creados · ${actualizados} actualizados · ${fallidos} fallidos`);
    } else {
        console.log(`\n(Con --aplicar se registrarían ${filas.length} leads y se correría el turno real en ${aResponder.length}.)`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
});
