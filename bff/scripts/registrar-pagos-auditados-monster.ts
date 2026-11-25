/**
 * registrar-pagos-auditados-monster — deja visibles para la escuela los 9 comprobantes REALES de Monster's Volley
 * (auditoría 2026-11-20) que llegaron por WhatsApp y no tienen cobro aplicado. SIMULA por defecto.
 *
 *   cd bff
 *   npx tsx scripts/registrar-pagos-auditados-monster.ts                                   # simulación (NO escribe)
 *   npx tsx scripts/registrar-pagos-auditados-monster.ts --aplicar --actor <profile_id>    # escribe (solo lo confirmado)
 *   ... --confirmar-lectura luisca,andrea     confirma que alguien comparó monto/referencia/fecha con la imagen
 *   ... --solo <clave>                         un solo caso
 *
 * REGLAS (instrucción del dueño): NUNCA se aprueba nada (todo queda `awaiting_approval` = «Por validar» o en
 * «Por clasificar», con el comprobante), la escuela valida, y NO se le escribe a ninguna familia: este script no
 * importa ni llama ningún envío (WhatsApp, plantillas, correo); además marca `outcome_notified_at` en la fila de la
 * cola que aplica, para que `whatsapp-payment-outcome.job` no mande su texto genérico.
 *
 * CAMINOS (el de menor intervención, decidido caso por caso con la base el 2026-11-20):
 *   anotar          el comprobante YA está en «Por clasificar» (visible en Cobros): no se escribe nada.
 *   por_clasificar  la fila de la cola no tenía lectura guardada: se registra en «Por clasificar» con la RPC
 *                   `wa_crear_comprobante_por_clasificar` (idempotente por fila de la cola). No crea payments.
 *   aplicar_a_cobro hay un cobro abierto EXACTO de ese deportista: el comprobante se estampa en él con
 *                   `estamparComprobante` (el mismo camino del worker) → `awaiting_approval`. No toca amount_paid
 *                   (lo suma la aprobación de la escuela), no cancela nada, no cambia nada más del cobro.
 *
 * LECTURA CONFIRMADA: los casos `por_clasificar` / `aplicar_a_cobro` parten de monto, referencia y fecha que dio la
 * auditoría, porque la cola nunca guardó la lectura del OCR de esas filas. Hasta que una persona la compare con la
 * imagen y pase `--confirmar-lectura <clave>`, el caso solo se simula.
 *
 * IDEMPOTENCIA: llave `monster-pago-<referencia>` guardada en `audit_logs.new_data._idempotency_key`; además se
 * verifica por referencia (`payments.ocr_reference`) que el pago no esté ya registrado, y las RPC/índices únicos de
 * la base (uq_payments_school_ocr_reference, queue_id) hacen de segunda barrera.
 * AUDITORÍA: cada escritura deja ANTES su fila en `audit_logs` (acción `registrar_pagos_auditados_monster`).
 *
 * NO HACE (solo se reporta): cancelar el cobro falso de clínica de Andrea ni sus duplicados de la Copa Navidad;
 * decidir el precio de la clínica de Consuelo; registrar el supuesto abono previo de Isaac (sin comprobante).
 */
