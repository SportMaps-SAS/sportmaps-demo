/**
 * Pasa a «Por clasificar» (Cobros) los comprobantes con dinero que ya estaban en la bandeja.
 * No aprueba nada, no crea `payments`, no le escribe a nadie. Idempotente (por fila de la cola).
 *
 *   cd bff
 *   npx tsx scripts/wa-bandeja-a-por-clasificar.ts --escuela <school_id>                 # simulación (NO escribe)
 *   npx tsx scripts/wa-bandeja-a-por-clasificar.ts --escuela <school_id> --desde 2026-11-04
 *   npx tsx scripts/wa-bandeja-a-por-clasificar.ts --escuela <school_id> --aplicar       # escribe
 *
 * Spec: docs/specs/whatsapp-comprobantes-nunca-en-la-bandeja.md (fases 1 y 4).
 * Requiere la migración 20261118124124 aplicada (sin ella `--aplicar` no registra nada y lo dice).
 *
 * QUÉ TOMA: filas de `whatsapp_inbound_queue` de esa escuela en failed | ignored | waiting_user, con imagen o
 * documento, NO cerradas por la escuela, cuya lectura del OCR (ya guardada en `pregunta_ocr`) trae un monto y
 * cuyo motivo de bandeja es de plata (`decidirPorClasificar`: la misma regla del worker). El destino del
 * dinero se cruza con las cuentas de la escuela, igual que el worker.
 *
 * NO LEE EL OCR OTRA VEZ ni baja nada de Meta: usa lo que la cola ya guardó. Las filas sin lectura guardada
 * (archivo vencido, nunca leído) se cuentan aparte: para ésas está `wa-recuperar-comprobantes.ts`.
 */

import 'dotenv/config';
import { supabase } from '../src/config/supabase';
import { destinoEsDeLaEscuela, destinoFueraDeSportmaps } from '../src/jobs/whatsapp-queue.job';
import {
    decidirPorClasificar, registrarPorClasificar, type LecturaParaClasificar,
} from '../src/services/wa-comprobante-por-clasificar.service';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const ESCUELA = arg('--escuela');
const DESDE = arg('--desde') ?? '2026-10-01';
const APLICAR = process.argv.includes('--aplicar');

const cop = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

interface Fila {
    id: string; school_id: string; wa_phone_number: string; status: string; error_message: string | null;
    storage_path: string | null; media_caption: string | null; created_at: string; pregunta_ocr: any;
}

