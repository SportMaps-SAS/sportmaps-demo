/**
 * aprobar-pagos-auditados — aprueba los cobros que una PERSONA ya revisó uno por uno
 * (auditoría de pendientes) y le avisa a cada familia.
 *
 *   npx tsx scripts/aprobar-pagos-auditados.ts --archivo <lista.json>                       # simulación (no escribe)
 *   npx tsx scripts/aprobar-pagos-auditados.ts --archivo <lista.json> --aplicar             # aprueba y avisa
 *   npx tsx scripts/aprobar-pagos-auditados.ts --archivo <lista.json> --solo-avisos --aplicar
 *       # no aprueba nada: reintenta solo los avisos que no salieron (p. ej., una plantilla
 *       # que cayó fuera del horario de la escuela)
 *
 * Nació el 2026-11-08 con Monster: 32 comprobantes «Por validar» y la auditoría mostró que
 * aprobarlos en bloque habría marcado mal 14 (pagos de otro concepto, fichas duplicadas,
 * rebajas pendientes). Por eso el script NO decide: aprueba solo lo que trae la lista.
 *
 * La aprobación hace lo mismo que la pantalla (`frontend/src/lib/approvePayment.ts`), con
 * dos diferencias a propósito:
 *   · Respeta el pronto pago. Con `early_payment_discount_applied`, lo debido es
 *     amount − descuento − ya pagado. La pantalla compara contra `amount` y propondría un
 *     abono con «saldo $7.250».
 *   · El aviso por WhatsApp va con el texto revisado (ventana abierta) o con la plantilla
 *     aprobada que corresponde (cerrada), y se marca la fila de la cola para que
 *     `whatsapp-payment-outcome.job` no mande además su texto genérico.
 *
 * Formato:
 *   {
 *     "escuela": "<school_id>",
 *     "aprobadoPor": "<profile_id de quien revisó>",
 *     "paso": "aprobacion_auditoria_2026_11_08",
 *     "items": [
 *       { "pago": "<uuid>", "tipo": "completo" | "abono", "monto": 140000,
 *         "texto": "mensaje para la ventana abierta (opcional)",
 *         "conversacion": "<uuid opcional>",
 *         "grupo": "sara", "avisoMonto": 280000, "avisoConcepto": "la mensualidad de noviembre y el torneo" }
 *     ]
 *   }
 * En un `grupo` (un comprobante para varios cobros) solo el PRIMER ítem avisa, con
 * `avisoMonto` / `avisoConcepto`.
 */
import fs from 'node:fs';
import type { WhatsAppIntegration } from '../src/services/whatsapp.service';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const ARCHIVO = arg('--archivo');
const APLICAR = process.argv.includes('--aplicar');
const SOLO_AVISOS = process.argv.includes('--solo-avisos');
const VENTANA_MS = 24 * 3600_000;
const MARGEN_MS = 10 * 60_000;
const ABIERTOS = ['awaiting_approval', 'pending', 'overdue', 'partial'];

interface Item {
    pago: string;
    tipo: 'completo' | 'abono';
    monto: number;
    texto?: string;
    conversacion?: string;
    grupo?: string;
    avisoMonto?: number;
    avisoConcepto?: string;
    /** Nombre del deportista como lo reconoce la familia (la ficha puede venir en mayúsculas o con apodo). */
    atleta?: string;
    /** Cómo se nombra lo pagado en la plantilla de «otro concepto» («el torneo», «el vacacional»). */
    concepto?: string;
}
interface Lista { escuela: string; aprobadoPor: string; paso: string; items: Item[] }

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO').replace(/,/g, '.')}`;
const enmascarar = (tel: string) => {
    const d = String(tel || '').replace(/\D/g, '');
    return d.length > 4 ? `••${d.slice(-4)}` : d;
};
const hoyBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
/** Mismo criterio que la app: lo que no es mensualidad es un cobro único (no activa inscripción). */
const esMensualidad = (cat: string | null | undefined) => (cat ?? 'mensualidad') === 'mensualidad';

