/**
 * Registro de avisos de WhatsApp: qué avisos automáticos salieron, a quién y con qué resultado. SOLO LECTURA.
 *
 *   cd bff
 *   npx tsx scripts/registro-avisos.ts --escuela monsters-volley-club              # últimas 24 h
 *   npx tsx scripts/registro-avisos.ts --escuela monsters-volley-club --horas 72
 *   npx tsx scripts/registro-avisos.ts --escuela monsters-volley-club --csv C:/tmp/avisos.csv   # detalle con teléfono (no subir al repo)
 *
 * FUENTE: whatsapp_messages saliente con payload.step de aviso (cobro_*, acuse_*, plantillas) o payload.automatico.
 * Todo aviso que sale ya queda ahí; este script solo lo ordena. NO ve los avisos que NO salieron (sin opt-in, fuera de
 * horario, bandera apagada): esos no dejan fila. Registrarlos pide una tabla nueva → plan y aprobación primero.
 * En pantalla el teléfono va enmascarado.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { supabase } from '../src/config/supabase';

const args = process.argv.slice(2);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? (args[i + 1] ?? '') : ''; };
const SLUG = val('--escuela');
const HORAS = Math.max(1, parseInt(val('--horas'), 10) || 24);
const CSV = val('--csv');

const esAviso = (p: any) => !!p && (p.automatico === true || /^(cobro_|acuse_|grupo_|recordatorio_)/.test(String(p.step ?? '')));
const mascara = (t: string | null) => (t ? `${t.slice(0, 5)}…${t.slice(-3)}` : 'sin teléfono');

async function main() {
    if (!SLUG) { console.error('Falta --escuela <slug>'); process.exit(1); }
    const { data: esc } = await supabase.from('schools').select('id,name').eq('slug', SLUG).maybeSingle();
    if (!esc) { console.error(`No hay escuela con slug ${SLUG}`); process.exit(1); }
    const desde = new Date(Date.now() - HORAS * 3600_000).toISOString();

    const { data: convs } = await supabase.from('whatsapp_conversations').select('id,contact_name').eq('school_id', esc.id);
    const nombre = new Map((convs ?? []).map((c: any) => [c.id, c.contact_name as string | null]));
    const ids = [...nombre.keys()];
    const filas: any[] = [];
    for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('whatsapp_messages')
            .select('conversation_id,to_wa_id,type,status,payload,created_at')
            .eq('direction', 'outbound').gte('created_at', desde).in('conversation_id', ids.slice(i, i + 200));
        if (error) throw error;
        filas.push(...(data ?? []));
    }
    const avisos = filas.filter((f) => esAviso(f.payload)).sort((a, b) => a.created_at.localeCompare(b.created_at));

    console.log(`\nAvisos de ${esc.name} · últimas ${HORAS} h · ${avisos.length} (de ${filas.length} salientes)\n`);
    const por = new Map<string, { n: number; fallidos: number; personas: Set<string>; ultimo: string }>();
    for (const a of avisos) {
        const clave = `${a.payload?.step ?? '(sin step)'}${a.payload?.plantilla ? ` · ${a.payload.plantilla}` : ''}`;
        const g = por.get(clave) ?? { n: 0, fallidos: 0, personas: new Set(), ultimo: '' };
        g.n++; g.personas.add(a.conversation_id); g.ultimo = a.created_at;
        if (a.status === 'failed') g.fallidos++;
        por.set(clave, g);
    }
    for (const [k, g] of [...por.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`${String(g.n).padStart(4)}  ${k}  · ${g.personas.size} persona(s)${g.fallidos ? ` · ${g.fallidos} FALLIDO(S)` : ''} · último ${g.ultimo.slice(0, 16).replace('T', ' ')}`);
    }
    console.log('\nDetalle (más recientes):');
    for (const a of avisos.slice(-25)) {
        console.log(`${a.created_at.slice(0, 16).replace('T', ' ')}  ${mascara(a.to_wa_id).padEnd(12)}  ${(nombre.get(a.conversation_id) ?? '—').slice(0, 24).padEnd(24)}  ${a.payload?.step ?? ''}  [${a.status}]`);
    }
    if (CSV) {
        const linea = (a: any) => [a.created_at, a.to_wa_id ?? '', nombre.get(a.conversation_id) ?? '', a.payload?.step ?? '', a.payload?.plantilla ?? '', a.status ?? '']
            .map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',');
        writeFileSync(CSV, ['fecha,telefono,contacto,paso,plantilla,estado', ...avisos.map(linea)].join('\n'), 'utf8');
        console.log(`\nCSV con teléfonos: ${CSV} (no subir al repo)`);
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
