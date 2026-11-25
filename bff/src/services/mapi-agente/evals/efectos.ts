/**
 * Lo que tiene que dejar el clic en Confirmar, por herramienta (punta a punta).
 *
 * Cada constructor devuelve el `efecto` de un caso: las escrituras que el
 * `ejecutar` de esa herramienta hace sobre la escuela de prueba (fixtures.ts),
 * leídas del código de la herramienta y de su servicio, y la `semilla` (la
 * llamada que el caso espera del modelo) para probar el Confirmar sin modelo.
 *
 * Lo que la escuela ve (vista previa) se contrasta con lo que queda escrito:
 * si la tarjeta dice «A la familia le llega el aviso por la app y por correo»,
 * el efecto exige la notificación y el correo.
 *
 * Ojo con los ids: la base falsa es la de fixtures.ts, una nueva por corrida.
 */

import {
    ADMIN_ID, AVISO, CATEGORIA_COPA, CLAVE, COACH_ID, COBRO, CONVERSACION, CORREO_FAMILIA, CUPO, EQUIPO_TORNEO, ESCUELA, IDS,
    INSCRIPCION, PADRE, PAGO, PLAN, PRODUCTO, PROSPECTO, RESERVA, SESION_ID, STAFF_COACH, T_TIBURONES, TORNEO, VARIANTE, WA_FAMILIA,
} from './fixtures';
import type { EscrituraEsperada, EsperaEfecto, PatronTexto, ValorEscrito } from './tipos';

export type Atleta = keyof typeof IDS;

/** Número de cada deportista en fixtures.ts y el de su familia (Emilia es de la familia 10). */
const NUMERO: Record<Atleta, number> = {
    marianaLopez: 1, marianaRestrepo: 2, mariaJose: 3, juanEsteban: 4, juanDavid: 5, santiago: 6,
    valentina: 7, samuel: 8, sofia: 9, tomas: 10, emilia: 11, danielTorres: 12,
};
const FAMILIA = (a: Atleta) => (a === 'emilia' ? 10 : a === 'danielTorres' ? 11 : NUMERO[a]);

/** La familia del deportista recibe la notificación en la app. */
const notificacion = (a: Atleta, valores: Record<string, ValorEscrito> = {}): EscrituraEsperada =>
    ({ tabla: 'notifications', op: 'insert', valores: { user_id: PADRE(FAMILIA(a)), ...valores } });
/** …y el correo. */
const correo = (a: Atleta): EscrituraEsperada => ({ salida: 'correo', valores: { to: CORREO_FAMILIA(FAMILIA(a)) } });

// ─── Excusas ────────────────────────────────────────────────────────────────

/**
 * excusar_ausencia: un aviso por día (source=staff, quien lo reporta), la
 * notificación y el correo a la familia; WhatsApp «ventana cerrada» (nadie
 * escribió en 24 h). `dias`: fechas exactas, o un patrón y cuántas.
 */
export function efectoExcusa(p: {
    atleta: Atleta; rol: 'admin' | 'coach'; dias: string[] | { patron: RegExp; n: [number, number] };
    motivo: ValorEscrito; semilla: { desde: string; hasta: string; motivo: string };
}): EsperaEfecto {
    const base = { child_id: IDS[p.atleta], reason: p.motivo, source: 'staff', status: 'active', reported_by: p.rol === 'admin' ? ADMIN_ID : COACH_ID, school_id: ESCUELA };
    const avisos: EscrituraEsperada[] = Array.isArray(p.dias)
        ? p.dias.map((d) => ({ tabla: 'athlete_absence_notices', op: 'insert', valores: { ...base, absence_date: d } }))
        : [{ tabla: 'athlete_absence_notices', op: 'insert', valores: { ...base, absence_date: p.dias.patron }, n: p.dias.n }];
    return {
        escrituras: [...avisos, notificacion(p.atleta, { category: 'calendar', title: /Excusa registrada/ }), correo(p.atleta)],
        mensaje_contiene: [/Quedó registrada la excusa/, /app: enviado · correo: enviado · WhatsApp: no salió/],
        semilla: { herramienta: 'excusar_ausencia', input: { deportista: CLAVE[p.atleta], ...p.semilla } },
    };
}

