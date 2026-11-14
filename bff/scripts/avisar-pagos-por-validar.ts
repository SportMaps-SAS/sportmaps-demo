/**
 * Resumen de «Pagos por validar» a mano (src/jobs/pagos-por-validar.job.ts).
 *
 * Por defecto SIMULA: lee la base y muestra qué saldría, a quién (correos
 * enmascarados) y con qué enlace. No reserva, no inserta notificaciones, no
 * manda correos ni WhatsApp.
 *
 *   cd bff
 *   npx tsx scripts/avisar-pagos-por-validar.ts                       # todas las escuelas, tramo por la hora
 *   npx tsx scripts/avisar-pagos-por-validar.ts --escuela <school_id> # una escuela
 *   npx tsx scripts/avisar-pagos-por-validar.ts --tramo tarde         # el recordatorio de las 17:00 (> 48 h)
 *   npx tsx scripts/avisar-pagos-por-validar.ts --html ./tmp          # además escribe el HTML de cada correo
 *   npx tsx scripts/avisar-pagos-por-validar.ts --escuela <id> --aplicar   # ENVÍA (correo + in-app)
 *
 * Con --aplicar usa la MISMA reserva que el cron (email_sends, por escuela +
 * día + tramo): si el cron ya avisó hoy en ese tramo, no repite, y si lo corres
 * tú primero, el cron no repite. El WhatsApp de plataforma solo sale con
 * PAGOS_POR_VALIDAR_WA_ENABLED=true (apagado).
 *
 * Los enlaces usan el origen FIJO de producción (https://app.sportmaps.co):
 * nunca el FRONTEND_URL del .env local (localhost). El origen se imprime.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
    runPagosPorValidar, correoDelPlan, enmascararCorreo, cop, tramoPorHora,
    URL_PANEL, LINK_IN_APP, ORIGEN_APP, type Tramo,
} from '../src/jobs/pagos-por-validar.job';
import { horaColombia } from '../src/services/avisos-correo.service';
import { formatoEspera } from '../src/jobs/receipt-review-alerts.job';
import { pagosPorValidarWaHabilitado } from '../src/services/plataforma-wa-avisos.service';

function arg(nombre: string): string | undefined {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const aplicar = process.argv.includes('--aplicar');
    const escuela = arg('--escuela');
    const tramoArg = arg('--tramo');
    if (tramoArg && tramoArg !== 'manana' && tramoArg !== 'tarde') throw new Error('--tramo debe ser manana o tarde');
    const ahora = Date.now();
    const tramo: Tramo = (tramoArg as Tramo | undefined) ?? tramoPorHora(ahora);
    const dirHtml = arg('--html');

    console.log(`Modo: ${aplicar ? 'APLICAR (envía)' : 'SIMULACRO (no escribe nada)'}`);
    console.log(`Tramo: ${tramo === 'manana' ? 'mañana (07:30, si hay pendientes)' : 'tarde (17:00, solo si alguno lleva > 48 h)'}`);
    console.log(`Origen de los enlaces: ${ORIGEN_APP}  · botón del correo: ${URL_PANEL}  · in-app: ${LINK_IN_APP}`);
    console.log(`WhatsApp de plataforma: ${pagosPorValidarWaHabilitado() ? 'PRENDIDO (PAGOS_POR_VALIDAR_WA_ENABLED=true)' : 'apagado'}`);
    if (escuela) console.log(`Escuela: ${escuela}`);

    // Siempre primero el simulacro: lo que se imprime es lo que se manda.
    const plan = await runPagosPorValidar({ tramo, ahora, escuela, aplicar: false });
    console.log(`\nFecha (Colombia): ${plan.fecha} · escuelas con pendientes: ${plan.escuelasConPendientes} · `
        + `omitidas: no reales/demo=${plan.omitidas.noElegible}, nada que avisar en este tramo=${plan.omitidas.nadaQueAvisar}, `
        + `sin destinatarios=${plan.omitidas.sinDestinatarios}`);

    for (const p of plan.plan) {
        const r = p.resumen;
        console.log(`\n=== ${p.escuela} (${p.schoolId})${p.yaEnviado ? '  — YA AVISADA hoy en este tramo: no se repite' : ''}`);
        console.log(`  ${r.total} por validar · ${cop(r.monto)} · verdes ${r.verdes} (de un clic: ${r.verdesUnClic}) · > 48 h: ${r.masDe48h}`
            + ` · aprobación automática: ${p.autoAprobacion ? 'SÍ (el correo no invita a «Aprobar todos los verdes»)' : 'no'}`);
        const excluidos = Object.entries(r.verdesExcluidos).map(([m, n]) => `${m}: ${n}`).join(' · ');
        if (excluidos) console.log(`  verdes que NO entran en «Aprobar todos los verdes»: ${excluidos}`);
        console.log(`  más antiguo: ${r.masAntiguo ? `${horaColombia(r.masAntiguo)} (${formatoEspera(r.esperaMasAntiguoMs)})` : '—'}`);
        console.log(`  por tipo: ${r.desglose.map((l) => `${l.etiqueta} ${l.cantidad} (${cop(l.monto)})`).join(' · ')}`);
        console.log(`  in-app a ${p.perfiles.length} perfil(es): «${p.textos.titulo}» — ${p.textos.mensaje}`);
        console.log(`  correo a ${p.correos.length ? p.correos.map(enmascararCorreo).join(', ') : '(nadie con correo)'}`);
        console.log(`  asunto: ${p.textos.asunto}`);
        if (dirHtml) {
            const tpl = await correoDelPlan(p);
            fs.mkdirSync(dirHtml, { recursive: true });
            const archivo = path.join(dirHtml, `pagos-por-validar-${p.schoolId}-${tramo}.html`);
            fs.writeFileSync(archivo, tpl.html);
            console.log(`  HTML: ${archivo}`);
        }
    }

    if (!aplicar) {
        console.log('\nSimulacro: no se envió nada. Repite con --aplicar para mandar.');
        return;
    }
    const r = await runPagosPorValidar({ tramo, ahora, escuela, aplicar: true });
    console.log(`\nEnviado: ${r.avisadas} escuela(s) avisada(s) · ${r.duplicadas} ya avisada(s) · `
        + `${r.fallosCorreo} correo(s) fallido(s) · ${r.sinCorreo} sin correo (solo in-app).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e?.message || e); process.exit(1); });
