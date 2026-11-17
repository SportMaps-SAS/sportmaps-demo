/**
 * Monster´s Volley Club — pagos pendientes, rapidez de respuesta y campaña fallida.
 * SOLO LECTURA (SELECT). No envía nada.
 *
 *   cd bff && npx tsx scripts/monster-pendientes.ts <carpeta_de_salida>
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { supabase } from '../src/config/supabase';
import {
    comprobantesSinDesenlace, indexar, contactoCorto, horaCot, pesos, montoDe, momento, fechaCot, normalizar,
    esSalienteDelBot, esSalienteHumano,
    type FilaDeCola, type MensajeV, type ConversacionV, type ConceptoVivo,
} from '../src/services/whatsapp-vigilante.service';

const INTEG = '090b0237-58e4-48df-8475-529077218939';
const SCHOOL = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const OUT = process.argv[2] || '.';
const AHORA = Date.now();
const COT = 5 * 3600_000;
const DESDE_COLA = '2026-11-01T05:00:00Z';
const DESDE_MSG = '2026-11-09T05:00:00Z';
let consultas = 0;
const tel10 = (t: string | null | undefined) => String(t ?? '').replace(/\D/g, '').slice(-10);
const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const med = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; };
const fmtS = (s: number) => (Number.isNaN(s) ? '–' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);

type Msg = MensajeV & { status: string | null; error_detail: unknown; to_wa_id: string | null };

async function main() {
    // ── Lecturas (acotadas a la integración) ─────────────────────────────────
    consultas++;
    const colaQ = await supabase.from('whatsapp_inbound_queue')
        .select('id, wa_phone_number, message_type, status, result_type, error_message, storage_path, media_caption, created_at, updated_at, processed_at, pregunta_at, monto:pregunta_ocr->ocr->>amount, tipo:pregunta_ocr->>tipo')
        .eq('school_id', SCHOOL).eq('integration_id', INTEG).in('message_type', ['image', 'document'])
        .gte('created_at', DESDE_COLA).order('created_at', { ascending: false }).limit(1000);
    if (colaQ.error) throw new Error(colaQ.error.message);
    const cola = (colaQ.data ?? []) as unknown as FilaDeCola[];

    consultas++;
    const convQ = await supabase.from('whatsapp_conversations')
        .select('id, contact_wa_id, contact_name, status, tomada_hasta, parent_id')
        .eq('integration_id', INTEG).gte('last_message_at', DESDE_COLA).order('last_message_at', { ascending: false }).limit(600);
    if (convQ.error) throw new Error(convQ.error.message);
    const convs = (convQ.data ?? []) as unknown as ConversacionV[];

    consultas++;
    const conceptosQ = await supabase.from('whatsapp_conceptos_esperados').select('telefono, motivo, monto, vence_en')
        .eq('school_id', SCHOOL).is('consumido_at', null).limit(500);
    const conceptos = conceptosQ.error ? null : ((conceptosQ.data ?? []) as unknown as ConceptoVivo[]);

    const mensajes: Msg[] = [];
    const ids = convs.map((c) => c.id);
    let topeMsgs = false;
    for (let i = 0; i < ids.length; i += 60) {
        const lote = ids.slice(i, i + 60);
        for (let pag = 0; pag < 6; pag++) {
            consultas++;
            const { data, error } = await supabase.from('whatsapp_messages')
                .select('id, conversation_id, direction, type, text_body, ai_generated, wa_timestamp, created_at, status, error_detail, to_wa_id, step:payload->>step, automatico:payload->automatico, manual:payload->manual, campana:payload->>campana_id')
                .in('conversation_id', lote).gte('created_at', DESDE_MSG).order('created_at', { ascending: true })
                .range(pag * 1000, pag * 1000 + 999);
            if (error) throw new Error(error.message);
            const f = (data ?? []) as unknown as Msg[];
            mensajes.push(...f);
            if (f.length < 1000) break;
            if (pag === 5) topeMsgs = true;
        }
    }
    const indices = indexar(mensajes, convs);

    // ════════ ENTREGA 1 — pagos pendientes ════════════════════════════════════
    const concepto = (txt: string): string => {
        const n = normalizar(txt);
        if (/clinica|armador|atacante/.test(n)) return 'clínica';
        if (/vacacional/.test(n)) return 'vacacional';
        if (/torneo/.test(n)) return 'torneo';
        if (/matricula|inscripcion/.test(n)) return 'matrícula';
        if (/clase de prueba|prueba/.test(n)) return 'clase de prueba';
        if (/mensualidad|mes de|octubre|noviembre|septiembre/.test(n)) return 'mensualidad';
        return 'otro';
    };
    interface Fila {
        id: string; contacto: string; t: number; hora: string; monto: number | null; concepto: string; estado: string;
        horas: number; accion: string; dijo: string; tel: string; dup: boolean; nota: string;
    }
    const filas: Fila[] = [];
    for (const f of cola) {
        const r = comprobantesSinDesenlace({ cola: [f], conceptos, indices, ahora: AHORA });
        const it = r.items[0];
        if (!it) continue;
        const tel = tel10(f.wa_phone_number);
        const conv = indices.convPorTelefono.get(tel);
        const cercanos = conv ? (indices.porConversacion.get(conv.id) ?? []).filter((m) => Math.abs(momento(m) - it.t) <= 3 * 3600_000) : [];
        const pista = [f.media_caption, f.tipo, f.error_message, it.dijo, it.motivo, ...cercanos.map((m) => m.text_body)].join(' ');
        let est = 'cerrada en silencio';
        if (f.status === 'failed') est = 'fallida';
        else if (f.status === 'ignored' && f.result_type === 'escalated') est = 'en bandeja';
        else if (f.status === 'waiting_user') est = 'esperando al cliente';
        else if (f.status === 'pending' || f.status === 'processing') est = 'sin procesar';
        filas.push({
            id: f.id, contacto: it.contacto, t: it.t, hora: it.hora, monto: it.monto, concepto: concepto(pista), estado: est,
            horas: Math.floor((AHORA - it.t) / 3600_000), accion: it.queHacer, dijo: it.dijo, tel, dup: false, nota: it.motivo,
        });
    }
    // (ii) duplicados: mismo teléfono + mismo monto a menos de 72 h → se cuenta el más antiguo.
    filas.sort((a, b) => a.t - b.t);
    for (let i = 0; i < filas.length; i++) {
        if (filas[i].dup || filas[i].monto === null) continue;
        for (let j = i + 1; j < filas.length; j++) {
            if (!filas[j].dup && filas[j].tel === filas[i].tel && filas[j].monto === filas[i].monto && filas[j].t - filas[i].t <= 72 * 3600_000) filas[j].dup = true;
        }
    }
    // «Ya cobrado»: la misma persona tiene un archivo con el mismo monto que terminó en cobro (done+payment_receipt).
    const cobrados = new Set(cola.filter((f) => f.status === 'done' && f.result_type === 'payment_receipt' && montoDe(f.monto) !== null).map((f) => `${tel10(f.wa_phone_number)}|${montoDe(f.monto)}`));
    for (const f of filas) if (!f.dup && f.monto !== null && cobrados.has(`${f.tel}|${f.monto}`)) { f.dup = true; f.nota += ' · YA hay un archivo igual (mismo monto) que sí terminó en cobro'; }
    const unicas = filas.filter((f) => !f.dup).sort((a, b) => (b.monto ?? 0) - (a.monto ?? 0) || a.t - b.t);
    const dups = filas.filter((f) => f.dup);

    const porConcepto = new Map<string, { n: number; total: number; sinMonto: number }>();
    for (const f of unicas) {
        const c = porConcepto.get(f.concepto) ?? { n: 0, total: 0, sinMonto: 0 };
        c.n++; if (f.monto !== null) c.total += f.monto; else c.sinMonto++;
        porConcepto.set(f.concepto, c);
    }

    // (i) abonos parciales de la clínica y vacacional sin nombre — desde lo que el bot dijo en el chat.
    const parciales: { contacto: string; abono: number | null; saldo: number | null; hora: string; fecha: number }[] = [];
    const sinNombre: { contacto: string; monto: number | null; hora: string }[] = [];
    const num = (s: string | undefined) => (s ? Number(s.replace(/[^\d]/g, '')) : null);
    for (const c of convs) {
        const ms = indices.porConversacion.get(c.id) ?? [];
        const contacto = contactoCorto(c.contact_name, c.contact_wa_id);
        let ultimoParcial: { abono: number | null; saldo: number | null; t: number } | null = null;
        for (const m of ms) {
            if (m.direction !== 'outbound') continue;
            const tx = m.text_body ?? '';
            const q = tx.match(/Quedan \*?\$\s?([\d.]+)\*? para completar/i);
            const s = tx.match(/Saldo pendiente: \*?\$\s?([\d.]+)/i);
            const a = tx.match(/abono de \*?\$\s?([\d.]+)/i);
            if (m.step === 'venta_comprobante_recibido' && q) ultimoParcial = { abono: num(a?.[1]), saldo: num(q[1]), t: momento(m) };
            if (m.step === 'resultado_partial') ultimoParcial = { abono: num(a?.[1]), saldo: num(s?.[1]), t: momento(m) };
            if (m.step === 'resultado_paid' && ultimoParcial && /cl[ií]nica/i.test(tx)) ultimoParcial = null;
        }
        if (ultimoParcial) parciales.push({ contacto, abono: ultimoParcial.abono, saldo: ultimoParcial.saldo, hora: horaCot(ultimoParcial.t), fecha: ultimoParcial.t });
        // Vacacional / clínica: el bot pidió el nombre y después de la respuesta nunca confirmó.
        const idxAsk = ms.map((m, i) => (m.step === 'ask_asistente_servicio' ? i : -1)).filter((i) => i >= 0).pop();
        if (idxAsk !== undefined) {
            const despues = ms.slice(idxAsk + 1);
            const confirmo = despues.some((m) => m.direction === 'outbound' && (m.step === 'venta_comprobante_recibido' || (m.step ?? '').startsWith('resultado_')));
            if (!confirmo) {
                const monto = montoDe((ms[idxAsk].text_body ?? '').match(/comprobante de \*?\$\s?([\d.]+)/)?.[1]?.replace(/\./g, ''));
                sinNombre.push({ contacto, monto, hora: horaCot(momento(ms[idxAsk])) });
            }
        }
    }

    // ════════ ENTREGA 2 — rapidez 10→17 nov ═══════════════════════════════════
    const d0 = Date.parse('2026-11-10T05:00:00Z');
    interface Turno { dia: string; hora: number; resp: number | null; bot: number | null; humano: number | null; sinResp30: boolean }
    const turnos: Turno[] = [];
    const repPorDia = new Map<string, number>();
    const botPorDia = new Map<string, number>();
    for (const ms of indices.porConversacion.values()) {
        let prevBot: { txt: string; t: number }[] = [];
        for (let i = 0; i < ms.length; i++) {
            const m = ms[i];
            const t = momento(m);
            if (m.direction === 'outbound' && esSalienteDelBot(m)) {
                const dia = fechaCot(t);
                if (t >= d0) botPorDia.set(dia, (botPorDia.get(dia) ?? 0) + 1);
                const txt = normalizar(m.text_body).slice(0, 120);
                if (txt && prevBot.some((p) => p.txt === txt && t - p.t <= 10 * 60_000) && t >= d0) repPorDia.set(dia, (repPorDia.get(dia) ?? 0) + 1);
                prevBot.push({ txt, t }); prevBot = prevBot.filter((p) => t - p.t <= 10 * 60_000);
            }
            if (m.direction !== 'inbound' || t < d0) continue;
            // primer mensaje de una ráfaga: el anterior fue saliente, o hay >10 min de hueco
            const prev = ms[i - 1];
            if (prev && prev.direction === 'inbound' && t - momento(prev) <= 10 * 60_000) continue;
            let resp: number | null = null, bot: number | null = null, humano: number | null = null;
            for (let j = i + 1; j < ms.length; j++) {
                const o = ms[j];
                if (o.direction !== 'outbound') continue;
                const to = momento(o);
                if (o.campana) continue;
                const dt = (to - t) / 1000;
                if (dt < 0) continue;
                if (resp === null) resp = dt;
                if (bot === null && esSalienteDelBot(o)) bot = dt;
                if (humano === null && esSalienteHumano(o)) humano = dt;
                if (resp !== null && bot !== null && humano !== null) break;
            }
            const h = new Date(t - COT).getUTCHours();
            turnos.push({ dia: fechaCot(t), hora: h, resp, bot, humano, sinResp30: resp === null || resp > 1800 });
        }
    }
    const dias = [...new Set(turnos.map((t) => t.dia))].sort();
    const rapidez = dias.map((d) => {
        const ts = turnos.filter((t) => t.dia === d);
        const r = ts.map((t) => t.resp).filter((x): x is number => x !== null);
        const b = ts.map((t) => t.bot).filter((x): x is number => x !== null);
        const hu = ts.map((t) => t.humano).filter((x): x is number => x !== null);
        return { dia: d, turnos: ts.length, medBot: med(b), p90Bot: p90(b), medHum: med(hu), p90Hum: p90(hu), medAny: med(r), pctSin30: ts.length ? (100 * ts.filter((t) => t.sinResp30).length) / ts.length : 0, repet: repPorDia.get(d) ?? 0, bot: botPorDia.get(d) ?? 0 };
    });
    const porHora = Array.from({ length: 24 }, (_, h) => {
        const ts = turnos.filter((t) => t.hora === h);
        const r = ts.map((t) => t.resp ?? 86400);
        return { h, n: ts.length, pctSin30: ts.length ? (100 * ts.filter((t) => t.sinResp30).length) / ts.length : 0, p90: p90(r), sinResp: ts.filter((t) => t.sinResp30).length };
    }).filter((x) => x.n >= 10).sort((a, b) => b.pctSin30 - a.pctSin30 || b.p90 - a.p90);

    // ════════ ENTREGA 3 — campaña fallida 9–10 nov ════════════════════════════
    const MOTIVOS = /spam rate limit|ecosystem engagement|part of an experiment|undeliverable/i;
    const campana = mensajes.filter((m) => m.direction === 'outbound' && m.campana);
    const fallidos = campana.filter((m) => m.status === 'failed' && MOTIVOS.test(JSON.stringify(m.error_detail ?? '')));
    const filasQ = new Map<string, FilaDeCola[]>();
    for (const f of cola) { const k = tel10(f.wa_phone_number); (filasQ.get(k) ?? filasQ.set(k, []).get(k)!).push(f); }
    const destinos = new Map<string, { contacto: string; motivo: string; t: number; escribio: number; archivo: number; cobrado: boolean; recibioOtra: boolean }>();
    for (const m of fallidos) {
        const c = indices.convPorId.get(m.conversation_id);
        const tel = tel10(m.to_wa_id ?? c?.contact_wa_id);
        const key = c?.id ?? tel;
        const t = momento(m);
        const ms = indices.porConversacion.get(m.conversation_id) ?? [];
        const escribio = ms.filter((x) => x.direction === 'inbound' && momento(x) > t).length;
        const arch = (filasQ.get(tel) ?? []).filter((f) => Date.parse(f.created_at) > t);
        const cobrado = arch.some((f) => f.status === 'done' && f.result_type === 'payment_receipt');
        const recibioOtra = ms.some((x) => x.direction === 'outbound' && x.campana && momento(x) > t && ['sent', 'delivered', 'read'].includes(String(x.status)));
        const e = JSON.stringify(m.error_detail ?? '');
        const motivo = /spam rate/i.test(e) ? 'Spam rate limit' : /ecosystem/i.test(e) ? 'Límite de ecosistema (Meta)' : /experiment/i.test(e) ? 'Número en experimento (Meta)' : 'No entregable';
        const prev = destinos.get(key);
        destinos.set(key, {
            contacto: contactoCorto(c?.contact_name, m.to_wa_id ?? c?.contact_wa_id), motivo: prev ? `${prev.motivo}; ${motivo}` : motivo,
            t: Math.max(t, prev?.t ?? 0), escribio, archivo: arch.length, cobrado: cobrado || Boolean(prev?.cobrado), recibioOtra: recibioOtra || Boolean(prev?.recibioOtra),
        });
    }
    const dest = [...destinos.values()];
    const noReenviar = dest.filter((d) => d.cobrado || d.escribio > 0 || d.archivo > 0 || d.recibioOtra);
    const reenviar = dest.filter((d) => !(d.cobrado || d.escribio > 0 || d.archivo > 0 || d.recibioOtra));

    // ════════ Salidas ══════════════════════════════════════════════════════════
    mkdirSync(OUT, { recursive: true });
    const cab = 'contacto,fecha_hora_bogota,monto,concepto,estado,antiguedad_h,accion,dijo,duplicado,nota';
    writeFileSync(`${OUT}/monster-pendientes.csv`, '﻿' + [cab, ...filas.sort((a, b) => (b.monto ?? 0) - (a.monto ?? 0)).map((f) => [f.contacto, f.hora, f.monto ?? '', f.concepto, f.estado, f.horas, f.accion, f.dijo, f.dup ? 'sí' : 'no', f.nota].map(csv).join(','))].join('\n'));

    const L: string[] = [];
    const sumaUnicas = unicas.reduce((s, f) => s + (f.monto ?? 0), 0);
    L.push(`# Monster´s — pagos pendientes, rapidez y campaña (${fechaCot(AHORA)})`, '');
    L.push(`Lecturas: ${consultas} consultas (cola ≤1000 filas desde 1-nov: ${cola.length} leídas; ${convs.length} conversaciones; ${mensajes.length} mensajes desde 9-nov${topeMsgs ? ' — TOPE alcanzado' : ''}).`, '');
    L.push('## 1. Pagos pendientes (sin desenlace, deduplicados)', '');
    L.push(`**${unicas.length} comprobantes únicos · ${pesos(sumaUnicas)}** (+ ${unicas.filter((f) => f.monto === null).length} sin monto leído). Duplicados descontados: ${dups.length} (${pesos(dups.reduce((s, f) => s + (f.monto ?? 0), 0))}).`, '');
    L.push('| Concepto | # | Total | Sin monto |', '|---|---:|---:|---:|');
    for (const [c, v] of [...porConcepto].sort((a, b) => b[1].total - a[1].total)) L.push(`| ${c} | ${v.n} | ${pesos(v.total)} | ${v.sinMonto} |`);
    L.push('', '| # | Contacto | Fecha | Monto | Concepto | Estado | Horas | Acción |', '|---:|---|---|---:|---|---|---:|---|');
    unicas.slice(0, 25).forEach((f, i) => L.push(`| ${i + 1} | ${f.contacto} | ${f.hora} | ${f.monto ? pesos(f.monto) : '?'} | ${f.concepto} | ${f.estado} | ${f.horas} | ${f.accion} |`));
    L.push('', `### Abonos parciales (clínica/otros) con saldo — ${parciales.length}`, '| Contacto | Abono | Saldo | Cuándo |', '|---|---:|---:|---|');
    for (const p of parciales.sort((a, b) => (b.saldo ?? 0) - (a.saldo ?? 0))) L.push(`| ${p.contacto} | ${p.abono ? pesos(p.abono) : '?'} | ${p.saldo ? pesos(p.saldo) : '?'} | ${p.hora} |`);
    L.push('', `### Pagaron pero el bot pidió el nombre del asistente y nunca confirmó — ${sinNombre.length}`, '| Contacto | Monto | Cuándo |', '|---|---:|---|');
    for (const s of sinNombre) L.push(`| ${s.contacto} | ${s.monto ? pesos(s.monto) : '?'} | ${s.hora} |`);
    L.push('', '## 2. Rapidez (10→17 nov, primera respuesta a cada ráfaga de mensajes del cliente)', '', '| Día | Turnos | Bot mediana | Bot p90 | Persona mediana | Persona p90 | % sin respuesta >30 min | Bot: repetidos / total |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of rapidez) L.push(`| ${r.dia} | ${r.turnos} | ${fmtS(r.medBot)} | ${fmtS(r.p90Bot)} | ${fmtS(r.medHum)} | ${fmtS(r.p90Hum)} | ${r.pctSin30.toFixed(0)} % | ${r.repet} / ${r.bot} |`);
    L.push('', '3 peores horas (hora Bogotá, mín. 10 turnos):', '| Hora | Turnos | % sin respuesta >30 min | p90 primera respuesta |', '|---|---:|---:|---:|');
    for (const h of porHora.slice(0, 3)) L.push(`| ${h.h}:00–${h.h}:59 | ${h.n} | ${h.pctSin30.toFixed(0)} % | ${fmtS(h.p90)} |`);
    L.push('', '## 3. Recordatorio de la clínica — envíos fallidos 9 y 10 nov', '', `Destinatarios con envío fallido: **${dest.length}** (${fallidos.length} mensajes). No reenviar (ya escribieron / mandaron archivo / pagaron / recibieron otro): **${noReenviar.length}**. Candidatos a reenvío: **${reenviar.length}**.`, '', '| Contacto | Motivo | Escribió después | Archivos después | Cobro | Recibió otra campaña | Decisión |', '|---|---|---:|---:|---|---|---|');
    for (const d of dest.sort((a, b) => a.contacto.localeCompare(b.contacto))) L.push(`| ${d.contacto} | ${d.motivo} | ${d.escribio} | ${d.archivo} | ${d.cobrado ? 'sí' : 'no'} | ${d.recibioOtra ? 'sí' : 'no'} | ${d.cobrado || d.escribio > 0 || d.archivo > 0 || d.recibioOtra ? 'NO reenviar' : 'candidato'} |`);
    writeFileSync(`${OUT}/monster-pendientes.md`, L.join('\n'));
    console.log(L.join('\n'));
    process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