/** quitar_excusa: el aviso queda «cancelled» (nada se borra) y no se le escribe a nadie. */
export function efectoQuitarExcusa(p: { atleta: Atleta; aviso: number; dia: string }): EsperaEfecto {
    return {
        escrituras: [{ tabla: 'athlete_absence_notices', op: 'update', antes: { id: AVISO(p.aviso), status: 'active' }, valores: { status: 'cancelled' } }],
        mensaje_contiene: [/Se quitó 1 aviso/],
        semilla: { herramienta: 'quitar_excusa', input: { deportista: CLAVE[p.atleta], desde: p.dia, hasta: p.dia } },
    };
}

// ─── Recordatorio de pago (segundo plano) ───────────────────────────────────

/**
 * enviar_recordatorio_pago de octubre: tres familias (Santiago, Juan David y
 * Samuel), una plantilla «quedó pendiente» a cada una, su fila de
 * collection_notices como 'recordatorio_manual' y el sello overdue_notice_sent_at.
 */
export function efectoRecordatorioOctubre(quienes: Atleta[] = ['santiago', 'juanDavid', 'samuel']): EsperaEfecto {
    const cobroDe: Partial<Record<Atleta, number>> = { santiago: 1, juanDavid: 2, samuel: 3 };
    return {
        escrituras: quienes.flatMap((a): EscrituraEsperada[] => [
            { salida: 'plantilla_whatsapp', valores: { to: WA_FAMILIA(FAMILIA(a)), concepto: 'pendiente_suave', paymentId: COBRO(cobroDe[a]!) } },
            { tabla: 'collection_notices', op: 'insert', valores: { payment_id: COBRO(cobroDe[a]!), notice_type: 'recordatorio_manual', status: 'sent', channel: 'whatsapp', is_lead: true, family_key: `wa:${WA_FAMILIA(FAMILIA(a))}` } },
            { tabla: 'payments', op: 'update', antes: { id: COBRO(cobroDe[a]!), status: 'overdue', overdue_notice_sent_at: null }, valores: { overdue_notice_sent_at: /^\d{4}-\d{2}-\d{2}T/ } },
        ]),
        mensaje_contiene: [new RegExp(`Salió el recordatorio de octubre de 2026 a ${quienes.length} familias`)],
        semilla: { herramienta: 'enviar_recordatorio_pago', input: { periodo: '2026-10' } },
    };
}

// ─── Pagos ──────────────────────────────────────────────────────────────────

/** pedir_aclaracion: create_glosa (la RPC deja la glosa y el pago «glosado») y el correo a la familia. */
export function efectoAclaracion(p: { pago: string; motivo: string; atleta: Atleta }): EsperaEfecto {
    return {
        escrituras: [
            { rpc: 'create_glosa', valores: { p_payment_id: p.pago, p_reason: p.motivo, p_actor: ADMIN_ID }, sesion: 'service_role' },
            { tabla: 'payment_glosas', op: 'insert', valores: { payment_id: p.pago, reason: p.motivo, status: 'GLOSADA' } },
            { tabla: 'payments', op: 'update', antes: { id: p.pago, status: 'awaiting_approval' }, valores: { status: 'glosado' } },
            correo(p.atleta),
        ],
        mensaje_contiene: [/Se le pidió a la familia de .* que aclare el comprobante/, /Tiene hasta el/],
        semilla: { herramienta: 'pedir_aclaracion', input: { pago: p.pago, motivo: p.motivo } },
    };
}

// ─── Entrenador ─────────────────────────────────────────────────────────────

/**
 * registrar_asistencia de HOY en Tiburones (siete en la lista: Mariana López,
 * María José, Juanes, Santiago, Valentina, Sofía y Tomás, ficha sin cuenta).
 * Se crea la sesión, una marca por deportista (upsert_attendance_record), una
 * clase descontada por cada presente con saldo, y Juanes (8 de 8 clases) queda
 * «sin clases»: su familia recibe el aviso del plan excedido.
 */