/** Lo debido HOY, respetando el pronto pago y lo ya abonado. Pura. */
export function debidoDe(p: { amount: unknown; amount_paid?: unknown; early_payment_discount_applied?: unknown }): number {
    const amount = Number(p.amount) || 0;
    const pagado = Number(p.amount_paid) || 0;
    const descuento = Number(p.early_payment_discount_applied) || 0;
    return Math.max(amount - descuento - pagado, 0);
}

async function main(): Promise<void> {
    if (!ARCHIVO) {
        console.error('Uso: npx tsx scripts/aprobar-pagos-auditados.ts --archivo <lista.json> [--aplicar] [--solo-avisos]');
        process.exit(1);
    }
    const lista = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')) as Lista;
    if (!lista.escuela || !lista.aprobadoPor || !lista.paso || !Array.isArray(lista.items)) {
        throw new Error('El archivo necesita escuela, aprobadoPor, paso e items');
    }

    const { supabase } = await import('../src/config/supabase');
    const { deliver } = await import('../src/services/whatsapp-bot.service');
    const { conversacionTomada } = await import('../src/services/whatsapp-tomada.service');
    const { estaDadoDeBaja } = await import('../src/services/whatsapp-optin.service');
    const { enviarCobroPorPlantilla } = await import('../src/services/whatsapp-plantillas.service');
    const { emitirTokenCobro } = await import('../src/services/cobro-enlace-publico.service');

    const { data: aprobador } = await supabase.from('profiles').select('id, full_name').eq('id', lista.aprobadoPor).maybeSingle();
    if (!aprobador) throw new Error(`aprobadoPor ${lista.aprobadoPor} no es un perfil`);
    const { data: escuela } = await supabase.from('schools').select('id, name').eq('id', lista.escuela).maybeSingle();
    if (!escuela) throw new Error(`Escuela ${lista.escuela} no existe`);
    const { data: integ } = await supabase.from('school_whatsapp_integrations').select('*')
        .eq('school_id', lista.escuela).eq('status', 'active').maybeSingle();
    const integration = (integ ?? null) as unknown as WhatsAppIntegration | null;

    // Una sola lectura de todos los cobros (sin N+1).
    const ids = lista.items.map((i) => i.pago);
    const { data: filas, error } = await supabase.from('payments')
        .select('id, school_id, status, amount, amount_paid, early_payment_discount_applied, payment_method, payment_category, concept, child_id, parent_id, user_id, unregistered_athlete_id, team_id, approved_by')
        .in('id', ids);
    if (error) throw error;
    const pagos = new Map((filas ?? []).map((f: any) => [f.id as string, f]));

    console.log(`${APLICAR ? 'APLICANDO' : 'SIMULACIÓN'}${SOLO_AVISOS ? ' (solo avisos)' : ''} · ${lista.items.length} cobros · ${escuela.name} · aprueba ${aprobador.full_name}\n`);

    const gruposAvisados = new Set<string>();
    const resumen = { aprobados: 0, abonos: 0, rechazados: 0, texto: 0, plantilla: 0, soloApp: 0, avisoPendiente: 0 };

    for (const it of lista.items) {
        const p = pagos.get(it.pago);
        const tag = it.pago.slice(0, 8);
        if (!p) { console.log(`✗ ${tag} no existe`); resumen.rechazados++; continue; }
        if (p.school_id !== lista.escuela) { console.log(`✗ ${tag} es de otra escuela`); resumen.rechazados++; continue; }

        const debido = debidoDe(p);
        const monto = Number(it.monto) || 0;
        let estadoFinal: 'paid' | 'partial';
        let pagadoFinal: number;
        let saldo = 0;
        if (it.tipo === 'completo') {
            // Un completo que no cubre lo debido sería un abono disfrazado: no se aprueba.
            if (monto + 1 < debido) {
                console.log(`✗ ${tag} «completo» pero ${cop(monto)} no cubre lo debido ${cop(debido)}: revisar`);
                resumen.rechazados++; continue;
            }
            estadoFinal = 'paid';
            pagadoFinal = (Number(p.amount_paid) || 0) + debido;
        } else {
            if (monto <= 0 || monto >= debido) {
                console.log(`✗ ${tag} «abono» de ${cop(monto)} contra lo debido ${cop(debido)}: revisar`);
                resumen.rechazados++; continue;
            }
            estadoFinal = 'partial';
            pagadoFinal = (Number(p.amount_paid) || 0) + monto;
            saldo = debido - monto;
        }

        console.log(`→ ${tag} ${String(p.concept ?? '').slice(0, 70)}`);
        console.log(`    ${p.status} → ${estadoFinal} · pagado ${cop(pagadoFinal)}${saldo ? ` · saldo ${cop(saldo)}` : ''}${Number(p.early_payment_discount_applied) ? ` · pronto pago ${cop(Number(p.early_payment_discount_applied))}` : ''}`);

        // ── 1. Aprobar (igual que la pantalla) ────────────────────────────────
        if (!SOLO_AVISOS) {
            if (!ABIERTOS.includes(p.status)) { console.log(`    ✗ ya no está abierto (${p.status}): no se toca`); resumen.rechazados++; continue; }
            if (APLICAR) {
                const ahora = new Date().toISOString();
                const metodo = p.payment_method || 'transfer';
                const { data: upd, error: errUpd } = await supabase.from('payments').update({
                    status: estadoFinal,
                    payment_method: metodo,
                    payment_channel: metodo === 'cash' ? 'cash' : 'transfer',
                    payment_date: hoyBogota(),
                    approved_by: lista.aprobadoPor,
                    approved_at: ahora,
                    amount_paid: pagadoFinal,
                    requires_review: false,
                    unblocked_at: ahora,
                    unblocked_by: lista.aprobadoPor,
                } as never).eq('id', p.id).in('status', ABIERTOS).select('id');
                if (errUpd || !upd?.length) {
                    console.log(`    ✗ no se aprobó: ${errUpd?.message ?? 'otra persona lo cambió mientras tanto'}`);
                    resumen.rechazados++; continue;
                }
                // Inscripción activa solo con la mensualidad completa (cobro único nunca).
                if (estadoFinal === 'paid' && esMensualidad(p.payment_category)) {
                    let q = supabase.from('enrollments').update({ status: 'active' })
                        .eq('school_id', lista.escuela).eq('status', 'pending');
                    if (p.child_id) q = q.eq('child_id', p.child_id);
                    else if (p.unregistered_athlete_id) q = (q as any).eq('unregistered_athlete_id', p.unregistered_athlete_id);
                    else if (p.user_id) q = (q as any).eq('user_id', p.user_id).is('child_id', null);
                    else q = null as any;
                    if (q) { if (p.team_id) q = q.eq('team_id', p.team_id); await q; }
                }
                // El job de desenlaces no repite con su texto genérico.
                await supabase.from('whatsapp_inbound_queue').update({ outcome_notified_at: ahora })
                    .eq('result_ref_id', p.id).is('outcome_notified_at', null);
                // Aviso en la app (INSERT con service_role, como manda el CLAUDE.md para avisos del BFF).
                const destinatario = p.parent_id || p.user_id;
                if (destinatario) {
                    await supabase.from('notifications').insert({
                        user_id: destinatario,
                        school_id: lista.escuela,
                        title: estadoFinal === 'partial' ? '💰 Abono registrado' : '✅ Pago confirmado',
                        message: estadoFinal === 'partial'
                            ? `${escuela.name} registró un abono de ${cop(monto)} por ${p.concept}. Saldo pendiente: ${cop(saldo)}.`
                            : `${escuela.name} confirmó tu pago de ${cop(debido)} por ${p.concept}.`,
                        type: estadoFinal === 'partial' ? 'payment' : 'success',
                        link: '/my-payments',
                        data: { payment_id: p.id },
                    } as never);
                }
            }
            if (estadoFinal === 'partial') resumen.abonos++; else resumen.aprobados++;
        }

        // ── 2. Avisar por WhatsApp ────────────────────────────────────────────
        if (it.grupo) {
            if (gruposAvisados.has(it.grupo)) { console.log('    aviso: va en el mensaje del grupo'); continue; }
            gruposAvisados.add(it.grupo);
        }
        if (!integration) { console.log('    aviso: la escuela no tiene WhatsApp conectado → solo en la app'); resumen.soloApp++; continue; }

        // Conversación: la que trae la lista o la del teléfono del acudiente.
        let conv: any = null;
        if (it.conversacion) {
            const { data } = await supabase.from('whatsapp_conversations')
                .select('id, school_id, contact_wa_id, last_inbound_at').eq('id', it.conversacion).maybeSingle();
            conv = data;
        }
        if (!conv && (p.parent_id || p.user_id)) {
            const { data: perfil } = await supabase.from('profiles').select('phone').eq('id', p.parent_id || p.user_id).maybeSingle();
            const tel = String((perfil as any)?.phone ?? '').replace(/\D/g, '');
            if (tel.length >= 10) {
                const wa = tel.length === 10 ? `57${tel}` : tel;
                const { data } = await supabase.from('whatsapp_conversations')
                    .select('id, school_id, contact_wa_id, last_inbound_at')
                    .eq('school_id', lista.escuela).eq('contact_wa_id', wa).maybeSingle();
                conv = data;
            }
        }
        if (!conv || conv.school_id !== lista.escuela) {
            console.log('    aviso: sin conversación de WhatsApp → solo en la app'); resumen.soloApp++; continue;
        }

        // Idempotencia: ¿ya salió el aviso de ESTE cobro con este paso?
        const { data: yaSalio } = await supabase.from('whatsapp_messages').select('id')
            .eq('conversation_id', conv.id).eq('direction', 'outbound')
            .eq('payload->>step', lista.paso).eq('payload->>payment_id', p.id).limit(1);
        if (yaSalio?.length) { console.log('    aviso: ya había salido'); continue; }

        if (await estaDadoDeBaja(integration.id, conv.contact_wa_id)) {
            console.log(`    aviso: ${enmascarar(conv.contact_wa_id)} dado de baja → solo en la app`); resumen.soloApp++; continue;
        }
        const ultimo = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : NaN;
        const abierta = Number.isFinite(ultimo) && ultimo + VENTANA_MS - Date.now() >= MARGEN_MS;
        const tomada = await conversacionTomada(conv.id);

        if (abierta && it.texto && !tomada) {
            console.log(`    aviso (texto, ${enmascarar(conv.contact_wa_id)}): ${it.texto}`);
            if (APLICAR) {
                await deliver(integration, conv.id, conv.contact_wa_id, it.texto, {
                    step: lista.paso, payment_id: p.id, repetible: true, enviado_por: 'sportmaps_auditoria',
                });
            }
            resumen.texto++;
            continue;
        }
        if (tomada) { console.log('    aviso: conversación tomada por una persona → no se escribe'); resumen.avisoPendiente++; continue; }

        // Ventana cerrada → la plantilla UTILITY aprobada que dice la verdad.
        const [{ data: hijo }, { data: sinReg }] = await Promise.all([
            p.child_id ? supabase.from('children').select('full_name').eq('id', p.child_id).maybeSingle() : Promise.resolve({ data: null }),
            p.unregistered_athlete_id ? supabase.from('unregistered_athletes').select('full_name').eq('id', p.unregistered_athlete_id).maybeSingle() : Promise.resolve({ data: null }),
        ]);
        let atleta = String(it.atleta ?? (hijo as any)?.full_name ?? (sinReg as any)?.full_name ?? '').trim();
        if (!atleta && p.user_id) {
            const { data: u } = await supabase.from('profiles').select('full_name').eq('id', p.user_id).maybeSingle();
            atleta = String((u as any)?.full_name ?? '').trim();
        }
        if (!atleta) { console.log('    aviso: sin nombre del deportista para la plantilla → pendiente'); resumen.avisoPendiente++; continue; }

        const montoAviso = it.avisoMonto ?? (estadoFinal === 'partial' ? monto : debido);
        const concepto = estadoFinal === 'partial' ? 'abono_recibido'
            : (it.avisoConcepto || !esMensualidad(p.payment_category)) ? 'pago_recibido_otro_concepto' : 'pago_confirmado';
        const datos = {
            nombreContacto: 'familia',
            nombreAtleta: atleta,
            nombreEscuela: escuela.name,
            monto: cop(montoAviso),
            montoAbono: cop(monto),
            saldoPendiente: cop(saldo),
            fechaVencimiento: null as string | null,
            conceptoPago: it.avisoConcepto ?? it.concepto ?? String(p.concept ?? '').split(' — ')[0],
        };
        console.log(`    aviso (plantilla ${concepto}, ${enmascarar(conv.contact_wa_id)}): ${cop(montoAviso)} · ${datos.conceptoPago} · ${atleta}`);
        if (!APLICAR) { resumen.plantilla++; continue; }
        const r = await enviarCobroPorPlantilla({
            schoolId: lista.escuela,
            concepto: concepto as any,
            telefono: conv.contact_wa_id,
            datos: datos as any,
            tokenBoton: await emitirTokenCobro(p.id),
            paymentId: p.id,
            parentId: p.parent_id,
            payloadExtra: { step: lista.paso, payment_id: p.id },
        });
        if ((r as any).enviado) { console.log('      ✓ enviada'); resumen.plantilla++; continue; }
        console.log(`      ✗ no salió: ${(r as any).motivo}${(r as any).detalle ? ` (${(r as any).detalle})` : ''}`);
        // Respaldo: sin opt-in de plantillas (lo normal en familias que nunca lo aceptaron), el aviso va por correo.
        const destinatario = p.parent_id || p.user_id;
        const { data: pf } = destinatario
            ? await supabase.from('profiles').select('full_name, email').eq('id', destinatario).maybeSingle()
            : { data: null } as any;
        const email = String((pf as any)?.email ?? '').trim();
        if ((r as any).motivo !== 'sin_optin' || !email.includes('@') || estadoFinal !== 'paid') { resumen.avisoPendiente++; continue; }
        const { error: errMail } = await supabase.functions.invoke('send-email', { body: {
            type: 'payment_confirmation', to: email, from_name: escuela.name,
            data: {
                userName: String((pf as any)?.full_name ?? '').split(' ')[0] || 'familia',
                schoolName: escuela.name,
                concept: it.avisoConcepto ? `${it.avisoConcepto} de ${atleta}` : `${datos.conceptoPago} de ${atleta}`,
                amount: cop(montoAviso),
                reference: it.pago.slice(0, 8).toUpperCase(),
            },
        } });
        if (errMail) { console.log(`      ✗ correo de respaldo: ${errMail.message ?? errMail}`); resumen.avisoPendiente++; }
        else { console.log(`      ✓ correo de respaldo a ${email.replace(/^(.{2}).*(@.*)$/, '$1•••$2')}`); resumen.soloApp++; }
    }

    console.log(`\n${APLICAR ? 'Hecho' : 'Se haría'}: ${resumen.aprobados} completos · ${resumen.abonos} abonos · ${resumen.rechazados} sin tocar`
        + ` · avisos: ${resumen.texto} por texto, ${resumen.plantilla} por plantilla, ${resumen.soloApp} solo en la app, ${resumen.avisoPendiente} pendientes`);
}

main().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
});
