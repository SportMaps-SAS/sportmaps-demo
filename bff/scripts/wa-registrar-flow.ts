/**
 * Registra (crea o actualiza) un formulario de WhatsApp (Flow) en la WABA de una
 * escuela y lo deja en `whatsapp_flows`. Fase F-a de
 * docs/specs/whatsapp-plan-v2-anuncios-campanas-formularios.md §3.
 *
 *   cd bff
 *   npx tsx scripts/wa-registrar-flow.ts --escuela <school_id> [--flow servicio_inscripcion]
 *   npx tsx scripts/wa-registrar-flow.ts --escuela <school_id> --publicar            # además lo publica
 *   npx tsx scripts/wa-registrar-flow.ts --escuela <school_id> --activar             # la escuela lo usa
 *
 * Opciones: --integracion <id> (si la escuela tiene varios números) ·
 * --nombre-meta <nombre> (por defecto sportmaps_<flow>) · --desactivar ·
 * --forzar-borrador (subir el JSON a un flow PUBLICADO lo devuelve a borrador en
 * Meta: sin esta bandera ni --publicar, el script no lo toca).
 *
 * Por defecto queda en BORRADOR: crear borradores no exige negocio verificado;
 * publicar y enviar sí (lo dice la doc de Meta). El JSON sale del repo
 * (bff/whatsapp-flows/<flow>.json) y se valida antes de subirlo.
 *
 * El token sale cifrado de la base y se descifra en memoria; nunca se imprime.
 */

import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { decryptToken } from '../src/services/whatsapp.service';
import {
    leerFlowDelRepo, validarFlowJson, metaFlows, saludDesdeDetalle, ErrorGraph, FLOW_JSON_VERSION,
} from '../src/services/whatsapp-flows.service';

const linea = (t = '─') => console.log(t.repeat(72));

