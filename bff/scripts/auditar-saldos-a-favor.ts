/**
 * auditar-saldos-a-favor — retro-auditoría de los saldos a favor automáticos
 * (§8.3 y D7 de docs/specs/seguridad-veredicto-comprobante-plan.md). SOLO LECTURA.
 *
 * El saldo a favor lo acredita `fn_payments_saldo_a_favor_al_aprobar` con el
 * `ocr_amount` del cobro, que hasta el 2026-11-25 podía escribir la familia. Para
 * cada `payment_adjustments.kind='saldo_a_favor'` lista cobro, escuela, crédito,
 * `ocr_amount` guardado y fuente de la huella. Con --releer descarga la imagen
 * guardada y la vuelve a leer con OCR para comparar el monto de hoy con el
 * guardado; marca «revisar» si difieren más de 1 % o si no se puede leer.
 *
 *   cd bff
 *   npx tsx scripts/auditar-saldos-a-favor.ts --salida <carpeta>                       # sin OCR
 *   npx tsx scripts/auditar-saldos-a-favor.ts --salida <carpeta> --releer [--pausa-ms 3000]
 *
 * La salida (CSV + resumen .md) tiene NOMBRES DE FAMILIAS: va a una carpeta fuera
 * del repo (scratchpad). El script se niega a escribir dentro del repo.
 *
 * --releer gasta una lectura OCR por crédito (~42). No escribe en la base: solo
 * SELECT, descarga del bucket y OCR, con el registro de uso de LLM apagado
 * (DISABLE_LLM_USAGE_LOG) para no insertar en `llm_usage`. Nada se reversa (D7).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
    aCsv, compararLectura, resumenMarkdown, resumir, type FilaSaldoAFavor,
} from '../src/services/auditoria-saldos-a-favor';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const RELEER = process.argv.includes('--releer');
const PAUSA_MS = Number(arg('--pausa-ms') ?? 3000);
const LIMITE = 2000;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    const salida = arg('--salida');
    if (!salida) throw new Error('Falta --salida <carpeta> (fuera del repo: el informe tiene nombres de familias).');
    const destino = path.resolve(salida);
    const repo = path.resolve(__dirname, '..', '..');
    if (!path.relative(repo, destino).startsWith('..') && !path.isAbsolute(path.relative(repo, destino))) {
        throw new Error(`--salida está dentro del repo (${destino}). Usa una carpeta fuera, p. ej. el scratchpad.`);
    }
    // Ninguna escritura: ni siquiera el registro de uso del OCR.
    process.env.DISABLE_LLM_USAGE_LOG = 'true';
    const { supabase } = await import('../src/config/supabase');

    // 1. Los créditos (SELECT).
    const { data: ajustes, error } = await supabase.from('payment_adjustments')
        .select('id, payment_id, school_id, amount, origin, created_at')
        .eq('kind', 'saldo_a_favor')
        .order('created_at', { ascending: true })
        .limit(LIMITE);
    if (error) throw new Error(`payment_adjustments: ${error.message}`);
    const aj = (ajustes ?? []) as any[];
    if (!aj.length) {
        console.log('No hay saldos a favor.');
        return;
    }

    // 2. Cobros, escuelas y nombres (SELECT por trozos).
    const trozos = <T,>(xs: T[], n = 100) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
    const pagos = new Map<string, any>();
    for (const t of trozos([...new Set(aj.map((a) => a.payment_id))])) {
        const { data, error: e } = await supabase.from('payments')
            .select('id, school_id, amount, concept, ocr_amount, receipt_image_sha256_source, receipt_url, parent_id, user_id, child_id, unregistered_athlete_id')
            .in('id', t);
        if (e) throw new Error(`payments: ${e.message}`);
        for (const p of (data ?? []) as any[]) pagos.set(p.id, p);
    }
    const ps = [...pagos.values()];
    const ids = (k: string) => [...new Set(ps.map((p) => p[k]).filter(Boolean))] as string[];
    const nombre = new Map<string, string>();
    const leer = async (tabla: string, col: string, lista: string[]) => {
        for (const t of trozos(lista)) {
            const { data } = await supabase.from(tabla).select(`id, ${col}`).in('id', t);
            for (const r of (data ?? []) as any[]) nombre.set(r.id, r[col] ?? '');
        }
    };
    await Promise.all([
        leer('schools', 'name', [...new Set(aj.map((a) => a.school_id))]),
        leer('profiles', 'full_name', [...new Set([...ids('parent_id'), ...ids('user_id')])]),
        leer('children', 'full_name', ids('child_id')),
        leer('unregistered_athletes', 'full_name', ids('unregistered_athlete_id')),
    ]);

    const filas: FilaSaldoAFavor[] = aj.map((a) => {
        const p = pagos.get(a.payment_id) ?? {};
        const atleta = nombre.get(p.child_id) || nombre.get(p.unregistered_athlete_id) || '';
        const pagador = nombre.get(p.parent_id) || nombre.get(p.user_id) || '';
        return {
            ajusteId: a.id, pagoId: a.payment_id, schoolId: a.school_id, escuela: nombre.get(a.school_id) || a.school_id,
            familia: [atleta, pagador && pagador !== atleta ? `(paga ${pagador})` : ''].filter(Boolean).join(' '),
            concepto: p.concept ?? '', creadoEn: a.created_at, credito: Number(a.amount) || 0, montoCobro: Number(p.amount) || 0,
            ocrGuardado: p.ocr_amount == null ? null : Number(p.ocr_amount), fuenteHuella: p.receipt_image_sha256_source ?? null,
            origen: a.origin ?? '', receiptUrl: p.receipt_url ?? null,
        };
    });

    // 3. --releer: descarga y OCR, sin escribir nada.
    if (RELEER) {
        const { extractReceiptWithFallback, listConfiguredProviders, tipoPorFirma } = await import('../src/services/ocr.service');
        const { BUCKET_COMPROBANTES, rutaDelComprobante, tipoPorExtension } = await import('../src/services/comprobante-sellado.service');
        const proveedores = listConfiguredProviders();
        for (const [i, f] of filas.entries()) {
            const ruta = rutaDelComprobante(f.receiptUrl);
            if (!ruta) {
                f.errorRelectura = 'el comprobante no está en el bucket';
            } else {
                const { data: blob, error: dl } = await supabase.storage.from(BUCKET_COMPROBANTES).download(ruta);
                if (dl || !blob) {
                    f.errorRelectura = `no se pudo descargar (${dl?.message ?? 'vacío'})`;
                } else {
                    const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
                    const lectura = await extractReceiptWithFallback(proveedores, base64, tipoPorFirma(base64) ?? tipoPorExtension(ruta));
                    if (!lectura) f.errorRelectura = 'ningún proveedor lo pudo leer';
                    else f.ocrHoy = lectura.result.amount;
                }
            }
            console.log(`  [${i + 1}/${filas.length}] ${f.pagoId}: ${f.errorRelectura ?? `hoy ${f.ocrHoy} · guardado ${f.ocrGuardado}`}`);
            if (i < filas.length - 1) await esperar(PAUSA_MS);
        }
    }

    const comparadas = filas.map((fila) => ({ fila, cmp: compararLectura(fila, RELEER) }));
    const fecha = new Date().toISOString().slice(0, 10);
    const sufijo = RELEER ? 'releido' : 'sin-releer';
    fs.mkdirSync(destino, { recursive: true });
    const csv = path.join(destino, `saldos-a-favor-${fecha}-${sufijo}.csv`);
    const md = path.join(destino, `saldos-a-favor-${fecha}-${sufijo}.md`);
    const resumen = resumenMarkdown(resumir(comparadas), RELEER, fecha);
    fs.writeFileSync(csv, aCsv(comparadas), 'utf8');
    fs.writeFileSync(md, resumen, 'utf8');
    console.log(`\n${resumen}\nCSV: ${csv}\nResumen: ${md}`);
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
