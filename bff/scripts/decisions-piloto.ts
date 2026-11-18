/**
 * Prueba en paralelo: detector de ausencias (regex) vs Decisions API de Google.
 * NO toca producción: no envía nada por WhatsApp ni escribe en la base.
 *
 *   cd bff && npx tsx scripts/decisions-piloto.ts <carpeta_de_salida>
 *       Modo SINTÉTICO (por defecto): frases de ejemplo con la respuesta esperada.
 *       No manda datos de familias a Google.
 *
 *   cd bff && npx tsx scripts/decisions-piloto.ts <carpeta_de_salida> --real [--horas 72]
 *       Modo REAL: lee mensajes entrantes de texto de Monster (SELECT) y los manda
 *       a Google. Solo correrlo con la aprobación del dueño (datos de familias).
 *       El informe NO guarda teléfonos ni nombres, solo el texto.
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { detectaAusencia } from '../src/services/whatsapp-ausencias.service';
import { clasificarMensajeFamilia, CATEGORIAS_AUSENCIA } from '../src/services/gemini-decisions.service';

const INTEG = '090b0237-58e4-48df-8475-529077218939';
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.';
const REAL = process.argv.includes('--real');
const iH = process.argv.indexOf('--horas');
const HORAS = iH > 0 ? Number(process.argv[iH + 1]) || 72 : 72;
const HOY = new Date().toISOString().slice(0, 10);
const UMBRAL = 0.5; // P(ausencia_proxima)+P(ausencia_larga_o_evento)

type Caso = { texto: string; esperado: boolean | null };

// esperado: true = SÍ avisa ausencia; false = NO; null = sin etiqueta (modo real)
const SINTETICOS: Caso[] = [
    { texto: 'Buenas tardes, hoy no podemos ir al entrenamiento, está enfermo', esperado: true },
    { texto: 'Mañana Juan no asiste porque tiene cita médica', esperado: true },
    { texto: 'El sábado no va a poder ir, tiene un cumpleaños', esperado: true },
    { texto: 'Hoy no alcanzamos a llegar, se nos hizo tarde', esperado: true },
    { texto: 'vamos a salir del grupo de capacitaciones porque no alcanzamos a ir', esperado: false },
    { texto: 'Quiero retirar a mi hija de la escuela, ya no vamos a continuar', esperado: false },
    { texto: 'A qué hora es el entrenamiento de mañana?', esperado: false },
    { texto: 'Si no puede ir me avisan por favor', esperado: false },
    { texto: 'El mes pasado no asistió y me cobraron igual', esperado: false },
    { texto: 'Ya hice la transferencia, no puedo adjuntar el comprobante', esperado: false },
    { texto: 'Los sábados no puede ir porque estudia inglés', esperado: false },
    { texto: 'Hola, buenas tardes', esperado: false },
    { texto: 'Mañana no hay clase por el festivo?', esperado: false },
    { texto: 'Hoy mi hijo no va, se lastimó la rodilla', esperado: true },
];

async function casosReales(): Promise<Caso[]> {
    const { supabase } = await import('../src/config/supabase');
    const desde = new Date(Date.now() - HORAS * 3600_000).toISOString();
    const convs = await supabase.from('whatsapp_conversations').select('id')
        .eq('integration_id', INTEG).gte('last_message_at', desde).limit(600);
    if (convs.error) throw new Error(convs.error.message);
    const ids = (convs.data ?? []).map((c: { id: string }) => c.id);
    const out: Caso[] = [];
    for (let i = 0; i < ids.length; i += 60) {
        const r = await supabase.from('whatsapp_messages').select('text_body')
            .in('conversation_id', ids.slice(i, i + 60)).eq('direction', 'inbound').eq('type', 'text')
            .gte('created_at', desde).limit(1000);
        if (r.error) throw new Error(r.error.message);
        for (const f of r.data ?? []) {
            const t = String((f as { text_body: string | null }).text_body ?? '').trim();
            if (t && t.length <= 400) out.push({ texto: t, esperado: null });
        }
    }
    return out;
}

async function main() {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
    const casos = REAL ? await casosReales() : SINTETICOS;
    console.log(`Modo ${REAL ? 'REAL' : 'SINTÉTICO'}: ${casos.length} mensajes`);

    const filas: { texto: string; regex: boolean; pSi: number | null; conf: number | null; ms: number | null; esperado: boolean | null; cat: string }[] = [];
    let sinRespuesta = 0;
    for (const c of casos) {
        const regex = detectaAusencia(c.texto, HOY) !== null;
        const d = await clasificarMensajeFamilia(c.texto);
        if (!d) sinRespuesta++;
        const pSi = d ? CATEGORIAS_AUSENCIA.reduce((a, k) => a + (d.probabilidades[k] ?? 0), 0) : null;
        filas.push({ texto: c.texto, regex, pSi, conf: d?.confianza ?? null, ms: d?.ms ?? null, esperado: c.esperado, cat: d?.opcion ?? '' });
        await new Promise((r) => setTimeout(r, 120)); // sin ráfagas: el plan gratis tiene tope por minuto
    }

    const api = (f: (typeof filas)[number]) => (f.pSi === null ? null : f.pSi >= UMBRAL);
    const dif = filas.filter((f) => api(f) !== null && api(f) !== f.regex);
    const etiq = filas.filter((f) => f.esperado !== null && api(f) !== null);
    const acierto = (pred: (f: (typeof filas)[number]) => boolean | null) =>
        etiq.length ? `${etiq.filter((f) => pred(f) === f.esperado).length}/${etiq.length}` : 'n/a (sin etiquetas)';
    const mss = filas.map((f) => f.ms).filter((x): x is number => x !== null).sort((a, b) => a - b);

    const md: string[] = [];
    md.push(`# Piloto Decisions API vs regex de ausencias (${REAL ? 'datos reales' : 'sintético'})`);
    md.push('');
    md.push(`- Mensajes: ${filas.length} · sin respuesta de la API: ${sinRespuesta}`);
    md.push(`- Umbral sí/no: P(sí) ≥ ${UMBRAL}`);
    md.push(`- Aciertos regex: ${acierto((f) => f.regex)} · Aciertos API: ${acierto((f) => api(f))}`);
    md.push(`- Latencia mediana API: ${mss.length ? mss[mss.length >> 1] + ' ms' : '–'}`);
    md.push(`- Discrepancias regex ≠ API: ${dif.length}`);
    md.push('');
    md.push('## Discrepancias');
    md.push('| Texto | Regex | API P(ausencia) | Categoría API | Esperado |');
    md.push('|---|---|---|---|---|');
    for (const f of dif) {
        md.push(`| ${f.texto.replace(/\|/g, '/').replace(/\s+/g, ' ')} | ${f.regex ? 'sí' : 'no'} | ${f.pSi?.toFixed(2)} | ${f.cat} | ${f.esperado === null ? '?' : f.esperado ? 'sí' : 'no'} |`);
    }
    mkdirSync(OUT, { recursive: true });
    const ruta = join(OUT, REAL ? 'decisions-piloto-real.md' : 'decisions-piloto-sintetico.md');
    writeFileSync(ruta, md.join('\n'), 'utf8');
    console.log(md.slice(0, 7).join('\n'));
    console.log('Informe:', ruta);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
