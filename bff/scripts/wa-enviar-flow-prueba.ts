/**
 * Manda UN formulario de WhatsApp (Flow) de prueba a un teléfono, por el número
 * de la escuela. Fase F-a de docs/specs/whatsapp-plan-v2-anuncios-campanas-formularios.md
 * §3.0: «prueba real en el número de Monster en modo draft (entrega, nfm_reply,
 * cómo se ve en la app Business)».
 *
 *   cd bff
 *   npx tsx scripts/wa-enviar-flow-prueba.ts --escuela <school_id> --telefono 573001234567 \
 *       --flow servicio_inscripcion --servicio <school_tournament_items.id> --draft
 *
 * Opciones: --flow-id <id de Meta> (si todavía no está en whatsapp_flows) ·
 * --data-como-texto (manda flow_action_payload.data como string: la doc de Meta
 * muestra las dos formas) · --simular (arma y valida todo, imprime el payload sin
 * el token y NO envía).
 *
 * Requisitos: el teléfono le escribió al número de la escuela en las últimas 24 h
 * (un mensaje interactivo solo sale dentro de la ventana) y
 * WHATSAPP_FLOW_TOKEN_SECRET en el entorno (el MISMO del BFF que recibe el
 * webhook, o la respuesta llega como «token inválido»). La respuesta (nfm_reply)
 * llega al webhook de PRODUCCIÓN; lo que el bot conteste sale por `deliver`
 * (con el bot apagado no contesta, pero guarda consentimientos, lead y esperado).
 *
 * El token de Meta sale cifrado de la base y se descifra en memoria; nunca se imprime.
 */

import 'dotenv/config';
import { randomBytes } from 'crypto';
import { supabase } from '../src/config/supabase';
import { sendRawPayload, type WhatsAppIntegration } from '../src/services/whatsapp.service';
import {
    leerFlowDelRepo, validarDatosDeEntrada, firmarTokenFormulario, payloadDeFormulario, ENV_SECRETO_TOKEN,
} from '../src/services/whatsapp-flows.service';
import {
    armarFormularioServicio, textoRespaldoFormulario, FORMULARIO_SERVICIO, PANTALLA_INICIAL_SERVICIO,
    CTA_FORMULARIO_SERVICIO, PASO_FORMULARIO_ENVIADO,
} from '../src/services/whatsapp-formulario-servicio';
import { servicioDeAnuncioPorId } from '../src/services/whatsapp-anuncio-destino';
import { hoyBogota } from '../src/services/wa-cobro-desde-comprobante.service';

const linea = (t = '─') => console.log(t.repeat(72));

