/**
 * Registro de avisos de WhatsApp: qué avisos automáticos salieron, a quién y con qué resultado. SOLO LECTURA.
 *
 *   cd bff
 *   npx tsx scripts/registro-avisos.ts --escuela monsters-volley-club              # últimas 24 h
 *   npx tsx scripts/registro-avisos.ts --escuela monsters-volley-club --horas 72
 *   npx tsx scripts/registro-avisos.ts --escuela monsters-volley-club --csv C:/tmp/avisos.csv   # detalle con teléfono (no subir al repo)
 *
 * FUENTE: whatsapp_messages saliente con payload.step de aviso (cobro_*, acuse_*, plantillas) o payload.automatico.
 * Todo aviso que sale ya queda ahí; este script solo lo ordena. Los que NO salieron (sin opt-in, fuera de horario…) se
 * leen de whatsapp_avisos_log, que solo se llena con WA_AVISOS_LOG_SCHOOL_IDS encendida en el BFF (sección «No salieron»).
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
    // Avisos que NO salieron: viven en whatsapp_avisos_log (solo se llena con WA_AVISOS_LOG_SCHOOL_IDS encendida).
    const { data: logs, error: errLog } = await supabase.from('whatsapp_avisos_log')
        .select('concepto,plantilla,payment_id,parent_id,destino,resultado,motivo,detalle,created_at')
        .eq('school_id', esc.id).gte('created_at', desde).order('created_at', { ascending: true }).limit(5000);
    const noSalieron = (logs ?? []).filter((l: any) => l.resultado === 'no_enviado');
    const personas = new Map<string, string>();
    const parentIds = [...new Set(noSalieron.map((l: any) => l.parent_id).filter(Boolean))] as string[];
    for (let i = 0; i < parentIds.length; i += 200) {
        const { data } = await supabase.from('profiles').select('id,full_name').in('id', parentIds.slice(i, i + 200));
        for (const p of data ?? []) personas.set((p as any).id, (p as any).full_name ?? '');
    }
    const quien = (l: any) => personas.get(l.parent_id) || mascara(l.destino ?? null);
    console.log('\nNo salieron (whatsapp_avisos_log):');
    if (errLog) {
        console.log(`  no se pudo leer la tabla: ${errLog.message}`);
    } else if (!logs || logs.length === 0) {
        console.log('  sin filas en la ventana (¿WA_AVISOS_LOG_SCHOOL_IDS apagada, o sin intentos?)');
    } else {
        console.log(`  ${noSalieron.length} no enviado(s) de ${logs.length} intento(s) registrado(s)`);
        const porMotivo = new Map<string, { n: number; quienes: Set<string>; conceptos: Set<string>; ultimo: string }>();
        for (const l of noSalieron) {
            const g = porMotivo.get(l.motivo ?? '(sin motivo)') ?? { n: 0, quienes: new Set(), conceptos: new Set(), ultimo: '' };
            g.n++; g.quienes.add(quien(l)); g.conceptos.add(l.concepto); g.ultimo = l.created_at;
            porMotivo.set(l.motivo ?? '(sin motivo)', g);
        }
        for (const [m, g] of [...porMotivo.entries()].sort((a, b) => b[1].n - a[1].n)) {
            const lista = [...g.quienes].slice(0, 6).join(', ') + (g.quienes.size > 6 ? `, +${g.quienes.size - 6}` : '');
            console.log(`${String(g.n).padStart(4)}  ${m}  · ${g.quienes.size} persona(s) · ${[...g.conceptos].join('/')} · último ${g.ultimo.slice(0, 16).replace('T', ' ')}`);
            console.log(`        ${lista}`);
        }
    }
    if (CSV) {
        const linea = (a: any) => [a.created_at, a.to_wa_id ?? '', nombre.get(a.conversation_id) ?? '', a.payload?.step ?? '', a.payload?.plantilla ?? '', a.status ?? '']
            .map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',');
        writeFileSync(CSV, ['fecha,telefono,contacto,paso,plantilla,estado', ...avisos.map(linea),
            ...noSalieron.map((l: any) => [l.created_at, l.destino ?? '', personas.get(l.parent_id) ?? '', l.concepto, l.plantilla ?? '', `no_enviado:${l.motivo ?? ''}`]
                .map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\n'), 'utf8');
        console.log(`\nCSV con teléfonos: ${CSV} (no subir al repo)`);
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
