/**
 * Campañas de WhatsApp por consola (plan B5 T3): el respaldo de la pantalla
 * WhatsApp › Campañas.
 *
 *   cd bff
 *   npx tsx scripts/wa-campana.ts estado   --escuela <id> [--campana <id>]
 *   npx tsx scripts/wa-campana.ts crear    --escuela <id> --nombre "Cierre 2026" --plantilla monster_cierre_2026 \
 *        [--intereses clase_prueba,inscripcion,clinica] [--sedes <branch_id,branch_id>] \
 *        [--respuesta-si "texto que sale al tocar «Sí»"] [--vence 2026-11-30T23:59:00-05:00] [--por <profile_id>]
 *   npx tsx scripts/wa-campana.ts simular  --escuela <id> --campana <id>          # cuenta; no envía ni escribe
 *   npx tsx scripts/wa-campana.ts aprobar  --escuela <id> --campana <id> --por <profile_id> [--acepto-declaracion]
 *   npx tsx scripts/wa-campana.ts pausar   --escuela <id> --campana <id>
 *   npx tsx scripts/wa-campana.ts reanudar --escuela <id> --campana <id>
 *
 * `aprobar` toma la foto de la audiencia (`wa_campana_aprobar`, que verifica
 * que `--por` administre ESA escuela). Con la base 'contacto_previo_declarado'
 * imprime la declaración y exige `--acepto-declaracion`: solo después del «sí»
 * ESCRITO de la escuela al conteo. El envío lo hace el cron (`runCampanas`),
 * en horario, con piloto, tope y freno; este script nunca manda mensajes.
 */

import 'dotenv/config';
import {
    DECLARACION, aprobarCampana, avanceDeCampanas, campanaDeEscuela, campanasDeEscuela, crearCampana,
    leerAjustesCampanas, pausarCampana, reanudarCampana, simularCampana,
} from '../src/services/whatsapp-campanas.service';
import { nombreDeEscuela } from '../src/services/plataforma-wa.service';

const linea = (t = '─') => console.log(t.repeat(72));

function arg(nombre: string): string | undefined {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const lista = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function salir(msg: string): never {
    console.error(msg);
    process.exit(1);
}

async function main() {
    const accion = process.argv[2];
    const escuela = arg('--escuela') ?? salir('Falta --escuela <school_id>.');
    const campanaId = arg('--campana');

    const { disponible, ajustes } = await leerAjustesCampanas(escuela);
    if (!disponible) salir('La tabla whatsapp_campanas_ajustes no existe todavía (migración M3 sin aplicar).');
    linea('═');
    console.log(`  Campañas de WhatsApp · ${await nombreDeEscuela(escuela)}`);
    console.log(`  Ajustes: ${ajustes ? `habilitadas=${ajustes.habilitadas} · base=${ajustes.baseConsentimiento} · `
        + `tope=${ajustes.topeDiarioMax}/día · piloto=${ajustes.lotePiloto} · ${ajustes.pausadaAt ? `EN PAUSA (${ajustes.pausaMotivo})` : 'sin pausa'}`
        : 'sin fila (apagadas)'}`);
    linea('═');

    switch (accion) {
        case 'estado': {
            const campanas = campanaId
                ? [await campanaDeEscuela(escuela, campanaId)].filter((c): c is NonNullable<typeof c> => !!c)
                : await campanasDeEscuela(escuela);
            const avance = await avanceDeCampanas(campanas.map((c) => c.id));
            for (const c of campanas) {
                const a = avance.get(c.id)!;
                console.log(`  ${c.nombre}  [${c.estado}${c.pausa_motivo ? `: ${c.pausa_motivo}` : ''}]  ${c.id}`);
                console.log(`    plantilla ${c.plantilla} · destinatarios ${c.destinatarios ?? '—'} · aprobada ${c.aprobada_at ?? '—'} · vence ${c.vence_at ?? '—'}`);
                console.log(`    enviados ${a.enviado + a.respondio_si + a.respondio_luego + a.baja} · pendientes ${a.pendiente} · `
                    + `sí ${a.respondio_si} · más adelante ${a.respondio_luego} · bajas ${a.baja} · fallidos ${a.fallido} · `
                    + `inciertos ${a.incierto} · omitidos ${a.omitido}`);
            }
            if (!campanas.length) console.log('  No hay campañas.');
            return;
        }
        case 'crear': {
            const r = await crearCampana(escuela, arg('--por') ?? null, {
                nombre: arg('--nombre') ?? '',
                plantilla: arg('--plantilla') ?? '',
                filtro: { intereses: lista(arg('--intereses')), branch_ids: lista(arg('--sedes')) },
                respuestaSi: arg('--respuesta-si') ?? null,
                venceAt: arg('--vence') ?? null,
            });
            if (!r.ok) salir(`  ✗ ${r.error}${r.detalle ? `: ${r.detalle}` : ''}`);
            console.log(`  ✓ Borrador creado: ${r.campana.id}`);
            console.log(`    Siguiente: npx tsx scripts/wa-campana.ts simular --escuela ${escuela} --campana ${r.campana.id}`);
            return;
        }
        case 'simular': {
            if (!campanaId) salir('Falta --campana <id>.');
            const r = await simularCampana(escuela, campanaId);
            if (!r.ok) salir(`  ✗ ${r.error}${r.detalle ? `: ${r.detalle}` : ''}`);
            console.log(`  Lista: ${r.conteo.total} personas (nada se envió).`);
            console.log(`  Por interés: ${JSON.stringify(r.conteo.porInteres)}`);
            console.log(`  Por sede:    ${JSON.stringify(r.conteo.porSede)}`);
            console.log(`  Plantilla:   ${r.plantilla.ok ? 'lista' : `NO lista — ${r.plantilla.detalle}`}`);
            return;
        }
        case 'aprobar': {
            if (!campanaId) salir('Falta --campana <id>.');
            const por = arg('--por') ?? salir('Falta --por <profile_id> (owner o admin de la escuela).');
            const acepto = process.argv.includes('--acepto-declaracion');
            if (ajustes?.baseConsentimiento === 'contacto_previo_declarado') {
                console.log('  Declaración de la escuela:');
                console.log(`    «${DECLARACION.texto(await nombreDeEscuela(escuela), ajustes.antiguedadMaxDias)}»`);
                if (!acepto) salir('  Agrega --acepto-declaracion SOLO con el «sí» escrito de la escuela al conteo.');
            }
            const r = await aprobarCampana({ schoolId: escuela, campanaId, por, declaracionAceptada: acepto });
            if (!r.ok) salir(`  ✗ ${r.error}${r.detalle ? `: ${r.detalle}` : ''}`);
            console.log(`  ✓ Aprobada para ${r.destinatarios} personas. El envío arranca en el próximo tick (en horario).`);
            return;
        }
        case 'pausar':
        case 'reanudar': {
            if (!campanaId) salir('Falta --campana <id>.');
            const r = accion === 'pausar' ? await pausarCampana(escuela, campanaId) : await reanudarCampana(escuela, campanaId);
            if (!r.ok) salir(`  ✗ ${r.error}`);
            console.log(`  ✓ ${accion === 'pausar' ? 'Pausada' : 'Reanudada'}.`);
            return;
        }
        default:
            salir('Acción: estado | crear | simular | aprobar | pausar | reanudar');
    }
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