async function main() {
    if (!ESCUELA || !/^[0-9a-f-]{36}$/i.test(ESCUELA)) {
        console.error('Uso: npx tsx scripts/wa-bandeja-a-por-clasificar.ts --escuela <school_id> [--desde YYYY-MM-DD] [--aplicar]');
        process.exit(1);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) { console.error('--desde debe ser YYYY-MM-DD'); process.exit(1); }
    console.log(APLICAR ? '>>> MODO APLICAR: registra en «Por clasificar». NO aprueba, NO crea pagos, NO escribe a nadie.'
        : '>>> SIMULACIÓN: no escribe nada. Para aplicar, agregar --aplicar.');

    // Una sola lectura (sin N+1): la bandeja de esa escuela desde la fecha.
    const filas: Fila[] = [];
    for (let desde = 0; ; desde += 1000) {
        const { data, error } = await supabase.from('whatsapp_inbound_queue')
            .select('id,school_id,wa_phone_number,status,error_message,storage_path,media_caption,created_at,pregunta_ocr')
            .eq('school_id', ESCUELA).in('status', ['failed', 'ignored', 'waiting_user'])
            .in('message_type', ['image', 'document']).gte('created_at', DESDE)
            .order('created_at').range(desde, desde + 999);
        if (error) { console.error('No se pudo leer la cola:', error.message); process.exit(1); }
        filas.push(...((data ?? []) as Fila[]));
        if (!data || data.length < 1000) break;
    }

    const yaPorClasificar = new Set<string>();
    if (filas.length) {
        const { data } = await supabase.from('wa_comprobantes_por_clasificar').select('queue_id').in('queue_id', filas.map((f) => f.id));
        for (const r of (data ?? []) as { queue_id: string }[]) yaPorClasificar.add(r.queue_id);
    }

    const tabla: Record<string, unknown>[] = [];
    let sinLectura = 0, cerradas = 0, noEsPlata = 0, destinoAjeno = 0, ya = 0;
    const porEtiqueta = new Map<string, { n: number; monto: number }>();
    const aRegistrar: { fila: Fila; decision: NonNullable<ReturnType<typeof decidirPorClasificar>> }[] = [];

    for (const f of filas) {
        if ((f.error_message ?? '').startsWith('cerrado_escuela:')) { cerradas++; continue; }
        if (yaPorClasificar.has(f.id)) { ya++; continue; }
        const ocr = f.pregunta_ocr?.ocr as LecturaParaClasificar | undefined;
        if (!ocr) { sinLectura++; continue; }
        const decision = decidirPorClasificar({ errorMessage: f.error_message, ocr, texto: f.media_caption });
        if (!decision) { noEsPlata++; continue; }
        const aqui = { amount: decision.monto, destination: decision.destino } as any;
        if (!(await destinoEsDeLaEscuela(ESCUELA, aqui)) || (await destinoFueraDeSportmaps(ESCUELA, aqui))) { destinoAjeno++; continue; }
        aRegistrar.push({ fila: f, decision });
        const e = porEtiqueta.get(decision.etiqueta) ?? { n: 0, monto: 0 };
        e.n++; e.monto += decision.monto; porEtiqueta.set(decision.etiqueta, e);
        tabla.push({
            fila: f.id.slice(0, 8), llegó: f.created_at.slice(0, 16).replace('T', ' '), tel: `…${f.wa_phone_number.slice(-4)}`,
            monto: cop(decision.monto), ref: decision.referencia ?? '—', etiqueta: decision.etiqueta, motivo: decision.motivo,
        });
    }

    console.log(`\nFilas en la bandeja desde ${DESDE}: ${filas.length}`);
    console.table(tabla);
    console.log('Por etiqueta:');
    for (const [e, v] of [...porEtiqueta.entries()].sort((a, b) => b[1].monto - a[1].monto)) console.log(`  ${e.padEnd(20)} ${String(v.n).padStart(3)}  ${cop(v.monto)}`);
    console.log(`\nPasarían a «Por clasificar»: ${aRegistrar.length} (${cop(aRegistrar.reduce((s, x) => s + x.decision.monto, 0))})`);
    console.log(`No entran: ${sinLectura} sin lectura guardada · ${noEsPlata} sin monto o motivo que no es de plata · ${destinoAjeno} con destino ajeno · ${cerradas} ya cerradas · ${ya} ya registradas`);

    if (!APLICAR) { console.log('\nNada se escribió. Para aplicar: agregar --aplicar.'); return; }

    let ok = 0, repetidos = 0, referenciaUsada = 0, fallas = 0, pendiente = false;
    for (const { fila, decision } of aRegistrar) {
        const r = await registrarPorClasificar({
            schoolId: ESCUELA, queueId: fila.id, decision, storagePath: fila.storage_path,
            telefono: fila.wa_phone_number, nombre: null, motivoBot: fila.error_message,
        });
        if (r.ok) { ok++; if (r.repetido) repetidos++; }
        else if (r.codigo === 'migracion_pendiente') { pendiente = true; break; }
        else if (r.codigo === 'referencia_ya_usada') referenciaUsada++;
        else { fallas++; console.warn('  falló', fila.id.slice(0, 8), r.codigo); }
    }
    if (pendiente) {
        console.error('\nLa migración 20261118124124 no está aplicada: no se registró nada.');
        process.exit(2);
    }
    console.log(`\nRegistradas: ${ok} (${repetidos} repetidas de otra fila) · referencia ya usada por un pago: ${referenciaUsada} · fallas: ${fallas}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
