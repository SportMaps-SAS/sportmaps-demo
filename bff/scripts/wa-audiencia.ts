/**
 * Audiencia de campañas de WhatsApp de una escuela (plan B5 T2).
 *
 *   cd bff
 *   npx tsx scripts/wa-audiencia.ts --escuela <school_id>              # simula: cuenta, no escribe
 *   npx tsx scripts/wa-audiencia.ts --escuela <school_id> --aplicar    # guarda whatsapp_audiencia
 *   npx tsx scripts/wa-audiencia.ts --escuela <school_id> --completo   # relee todo (no solo lo nuevo)
 *
 * Clasifica con las reglas deterministas del bot (clase de prueba, inscripción,
 * clínica/campamento/vacacional, precio, horarios) y la sede por las
 * `palabras_sede` de los ajustes. Excluye familias, staff, inscritos, marcas
 * manuales y bajas.
 *
 * Solo corre con `whatsapp_campanas_ajustes.habilitadas = true`: sin eso hace
 * una lectura y termina. Los teléfonos salen enmascarados (+57 ••• ••• 1234).
 */

import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { clasificarEscuela } from '../src/services/whatsapp-audiencias.service';

const linea = (t = '─') => console.log(t.repeat(72));

function arg(nombre: string): string | undefined {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const escuela = arg('--escuela');
    if (!escuela) {
        console.error('Uso: npx tsx scripts/wa-audiencia.ts --escuela <school_id> [--aplicar] [--completo]');
        process.exit(1);
    }
    const aplicar = process.argv.includes('--aplicar');
    const completo = process.argv.includes('--completo');

    const r = await clasificarEscuela(escuela, { aplicar, completo });

    const { data: sedes } = await supabase.from('school_branches').select('id, name').eq('school_id', escuela);
    const nombreSede = new Map(((sedes as any[]) ?? []).map((s) => [String(s.id), String(s.name)]));
    const sede = (id: string | null) => (!id || id === 'sin_sede' ? 'sin sede' : nombreSede.get(id) ?? id);

    linea('═');
    console.log(`  Audiencia de campañas · ${escuela} · ${aplicar ? 'APLICAR' : 'simulación (no escribe)'}`);
    linea('═');
    console.log(`  Estado               : ${r.estado}${r.detalle ? ` (${r.detalle})` : ''}`);
    if (r.estado !== 'ok') {
        if (r.estado === 'apagado') console.log('  Las campañas están apagadas para esta escuela (whatsapp_campanas_ajustes).');
        process.exit(r.estado === 'apagado' ? 0 : 1);
    }
    console.log(`  Conversaciones       : ${r.conversaciones} (releídas ${r.releidas}, ${r.mensajes} mensajes)`);
    console.log(`  Con intención clara  : ${r.candidatos}`);
    console.log(`  Vigentes (sin excluir): ${r.vigentes}`);
    linea();
    console.log('  Por interés:');
    for (const [k, v] of Object.entries(r.porInteres).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(14)} ${v}`);
    console.log('  Por sede:');
    for (const [k, v] of Object.entries(r.porSede).sort((a, b) => b[1] - a[1])) console.log(`    ${sede(k).padEnd(28)} ${v}`);
    console.log('  Excluidos:');
    for (const [k, v] of Object.entries(r.excluidos).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(14)} ${v}`);
    linea();
    console.log('  Muestra (máx. 20):');
    for (const m of r.muestra) {
        console.log(`    ${m.telefono.padEnd(20)} ${m.intereses.join(',').padEnd(28)} ${sede(m.sede).padEnd(20)} `
            + `${m.excluido ? `[${m.excluido}]` : ''} ${m.evidencia ? `«${m.evidencia}»` : ''}`);
    }
    linea();
    console.log(aplicar ? `  Guardadas: ${r.guardados} filas en whatsapp_audiencia.` : '  Nada se escribió. Agrega --aplicar para guardar.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
