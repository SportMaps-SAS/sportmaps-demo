/**
 * Fija el texto que sale al tocar «Sí» en una campaña, leído de un archivo.
 * Existe porque pasar un texto de varias líneas por --respuesta-si en la consola
 * lo cortó en la primera línea (campaña de la clínica de Monster, 11-05).
 * Uso: npx tsx scripts/wa-campana-respuesta-si.ts --escuela <id> --campana <id> --archivo <ruta.txt>
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { supabase } from '../src/config/supabase';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const escuela = arg('--escuela'), campana = arg('--campana'), archivo = arg('--archivo');
if (!escuela || !campana || !archivo) { console.error('Faltan --escuela, --campana o --archivo.'); process.exit(1); }
const texto = readFileSync(archivo, 'utf8').replace(/\r\n/g, '\n').trim();
if (texto.length < 20 || texto.length > 4000) { console.error(`Texto fuera de rango (${texto.length}).`); process.exit(1); }
async function main() {
const { data, error } = await supabase.from('whatsapp_campanas')
    .update({ respuesta_si: texto }).eq('id', campana).eq('school_id', escuela).select('id, estado').maybeSingle();
if (error || !data) { console.error('No se pudo actualizar:', error?.message ?? 'campaña no encontrada'); process.exit(1); }
console.log(`✓ respuesta_si de ${data.id} (${data.estado}) = ${texto.length} caracteres.`);
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
