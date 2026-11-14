/**
 * Estado de los formularios de WhatsApp (Flows) de una escuela, leído EN VIVO de
 * Meta. Fase F-a de docs/specs/whatsapp-plan-v2-anuncios-campanas-formularios.md §3.
 *
 *   cd bff
 *   npx tsx scripts/wa-estado-flows.ts --escuela <school_id>
 *
 * SOLO LECTURA: GET a Graph y SELECT a la base. No escribe en whatsapp_flows ni
 * toca nada en Meta. Muestra:
 *   - si el negocio está verificado (`business_verification_status` de la WABA):
 *     publicar y enviar formularios lo exigen;
 *   - cada flow de la WABA con su estado, errores de validación y la salud
 *     (`health_status.can_send_message`) contra el número de la integración,
 *     entidad por entidad (flow, WABA, negocio, app);
 *   - lo guardado en whatsapp_flows y si el bot lo mandaría hoy.
 *
 * El token sale cifrado de la base y se descifra en memoria; nunca se imprime.
 */

import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { decryptToken } from '../src/services/whatsapp.service';
import { metaFlows, saludDesdeDetalle, decisionDeFormulario } from '../src/services/whatsapp-flows.service';

const linea = (t = '─') => console.log(t.repeat(78));

function arg(nombre: string): string | undefined {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const escuela = arg('--escuela');
    if (!escuela) {
        console.error('Uso: npx tsx scripts/wa-estado-flows.ts --escuela <school_id>');
        process.exit(1);
    }
    const { data, error } = await supabase.from('school_whatsapp_integrations')
        .select('id, waba_id, phone_number_id, display_phone_number, status, access_token_encrypted, school:schools(name)')
        .eq('school_id', escuela);
    if (error) throw new Error(`Error leyendo la integración: ${error.message}`);
    if (!data?.length) throw new Error(`La escuela ${escuela} no tiene WhatsApp conectado.`);

    for (const i of data as any[]) {
        linea('═');
        console.log(`  ${i.school?.name ?? '—'} · ${i.display_phone_number ?? '—'} · WABA ${i.waba_id ?? '—'} · integración ${i.status}`);
        linea('═');
        if (!i.waba_id || !i.access_token_encrypted) {
            console.log('  Sin waba_id o sin token: nada que consultar.');
            continue;
        }
        const token = decryptToken(i.access_token_encrypted);

        const verificacion = await metaFlows.verificacionDelNegocio(token, i.waba_id).catch((e: any) => `no se pudo leer (${e?.message ?? e})`);
        console.log(`  Negocio verificado: ${verificacion === 'verified' ? 'SÍ' : `NO (${verificacion ?? '—'})`}`
            + ' — publicar y enviar formularios lo exigen; crear borradores no.');

        const { data: guardadas, error: errTabla } = await supabase.from('whatsapp_flows')
            .select('nombre, flow_id, estado, activo, health_can_send, health_revisado_at, version_repo')
            .eq('integration_id', i.id);
        const porFlowId = new Map(((guardadas ?? []) as any[]).filter((g) => g.flow_id).map((g) => [String(g.flow_id), g]));

        let flows: Awaited<ReturnType<typeof metaFlows.listar>> = [];
        try {
            flows = await metaFlows.listar(token, i.waba_id);
        } catch (e: any) {
            console.log(`  No se pudo listar los flows de la WABA: ${e?.message ?? e}`);
        }
        console.log(`  Flows en la WABA: ${flows.length}`);
        linea();
        for (const f of flows) {
            let s: ReturnType<typeof saludDesdeDetalle> | null = null;
            let detalle: any = null;
            try {
                detalle = await metaFlows.detalle(token, f.id, i.phone_number_id);
                s = saludDesdeDetalle(detalle);
            } catch (e: any) {
                console.log(`  ${f.name} (${f.id}): no se pudo leer el detalle — ${e?.message ?? e}`);
                continue;
            }
            const g = porFlowId.get(String(f.id));
            console.log(`  ${f.name}  (${f.id})`);
            console.log(`    estado ${s.estado ?? f.status} · Flow JSON ${detalle?.json_version ?? '—'} · categorías ${(f.categories ?? []).join(', ') || '—'}`);
            const errs = Array.isArray(f.validation_errors) ? f.validation_errors : [];
            console.log(`    errores de validación: ${errs.length ? errs.map((e: any) => e?.message ?? e?.error).join(' | ') : 'ninguno'}`);
            console.log(`    se puede enviar por ${i.display_phone_number ?? i.phone_number_id}: ${s.puedeEnviar ?? '—'}`);
            for (const e of s.entidades) console.log(`      ${e.tipo.padEnd(9)} ${String(e.puede ?? '—').padEnd(10)} ${e.problemas.join(' | ')}`);
            if (g) {
                const decision = decisionDeFormulario(
                    { flow_id: g.flow_id, activo: g.activo, estado: s.estado ?? g.estado },
                    s.puedeEnviar,
                );
                console.log(`    whatsapp_flows: «${g.nombre}» · guardado ${g.estado} · activo=${g.activo} · repo ${g.version_repo ?? '—'}`
                    + ` · salud guardada ${g.health_can_send ?? '—'} (${g.health_revisado_at ?? 'nunca'})`);
                console.log(`    ¿el bot lo manda hoy? ${decision === 'listo' ? 'SÍ' : `no (${decision})`}`);
            } else {
                console.log('    (no está en whatsapp_flows: el bot no lo usa)');
            }
            linea();
        }
        if (errTabla) console.log(`  whatsapp_flows: no disponible (${errTabla.message})`);
        else {
            const sinMeta = ((guardadas ?? []) as any[]).filter((g) => !g.flow_id || !flows.some((f) => String(f.id) === String(g.flow_id)));
            for (const g of sinMeta) console.log(`  whatsapp_flows «${g.nombre}» apunta a ${g.flow_id ?? '—'}, que no está en la WABA.`);
        }
    }
    linea('═');
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
