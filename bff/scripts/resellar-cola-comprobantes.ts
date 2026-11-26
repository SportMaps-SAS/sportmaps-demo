/**
 * resellar-cola-comprobantes — Paso 4 de docs/specs/seguridad-veredicto-comprobante-plan.md.
 *
 * Vuelve a sellar con el servidor los comprobantes de la cola «por validar» cuya
 * lectura NO hizo el servidor (`receipt_image_sha256_source` distinto de
 * 'server_verified' o NULL). Hasta el 2026-11-25 ese veredicto y ese monto los
 * podía escribir la familia desde su navegador; «Aprobar todos los verdes» solo
 * toma verdes sellados por el servidor, así que estos quedan fuera del lote hasta
 * que se re-sellen.
 *
 *   cd bff
 *   npx tsx scripts/resellar-cola-comprobantes.ts                              # DRY-RUN: lista, no lee OCR, no escribe
 *   npx tsx scripts/resellar-cola-comprobantes.ts --escuela <school_id>        # dry-run de una escuela
 *   npx tsx scripts/resellar-cola-comprobantes.ts --aplicar                    # sella como máximo 10
 *   npx tsx scripts/resellar-cola-comprobantes.ts --aplicar --limite 41 --pausa-ms 4000
 *
 * ⚠ ADVERTENCIAS (léelas antes de --aplicar):
 *   1. El sellado termina en `evaluatePaymentReceipt`. En una escuela con la
 *      APROBACIÓN AUTOMÁTICA encendida, un comprobante que cumple PUEDE QUEDAR
 *      APROBADO (y avisar a la familia, y acreditar saldo a favor si sobra). Es
 *      lo mismo que habría pasado al subirlo, pero pasa ahora. Un rojo puede
 *      quedar rechazado y un duplicado (23505) se rechaza automáticamente (D4).
 *   2. Cada cobro sellado GASTA UNA LECTURA OCR (y, si hay auto-aprobación, la
 *      segunda lectura que esa decisión pide). Los «compartidos» y las rutas
 *      inválidas no gastan OCR.
 *   3. La base es UNA sola para dev, stg y prod: esto escribe en producción.
 *   4. Una sesión a la vez: va de a uno, con pausa entre llamadas (Disk IO).
 *
 * Sin --aplicar solo hace SELECT (cola, archivos compartidos, nombres de escuela
 * y si tienen auto-aprobación).
 */
import 'dotenv/config';
import {
    COLUMNAS_RESELLADO, claveArchivo, conteoPorEscuela, loteDeEstaCorrida, opcionesResellado, planDeResellado,
    type FilaResellado,
} from '../src/services/resellado-cola';
import { rutaDelComprobante } from '../src/services/comprobante-sellado.service';

