/**
 * Enviar mensajes puntuales (redactados y revisados por una persona) a
 * conversaciones de WhatsApp de una escuela, por el mismo `deliver` del bot.
 *
 *   cd bff
 *   npx tsx scripts/wa-enviar-mensajes.ts --archivo <lista.json>            # simulación (NO envía)
 *   npx tsx scripts/wa-enviar-mensajes.ts --archivo <lista.json> --aplicar  # envía
 *
 * Nació el 2026-11-08 para contestar y cerrar a los interesados de la clínica de
 * Monster que el bot dejó sin respuesta o con un dato equivocado.
 *
 * Formato del archivo:
 *   {
 *     "escuela": "<school_id>",
 *     "paso": "cierre_clinica_2026_11_08",            // step del payload (para rastrear)
 *     "esperado": { "motivo": "clase_extra", "venceEn": "2026-11-23T04:59:00Z" },  // opcional
 *     "envios": [ { "conversacion": "<uuid>", "mensajes": ["...", "..."], "esperado": true } ]
 *   }
 *
 * Reglas (todas se revisan JUSTO antes de enviar cada conversación):
 *   · ventana de 24 h de Meta abierta, con 10 min de margen (si no, se salta);
 *   · conversación no tomada por una persona y bot encendido (lo revisa `deliver`);
 *   · número no dado de baja (se salta: a una baja no se le escribe por iniciativa propia);
 *   · la conversación es de ESA escuela.
 * Con `esperado`, deja registrado el motivo del próximo comprobante (B4) a nombre del
 * lead del teléfono, para que el comprobante cree el cobro del servicio y no se pierda.
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import type { WhatsAppIntegration } from '../src/services/whatsapp.service';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const ARCHIVO = arg('--archivo');
const APLICAR = process.argv.includes('--aplicar');
const VENTANA_MS = 24 * 3600_000;
const MARGEN_MS = 10 * 60_000;

interface Envio { conversacion: string; mensajes: string[]; esperado?: boolean; nota?: string }
interface Lista {
    escuela: string;
    paso: string;
    esperado?: { motivo: string; venceEn?: string };
    envios: Envio[];
}

const enmascarar = (tel: string) => {
    const d = String(tel || '').replace(/\D/g, '');
    return d.length > 4 ? `••${d.slice(-4)}` : d;
};

async function main(): Promise<void> {
    if (!ARCHIVO) {
        console.error('Uso: npx tsx scripts/wa-enviar-mensajes.ts --archivo <lista.json> [--aplicar]');
        process.exit(1);
    }
    const lista = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')) as Lista;
    if (!lista.escuela || !lista.paso || !Array.isArray(lista.envios)) throw new Error('Archivo sin escuela, paso o envios');

    const { supabase } = await import('../src/config/supabase');
    const { deliver } = await import('../src/services/whatsapp-bot.service');
    const { conversacionTomada } = await import('../src/services/whatsapp-tomada.service');
    const { estaDadoDeBaja } = await import('../src/services/whatsapp-optin.service');
    const { registrarConceptoEsperado } = await import('../src/services/wa-concepto-esperado.service');
    const { leadPorTelefono } = await import('../src/services/wa-cobro-desde-comprobante.service');

    const { data: integ, error: errInteg } = await supabase
        .from('school_whatsapp_integrations')
        .select('*')
        .eq('school_id', lista.escuela).eq('status', 'active')
        .maybeSingle();
    if (errInteg || !integ) throw new Error(`Sin integración activa para ${lista.escuela}`);
    const integration = integ as unknown as WhatsAppIntegration;

    console.log(`${APLICAR ? 'ENVÍO REAL' : 'SIMULACIÓN'} · ${lista.envios.length} conversaciones · paso ${lista.paso}\n`);
    let enviados = 0;
    let saltados = 0;
    for (const e of lista.envios) {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('id, school_id, integration_id, contact_wa_id, contact_name, last_inbound_at')
            .eq('id', e.conversacion).maybeSingle();
        const c = conv as any;
        const etiqueta = c ? `${String(c.id).slice(0, 8)} ${enmascarar(c.contact_wa_id)} ${(c.contact_name ?? '').slice(0, 16)}` : e.conversacion;
        const saltar = (motivo: string) => { saltados++; console.log(`✗ ${etiqueta} — se salta: ${motivo}`); };
        if (!c) { saltar('no existe'); continue; }
        if (c.school_id !== lista.escuela || c.integration_id !== integration.id) { saltar('es de otra escuela'); continue; }
        const ultimo = c.last_inbound_at ? new Date(c.last_inbound_at).getTime() : NaN;
        const quedan = ultimo + VENTANA_MS - Date.now();
        if (!Number.isFinite(ultimo) || quedan < MARGEN_MS) { saltar('ventana de 24 h cerrada'); continue; }
        if (await conversacionTomada(c.id)) { saltar('tomada por una persona'); continue; }
        if (await estaDadoDeBaja(integration.id, c.contact_wa_id)) { saltar('dado de baja'); continue; }
        const textos = (e.mensajes ?? []).map((t) => String(t).trim()).filter(Boolean);
        if (!textos.length) { saltar('sin mensajes'); continue; }

        console.log(`→ ${etiqueta} (ventana: ${Math.floor(quedan / 3600_000)} h ${Math.floor((quedan % 3600_000) / 60_000)} min)`);
        for (const t of textos) console.log(t.split('\n').map((l) => `      ${l}`).join('\n') + '\n');
        if (!APLICAR) { enviados++; continue; }

        for (const t of textos) {
            await deliver(integration, c.id, c.contact_wa_id, t, {
                step: lista.paso, repetible: true, enviado_por: 'sportmaps_revision_manual',
            });
        }
        if (e.esperado && lista.esperado?.motivo) {
            const lead = await leadPorTelefono(lista.escuela, c.contact_wa_id).catch(() => null);
            const ok = await registrarConceptoEsperado(lista.escuela, c.contact_wa_id, {
                motivo: lista.esperado.motivo as any, leadId: lead?.id ?? null, venceEn: lista.esperado.venceEn,
            } as any).catch(() => false);
            console.log(`      esperado ${lista.esperado.motivo}: ${ok ? 'registrado' : 'NO registrado'}${lead?.id ? ' (lead)' : ' (sin lead)'}`);
        }
        enviados++;
    }
    console.log(`\n${APLICAR ? 'Enviadas' : 'Se enviarían'}: ${enviados} · saltadas: ${saltados}`);
    if (APLICAR) console.log('Revisa en whatsapp_messages (payload.step) que hayan salido: deliver no lanza si Meta rechaza.');
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