import 'dotenv/config';
import crypto from 'node:crypto';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const ACCION_AUDIT = 'registrar_pagos_auditados_monster';
const BUCKET = 'payment-receipts';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const APLICAR = process.argv.includes('--aplicar');
const ACTOR = arg('--actor');
const SOLO = arg('--solo');
const CONFIRMADAS = new Set((arg('--confirmar-lectura') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

type Etiqueta = 'inscripcion' | 'servicio_nuevo' | 'por_identificar' | 'otro' | 'clase_de_prueba' | 'mensualidad';

interface Caso {
    clave: string;
    quien: string;
    /** Referencia bancaria como la dio la auditoría (puede ir truncada: se busca por prefijo). */
    referencia: string;
    monto: number;
    fecha: string;
    banco: string | null;
    paraQue: string;
    /** Fila de la cola (id completo) y los dos últimos dígitos/teléfono para verificar que sea de esa persona. */
    queueId: string;
    telefonoTermina: string;
    accion: 'anotar' | 'por_clasificar' | 'aplicar_a_cobro';
    /** `anotar`: la fila de «Por clasificar» que ya existe. */
    porClasificarId?: string;
    /** `por_clasificar`: etiqueta con la que se registra. */
    etiqueta?: Etiqueta;
    /** `aplicar_a_cobro`: cobro abierto de ese deportista (id exacto) y su ficha. */
    pagoId?: string;
    childId?: string;
    /** Cobros de la misma persona que NO se tocan, solo se reportan. */
    reportar?: { id: string; nota: string }[];
    notas: string[];
    /** ¿Alguien comparó monto/referencia/fecha con la imagen? (solo importa si la acción escribe) */
    lecturaConfirmada: boolean;
}

/** PLAN EMBEBIDO (ids reales, base viva 2026-11-20). */
const PLAN: Caso[] = [
    {
        clave: 'luisca', quien: 'Luisca (Luis Riaño, perfil be29a97e…)', referencia: 'M19296615', monto: 370000, fecha: '2026-11-11',
        banco: 'Nequi', paraQue: 'Inscripción (no es de la clínica)',
        queueId: 'ab1ba185-2f33-4715-b416-255571aa8779', telefonoTermina: '573004693902',
        accion: 'por_clasificar', etiqueta: 'inscripcion', lecturaConfirmada: false,
        notas: [
            'La fila de la cola (11-11 17:51) NO tiene lectura guardada: no entra en «Por clasificar». Sin cobro de inscripción ni ficha de deportista para él (solo la mensualidad vencida c5aae0be $145.000): no se inventa un cobro.',
            'Su pago de $30.000 del 17-nov (clase de prueba de 2 amigos) YA está en «Por clasificar» (ec93965b…, fila df5d3ddf): no se toca.',
            'Los $140.000 Nequi del 15-nov (dos capturas) NO son de este teléfono: las filas f5b9dbaa, ffc6be7f y 2217f7fc (sin lectura, «contacto_no_atendido») son de 573108863902 («Andrea ❤️», lead «Gabriela Reina»). Falta confirmarlas con la imagen: no se registran.',
        ],
    },
    {
        clave: 'andrea_vacacional', quien: 'Andrea (…3902 de 573108863902, hija Gabriela Reina Fonseca)', referencia: 'SIN-REF-NEQUI-20261115-1937-140000', monto: 140000, fecha: '2026-11-15',
        banco: 'Nequi', paraQue: 'Vacacional de voleibol — Sede Suba, 2 semanas (tarifa de externos $140.000) — Gabriela Reina Fonseca',
        queueId: 'f5b9dbaa-895e-4931-a306-616ee8e01990', telefonoTermina: '573108863902',
        accion: 'por_clasificar', etiqueta: 'servicio_nuevo', lecturaConfirmada: false,
        notas: [
            'Hallado por la auditoría del vacacional (lote 01, caso 052). Tres capturas del MISMO pago (f5b9dbaa 15-nov 19:37, ffc6be7f 19:39, 2217f7fc 16-nov 17:25), todas `contacto_no_atendido`, ninguna en «Por clasificar». La imagen muestra «Transferencia exitosa $140.000» a Ivan Felipe Sossa Benitez (Nequi 3194505150); NO trae referencia: la de acá es una marca propia («SIN-REF-…») solo para la idempotencia, no un dato bancario.',
            'Son del teléfono 573108863902, no del de Luisca (573004693902): ambos terminan en 3902.',
        ],
    },
    {
        clave: 'consuelo', quien: 'Consuelo Chala (…5201)', referencia: 'M15485762', monto: 200000, fecha: '2026-11-15', banco: 'Nequi',
        paraQue: 'Clínica — Jesús Giovanni Solarte Chala',
        queueId: '4ac2639a-3abd-42fd-8836-61f1361f0555', telefonoTermina: '573023345201',
        accion: 'anotar', porClasificarId: 'e6598053-c493-4fa9-909b-b298691a25ba', lecturaConfirmada: true,
        notas: [
            'Ya visible en «Por clasificar» (etiqueta «otro»). Sin ficha del deportista (el lead «Jesús Solarte» a3a6f0c2 tiene OTRO teléfono: 3028337989) ni perfil/lead con su número.',
            'DECISIÓN HUMANA: el precio ($332.500 o $350.000; hoy rige $350.000). El abono mínimo del 50 % se cumple con cualquiera ($200.000 ≥ $175.000). Al crear el servicio desde «Por clasificar» la base usa el precio de HOY y deja $200.000 como abono.',
        ],
    },
    {
        clave: 'carlos', quien: 'Carlos Daniel Clavijo (…5923)', referencia: '20261115900047981ENT', monto: 175000, fecha: '2026-11-15', banco: 'Bre-B/Nequi',
        paraQue: 'Clínica',
        queueId: 'f712e6ce-5383-42b4-93ac-15b4da67c09b', telefonoTermina: '573507065923',
        accion: 'anotar', porClasificarId: 'fba73715-19be-4939-8053-0057bcf90ed0', lecturaConfirmada: true,
        reportar: [{ id: 'a77c817e-ef73-4cef-be4d-a2e83494a5ad', nota: 'fila ORIGINAL del 15-nov 17:43 (sin lectura, «contacto_no_atendido»): es el mismo pago que el reenvío del 19-nov; no registrar aparte (duplicaría)' }],
        notas: [
            'El reenvío del 19-nov YA está en «Por clasificar» ($175.000, 20261115900047981ENT…034…, etiqueta «servicio_nuevo»). Existe el lead «Carlos Clavijo» 2bfbbb83 con ese teléfono, pero sin ficha de deportista.',
        ],
    },
    {
        clave: 'claudia', quien: 'Claudia Silva (contacto de Instagram)', referencia: '20261105900047981ENT00000000007090', monto: 150000, fecha: '2026-11-05', banco: 'BreB',
        paraQue: 'Clínica — Catalina Costa Silva',
        queueId: 'a4959eb2-23ff-4316-b641-8d800b3f0214', telefonoTermina: 'f-f',
        accion: 'anotar', porClasificarId: '68140edb-5cdc-4cf2-9b9e-e4bb61873337', lecturaConfirmada: true,
        notas: [
            'Ya visible en «Por clasificar» (etiqueta «por_identificar»). Sin ficha de «Catalina Costa Silva» y el contacto de Instagram no tiene teléfono: no hay a quién asignarle el cobro sin que la escuela lo diga.',
        ],
    },
    {
        clave: 'isaac', quien: 'Isaac Zaidman (…0883)', referencia: 'M20540656', monto: 150000, fecha: '2026-11-15', banco: 'Nequi', paraQue: 'Clínica',
        queueId: '644c5753-b29f-41fd-8c09-9806c679f571', telefonoTermina: '573208800883',
        accion: 'anotar', porClasificarId: '6907f1a4-3648-4297-96db-5d515baa74fb', lecturaConfirmada: true,
        notas: [
            'Ya visible en «Por clasificar» (etiqueta «servicio_nuevo»). Lead «ISAAC» 00563d0c con su teléfono; sin ficha.',
            'SOLO ANOTAR: dice haber abonado otros $150.000 antes del 10-nov SIN comprobante. No se registra; la escuela lo verifica en su banco.',
        ],
    },
    {
        clave: 'paola', quien: 'Paola Aguirre (…0145)', referencia: 'M00179012', monto: 150000, fecha: '2026-11-11', banco: 'Nequi',
        paraQue: 'Clínica — Julieta Sofía Moya Aguirre',
        queueId: 'ff96cace-c85c-46d7-a4da-200911c82b20', telefonoTermina: '573112540145',
        accion: 'anotar', porClasificarId: '1e9fbf49-dab2-452d-ad4a-df47840cdc8b', lecturaConfirmada: true,
        notas: [
            'Ya visible en «Por clasificar» (etiqueta «servicio_nuevo»). Lead «Paola Aguirre 🌸» 1e8d19ca con su teléfono; sin ficha de Julieta.',
            'El 20-nov pidió cancelar y la escuela dijo que no era posible: el dinero está recibido y debe quedar a la vista; no se decide nada de devolución.',
        ],
    },
    {
        clave: 'brady', quien: 'Brady Luz (…9340)', referencia: '1915518166', monto: 140000, fecha: '2026-11-15', banco: 'Bancolombia',
        paraQue: 'Vacacional 2 semanas — Gabriela Covaleda García',
        queueId: 'd91f1aaa-4783-4ba9-9c48-42ff14f25ef8', telefonoTermina: '573114579340',
        accion: 'anotar', porClasificarId: 'f723bc15-9b15-42ac-926c-2af2633b55ec', lecturaConfirmada: true,
        notas: [
            'Ya visible en «Por clasificar» (etiqueta «otro»; la propuesta correcta es el vacacional de voleibol — Sede Suba, opción «2 semanas» = $140.000 exactos, ítem fff41827…). Lead «Brady Luz» 0b08eccb; sin ficha de Gabriela.',
            'Nota: la referencia en la cola es de Bancolombia (1915518166), no Nequi como se anotó en la auditoría.',
        ],
    },
    {
        clave: 'andrea', quien: 'Andrea (…7513, hija Mariana Jiménez Alape)', referencia: 'M25906608', monto: 85000, fecha: '2026-11-14', banco: 'Nequi',
        paraQue: 'Copa Navidad (torneo) — Mariana Jiménez Alape U15',
        queueId: '655a6664-d978-4819-9250-f5c39bad3cdc', telefonoTermina: '573219887513',
        accion: 'aplicar_a_cobro', pagoId: '64b81900-e7f2-44ac-8267-909c86c0a682', childId: 'a787e4d7-0958-48c1-af88-a35425d58b2e',
        lecturaConfirmada: false,
        reportar: [
            { id: '063d279b-650d-45ff-9bcd-0f5bab24ad35', nota: 'cobro FALSO de clínica $250.000 (creado por el bot el 11-12, pending, ficha a787e4d7): NO se cancela, decide la escuela' },
            { id: '589003b1-3f19-403e-b8ce-e694f8b22ab8', nota: 'DUPLICADO de Copa Navidad U15 $85.000 en una ficha «sin cuenta» 9c91d1a8 (sin parent): NO se cancela' },
        ],
        notas: [
            'Cobro abierto exacto: 64b81900 (Copa Navidad U15 — Mariana Jiménez Alape, ficha a787e4d7, parent 7e65af0f, pending $85.000). Es el que tiene ficha y acudiente; el 589003b1 es el duplicado sin cuenta.',
            'La fila 655a6664 (11-14 19:12, pie «Mariana Jiménez Alape U15 proyección») no tiene lectura guardada: monto/referencia/fecha vienen de la auditoría. Hay que compararlos con la imagen (--confirmar-lectura andrea).',
        ],
    },
    {
        clave: 'marco', quien: 'Marco (…9564)', referencia: 'M16838503', monto: 10000, fecha: '2026-11-15', banco: 'Nequi',
        paraQue: 'Saldo de MENSUALIDAD (no clínica)',
        queueId: 'ec657b77-a3b0-4e1d-a9f5-f658bb817ddb', telefonoTermina: '573163959564',
        accion: 'anotar', porClasificarId: 'd0e5bc87-1c28-4944-befd-ce1417360e98', lecturaConfirmada: true,
        notas: [
            'Ya visible en «Por clasificar», pero con etiqueta «servicio_nuevo» (imprecisa: es saldo de mensualidad). Sin perfil ni lead con su número: no se pudo identificar a quién pertenece ni qué mensualidad completa. La escuela lo clasifica.',
        ],
    },
];

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO').replace(/,/g, '.')}`;
const corto = (s: string | null | undefined) => (s ?? '—').slice(0, 8);

async function main(): Promise<void> {
    if (APLICAR && !ACTOR) { console.error('--aplicar necesita --actor <profile_id> (queda en audit_logs).'); process.exit(1); }
    const { supabase: sb } = (await import('../src/config/supabase')) as { supabase: any };

    console.log(APLICAR ? '>>> MODO APLICAR (solo lo confirmado). No aprueba, no avisa a nadie.'
        : '>>> SIMULACIÓN: no escribe nada. Para aplicar: --aplicar --actor <profile_id> [--confirmar-lectura clave,…]');
    const { data: escuela } = await sb.from('schools').select('id, name').eq('id', ESCUELA).maybeSingle();
    if (!escuela) throw new Error(`Escuela ${ESCUELA} no existe`);
    if (APLICAR) {
        const { data: a } = await sb.from('profiles').select('id').eq('id', ACTOR).maybeSingle();
        if (!a) throw new Error(`--actor ${ACTOR} no es un perfil`);
    }
    console.log(`Escuela: ${escuela.name}\n`);

    const casos = PLAN.filter((c) => !SOLO || c.clave === SOLO);
    if (!casos.length) throw new Error(`No hay caso con clave ${SOLO}`);

    // Lecturas en lote (sin N+1).
    const queueIds = casos.map((c) => c.queueId);
    const pcIds = casos.map((c) => c.porClasificarId).filter(Boolean) as string[];
    const pagoIds = casos.flatMap((c) => [c.pagoId, ...(c.reportar ?? []).map((r) => r.id)]).filter(Boolean) as string[];
    const [colas, pcs, pagos, pcPorCola, auditPrevia] = await Promise.all([
        sb.from('whatsapp_inbound_queue').select('id, school_id, status, wa_phone_number, storage_path, error_message, result_ref_id, outcome_notified_at, created_at').in('id', queueIds),
        pcIds.length ? sb.from('wa_comprobantes_por_clasificar').select('id, queue_id, estado, monto, referencia, payment_id').in('id', pcIds) : Promise.resolve({ data: [] }),
        pagoIds.length ? sb.from('payments').select('id, school_id, status, amount, amount_paid, concept, child_id, parent_id, unregistered_athlete_id, ocr_reference, receipt_url').in('id', pagoIds) : Promise.resolve({ data: [] }),
        sb.from('wa_comprobantes_por_clasificar').select('id, queue_id, estado').in('queue_id', queueIds),
        sb.from('audit_logs').select('record_id, new_data').eq('school_id', ESCUELA).eq('action', ACCION_AUDIT),
    ]);
    for (const r of [colas, pcs, pagos, pcPorCola, auditPrevia]) if (r.error) throw new Error(r.error.message);
    const colaPor = new Map<string, any>((colas.data ?? []).map((x: any) => [x.id, x]));
    const pcPor = new Map<string, any>((pcs.data ?? []).map((x: any) => [x.id, x]));
    const pagoPor = new Map<string, any>((pagos.data ?? []).map((x: any) => [x.id, x]));
    const pcDeCola = new Map<string, any>((pcPorCola.data ?? []).map((x: any) => [x.queue_id, x]));
    const llavesHechas = new Set<string>((auditPrevia.data ?? []).map((a: any) => a.new_data?._idempotency_key).filter(Boolean));

    const resumen = { anotados: 0, porClasificar: 0, aplicados: 0, saltados: 0, bloqueados: 0 };

    for (const c of casos) {
        console.log(`══ ${c.clave.toUpperCase()} · ${c.quien} · ${cop(c.monto)} · ${c.banco ?? ''} ${c.referencia} · ${c.fecha}`);
        console.log(`   ${c.paraQue}`);
        const problemas: string[] = [];

        // 1. La fila de la cola es de ESA persona y de esa escuela.
        const cola = colaPor.get(c.queueId);
        if (!cola) problemas.push(`la fila de la cola ${corto(c.queueId)} no existe`);
        else {
            if (cola.school_id !== ESCUELA) problemas.push('la fila de la cola es de otra escuela');
            if (!String(cola.wa_phone_number).endsWith(c.telefonoTermina)) problemas.push(`el teléfono de la fila (…${String(cola.wa_phone_number).slice(-4)}) no coincide con …${c.telefonoTermina.slice(-4)}`);
            if (!cola.storage_path) problemas.push('la fila no tiene archivo (storage_path)');
            console.log(`   cola ${corto(c.queueId)} · ${cola.status} · …${String(cola.wa_phone_number).slice(-4)} · ${String(cola.created_at).slice(0, 16)} · archivo ${cola.storage_path ? 'sí' : 'NO'}${cola.result_ref_id ? ` · ya ligada a ${corto(cola.result_ref_id)}` : ''}`);
        }

        // 2. ¿Ya está registrado el pago? Por referencia (prefijo: algunas vienen truncadas) en payments.
        const { data: yaPagos, error: eRef } = await sb.from('payments').select('id, status, concept')
            .eq('school_id', ESCUELA).ilike('ocr_reference', `${c.referencia.replace(/[\\%_]/g, (m) => `\\${m}`)}%`).limit(5);
        if (eRef) throw new Error(eRef.message);
        if (yaPagos?.length) problemas.push(`la referencia ya está en payments: ${yaPagos.map((p: any) => `${corto(p.id)} (${p.status})`).join(', ')}`);
        else console.log(`   referencia: NO está en payments (ocr_reference) ✓`);

        const llave = `monster-pago-${c.referencia}`;
        const hecho = llavesHechas.has(llave);
        if (hecho) console.log(`   idempotencia: la llave ${llave} ya tiene rastro en audit_logs → no se repite`);

        // 3. Según el camino.
        let escribe: null | (() => Promise<string | null>) = null;
        if (c.accion === 'anotar') {
            const pc = c.porClasificarId ? pcPor.get(c.porClasificarId) : null;
            if (!pc) problemas.push(`la fila de «Por clasificar» ${corto(c.porClasificarId)} no existe`);
            else {
                if (pc.queue_id !== c.queueId) problemas.push('«Por clasificar» apunta a otra fila de la cola');
                if (pc.estado !== 'por_clasificar') problemas.push(`«Por clasificar» ya está ${pc.estado}`);
                if (Math.abs(Number(pc.monto) - c.monto) > 1) problemas.push(`monto de «Por clasificar» ${cop(Number(pc.monto))} ≠ ${cop(c.monto)}`);
                console.log(`   «Por clasificar» ${corto(pc.id)} · ${pc.estado} · ${cop(Number(pc.monto))} · ${pc.referencia ?? 'sin ref'} → visible en Cobros: NO se escribe nada`);
            }
        } else if (c.accion === 'por_clasificar') {
            const ya = pcDeCola.get(c.queueId);
            if (ya) { console.log(`   ya existe «Por clasificar» ${corto(ya.id)} (${ya.estado}) para esta fila: no se repite`); }
            else {
                console.log(`   SE HARÍA: registrar en «Por clasificar» (etiqueta ${c.etiqueta}, ${cop(c.monto)}, ${c.referencia}, ${c.fecha}) con el archivo de la fila. Sin payments, sin aprobar.`);
                escribe = async () => {
                    const { registrarPorClasificar } = await import('../src/services/wa-comprobante-por-clasificar.service');
                    const r = await registrarPorClasificar({
                        schoolId: ESCUELA, queueId: c.queueId, storagePath: cola.storage_path, telefono: cola.wa_phone_number, nombre: null,
                        motivoBot: cola.error_message,
                        decision: {
                            etiqueta: c.etiqueta!, monto: c.monto, referencia: c.referencia, fecha: c.fecha, banco: c.banco, destino: null,
                            contactoNombreEscrito: null, motivo: 'auditoria_2026_11_20',
                            propuesta: { motivo: 'auditoria_2026_11_20', detalle: `Registrado tras la auditoría del 2026-11-20 (${c.paraQue})`, pagador: null },
                        },
                    });
                    return r.ok ? null : `registrarPorClasificar: ${r.codigo}`;
                };
            }
        } else {
            const p = c.pagoId ? pagoPor.get(c.pagoId) : null;
            if (!p) problemas.push(`el cobro ${corto(c.pagoId)} no existe`);
            else {
                if (p.school_id !== ESCUELA) problemas.push('el cobro es de otra escuela');
                if (!['pending', 'overdue', 'partial'].includes(p.status)) problemas.push(`el cobro ya no está abierto (${p.status})`);
                if (c.childId && p.child_id !== c.childId) problemas.push('el cobro no es de la ficha esperada');
                if (Math.abs(Number(p.amount) - c.monto) > 1) problemas.push(`el cobro vale ${cop(Number(p.amount))}, no ${cop(c.monto)}: sería abono/exceso, revisar`);
                if (p.receipt_url) problemas.push('el cobro ya trae un comprobante');
                console.log(`   cobro ${corto(p.id)} · ${p.status} · ${cop(Number(p.amount))} (pagado ${cop(Number(p.amount_paid) || 0)}) · ${p.concept}`);
            }
            if (!problemas.length) {
                console.log(`   SE HARÍA: estampar el comprobante en ${corto(c.pagoId)} → awaiting_approval («Por validar»), con veredicto; amount_paid NO se toca (lo suma la aprobación). Marca outcome_notified_at: nadie recibe aviso.`);
                escribe = async () => {
                    const { estamparComprobante } = await import('../src/jobs/whatsapp-queue.job');
                    const { lecturaComoOcr } = await import('../src/services/wa-comprobante-por-clasificar.service');
                    const dl = await sb.storage.from(BUCKET).download(cola.storage_path);
                    if (dl.error || !dl.data) return `no se pudo bajar el archivo: ${dl.error?.message}`;
                    const sha = crypto.createHash('sha256').update(Buffer.from(await dl.data.arrayBuffer())).digest('hex');
                    const r = await estamparComprobante(
                        { schoolId: ESCUELA, storagePath: cola.storage_path, sha, queueId: c.queueId, log: console as any,
                            ocr: lecturaComoOcr({ amount: c.monto, reference: c.referencia, date: c.fecha, bank: c.banco, isReceipt: true, provider: 'auditoria_humana' }) },
                        { id: p.id, amount: Number(p.amount), concept: p.concept ?? null, due_date: null, child_id: p.child_id ?? null, atleta: null, categoria: 'torneo' },
                        undefined, { estados: ['pending', 'overdue', 'partial'] },
                    );
                    if (!r.ok) return r.duplicado ? `referencia ya usada por ${corto(r.yaAplicado?.id)}` : r.error;
                    const ahora = new Date().toISOString();
                    await sb.from('whatsapp_inbound_queue').update({
                        status: 'done', result_ref_id: p.id, outcome_notified_at: ahora,
                        error_message: `aplicado tras la auditoría 2026-11-20: abono en revisión de ${cop(c.monto)} (${c.referencia}); sin aviso a la familia`,
                    }).eq('id', c.queueId).eq('school_id', ESCUELA).is('result_ref_id', null);
                    return null;
                };
            }
        }

        for (const r of c.reportar ?? []) {
            const p = pagoPor.get(r.id);
            console.log(`   REPORTE ${corto(r.id)}${p ? ` · ${p.status} · ${cop(Number(p.amount))} · ${p.concept}` : ' · (cola)'} → ${r.nota}`);
        }
        for (const n of c.notas) console.log(`   · ${n}`);

        // 4. Resolver.
        if (problemas.length) { for (const x of problemas) console.log(`   ✗ ${x}`); resumen.bloqueados++; console.log(''); continue; }
        if (!escribe) { if (c.accion === 'anotar') resumen.anotados++; else resumen.saltados++; console.log(''); continue; }
        if (hecho) { resumen.saltados++; console.log(''); continue; }
        const confirmada = c.lecturaConfirmada || CONFIRMADAS.has(c.clave);
        if (!confirmada) {
            console.log(`   ⚠ lectura SIN confirmar contra la imagen: ${APLICAR ? 'NO se escribe' : 'aun con --aplicar no se escribiría'} hasta --confirmar-lectura ${c.clave}`);
            resumen.saltados++; console.log(''); continue;
        }
        if (!APLICAR) { if (c.accion === 'por_clasificar') resumen.porClasificar++; else resumen.aplicados++; console.log(''); continue; }

        // Auditoría ANTES de escribir.
        const { error: eAud } = await sb.from('audit_logs').insert({
            school_id: ESCUELA, profile_id: ACTOR, table_name: c.accion === 'aplicar_a_cobro' ? 'payments' : 'wa_comprobantes_por_clasificar',
            record_id: c.accion === 'aplicar_a_cobro' ? c.pagoId : c.queueId, action: ACCION_AUDIT, old_data: null,
            new_data: { _idempotency_key: llave, _caso: c.clave, _accion: c.accion, queue_id: c.queueId, pago_id: c.pagoId ?? null,
                monto: c.monto, referencia: c.referencia, fecha: c.fecha, etiqueta: c.etiqueta ?? null, sin_aviso_a_familia: true },
        } as never);
        if (eAud) { console.log(`   ✗ audit_logs: ${eAud.message} → no se escribe`); resumen.bloqueados++; console.log(''); continue; }
        const falla = await escribe();
        if (falla) { console.log(`   ✗ ${falla}`); resumen.bloqueados++; } else {
            console.log('   ✓ escrito'); if (c.accion === 'por_clasificar') resumen.porClasificar++; else resumen.aplicados++;
        }
        console.log('');
    }

    console.log(`${APLICAR ? 'Hecho' : 'Se haría'}: ${resumen.anotados} ya visibles (sin escribir) · ${resumen.porClasificar} a «Por clasificar» · ${resumen.aplicados} comprobantes a un cobro (Por validar) · ${resumen.saltados} sin escribir (lectura sin confirmar / ya hecho) · ${resumen.bloqueados} bloqueados`);
    if (!APLICAR) console.log('Nada se escribió.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