const LIMITE_LECTURA = 2000;
const TROZO = 50;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    const op = opcionesResellado(process.argv.slice(2));
    const { supabase } = await import('../src/config/supabase');

    // 1. La cola sin sello del servidor (SELECT).
    let q = supabase.from('payments').select(COLUMNAS_RESELLADO)
        .eq('status', 'awaiting_approval')
        .not('receipt_url', 'is', null)
        .or('receipt_image_sha256_source.is.null,receipt_image_sha256_source.neq.server_verified');
    if (op.escuela) q = q.eq('school_id', op.escuela);
    const { data: cola, error } = await q.limit(LIMITE_LECTURA);
    if (error) throw new Error(`payments: ${error.message}`);
    const filas = (cola ?? []) as unknown as FilaResellado[];

    // 2. Archivos que usa otro cobro vivo (el sellado no los lee). SELECT por trozos.
    const rutas = [...new Set(filas.map((f) => rutaDelComprobante(f.receipt_url)).filter((r): r is string => !!r))];
    const usos = new Map<string, Set<string>>();
    for (let i = 0; i < rutas.length; i += TROZO) {
        const { data, error: e2 } = await supabase.from('payments').select('id, school_id, receipt_url')
            .in('receipt_url', rutas.slice(i, i + TROZO))
            .not('status', 'in', '(rejected,cancelled,failed)')
            .limit(LIMITE_LECTURA);
        if (e2) throw new Error(`payments (compartidos): ${e2.message}`);
        for (const f of (data ?? []) as any[]) {
            const k = claveArchivo(f.school_id, f.receipt_url);
            const s = usos.get(k) ?? new Set<string>();
            s.add(f.id);
            usos.set(k, s);
        }
    }
    const compartidos = new Set([...usos].filter(([, ids]) => ids.size >= 2).map(([k]) => k));
    const plan = planDeResellado(filas, compartidos);

    // 3. Nombre de la escuela y si tiene auto-aprobación (SELECT).
    const escuelas = [...new Set(plan.map((p) => p.fila.school_id).filter((s): s is string => !!s))];
    const nombres = new Map<string, string>();
    const auto = new Map<string, boolean>();
    if (escuelas.length) {
        const [{ data: sch }, { data: ajustes }] = await Promise.all([
            supabase.from('schools').select('id, name').in('id', escuelas),
            supabase.from('school_settings').select('school_id, auto_approve_enabled, auto_approve_max_amount').in('school_id', escuelas),
        ]);
        for (const s of (sch ?? []) as any[]) nombres.set(s.id, s.name);
        for (const a of (ajustes ?? []) as any[]) auto.set(a.school_id, !!a.auto_approve_enabled && Number(a.auto_approve_max_amount) > 0);
    }

    const conteo = conteoPorEscuela(plan);
    const total = conteo.reduce((s, c) => s + c.total, 0);
    const lecturas = conteo.reduce((s, c) => s + c.sellar, 0);
    console.log(`\nRe-sellado de la cola «por validar» — ${op.aplicar ? 'APLICAR' : 'DRY-RUN (no lee OCR, no escribe)'}`);
    console.log(`Cobros sin sello del servidor: ${total} · se sellarían (1 lectura OCR c/u): ${lecturas}\n`);
    console.log('| Escuela | Total | Sellar | Compartido | Ruta inválida | Veredicto guardado | Fuente de la huella | Auto-aprobación |');
    console.log('|---|---|---|---|---|---|---|---|');
    const fmt = (r: Record<string, number>) => Object.entries(r).map(([k, n]) => `${k} ${n}`).join(', ');
    for (const c of conteo) {
        console.log(`| ${nombres.get(c.schoolId) ?? c.schoolId} | ${c.total} | ${c.sellar} | ${c.compartido} | ${c.rutaInvalida} | ${fmt(c.porVeredicto)} | ${fmt(c.porFuente)} | ${auto.get(c.schoolId) ? 'ENCENDIDA (puede aprobar)' : 'apagada'} |`);
    }
    console.log('\nDetalle (id · escuela · acción · veredicto · fuente):');
    for (const { fila, accion } of plan) {
        console.log(`  ${fila.id} · ${nombres.get(fila.school_id ?? '') ?? fila.school_id} · ${accion} · ${fila.receipt_verdict ?? 'sin veredicto'} · ${fila.receipt_image_sha256_source ?? 'sin fuente'}`);
    }

    if (!op.aplicar) {
        console.log(`\nDRY-RUN: no se leyó ningún comprobante ni se escribió nada. Para sellar: --aplicar [--limite N] (por defecto ${op.limite}).`);
        return;
    }

    // 4. --aplicar: de a uno, con pausa.
    const lote = loteDeEstaCorrida(plan, op.limite);
    console.log(`\n⚠ Se van a sellar ${lote.length} cobro(s) (límite ${op.limite}, pausa ${op.pausaMs} ms). `
        + 'En escuelas con aprobación automática el sellado puede APROBAR. Ctrl+C en los próximos 10 s para cancelar.');
    await esperar(10_000);
    const { sellarComprobante } = await import('../src/services/comprobante-sellado.service');
    const resultados: Record<string, number> = {};
    for (const [i, { fila }] of lote.entries()) {
        const r = await sellarComprobante(fila.id, { sistema: true });
        const etiqueta = r.ok
            ? `ok · veredicto ${r.verdict ?? '—'} · acción ${r.action}${r.duplicado ? ' · DUPLICADO' : ''}${r.motivo ? ` · ${r.motivo}` : ''}`
            : `error ${r.status} · ${r.error}`;
        const clave = r.ok ? `${r.verdict ?? 'sin veredicto'}/${r.action}` : `error ${r.status}`;
        resultados[clave] = (resultados[clave] ?? 0) + 1;
        console.log(`  [${i + 1}/${lote.length}] ${fila.id} (${nombres.get(fila.school_id ?? '') ?? fila.school_id}): ${etiqueta}`);
        if (i < lote.length - 1) await esperar(op.pausaMs);
    }
    console.log(`\nResultado: ${fmt(resultados) || 'nada que sellar'}`);
    const quedan = plan.filter((p) => p.accion === 'sellar').length - lote.length;
    if (quedan > 0) console.log(`Quedan ${quedan} por sellar: vuelve a correr con --aplicar.`);
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