function arg(nombre: string): string | undefined {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const bandera = (nombre: string) => process.argv.includes(nombre);

async function main() {
    const escuela = arg('--escuela');
    const crudo = String(arg('--telefono') ?? '').replace(/\D/g, '');
    const telefono = /^3\d{9}$/.test(crudo) ? `57${crudo}` : crudo;
    const nombre = arg('--flow') ?? FORMULARIO_SERVICIO;
    const servicioId = arg('--servicio');
    const draft = bandera('--draft');
    const simular = bandera('--simular');
    if (!escuela || !/^\d{10,15}$/.test(telefono) || !servicioId) {
        console.error('Uso: npx tsx scripts/wa-enviar-flow-prueba.ts --escuela <school_id> --telefono <57…> '
            + '--flow servicio_inscripcion --servicio <id> --draft [--flow-id <id>] [--data-como-texto] [--simular]');
        process.exit(1);
    }
    if (nombre !== FORMULARIO_SERVICIO) throw new Error(`Por ahora solo existe el formulario «${FORMULARIO_SERVICIO}».`);
    if (!process.env[ENV_SECRETO_TOKEN] || process.env[ENV_SECRETO_TOKEN]!.length < 16) {
        throw new Error(`Falta ${ENV_SECRETO_TOKEN} (≥ 16 caracteres, el mismo del BFF que recibe el webhook).`);
    }

    const { data: integraciones, error } = await supabase.from('school_whatsapp_integrations')
        .select('id, school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted, verify_token, status, school:schools(name)')
        .eq('school_id', escuela).eq('status', 'active');
    if (error || !integraciones?.length) throw new Error(`La escuela ${escuela} no tiene un WhatsApp activo.`);
    if (integraciones.length > 1) throw new Error('La escuela tiene varios números activos: este script usa el único.');
    const integ = integraciones[0] as any;

    const { data: filas } = await supabase.from('whatsapp_flows')
        .select('id, flow_id, estado, config').eq('integration_id', integ.id).eq('nombre', nombre).limit(1);
    const fila = ((filas ?? []) as any[])[0];
    const flowId = arg('--flow-id') ?? fila?.flow_id;
    if (!flowId) throw new Error('No hay flow_id: registra el formulario con wa-registrar-flow.ts o pasa --flow-id.');
    if (!draft && fila?.estado !== 'PUBLISHED') throw new Error(`El formulario está ${fila?.estado ?? 'sin estado'}: usa --draft.`);

    const item = await servicioDeAnuncioPorId(escuela, servicioId);
    if (!item) throw new Error(`No encontré el servicio ${servicioId} en el catálogo de la escuela.`);
    const armado = armarFormularioServicio({
        item, escuela: integ.school?.name ?? 'la escuela', hoy: hoyBogota(Date.now()), config: fila?.config ?? {},
    });
    if (!armado) throw new Error(`«${item.name}» no se presta para el formulario (opciones por semana o sin precio).`);
    const problemas = validarDatosDeEntrada(leerFlowDelRepo(nombre).json, PANTALLA_INICIAL_SERVICIO, armado.data);
    if (problemas.length) {
        for (const p of problemas) console.error(`  · ${p.ruta}: ${p.problema}`);
        throw new Error('Los datos no caben en el formulario.');
    }

    // La conversación (el token la lleva) y la ventana de 24 h.
    const { data: conv } = await supabase.from('whatsapp_conversations')
        .select('id, last_inbound_at').eq('integration_id', integ.id).eq('contact_wa_id', telefono).maybeSingle();
    const ultima = (conv as any)?.last_inbound_at ? new Date((conv as any).last_inbound_at).getTime() : 0;
    if (!conv || Date.now() - ultima > 24 * 3600_000) {
        throw new Error(`Primero escribe desde ${telefono} al ${integ.display_phone_number}: la ventana de 24 h tiene que estar abierta.`);
    }

    const tokenId = randomBytes(9).toString('base64url');
    const token = firmarTokenFormulario({
        id: tokenId, schoolId: escuela, conversationId: (conv as any).id, contactWaId: telefono,
        formulario: nombre, servicioId: item.id, precios: armado.precios,
    });
    if (!token) throw new Error('No se pudo firmar el token.');
    const payload = payloadDeFormulario(telefono, {
        flowId, cta: CTA_FORMULARIO_SERVICIO, cuerpo: `[Prueba] ${armado.cuerpo.replace(/\*/g, '')}`, token,
        pantalla: PANTALLA_INICIAL_SERVICIO, data: armado.data, modo: draft ? 'draft' : 'published',
        dataComoTexto: bandera('--data-como-texto'),
    });
    if (!payload) throw new Error('El mensaje no cabe (cuerpo, botón o datos).');

    linea('═');
    console.log(`  ${integ.school?.name ?? '—'} · ${integ.display_phone_number} → ${telefono}`);
    console.log(`  Formulario ${nombre} · flow ${flowId} · modo ${draft ? 'draft' : 'published'} · servicio «${item.name}»`);
    console.log(`  Precios mostrados: lista ${armado.precios.lista} · afiliado ${armado.precios.afiliado ?? '—'} · abono ${armado.precios.abonoPct ?? '—'} %`);
    linea();
    const sinToken = JSON.parse(JSON.stringify(payload));
    sinToken.interactive.action.parameters.flow_token = `${token.slice(0, 12)}…`;
    console.log(JSON.stringify(sinToken, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
    linea();
    if (simular) {
        console.log('  --simular: no se envió nada.');
        return;
    }

    const r = await sendRawPayload(integ as WhatsAppIntegration, payload);
    if (!r.ok) {
        console.log(`  ✗ Meta no lo aceptó: ${r.error}`);
        if (/data/i.test(String(r.error)) && !bandera('--data-como-texto')) console.log('    Prueba de nuevo con --data-como-texto.');
        process.exit(1);
    }
    console.log(`  ✓ Enviado: ${r.waMessageId}`);
    // Queda en el buzón como cualquier saliente del bot (y con el respaldo por si llega un 131026).
    const { error: errReg } = await supabase.rpc('wa_record_outbound_message', {
        p_conversation_id: (conv as any).id,
        p_integration_id: integ.id,
        p_wa_message_id: r.waMessageId,
        p_type: 'interactive',
        p_text_body: `[Prueba] ${armado.cuerpo}`,
        p_payload: {
            step: PASO_FORMULARIO_ENVIADO, prueba: true, flow_id: flowId, flow_cta: CTA_FORMULARIO_SERVICIO,
            formulario: {
                nombre, fila_id: fila?.id ?? null, flow_id: flowId, servicio_id: item.id, token_id: tokenId,
                respaldo: textoRespaldoFormulario(true), sin_cuentas: false, modo: draft ? 'draft' : 'published',
            },
        },
        p_ai_generated: true,
        p_to_wa_id: telefono,
    });
    if (errReg) console.log(`  (no quedó en el buzón: ${errReg.message})`);
    console.log('  Ahora ábrelo en el teléfono, llénalo y envíalo: la respuesta llega al webhook de producción.');
    linea('═');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
