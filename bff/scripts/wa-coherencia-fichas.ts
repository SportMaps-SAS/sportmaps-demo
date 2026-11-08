/**
 * Coherencia del texto del asistente contra el catálogo, para TODAS las escuelas
 * con servicios vigentes (plan docs/specs/whatsapp-ventas-de-servicio-blindaje.md,
 * frente B). SOLO LECTURA: no escribe nada ni manda mensajes.
 *
 *   cd bff
 *   npx tsx scripts/wa-coherencia-fichas.ts                       # todas las escuelas con servicios vigentes
 *   npx tsx scripts/wa-coherencia-fichas.ts --escuela <school_id> # una escuela
 *   npx tsx scripts/wa-coherencia-fichas.ts --json                # salida en JSON
 *   npx tsx scripts/wa-coherencia-fichas.ts --escuela <id> --ficha borrador.txt
 *       # audita un BORRADOR (o una versión vieja) contra el catálogo real de la escuela, sin guardarlo
 *
 * Revisa la ficha de prospectos (`school_settings.wa_ficha_prospectos`, o la
 * clave puente en `schools.payment_settings`) y la descripción de cada servicio
 * contra sus precios del catálogo (precio, tramos por fecha, afiliado, abono,
 * opciones). Caso Monster 2026-11-08: la ficha decía «preventa hasta el 9 de
 * noviembre», el catálogo «hasta el 10».
 *
 * Tres consultas en total (catálogo, ajustes, escuelas), con tope: regla de Disk
 * IO del CLAUDE.md.
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { supabase } from '../src/config/supabase';
import { servicioVigente, type ItemConFicha } from '../src/services/whatsapp-anuncio-destino';
import { textoLargoLimpio } from '../src/services/whatsapp-prospecto-ia.service';
import { coherenciaDe } from '../src/routes/whatsapp-coherencia.routes';

const COLUMNAS = 'school_id, id, name, kind, price, active, event_id, starts_at, ends_at, description, image_url, '
    + 'allow_installments, precio_afiliado, precios_por_fecha, abono_minimo_pct, opciones';
const TOPE_ITEMS = 2000;

function arg(nombre: string): string | undefined {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const linea = (t = '─') => console.log(t.repeat(72));

async function main() {
    const escuela = arg('--escuela');
    const json = process.argv.includes('--json');
    const archivo = arg('--ficha');
    if ((escuela && !/^[0-9a-f-]{36}$/i.test(escuela)) || (archivo && !escuela)) {
        console.error('Uso: npx tsx scripts/wa-coherencia-fichas.ts [--escuela <school_id> [--ficha borrador.txt]] [--json]');
        process.exit(1);
    }
    const borrador = archivo ? textoLargoLimpio(readFileSync(archivo, 'utf8')) : null;

    let q = supabase.from('school_tournament_items').select(COLUMNAS).eq('active', true).is('event_id', null);
    if (escuela) q = q.eq('school_id', escuela);
    const { data: filas, error } = await q.limit(TOPE_ITEMS);
    if (error) throw new Error(`No se pudo leer el catálogo: ${error.message}`);
    const ahora = Date.now();
    const porEscuela = new Map<string, ItemConFicha[]>();
    for (const f of (filas ?? []) as any[]) {
        if (!servicioVigente(f, ahora)) continue;
        const { school_id: sid, ...item } = f;
        porEscuela.set(sid, [...(porEscuela.get(sid) ?? []), item as ItemConFicha]);
    }
    const ids = [...porEscuela.keys()];
    if (!ids.length) {
        console.log(escuela ? 'Esa escuela no tiene servicios vigentes.' : 'Ninguna escuela tiene servicios vigentes.');
        return;
    }

    const [{ data: ajustes }, { data: escuelas }] = await Promise.all([
        supabase.from('school_settings').select('school_id, wa_ficha_prospectos').in('school_id', ids),
        supabase.from('schools').select('id, name, ficha_puente:payment_settings->>wa_ficha_prospectos').in('id', ids),
    ]);
    const fichaDe = new Map<string, string | null>();
    for (const e of (escuelas ?? []) as any[]) fichaDe.set(e.id, textoLargoLimpio(e.ficha_puente));
    for (const a of (ajustes ?? []) as any[]) {
        const v = textoLargoLimpio(a.wa_ficha_prospectos);
        if (v) fichaDe.set(a.school_id, v);
    }
    const nombreDe = new Map(((escuelas ?? []) as any[]).map((e) => [e.id, String(e.name ?? e.id)]));
    if (escuela && archivo) fichaDe.set(escuela, borrador);

    const resultado = ids.map((id) => ({ escuela: id, nombre: nombreDe.get(id) ?? id, ...coherenciaDe(fichaDe.get(id) ?? null, porEscuela.get(id)!) }))
        .sort((a, b) => b.contradicciones.length - a.contradicciones.length || a.nombre.localeCompare(b.nombre));

    if (json) {
        console.log(JSON.stringify(resultado, null, 2));
        return;
    }
    linea('═');
    console.log(`  Coherencia texto del asistente ↔ catálogo · ${resultado.length} escuela(s) con servicios vigentes · solo lectura`);
    if (archivo) console.log(`  Ficha: el borrador ${archivo} (no la guardada)`);
    linea('═');
    for (const r of resultado) {
        console.log(`  ${r.nombre} (${r.escuela})`);
        console.log(`    Servicios vigentes: ${r.servicios} · ficha de prospectos: ${r.ficha ? 'sí' : 'no'} · contradicciones: ${r.contradicciones.length}`);
        for (const c of r.contradicciones) {
            console.log(`    • [${c.fuente} L${c.linea}] ${c.mensaje}`);
        }
        linea();
    }
    const total = resultado.reduce((s, r) => s + r.contradicciones.length, 0);
    console.log(`  Total: ${total} contradicción(es) en ${resultado.filter((r) => r.contradicciones.length).length} escuela(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