export function efectoListaHoy(p: { presentes: Atleta[]; ausentes: Atleta[]; semilla: Record<string, unknown>; mensaje: PatronTexto[] }): EsperaEfecto {
    const idDe = (a: Atleta): Record<string, ValorEscrito> => (a === 'tomas' ? { p_unregistered_id: IDS.tomas } : { p_child_id: IDS[a] });
    const conSaldo = p.presentes.filter((a) => a !== 'juanEsteban');
    return {
        escrituras: [
            { tabla: 'attendance_sessions', op: 'insert', valores: { team_id: T_TIBURONES, session_date: '2026-11-24', created_by: COACH_ID, coach_id: STAFF_COACH } },
            ...p.presentes.map((a): EscrituraEsperada => ({ rpc: 'upsert_attendance_record', valores: { ...idDe(a), p_status: 'present', p_attendance_date: '2026-11-24', p_team_id: T_TIBURONES, p_marked_by: COACH_ID } })),
            ...p.ausentes.map((a): EscrituraEsperada => ({ rpc: 'upsert_attendance_record', valores: { ...idDe(a), p_status: 'absent', p_attendance_date: '2026-11-24' } })),
            ...conSaldo.map((a): EscrituraEsperada => ({ rpc: 'move_session_credit', valores: { p_enrollment_id: INSCRIPCION(NUMERO[a]), p_delta: 1, p_is_secondary: false } })),
            ...(p.presentes.includes('juanEsteban') ? [notificacion('juanEsteban', { type: 'attendance', 'metadata.hito': 'excedida' })] : []),
        ],
        mensaje_contiene: p.mensaje,
        semilla: { herramienta: 'registrar_asistencia', input: p.semilla },
    };
}