function arg(nombre: string): string | undefined {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const bandera = (nombre: string) => process.argv.includes(nombre);

function errores(lista: unknown): string[] {
    return (Array.isArray(lista) ? lista : []).map((e: any) =>
        `${e?.error ?? e?.error_type ?? '?'}: ${e?.message ?? JSON.stringify(e)}${e?.pointers?.[0]?.path ? ` (${e.pointers[0].path})` : ''}`);
}

async function main() {
    const escuela = arg('--escuela');
    const nombre = arg('--flow') ?? 'servicio_inscripcion';
    const publicar = bandera('--publicar');
    const activar = bandera('--activar');
    const desactivar = bandera('--desactivar');
    if (!escuela || (activar && desactivar)) {
        console.error('Uso: npx tsx scripts/wa-registrar-flow.ts --escuela <school_id> [--flow servicio_inscripcion] [--publicar] [--activar|--desactivar]');
        process.exit(1);
    }

    // 1. El JSON del repo, validado.
    const flow = leerFlowDelRepo(nombre);
    const problemas = validarFlowJson(flow.json);
    linea('═');
    console.log(`  SportMaps · registro de formulario de WhatsApp · ${nombre} (repo ${flow.versionRepo}, Flow JSON ${flow.json.version})`);
    linea('═');
    if (problemas.length) {
        console.log('  ✗ El JSON no pasa la validación local:');
        for (const p of problemas) console.log(`    · ${p.ruta}: ${p.problema}`);
        process.exit(1);
    }

    // 2. La integración de la escuela.
    let q = supabase.from('school_whatsapp_integrations')
        .select('id, school_id, waba_id, phone_number_id, display_phone_number, status, access_token_encrypted, school:schools(name)')
        .eq('school_id', escuela);
    const integracionPedida = arg('--integracion');
    if (integracionPedida) q = q.eq('id', integracionPedida);
    const { data: integraciones, error } = await q;
    if (error || !integraciones?.length) throw new Error(`La escuela ${escuela} no tiene WhatsApp conectado.`);
    if (integraciones.length > 1) {
        console.error('La escuela tiene varios números. Indica cuál con --integracion <id>:');
        for (const x of integraciones as any[]) console.error(`  ${x.id}  ·  ${x.display_phone_number ?? '—'}  ·  ${x.status}`);
        process.exit(1);
    }
    const integ = integraciones[0] as any;
    if (!integ.waba_id || !integ.access_token_encrypted) throw new Error('La integración no tiene WABA o token.');
    const token = decryptToken(integ.access_token_encrypted);
    console.log(`  Escuela : ${integ.school?.name ?? '—'}`);
    console.log(`  Número  : ${integ.display_phone_number ?? '—'} (phone_number_id ${integ.phone_number_id})`);
    console.log(`  WABA    : ${integ.waba_id}`);
    const verificacion = await metaFlows.verificacionDelNegocio(token, integ.waba_id).catch(() => null);
    console.log(`  Negocio : ${verificacion ?? 'no se pudo leer'} (publicar y enviar exigen negocio verificado)`);
    linea();

    // 3. ¿Ya existe? (primero la base, luego la WABA por nombre).
    const { data: filas, error: errFila } = await supabase.from('whatsapp_flows')
        .select('id, flow_id, nombre_en_meta, estado, activo').eq('integration_id', integ.id).eq('nombre', nombre).limit(1);
    if (errFila) throw new Error(`whatsapp_flows no disponible (¿migración 20261104131451 sin aplicar?): ${errFila.message}`);
    const previa = (filas ?? [])[0] as any;
    const nombreMeta = arg('--nombre-meta') ?? previa?.nombre_en_meta ?? `sportmaps_${nombre}`;
    let flowId: string | null = previa?.flow_id ?? null;
    if (!flowId) {
        const enWaba = await metaFlows.listar(token, integ.waba_id);
        flowId = enWaba.find((f) => f.name === nombreMeta)?.id ?? null;
        if (flowId) console.log(`  En la WABA ya existe «${nombreMeta}» (${flowId}): se actualiza su JSON.`);
    }

    let validacion: string[] = [];
    if (!flowId) {
        console.log(`  POST /${integ.waba_id}/flows  «${nombreMeta}» (se crea como BORRADOR)`);
        const r = await metaFlows.crear(token, integ.waba_id, {
            nombre: nombreMeta, categorias: ['SIGN_UP'], flowJson: flow.texto, publicar: false,
        });
        flowId = String(r.id);
        validacion = errores(r.validation_errors);
        console.log(`  ✓ Creado: ${flowId}`);
    } else {
        const actual = saludDesdeDetalle(await metaFlows.detalle(token, flowId));
        if (actual.estado === 'PUBLISHED' && !publicar && !bandera('--forzar-borrador')) {
            console.log(`  El flow ${flowId} está PUBLICADO: subir el JSON lo devuelve a borrador en Meta.`);
            console.log('  Usa --publicar (sube y vuelve a publicar) o --forzar-borrador. No se tocó nada en Meta.');
        } else if (actual.estado === 'DEPRECATED' || actual.estado === 'BLOCKED') {
            throw new Error(`El flow ${flowId} está ${actual.estado}: crea uno nuevo con --nombre-meta ${nombreMeta}_v2.`);
        } else {
            console.log(`  POST /${flowId}/assets  (flow.json, ${flow.texto.length} bytes)`);
            const r = await metaFlows.subirJson(token, flowId, flow.texto);
            validacion = errores(r.validation_errors);
            console.log(`  ✓ JSON subido${r.success ? '' : ' (Meta no confirmó success)'}`);
        }
    }
    if (validacion.length) {
        console.log('  ✗ Meta encontró errores en el JSON (el borrador queda, pero no se puede publicar):');
        for (const v of validacion) console.log(`    · ${v}`);
    }

    // 4. Publicar (si se pidió y no hay errores).
    let publicadoAt: string | null = null;
    if (publicar) {
        if (validacion.length) {
            console.log('  No se publica: corrige los errores primero.');
        } else {
            try {
                await metaFlows.publicar(token, flowId);
                publicadoAt = new Date().toISOString();
                console.log('  ✓ Publicado');
            } catch (e: any) {
                console.log(`  ✗ No se pudo publicar: ${e?.message ?? e}`);
                if (e instanceof ErrorGraph) console.log(`    ${JSON.stringify(e.detalle).slice(0, 400)}`);
            }
        }
    }
    linea();

    // 5. Estado y salud contra el número, y la fila.
    const detalle = await metaFlows.detalle(token, flowId, integ.phone_number_id, true);
    const s = saludDesdeDetalle(detalle);
    console.log(`  Estado en Meta : ${s.estado ?? detalle?.status ?? '—'} · Flow JSON ${detalle?.json_version ?? '—'}`);
    console.log(`  Puede enviarse : ${s.puedeEnviar ?? '—'}`);
    for (const e of s.entidades) {
        console.log(`    ${e.tipo.padEnd(9)} ${String(e.puede ?? '—').padEnd(10)} ${e.problemas.join(' | ')}`);
    }
    if (detalle?.preview?.preview_url) console.log(`  Vista previa   : ${detalle.preview.preview_url}`);
    const ahora = new Date().toISOString();
    const fila = {
        school_id: integ.school_id,
        integration_id: integ.id,
        nombre,
        flow_id: flowId,
        nombre_en_meta: nombreMeta,
        version_repo: flow.versionRepo,
        flow_json_version: String(flow.json.version ?? FLOW_JSON_VERSION),
        estado: s.estado ?? 'DRAFT',
        health_can_send: s.puedeEnviar,
        health_detalle: { entidades: s.entidades },
        health_revisado_at: ahora,
        validacion: { errores: validacion, revisado_at: ahora },
        updated_at: ahora,
        ...(publicadoAt ? { publicado_at: publicadoAt } : {}),
        ...(activar ? { activo: true } : desactivar ? { activo: false } : {}),
    };
    const { data: guardada, error: errGuardar } = await supabase.from('whatsapp_flows')
        .upsert(fila, { onConflict: 'integration_id,nombre' }).select('id, estado, activo').single();
    if (errGuardar) throw new Error(`No se guardó en whatsapp_flows: ${errGuardar.message}`);
    linea();
    console.log(`  whatsapp_flows ${(guardada as any).id}: ${(guardada as any).estado} · activo=${(guardada as any).activo}`);
    if ((guardada as any).activo !== true) console.log('  (el bot no lo manda hasta --activar, publicado y con salud AVAILABLE/LIMITED)');
    linea('═');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
