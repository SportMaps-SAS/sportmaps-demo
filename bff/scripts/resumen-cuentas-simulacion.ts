/**
 * Simula el resumen de cuentas SIN enviar nada: lee los pendientes de verdad y deja el correo en un archivo.
 *
 *   cd bff
 *   npx tsx scripts/resumen-cuentas-simulacion.ts --escuela <school_id> [--informe] [--salida correo.html]
 *
 * `--informe` simula el corte de las 07:00 de un lunes/miércoles/viernes (informe completo).
 * Nunca escribe en la base ni manda correo (`aplicar: false`).
 */
import 'dotenv/config';
import * as fs from 'fs';
import { runResumenCuentas, htmlDelResumen } from '../src/jobs/resumen-cuentas.job';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] ?? null : null; };

async function main() {
    const escuela = arg('--escuela');
    if (!escuela) { console.error('Uso: --escuela <school_id> [--informe] [--salida archivo.html]'); process.exit(1); }
    process.env.RESUMEN_CUENTAS_ESCUELAS = escuela;
    const informe = process.argv.includes('--informe');
    // Miércoles 2026-11-18 a las 07:00 COT = informe; 11:00 COT = resumen normal.
    const ahora = Date.parse(informe ? '2026-11-18T07:00:00-05:00' : '2026-11-18T11:00:00-05:00');
    const r = await runResumenCuentas({ ahora, aplicar: false, escuela });
    console.log(`Corte ${r.hora}:00 · informe=${r.esInforme} · escuelas en el plan: ${r.plan.length} · nada que avisar: ${r.nadaQueAvisar}`);
    for (const p of r.plan) {
        const x = p.resumen;
        const fmt = (l: { cuenta: string; cantidad: number; monto: number }[]) => l.map((c) => `${c.cuenta} ${c.cantidad}/${c.monto}`).join(' | ');
        console.log(`\n${p.escuela}\n  asunto: ${p.asunto}\n  destinatarios con correo: ${p.correos.length}`);
        console.log(`  por validar: ${x.porValidar.cantidad} · $${x.porValidar.monto}`, fmt(x.porValidar.cuentas));
        console.log(`  por clasificar: ${x.porClasificar.cantidad} · $${x.porClasificar.monto}`, fmt(x.porClasificar.cuentas));
        if (x.aprobado) console.log(`  aprobado desde la revisión anterior: ${x.aprobado.cantidad} · $${x.aprobado.monto}`, fmt(x.aprobado.cuentas));
        console.log(`  sin decidir > 4 h: ${x.sinDecidir4h}`);
        const salida = arg('--salida');
        if (salida) {
            fs.writeFileSync(salida, `<!doctype html><meta charset="utf-8"><body style="background:#f3f4f6;padding:20px">${htmlDelResumen(x, p.escuela, p.esInforme, ahora)}</body>`, 'utf-8');
            console.log(`  correo → ${salida}`);
        }
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