/** evaluar_entreno del jueves 19 de Tiburones: vinieron Mariana López, Juanes y Sofía (Tomás es ficha sin cuenta). */
export function efectoEvaluarJueves(): EsperaEfecto {
    const nota = (a: Atleta, pct: number) => new RegExp(`"child_id":"${IDS[a]}","effort_pct":${pct}`);
    return {
        escrituras: [{
            rpc: 'submit_post_training_coach_rating', sesion: 'coach',
            valores: {
                p_session_id: SESION_ID(T_TIBURONES, '2026-11-19'), 'p_ratings.length': 3,
                p_ratings: new RegExp(`(?=[\\s\\S]*${nota('juanEsteban', 60).source})(?=[\\s\\S]*${nota('marianaLopez', 90).source})(?=[\\s\\S]*${nota('sofia', 90).source})`),
            },
        }],
        mensaje_contiene: [/Quedó guardada la evaluación del entreno de Sub-12 Tiburones del jueves 19 de noviembre de 2026 \(3 deportistas/],
        semilla: { herramienta: 'evaluar_entreno', input: { equipo: 'tiburones', fecha: '2026-11-19', bien: [], le_costo: [CLAVE.juanEsteban], los_demas: 'bien', nota: null } },
    };
}

/** felicitar: give_kudos como la persona (la RPC avisa a la familia). */
export function efectoFelicitar(p: { atleta: Atleta; mensaje: ValorEscrito; semilla: string }): EsperaEfecto {
    return {
        escrituras: [{ rpc: 'give_kudos', sesion: 'coach', valores: { p_school_id: ESCUELA, p_child_id: IDS[p.atleta], p_message: p.mensaje } }],
        mensaje_contiene: [/^Se envió la felicitación a /],
        semilla: { herramienta: 'felicitar', input: { deportista: CLAVE[p.atleta], mensaje: p.semilla } },
    };
}

// ─── Escuela ────────────────────────────────────────────────────────────────

const MOTIVO_PAUSA: Record<string, string> = { vacaciones: 'vacation', lesion: 'injury', otro: 'other' };

/** pausar_inscripcion: pause_enrollment_directly como la persona, sobre la inscripción del deportista. */
export function efectoPausa(p: { atleta: Atleta; desde: string; hasta: string; motivo: 'vacaciones' | 'lesion' | 'otro' }): EsperaEfecto {
    return {
        escrituras: [{
            rpc: 'pause_enrollment_directly', sesion: 'admin',
            valores: { p_enrollment_id: INSCRIPCION(NUMERO[p.atleta]), p_reason: MOTIVO_PAUSA[p.motivo], p_month_from: `${p.desde}-01`, p_month_to: `${p.hasta}-01` },
        }],
        mensaje_contiene: [/quedó en pausa/],
        semilla: { herramienta: 'pausar_inscripcion', input: { deportista: CLAVE[p.atleta], desde: p.desde, hasta: p.hasta, motivo: p.motivo, nota: null } },
    };
}

/** reactivar_inscripcion de Emilia: resume_enrollment; noviembre sigue sin cobro (la tarjeta lo dijo). */
export function efectoReactivarEmilia(): EsperaEfecto {
    return {
        escrituras: [{ rpc: 'resume_enrollment', sesion: 'admin', valores: { p_enrollment_id: INSCRIPCION(11) } }],
        mensaje_contiene: [/Emilia Castro volvió de la pausa/, /El mes en curso sigue sin cobro/],
        semilla: { herramienta: 'reactivar_inscripcion', input: { deportista: CLAVE.emilia, nota: null } },
    };
}

/** dar_de_baja: set_school_athlete_status(p_active=false) con la escuela de la SESIÓN. */
export function efectoBaja(p: { atleta: Atleta; cobros: number; motivo: string }): EsperaEfecto {
    return {
        escrituras: [{
            rpc: 'set_school_athlete_status', sesion: 'admin',
            valores: { p_school_id: ESCUELA, p_athlete_type: 'child', p_athlete_id: IDS[p.atleta], p_active: false },
        }],
        mensaje_contiene: [new RegExp(`quedó inactivo: se canceló su plan y se anularon ${p.cobros} cobros pendientes`)],
        semilla: { herramienta: 'dar_de_baja', input: { deportista: CLAVE[p.atleta], motivo: p.motivo } },
    };
}

/**
 * cambiar_plan de Santiago al de 3 días (crearInscripcion REAL sobre la base
 * falsa): se anula su mensualidad pendiente de noviembre del plan viejo, la
 * inscripción pasa al plan nuevo y nace la mensualidad de $150.000.
 */
export function efectoPlanSantiago(): EsperaEfecto {
    return {
        escrituras: [
            { tabla: 'payments', op: 'update', antes: { id: COBRO(4), status: 'pending' }, valores: { status: 'cancelled' } },
            { tabla: 'enrollments', op: 'update', antes: { id: INSCRIPCION(6), offering_plan_id: PLAN.dos }, valores: { offering_plan_id: PLAN.tres, monthly_fee: 150000 } },
            {
                tabla: 'payments', op: 'insert',
                valores: { child_id: IDS.santiago, parent_id: PADRE(6), amount: 150000, offering_plan_id: PLAN.tres, status: 'pending', payment_category: 'mensualidad', period_year: 2026, period_month: 11 },
            },
        ],
        mensaje_contiene: [/Santiago Morales pasó de Mensualidad 2 días por semana a Mensualidad 3 días por semana/],
        semilla: { herramienta: 'cambiar_plan', input: { deportista: CLAVE.santiago, plan: PLAN.tres, cobro: null } },
    };
}

/**
 * cambiar_plan de Juanes con banco de horas y noviembre ya pagado: la
 * inscripción pasa al plan nuevo, corre apply_hour_bank_plan_change y nace SOLO
 * el cobro que eligió la persona (parcial $30.000 o completo $150.000).
 */
export function efectoPlanJuanes(modo: 'parcial' | 'completo'): EsperaEfecto {
    const monto = modo === 'parcial' ? 30000 : 150000;
    return {
        escrituras: [
            { tabla: 'enrollments', op: 'update', antes: { id: INSCRIPCION(4), offering_plan_id: PLAN.dos }, valores: { offering_plan_id: PLAN.tres, monthly_fee: 150000 } },
            { rpc: 'apply_hour_bank_plan_change', valores: { p_enrollment_id: INSCRIPCION(4) }, sesion: 'service_role' },
            {
                tabla: 'payments', op: 'insert',
                valores: {
                    child_id: IDS.juanEsteban, parent_id: PADRE(4), amount: monto, status: 'pending', period_uniqueness_exempt: true,
                    offering_plan_id: modo === 'completo' ? PLAN.tres : null,
                },
            },
        ],
        mensaje_contiene: [new RegExp(`Se emitió el cobro ${modo} de \\$${monto.toLocaleString('es-CO').replace(/,/g, '.')}`)],
        semilla: { herramienta: 'cambiar_plan', input: { deportista: CLAVE.juanEsteban, plan: PLAN.tres, cobro: modo } },
    };
}

/** crear_cobro_unico: el lote va a create_charge_batch con lo de la tarjeta (idempotente por client_request_id). */
export function efectoCobroUnico(p: {
    equipo: boolean; deportistas: number; categoria: string; monto: number; vence: string; avisar: boolean;
    semilla: Record<string, unknown>; mensaje: PatronTexto[];
}): EsperaEfecto {
    return {
        escrituras: [{
            servicio: 'createChargeBatch',
            valores: {
                mode: 'multi', 'target.kind': p.equipo ? 'team' : 'list', ...(p.equipo ? { 'target.ids.0': T_TIBURONES } : {}),
                'athletes.length': p.deportistas, 'lines.length': 1, 'lines.0.category': p.categoria, 'lines.0.amount': p.monto, 'lines.0.due_date': p.vence,
                notify_families: p.avisar, confirmar_duplicado: true, client_request_id: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                preview_hash: /^eval-/, school_id: ESCUELA, user_id: ADMIN_ID,
            },
        }],
        mensaje_contiene: p.mensaje,
        semilla: { herramienta: 'crear_cobro_unico', input: p.semilla },
    };
}

// ─── Informes, torneos y clase de prueba ────────────────────────────────────

/** enviar_informe_atleta de octubre: el informe se reclama y se sella, correo (edge send-email) y aviso en la app. */
export function efectoEnviarInforme(p: { atleta: Atleta }): EsperaEfecto {
    return {
        escrituras: [
            {
                tabla: 'athlete_reports', op: 'update', antes: { subject_id: IDS[p.atleta], period_month: 10, sent_at: null },
                valores: { sent_at: /^\d{4}-\d{2}-\d{2}T/, send_claimed_at: /^\d{4}-\d{2}-\d{2}T/ },
            },
            notificacion(p.atleta, { type: 'report' }),
            correo(p.atleta),
        ],
        mensaje_contiene: [/^Se envió el informe de octubre de 2026 de /],
        semilla: { herramienta: 'enviar_informe_atleta', input: { deportista: CLAVE[p.atleta], mes: '2026-10' } },
    };
}

/** convocar_a_torneo: los nuevos a la nómina de «Tiburones Pruebas Mapi» en la Copa; sin cobro ni aviso. */
export function efectoConvocar(atletas: Atleta[]): EsperaEfecto {
    return {
        escrituras: atletas.map((a): EscrituraEsperada => ({
            tabla: 'event_team_members', op: 'insert', valores: { team_id: EQUIPO_TORNEO.tiburones, child_id: IDS[a], is_external: false },
        })),
        mensaje_contiene: [atletas.length === 1 ? /Quedó 1 deportista en la nómina/ : new RegExp(`Quedaron ${atletas.length} deportistas en la nómina`)],
        semilla: { herramienta: 'convocar_a_torneo', input: { torneo: TORNEO.copa, equipo_torneo: null, deportistas: atletas.map((a) => CLAVE[a]) } },
    };
}

/**
 * inscribir_a_torneo de Tiburones en la Copa: los 5 nuevos (Mariana López ya
 * estaba; Tomás es ficha sin cuenta), uno por uno con la RPC como la persona, y
 * el aviso a cada familia.
 */
export function efectoInscribirTiburones(): EsperaEfecto {
    const nuevos: Atleta[] = ['mariaJose', 'juanEsteban', 'santiago', 'valentina', 'sofia'];
    return {
        escrituras: nuevos.flatMap((a): EscrituraEsperada[] => [
            { rpc: 'school_register_athlete_for_tournament', sesion: 'admin', valores: { p_event_id: TORNEO.copa, p_category_id: CATEGORIA_COPA, p_child_id: IDS[a] } },
            notificacion(a, { category: 'tournament', link: `/tournaments/${TORNEO.copa}/register` }),
        ]),
        mensaje_contiene: [/Quedaron inscritos 5 deportistas en Copa Navidad Pruebas Mapi/, /Se crearon 5 cobros de \$60\.000/],
        semilla: { herramienta: 'inscribir_a_torneo', input: { torneo: TORNEO.copa, categoria: null, equipo: 'tiburones', deportistas: null } },
    };
}

/** agendar_clase_de_prueba de Martín el jueves 26 con Tiburones: la RPC del buzón, sin pago. */
export function efectoAgendarMartin(): EsperaEfecto {
    return {
        escrituras: [{
            rpc: 'agendar_clase_prueba_desde_chat', sesion: 'admin',
            valores: { p_conversation_id: CONVERSACION.martin, p_slot_id: CUPO.juevesTiburones, p_nombre: 'Martín Ospina', p_monto: null, p_metodo: null, p_referencia: null },
        }],
        mensaje_contiene: [/Quedó agendada la clase de prueba de Martín Ospina el jueves 26 de noviembre/],
        semilla: { herramienta: 'agendar_clase_de_prueba', input: { prospecto: PROSPECTO.martin, fecha: '2026-11-26', equipo: 'tiburones', hora: null } },
    };
}

// ─── Tienda y reservas ──────────────────────────────────────────────────────

/** ajustar_stock: inventory_adjust (con el stock FINAL) y el rastro en security_audit_log. */
export function efectoStock(p: { variante?: string; nuevo: number; razon: 'manual_restock' | 'manual_adjust'; semilla: Record<string, unknown>; mensaje: PatronTexto[] }): EsperaEfecto {
    const producto = p.variante ? null : PRODUCTO.balon;
    return {
        escrituras: [
            {
                rpc: 'inventory_adjust', sesion: 'service_role',
                valores: { p_variant_id: p.variante ?? null, p_product_id: producto, p_new_stock: p.nuevo, p_reason_code: p.razon, p_actor: ADMIN_ID },
            },
            {
                tabla: 'security_audit_log', op: 'insert',
                valores: { user_id: ADMIN_ID, target_table: p.variante ? 'product_variants' : 'products', target_id: p.variante ?? PRODUCTO.balon, 'new_value.new_stock': p.nuevo },
            },
        ],
        mensaje_contiene: p.mensaje,
        semilla: { herramienta: 'ajustar_stock', input: p.semilla },
    };
}

/** cancelar_reserva: la RPC (devolución 100 % de lo pagado, por registrar) y, si era de otra persona, la auditoría. */
export function efectoCancelarReserva(p: { reserva: 'carlos' | 'veteranos'; devolucion: string; motivo: string }): EsperaEfecto {
    const id = RESERVA[p.reserva];
    return {
        escrituras: [
            { rpc: 'cancelar_reserva', sesion: 'service_role', valores: { p_reservation_id: id, p_actor_profile_id: ADMIN_ID } },
            ...(p.reserva === 'carlos'
                ? [{ tabla: 'security_audit_log', op: 'insert', valores: { user_id: ADMIN_ID, target_table: 'facility_reservations', target_id: id, 'old_value.status': 'confirmed' } } as EscrituraEsperada]
                : []),
        ],
        mensaje_contiene: [new RegExp(`Devolución: 100 % \\(${p.devolucion.replace(/[$.]/g, '\\$&')}\\)`)],
        semilla: { herramienta: 'cancelar_reserva', input: { reserva: id, motivo: p.motivo } },
    };
}

export { PAGO, VARIANTE };
