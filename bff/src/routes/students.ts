import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { todayInZone } from '../utils/businessDate';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { normalizeSchoolName } from '../utils/brandingUtils';
import { prepareZkPinForSignup, assignZkPin, ZkPinError, type ZkSubject } from '../services/zkPinAssignment';
import { esMenorDeEdad } from '../services/contacto-acudiente';
import {
    createPendingPayment as createPendingPaymentShared,
    cancelPendingPlanPayments,
    cancelUnpaidPeriodCharges,
    accionCobroDePlan,
    INACTIVE_ATHLETE_ERROR,
    PLAN_PERIOD_CHARGE_FILTER,
    repricePendingCharges,
} from '../services/enrollmentBilling';
import { previewPlanChange, applyPlanChangeEffects } from '../services/planChange.service';

const router = Router();

// ── Schema Zod v4 ─────────────────────────────────────────────────────────────
// ⚠️  En Zod v4, los errores están en `error.issues`, no en `error.errors`
const StudentSchema = z.object({
    first_name: z.string().min(1, 'Nombre requerido').max(100).trim(),
    last_name: z.string().min(1, 'Apellido requerido').max(100).trim(),
    document_id: z.string().min(1, 'Documento requerido').max(30),
    grade: z.string().max(20).optional(),
    medical_info: z.string().max(1000).refine(
        val => { try { const p = JSON.parse(val); return typeof p.has_allergies === 'boolean'; } catch { return false; } },
        { message: 'notas_medicas debe ser JSON válido con campo has_allergies (boolean). Ej: {"has_allergies": false}' }
    ).optional(),
    branch: z.string().max(100).optional(),
    team: z.string().min(1, 'Equipo requerido').max(100),
    sport: z.string().min(1, 'Deporte requerido').max(100),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha de nacimiento debe tener formato YYYY-MM-DD').optional(),
    gender: z.string().optional(),
    parent_name: z.string().min(2, 'Nombre del acudiente requerido (mín. 2 caracteres)'),
    parent_email: z.string().email('Email del acudiente inválido'),
    parent_phone: z.string().regex(/^\d{10,}$/, 'Teléfono del acudiente debe tener mínimo 10 dígitos numéricos'),
    monthly_fee: z.number().min(10000, 'La mensualidad debe ser mínimo $10,000 COP').optional(),
});

const BulkUploadSchema = z.object({
    students: z.array(StudentSchema)
        .min(1, 'Al menos un deportista requerido')
        .max(200, 'Máximo 200 deportistas por carga'),
    options: z.object({
        // Si true: actualiza si document_id ya existe. Si false: reporta como error.
        upsert: z.boolean().default(false),
        // Branch ID por defecto para deportistas sin columna 'sede' en el CSV
        defaultBranchId: z.string().uuid().nullable().optional(),
    }).default({ upsert: false }),
});

// children-by-ids — resuelve nombres/PII de menores por lote.
// IMPORTANTE: el BFF usa service role (bypassa RLS). Sin el filtro school_id
// abajo, un admin de la escuela A podía obtener PII medica de niños de la
// escuela B con sólo saber los UUIDs.
async function fetchChildrenByIds(
    req: AuthenticatedRequest,
    res: Response,
    ids: string[] | undefined,
): Promise<Response> {
    try {
        const cleanIds = [...new Set((ids ?? []).filter(Boolean))];
        if (!cleanIds.length) return res.json([]);

        const { schoolId } = req;
        if (!schoolId) {
            return res.status(400).json({ error: 'schoolId del request es requerido.' });
        }

        // supabase-js traduce .in() a un GET a PostgREST con los IDs en la URL,
        // así que con lotes grandes la URL de PostgREST también revienta (500).
        // Chunkeamos para mantener cada query dentro de límites seguros.
        const CHUNK = 150;
        const rows: any[] = [];
        for (let i = 0; i < cleanIds.length; i += CHUNK) {
            const slice = cleanIds.slice(i, i + CHUNK);
            const { data, error } = await supabase
                .from('children')
                .select('id, full_name, date_of_birth, avatar_url, school_id, medical_info')
                .in('id', slice)
                .eq('school_id', schoolId);
            if (error) throw error;
            if (data?.length) rows.push(...data);
        }
        return res.json(rows);
    } catch (err: any) {
        req.log?.error({ err }, 'children-by-ids unhandled error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
}

// GET /api/v1/students/children-by-ids?ids=uuid1,uuid2
// Se mantiene por compatibilidad, pero con lotes grandes la URL supera el
// límite del proxy (503 / ERR_FAILED). Preferir el POST de abajo.
router.get('/children-by-ids', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const ids = (req.query.ids as string)?.split(',');
    return fetchChildrenByIds(req, res, ids);
});

// POST /api/v1/students/children-by-ids  { ids: uuid[] }
// Los IDs van en el body para evitar URLs gigantes cuando el lote es grande.
router.post('/children-by-ids', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : undefined;
    return fetchChildrenByIds(req, res, ids);
});

// ── POST /api/v1/students/bulk ────────────────────────────────────────────────
router.post(
    '/bulk',
    requireAuth,
    // Carga masiva de atletas: SOLO admin/owner (coach de escuela no crea atletas).
    requireRole('owner', 'admin', 'super_admin', 'school_admin', 'school'),
    async (req: AuthenticatedRequest, res: Response) => {
        try {
            const { schoolId } = req;

            // 1. Validar payload
            const parsed = BulkUploadSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    error: 'Datos inválidos.',
                    // ✅ Zod v4: usar .issues en vez de .errors
                    details: parsed.error.issues,
                });
            }

            const { students, options } = parsed.data;
            const defaultBranchId = options.defaultBranchId || null;

            // 2. Detectar duplicados DENTRO del mismo payload (document_id repetido)
            const docIds = students.map(s => s.document_id);
            const duplicatesInPayload = docIds.filter((id, i) => docIds.indexOf(id) !== i);
            if (duplicatesInPayload.length > 0) {
                return res.status(400).json({
                    error: 'El payload tiene document_id duplicados.',
                    duplicates: [...new Set(duplicatesInPayload)],
                });
            }

            // 3. Buscar cuáles ya existen en esta escuela (usando colas SQL reales: children.doc_number)
            const { data: existing } = await supabase
                .from('children')
                .select('id, doc_number')
                .eq('school_id', schoolId)
                .in('doc_number', docIds);

            const existingMap = new Map(existing?.map(s => [s.doc_number, s.id]) ?? []);

            // 4. Separar en nuevos vs. existentes
            const toInsert: typeof students = [];
            const toUpdate: Array<{ id: string; data: (typeof students)[0] }> = [];
            const skipped: Array<{ document_id: string; reason: string }> = [];

            for (const student of students) {
                const existingId = existingMap.get(student.document_id);
                if (existingId) {
                    if (options.upsert) {
                        toUpdate.push({ id: existingId, data: student });
                    } else {
                        skipped.push({ document_id: student.document_id, reason: 'Ya existe. Activa upsert para actualizar.' });
                    }
                } else {
                    toInsert.push(student);
                }
            }

            // 4.5. Auto-crear sedes (branches) ───────────────────────────
            let branchesCreated = 0;
            const branchNameToId = new Map<string, string>(); // lowercase name → id

            // Collect unique branch names
            const branchNamesSet = new Set<string>();
            const branchOriginalNames = new Map<string, string>();
            for (const student of students) {
                if (student.branch) {
                    const key = student.branch.trim().toLowerCase();
                    branchNamesSet.add(key);
                    if (!branchOriginalNames.has(key)) {
                        branchOriginalNames.set(key, student.branch.trim());
                    }
                }
            }

            if (branchNamesSet.size > 0) {
                // Fetch ALL branches for this school to do case-insensitive matching locally
                const { data: allExistingBranches } = await supabase
                    .from('school_branches')
                    .select('id, name')
                    .eq('school_id', schoolId);

                for (const b of allExistingBranches ?? []) {
                    branchNameToId.set(b.name.toLowerCase(), b.id);
                }

                // Create missing branches
                const branchesToCreate = [...branchNamesSet]
                    .filter(key => !branchNameToId.has(key))
                    .map(key => ({
                        name: branchOriginalNames.get(key) || key,
                        school_id: schoolId,
                        status: 'active',
                        created_at: new Date().toISOString(),
                    }));

                if (branchesToCreate.length > 0) {
                    const { data: createdBranches, error: branchError } = await supabase
                        .from('school_branches')
                        .insert(branchesToCreate)
                        .select('id, name');

                    if (branchError) {
                        req.log?.error({ err: branchError }, 'Error creando sedes');
                    } else {
                        branchesCreated = createdBranches?.length ?? 0;
                        for (const b of createdBranches ?? []) {
                            branchNameToId.set(b.name.toLowerCase(), b.id);
                        }
                    }
                }
            }

            // Helper: resolve branch_id for a student — falls back to defaultBranchId
            const resolveBranchId = (student: { branch?: string }) => {
                if (student.branch) {
                    return branchNameToId.get(student.branch.trim().toLowerCase()) || defaultBranchId;
                }
                return defaultBranchId;
            };

            // 4.75. Auto-crear equipos (teams) ─────────────────────────────
            let teamsCreated = 0;
            const existingTeamMap = new Map<string, string>(); // lowercase name → id

            // Collect unique team names from all students
            const teamStudentMap = new Map<string, { sport: string; branch?: string }>();
            const teamOriginalNames = new Map<string, string>();

            for (const student of students) {
                if (student.team) {
                    const teamKey = student.team.trim().toLowerCase();
                    if (!teamStudentMap.has(teamKey)) {
                        teamStudentMap.set(teamKey, {
                            sport: student.sport || 'General',
                            branch: student.branch,
                        });
                        teamOriginalNames.set(teamKey, student.team.trim());
                    }
                }
            }

            if (teamStudentMap.size > 0) {
                // Fetch ALL teams for this school to do case-insensitive matching locally
                const { data: allExistingTeams } = await supabase
                    .from('teams')
                    .select('id, name')
                    .eq('school_id', schoolId);

                for (const t of allExistingTeams ?? []) {
                    existingTeamMap.set(t.name.toLowerCase(), t.id);
                }

                // Create missing teams
                const teamsToCreate = [...teamStudentMap.entries()]
                    .filter(([key]) => !existingTeamMap.has(key))
                    .map(([key, val]) => ({
                        name: teamOriginalNames.get(key) || key,
                        sport: val.sport,
                        school_id: schoolId,
                        branch_id: val.branch ? resolveBranchId({ branch: val.branch }) : null,
                        status: 'active',
                        current_students: 0,
                        created_at: new Date().toISOString(),
                    }));

                if (teamsToCreate.length > 0) {
                    const { data: createdTeams, error: teamError } = await supabase
                        .from('teams')
                        .insert(teamsToCreate)
                        .select('id, name');

                    if (teamError) {
                        req.log?.error({ err: teamError }, 'Error creando equipos');
                    } else {
                        teamsCreated = createdTeams?.length ?? 0;
                        for (const t of createdTeams ?? []) {
                            existingTeamMap.set(t.name.toLowerCase(), t.id);
                        }
                    }
                }
            }

            const resolveTeamId = (student: { team?: string }) => {
                if (!student.team) return null;
                return existingTeamMap.get(student.team.trim().toLowerCase()) || null;
            };

            // 5. Ejecutar inserts
            let inserted = 0;
            const insertedChildMap = new Map<string, string>(); // doc_number → child_id
            if (toInsert.length > 0) {
                const records = toInsert.map(s => ({
                    full_name: `${s.first_name} ${s.last_name}`.trim(),
                    doc_number: s.document_id,
                    doc_type: 'CC', // Por defecto
                    grade: s.grade,
                    medical_info: s.medical_info,
                    school_id: schoolId,
                    branch_id: resolveBranchId(s),
                    team_id: resolveTeamId(s),  // Sincronizar para que la vista filtre correctamente
                    date_of_birth: s.date_of_birth || null,
                    gender: s.gender || null,
                    parent_name_temp: s.parent_name || null,
                    parent_email_temp: s.parent_email || null,
                    parent_phone_temp: s.parent_phone || null,
                    is_demo: false,
                    is_active: true,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                }));

                const { data, error } = await supabase
                    .from('children')
                    .insert(records)
                    .select('id, doc_number');

                if (error) {
                    req.log?.error({ err: error }, 'Error en bulk insert');
                    return res.status(500).json({
                        error: 'Error en base de datos al insertar.',
                        details: error.message,
                        hint: error.hint,
                        code: error.code,
                    });
                }
                inserted = data?.length ?? 0;

                // Map doc_number → child id for enrollment later
                for (const row of data ?? []) {
                    insertedChildMap.set(row.doc_number, row.id);
                }
            }

            // 6. Ejecutar updates (si upsert: true)
            let updated = 0;
            for (const { id, data: s } of toUpdate) {
                const { error } = await supabase
                    .from('children')
                    .update({
                        full_name: `${s.first_name} ${s.last_name}`.trim(),
                        doc_number: s.document_id,
                        grade: s.grade,
                        medical_info: s.medical_info,
                        branch_id: resolveBranchId(s),
                        team_id: resolveTeamId(s),  // Sincronizar para que la vista filtre correctamente
                        date_of_birth: s.date_of_birth || null,
                        gender: s.gender || null,
                        parent_name_temp: s.parent_name || null,
                        parent_email_temp: s.parent_email || null,
                        parent_phone_temp: s.parent_phone || null,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', id)
                    .eq('school_id', schoolId);

                if (!error) updated++;
            }

            // 7. Auto-crear enrollments y pagos ─────────────────────────────
            let enrollmentsCreated = 0;
            let paymentsCreated = 0;

            if (insertedChildMap.size > 0 || toUpdate.length > 0) {
                // Build a doc_number → child_id map for ALL students (inserted + updated)
                const allDocIds = students.map(s => s.document_id);
                const { data: childRows } = await supabase
                    .from('children')
                    .select('id, doc_number')
                    .eq('school_id', schoolId)
                    .in('doc_number', allDocIds);

                const docToChildId = new Map(
                    (childRows ?? []).map(c => [c.doc_number, c.id])
                );

                // Create enrollments & payments
                const enrollmentRecords: Array<{ child_id: string; team_id: string; school_id: string; status: string; start_date: string }> = [];
                const paymentRecords: Array<any> = [];

                const dueDate = new Date();
                dueDate.setMonth(dueDate.getMonth() + 1);
                // EL PERÍODO ES EL MES DE ENTRADA, no el del vencimiento. Sin
                // period_year/period_month el trigger `trg_payments_fill_period` los
                // deriva del `due_date` (que acá cae el mes siguiente) y el mes en que
                // el atleta entró no se facturaba nunca. Mismo criterio que
                // `calcFirstPayment` (prorationUtils) en el alta de a uno.
                const [periodYear, periodMonth] = todayInZone().split('-').map(Number);

                for (const student of students) {
                    const childId = docToChildId.get(student.document_id);
                    if (!childId) continue;

                    const teamId = resolveTeamId(student);
                    if (teamId) {
                        enrollmentRecords.push({
                            child_id: childId,
                            team_id: teamId,
                            school_id: schoolId,
                            status: 'active',
                            start_date: todayInZone(),
                        });
                    }

                    // Solo crear pago para los recién insertados para evitar duplicar cobros en upsert
                    const isNewChild = [...insertedChildMap.values()].includes(childId);
                    // Sin cuota en el CSV no nace cobro. Antes se inventaban $150.000:
                    // el atleta entraba debiendo un monto que la escuela nunca configuró.
                    // Mismo criterio que students-create-one (sin cuota, sin cobro).
                    const cuota = Number(student.monthly_fee) || 0;
                    if (isNewChild && cuota > 0) {
                        paymentRecords.push({
                            parent_id: null,
                            child_id: childId,
                            school_id: schoolId,
                            branch_id: resolveBranchId(student),
                            amount: cuota,
                            concept: `Mensualidad ${student.team || 'Programa'} - ${student.first_name} ${student.last_name}`.trim(),
                            due_date: dueDate.toISOString().split('T')[0],
                            status: 'pending',
                            // 'one_time'|'subscription' (payments_payment_type_check); 'monthly' rompía el INSERT
                            payment_type: 'one_time',
                            period_year: periodYear,
                            period_month: periodMonth,
                        });
                    }
                }

                if (paymentRecords.length > 0) {
                    const { data: paymentsData, error: paymentsError } = await supabase
                        .from('payments')
                        .insert(paymentRecords)
                        .select('id');

                    if (paymentsError) {
                        req.log?.error({ err: paymentsError }, 'Error creando pagos');
                    } else {
                        paymentsCreated = paymentsData?.length ?? 0;
                    }
                }

                if (enrollmentRecords.length > 0) {
                    // Check which enrollments already exist to avoid duplicates
                    const childIdsForEnroll = enrollmentRecords.map(e => e.child_id);
                    const teamIdsForEnroll = [...new Set(enrollmentRecords.map(e => e.team_id))];

                    const { data: existingEnrollments } = await supabase
                        .from('enrollments')
                        .select('child_id, team_id')
                        .in('child_id', childIdsForEnroll)
                        .in('team_id', teamIdsForEnroll);

                    const existingEnrollSet = new Set(
                        (existingEnrollments ?? []).map(e => `${e.child_id}:${e.team_id}`)
                    );

                    const newEnrollments = enrollmentRecords.filter(
                        e => !existingEnrollSet.has(`${e.child_id}:${e.team_id}`)
                    );

                    if (newEnrollments.length > 0) {
                        const { data: enrollData, error: enrollError } = await supabase
                            .from('enrollments')
                            .insert(newEnrollments)
                            .select('id');

                        if (enrollError) {
                            req.log?.error({ err: enrollError }, 'Error creando enrollments');
                        } else {
                            enrollmentsCreated = enrollData?.length ?? 0;
                        }
                    }
                }
            }

            // 8. Auto-crear Invitaciones para correos de padres
            let invitationsCreated = 0;

            // Recolectar correos únicos de padres con la info del primer hijo que encontremos para la plantilla
            const parentEmailMap = new Map<string, { childName: string; teamId: string | null; fee: number | null; parentName: string }>();

            for (const s of students) {
                if (s.parent_email && s.parent_email.trim() !== '') {
                    const emailKey = s.parent_email.trim().toLowerCase();
                    if (!parentEmailMap.has(emailKey)) {
                        parentEmailMap.set(emailKey, {
                            childName: `${s.first_name} ${s.last_name}`.trim(),
                            teamId: existingTeamMap.get(s.team?.trim()?.toLowerCase() || '') || null,
                            // Sin cuota en el CSV la invitación va sin cuota (null), no
                            // con los $150.000 inventados que el acudiente veía como suyos.
                            fee: s.monthly_fee ?? null,
                            parentName: s.parent_name || emailKey.split('@')[0]
                        });
                    }
                }
            }

            if (parentEmailMap.size > 0) {
                // Verificar cuáles invitaciones ya existen para esta escuela y rol
                const emailList = Array.from(parentEmailMap.keys());
                const { data: existingInvites } = await supabase
                    .from('invitations')
                    .select('email, status')
                    .eq('school_id', schoolId)
                    .eq('role_to_assign', 'parent')
                    .in('email', emailList);

                const existingInviteSet = new Set((existingInvites || []).filter(i => i.status === 'pending' || i.status === 'accepted').map(i => i.email));

                const newInvites = [];
                const emailsToSend = [];

                // Obtener nombre de la escuela para el correo
                const { data: schoolData } = await supabase.from('schools').select('name').eq('id', schoolId).single();
                const schoolName = normalizeSchoolName(schoolData?.name || 'la Academia');
                const senderId = req.user?.id || null;

                for (const [email, info] of parentEmailMap.entries()) {
                    if (!existingInviteSet.has(email)) {
                        newInvites.push({
                            email,
                            school_id: schoolId,
                            role_to_assign: 'parent',
                            invited_by: senderId,
                            status: 'pending',
                            child_name: info.childName,
                            team_id: info.teamId,
                            monthly_fee: info.fee
                        });
                        emailsToSend.push({ ...info, email });
                    }
                }

                if (newInvites.length > 0) {
                    const { data: insertedInvites, error: inviteError } = await supabase
                        .from('invitations')
                        .insert(newInvites)
                        .select('id, email');

                    if (inviteError) {
                        req.log?.error({ err: inviteError }, 'Error insertando invitaciones masivas');
                    } else {
                        invitationsCreated = insertedInvites?.length || 0;

                        // Enviar correos branded en background. El template
                        // se resuelve por escuela (logo + colores) — el primer
                        // hit lee DB, los siguientes vienen del cache de 60s.
                        if (insertedInvites && insertedInvites.length > 0) {
                            const { emailClient } = await import('../utils/emailClient');
                            const { BrandedEmailTemplates } = await import('../utils/emailTemplates');

                            const origin = process.env.CORS_ORIGIN || 'https://app.sportmaps.com';

                            for (const inviteRow of insertedInvites) {
                                const info = parentEmailMap.get(inviteRow.email);
                                if (!info) continue;
                                const inviteLink = `${origin}/register?email=${encodeURIComponent(inviteRow.email)}&role=parent&invite=${inviteRow.id}`;

                                try {
                                    const tpl = await BrandedEmailTemplates.invitation({
                                        parentName: info.parentName,
                                        childName: info.childName,
                                        schoolId,
                                        inviteLink,
                                    });
                                    emailClient.send({
                                        to: inviteRow.email,
                                        subject: tpl.subject,
                                        html: tpl.html,
                                    }).catch((e: any) =>
                                        req.log?.error({ email: inviteRow.email, err: e }, 'Fallo al enviar correo masivo'),
                                    );
                                } catch (e: any) {
                                    req.log?.error({ email: inviteRow.email, err: e }, 'Fallo armando template branded');
                                }
                            }
                        }
                    }
                }
            }

            // 9. Respuesta con reporte detallado
            const totalFailed = skipped.length;
            const statusCode = totalFailed === 0 ? 200 : inserted + updated > 0 ? 207 : 422;

            return res.status(statusCode).json({
                success: totalFailed === 0,
                message: `${inserted + updated} procesados, ${totalFailed} omitidos. ${branchesCreated} sedes creadas, ${teamsCreated} equipos creados, ${enrollmentsCreated} insc., ${paymentsCreated} pagos, ${invitationsCreated} invitaciones.`,
                summary: {
                    total: students.length,
                    inserted,
                    updated,
                    skipped: totalFailed,
                    branches_created: branchesCreated,
                    teams_created: teamsCreated,
                    enrollments_created: enrollmentsCreated,
                    invitations_created: invitationsCreated,
                },
                skipped,  // detalle fila por fila de los omitidos
            });

        } catch (err: any) {
            req.log?.error?.({ err: err.message || err }, 'Error inesperado en bulk upload');
            return res.status(500).json({ error: 'Error interno del servidor al procesar el CSV.' });
        }
    }
);

// ── GET /api/v1/students ──────────────────────────────────────────────────────
router.get('/', requireAuth, requireRole('owner', 'admin', 'super_admin', 'school_admin', 'school', 'coach', 'staff'), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { data, error } = await supabase
            .from('students')
            .select('id, first_name, last_name, document_id, grade, status')
            .eq('school_id', req.schoolId)   // 🔒 siempre filtrado
            .order('last_name');

        if (error) return res.status(500).json({ error: 'Error al obtener deportistas.' });
        return res.json({ students: data });
    } catch (err: any) {
        req.log?.error({ err: err.message || err }, 'Error inesperado al obtener deportistas');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── PUT /api/v1/students/:id ──────────────────────────────────────────────────
// Actualiza perfil base + enrollment de un atleta.
// Usa service role → ownership check OBLIGATORIO antes de cualquier write.
// Este endpoint escribe la cuota de la inscripción (`monthly_fee`), el correo y
// el teléfono del acudiente, y la identidad del atleta (nombre, documento,
// fecha de nacimiento). Cambiar cuánto paga una familia o a dónde le llegan las
// notificaciones no es una atribución deportiva — por eso 'coach' quedó fuera
// de esta lista en su momento, incoherente con POST /students/bulk (que nunca
// lo aceptó). Vuelve a entrar SOLO si la escuela activó
// school_settings.coach_can_create_athletes (mig 20260828174117, Carmel Club);
// el guard real está más abajo, después de leer settings, no en esta lista.
router.put(
  '/:id',
  requireAuth,
  requireRole('owner', 'admin', 'school_admin', 'staff', 'coach'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // req.params.id llega tipado como string | string[] (Express 5): se
      // normaliza una vez para poder pasarlo a los helpers tipados.
      // El `as string` es necesario: req.params tiene index signature, así que TS no
      // estrecha el tipo con Array.isArray sobre ese acceso y el ternario sigue siendo
      // string | string[] aguas abajo.
      const id = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
      const { schoolId } = req;
      const { athlete_type } = req.body;
      let { profile, enrollment } = req.body;

      if (!id || !athlete_type || !schoolId) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
      }

      // Sin fila de settings se aplica el default de ambas columnas (false): un
      // coach solo pasa si la escuela activó explícitamente alguna de las dos.
      if (req.role === 'coach') {
        const { data: settings } = await supabase
          .from('school_settings')
          .select('coach_can_create_athletes, coach_can_edit_categories')
          .eq('school_id', schoolId)
          .maybeSingle();

        const canFullEdit = !!settings?.coach_can_create_athletes;
        const canEditCategoryOnly = !!settings?.coach_can_edit_categories;

        if (!canFullEdit && !canEditCategoryOnly) {
          return res.status(403).json({
            error: 'Esta escuela no permite que un entrenador edite atletas. Pídelo a la escuela.',
          });
        }

        // Permiso acotado (hoy: Besser). El coach solo puede reasignar la
        // categoría (equipo) del atleta — nunca su perfil ni ningún campo de
        // dinero. Se sanea ACÁ, antes de que el resto del handler procese
        // nada, para que profile/offering_plan_id/monthly_fee/fee_is_manual/
        // fee_reason no se cuelen por este camino aunque el request los mande.
        if (!canFullEdit && canEditCategoryOnly) {
          profile = undefined;
          enrollment = enrollment && enrollment.team_id !== undefined
            ? { team_id: enrollment.team_id, team_start_date: enrollment.team_start_date }
            : undefined;
        }
      }

      // ── PASO 1: Verificar ownership según tipo ────────────────────────────
      // Nunca confiar en el body — siempre cruzar contra req.schoolId (del JWT)
      //
      // El estado (activo/inactivo) se lee aquí pero NO decide el ownership: un
      // atleta inactivo sigue siendo de la escuela y sus datos se pueden
      // corregir. Antes el chequeo del adulto exigía status='active' y devolvía
      // un 403 "Acceso denegado" opaco al editar a un inactivo.
      let athleteIsActive = true;
      // Ficha sin cuenta: ¿el contacto del formulario es del ACUDIENTE? (ver PASO 2)
      let fichaGuardada: { date_of_birth?: string | null; guardian_email?: string | null; guardian_phone?: string | null; guardian_full_name?: string | null } | null = null;

      if (athlete_type === 'child') {
        const { data: owned } = await supabase
          .from('children')
          .select('id, is_active')
          .eq('id', id)
          .eq('school_id', schoolId)
          .maybeSingle();
        if (!owned) return res.status(403).json({ error: 'Acceso denegado.' });
        athleteIsActive = (owned as any).is_active !== false;

      } else if (athlete_type === 'adult') {
        const { data: membership } = await supabase
          .from('school_members')
          .select('id, status')
          .eq('profile_id', id)
          .eq('school_id', schoolId)
          .eq('role', 'athlete')
          .maybeSingle();
        if (!membership) return res.status(403).json({ error: 'Acceso denegado.' });
        athleteIsActive = (membership as any).status === 'active';

      } else if (athlete_type === 'unregistered') {
        const { data: owned } = await supabase
          .from('unregistered_athletes')
          .select('id, is_active, date_of_birth, guardian_email, guardian_phone, guardian_full_name')
          .eq('id', id)
          .eq('school_id', schoolId)
          .maybeSingle();
        if (!owned) return res.status(403).json({ error: 'Acceso denegado.' });
        athleteIsActive = (owned as any).is_active !== false;
        fichaGuardada = owned as any;

      } else {
        return res.status(400).json({ error: 'athlete_type inválido.' });
      }

      // ── PASO 1.a: ID del torniquete (solo escuelas con registration_zk_pin_enabled) ──
      // Poner o cambiar el ID del lector de este deportista. Es configuración de
      // control de acceso: solo administración (igual que POST /access/assign-user).
      // Se valida y se asocia ANTES de tocar el perfil; es idempotente. Para quitarlo
      // se usa Control de acceso (aquí un valor vacío significa «no tocar»).
      const rawZkPin = req.body.zk_pin;
      if (rawZkPin !== undefined && rawZkPin !== null && rawZkPin !== '') {
        if (!['owner', 'admin', 'school_admin'].includes(req.role as string)) {
          return res.status(403).json({
            error: 'El ID del torniquete lo asigna la administración de la escuela.',
            code: 'ZK_PIN_FORBIDDEN',
          });
        }
        const zkSubject: ZkSubject = athlete_type === 'child' ? { child_id: id }
          : athlete_type === 'adult' ? { user_id: id }
          : { unregistered_athlete_id: id };
        const zkPin = await prepareZkPinForSignup(schoolId, rawZkPin, zkSubject);
        if (zkPin !== null) await assignZkPin(schoolId, zkPin, zkSubject);
      }

      // ── PASO 1.b: Atleta inactivo → no se le asigna equipo ni plan ────────
      // El plan es lo que genera los cobros: asignárselo a un inactivo lo mete
      // de vuelta a la facturación (open_month solo mira enrollments.status).
      // Se rechaza ANTES de cualquier escritura para no dejar el perfil
      // guardado a medias. Quitarlos (null) sí se permite.
      if (enrollment && !athleteIsActive && (enrollment.team_id || enrollment.offering_plan_id)) {
        return res.status(409).json({ error: INACTIVE_ATHLETE_ERROR });
      }

      // Becado / cuota negociada: solo se toca si el caller lo manda explícito
      // (fee_is_manual !== undefined). Así un PUT que no sabe de este campo
      // (otro caller futuro) no le resetea la marca a un atleta ya becado.
      // discount_type (mig. 20260916101241) solo tiene sentido junto a
      // fee_is_manual=true — es el tag de primos/referido para reportar y para
      // que la UI bloquee marcar un segundo tipo. Se limpia solo si el caller
      // desmarca fee_is_manual, igual que fee_reason.
      const feeManualPatch: Record<string, any> =
        enrollment && enrollment.fee_is_manual !== undefined
          ? {
              fee_is_manual: !!enrollment.fee_is_manual,
              fee_reason: enrollment.fee_reason || null,
              discount_type: enrollment.fee_is_manual ? (enrollment.discount_type || null) : null,
              fee_set_by: req.user?.id ?? null,
              fee_set_at: new Date().toISOString(),
            }
          : {};

      // ── PASO 2.0: documento de identidad del menor (RC/TI/CC/CE/PP) ───────
      // Lo corrige la administración (antes solo se podía fijar al crear la ficha).
      // Un adulto con cuenta NO pasa por aquí: su documento es de su perfil global.
      const docUpdate: { doc_type?: string; doc_number?: string; guardian_doc_type?: string; guardian_doc_number?: string } = {};
      if (profile && athlete_type !== 'adult') {
        const rawType = typeof profile.doc_type === 'string' ? profile.doc_type.trim().toUpperCase() : '';
        const rawNumber = typeof profile.doc_number === 'string' ? profile.doc_number.trim() : '';
        if (rawType && !['RC', 'TI', 'CC', 'CE', 'PP'].includes(rawType)) {
          return res.status(400).json({ error: 'Tipo de documento inválido (RC, TI, CC, CE o PP).' });
        }
        if (rawType) docUpdate.doc_type = rawType;
        // El frontend los manda dentro de `profile`; se acepta también en la raíz del body.
        const gSrcType = profile.guardian_doc_type !== undefined ? profile.guardian_doc_type : req.body.guardian_doc_type;
        const gSrcNumber = profile.guardian_doc_number !== undefined ? profile.guardian_doc_number : req.body.guardian_doc_number;
        const rawGType = typeof gSrcType === 'string' ? gSrcType.trim().toUpperCase() : '';
        const rawGNumber = typeof gSrcNumber === 'string' ? gSrcNumber.trim() : '';
        // null explícito = la escuela borró el documento del acudiente.
        const clearGuardianDoc = gSrcNumber === null;
        if (rawGType && !['CC', 'CE', 'PP', 'NIT'].includes(rawGType)) {
          return res.status(400).json({ error: 'Tipo de documento del acudiente inválido (CC, CE, PP o NIT).' });
        }
        if (rawGNumber && !/^[A-Za-z0-9-]{4,20}$/.test(rawGNumber)) {
          return res.status(400).json({ error: 'El número de documento del acudiente debe tener entre 4 y 20 letras o dígitos.' });
        }
        if (rawGType) docUpdate.guardian_doc_type = rawGType;
        if (rawGNumber) docUpdate.guardian_doc_number = rawGNumber;
        if (clearGuardianDoc) {
          (docUpdate as Record<string, unknown>).guardian_doc_type = null;
          (docUpdate as Record<string, unknown>).guardian_doc_number = null;
        }
        if (rawNumber) {
          if (!/^[A-Za-z0-9-]{4,20}$/.test(rawNumber)) {
            return res.status(400).json({ error: 'El número de documento debe tener entre 4 y 20 letras o dígitos.' });
          }
          docUpdate.doc_number = rawNumber;
          // Mismo documento en OTRO deportista de la escuela = casi seguro un duplicado.
          if (!req.body.allow_duplicate) {
            const [kids, unreg] = await Promise.all([
              supabase.from('children').select('id, full_name').eq('school_id', schoolId).eq('doc_number', rawNumber).neq('id', id).limit(1),
              supabase.from('unregistered_athletes').select('id, full_name').eq('school_id', schoolId).eq('doc_number', rawNumber).neq('id', id).limit(1),
            ]);
            const dup = (kids.data?.[0] ?? unreg.data?.[0]) as { id: string; full_name: string } | undefined;
            if (dup) {
              return res.status(409).json({
                error: `Ya existe otro deportista con el documento ${rawNumber} en esta escuela: "${dup.full_name}". Si es un error de digitación corrígelo; si son personas distintas confirma para guardar igual.`,
                code: 'DOC_DUPLICADO',
                duplicate: dup,
              });
            }
          }
        }
      }

      // ── PASO 2: Actualizar tabla base ─────────────────────────────────────
      if (profile && Object.keys(profile).length > 0) {
        const profileUpdate = {
          full_name:     profile.full_name     ?? undefined,
          date_of_birth: profile.date_of_birth ?? undefined,
          medical_info:  profile.medical_info  ?? undefined,
          updated_at:    new Date().toISOString(),
        };

        if (athlete_type === 'child') {
          const childUpdate: any = {
            ...profileUpdate,
            tshirt_size:       profile.tshirt_size       ?? undefined,
            blood_type:        profile.blood_type         ?? undefined,
            eps_name:          profile.eps_name           ?? undefined,
            dorsal:            profile.dorsal             ?? undefined,
            parent_email_temp: profile.parent_email       ?? undefined,
            parent_phone_temp: profile.parent_phone       ?? undefined,
            ...docUpdate,
          };
          // Limpiar keys undefined para no sobreescribir con null
          Object.keys(childUpdate).forEach(k => childUpdate[k] === undefined && delete childUpdate[k]);

          const { error } = await supabase
            .from('children')
            .update(childUpdate)
            .eq('id', id)
            .eq('school_id', schoolId); // doble candado
          if (error) throw new Error(`Error actualizando child: ${error.message}`);

        } else if (athlete_type === 'adult') {
          // profiles no tiene school_id → el ownership ya fue verificado en paso 1
          const adultUpdate: any = {
            ...profileUpdate,
            phone: profile.parent_phone ?? undefined,
          };
          Object.keys(adultUpdate).forEach(k => adultUpdate[k] === undefined && delete adultUpdate[k]);

          const { error } = await supabase
            .from('profiles')
            .update(adultUpdate)
            .eq('id', id);
          if (error) throw new Error(`Error actualizando profile: ${error.message}`);

          // dorsal es por membresía a la escuela (school_members), no del profile global.
          if (profile.dorsal !== undefined) {
            const { error: dorsalErr } = await supabase
              .from('school_members')
              .update({ dorsal: profile.dorsal ?? null })
              .eq('profile_id', id)
              .eq('school_id', schoolId)
              .eq('role', 'athlete');
            if (dorsalErr) throw new Error(`Error actualizando dorsal: ${dorsalErr.message}`);
          }

        } else if (athlete_type === 'unregistered') {
          // FIX 2026-10-05 (H-06): en el editor, "correo/teléfono del acudiente"
          // de una ficha MENOR es el del acudiente (guardian_*). Antes se escribía
          // en email/phone —el contacto DEL NIÑO—, así que cada edición pisaba el
          // correo del atleta con el del acudiente (o al revés) y los avisos de
          // cobro terminaban en el teléfono del menor. Adulto: su propio contacto.
          const esMenor = esMenorDeEdad(profile.date_of_birth ?? fichaGuardada?.date_of_birth ?? null)
            ?? !!(fichaGuardada?.guardian_email || fichaGuardada?.guardian_phone || fichaGuardada?.guardian_full_name);
          const unregUpdate: any = {
            ...profileUpdate,
            dorsal: profile.dorsal ?? undefined,
            ...docUpdate,
            ...(esMenor
              ? { guardian_email: profile.parent_email ?? undefined, guardian_phone: profile.parent_phone ?? undefined }
              : { email: profile.parent_email ?? undefined, phone: profile.parent_phone ?? undefined }),
          };
          Object.keys(unregUpdate).forEach(k => unregUpdate[k] === undefined && delete unregUpdate[k]);

          const { error } = await supabase
            .from('unregistered_athletes')
            .update(unregUpdate)
            .eq('id', id)
            .eq('school_id', schoolId); // doble candado
          if (error) throw new Error(`Error actualizando unregistered_athlete: ${error.message}`);
        }
      }

      // ── PASO 3: Actualizar enrollments + propagar a payments ──────────────────────
      const warnings: string[] = [];

      if (enrollment) {
        // Helper: columna del atleta según tipo
        const athleteCol = athlete_type === 'child' ? 'child_id'
          : athlete_type === 'adult' ? 'user_id'
          : 'unregistered_athlete_id';

        const applyAthleteFilter = (q: any) => q.eq(athleteCol, id);

        // Vencimiento y alta de cobro salen del servicio compartido
        // (enrollmentBilling): mismo criterio aquí y en POST /enrollments.
        const createPendingPayment = (
          teamId: string | null,
          planId: string | null,
          amount: number,
          concept: string,
          startDate: string
        ) => createPendingPaymentShared({
          schoolId, athleteCol, athleteId: id, teamId, planId, amount, concept, startDate,
        });

        /**
         * Fecha que define el PERIODO del cobro de reemplazo cuando el plan (o el
         * equipo) CAMBIAN. No es la misma que la de un alta.
         *
         * `billingDue` estampa el periodo = mes del startDate, que es lo correcto
         * para un alta. Pero en un cambio, el editor manda la fecha de inscripción
         * ORIGINAL (viene prellenada desde la vista), así que el cobro nuevo salía
         * con el periodo de un mes ya cerrado: nacía vencido y, como el del mes en
         * curso se acaba de cancelar, el mes corriente quedaba sin facturar.
         * Medido el 2026-08-11: 12 atletas de Dynasty y $1.710.000 de agosto
         * cancelados y reemplazados por cobros de julio, 7 de ellos en mora.
         *
         * Cambiar de plan cobra el plan nuevo en el mes en que se cambia. Si la
         * escuela quiere además cobrar clases viejas impagas, eso lo decide ella
         * y lo carga a mano; no lo inventa este endpoint.
         *
         * Una fecha del mes en curso o futura se respeta tal cual (deja programar
         * el cambio para el mes siguiente).
         */
        const billingStartForChange = (startDate: string): string => {
          const today = todayInZone();
          return startDate.slice(0, 7) < today.slice(0, 7) ? today : startDate;
        };

        /**
         * Cancela las inscripciones activas duplicadas. Va SIEMPRE antes de
         * actualizar la que sobrevive: los índices únicos son parciales
         * (WHERE status='active'), así que mover el plan a la fila que queda con
         * la duplicada todavía activa revienta con 23505.
         *
         * Declarado ACÁ ARRIBA a propósito: `consolidateEnrollments` lo usa y se
         * invoca antes de los dos bloques, así que con el `const` más abajo la
         * variable seguía en la zona muerta y cambiar de plan a un atleta con dos
         * inscripciones activas moría con "Cannot access 'cancelExtraEnrollments'
         * before initialization".
         */
        const cancelExtraEnrollments = async (extras: any[]) => {
          if (!extras.length) return;
          const today = todayInZone();
          await supabase.from('enrollments')
            .update({ status: 'cancelled', end_date: today, updated_at: new Date().toISOString() })
            .in('id', extras.map(r => r.id))
            .eq('school_id', schoolId);
        };

        /**
         * Lee las inscripciones activas de un tipo (equipo o plan) y devuelve la
         * más antigua + las sobrantes.
         *
         * Antes esto era un `.maybeSingle()` cuyo `error` se descartaba: con DOS
         * filas activas PostgREST responde 406, `data` llega null y el código
         * concluía "no tiene inscripción" → INSERT → 23505 contra
         * idx_enrollments_user_offering_plan_active. El editor de ese atleta
         * quedaba muerto: hasta cambiarle el nombre fallaba.
         */
        const readActiveEnrollments = async (kind: 'team' | 'plan') => {
          const col = kind === 'team' ? 'team_id' : 'offering_plan_id';
          // 'pending' también cuenta como abierta (misma lección que en POST
          // /enrollments): es la fila que deja el QR cuando exige primer pago.
          // Con `status='active'` a secas el editor no la veía, insertaba una
          // segunda fila activa y el atleta quedaba con dos inscripciones. La
          // activa va primero en el orden para que, si hay una, sea la que
          // sobrevive; consolidateEnrollments ya cerró las pending sobrantes.
          const { data, error } = await applyAthleteFilter(
            supabase.from('enrollments')
              .select('id, team_id, offering_plan_id, monthly_fee, status, start_date')
              .eq('school_id', schoolId).in('status', ['active', 'pending'])
              .order('status', { ascending: true })
              .order('created_at', { ascending: true })
          );
          if (error) throw new Error(`Error leyendo inscripciones: ${error.message}`);
          const rows = (data as any[]) ?? [];
          const withCol = rows.filter(r => r[col]);

          // El `.not(col, 'is', null)` estaba en la QUERY, así que los dos bloques de
          // abajo miraban conjuntos DISJUNTOS: el de equipo veía solo filas con
          // team_id y el de plan solo filas con offering_plan_id. Con una inscripción
          // de roster existente, asignar un plan hacía que el bloque de equipo la
          // actualizara y el de plan —al no ver ninguna con plan— INSERTARA una
          // segunda. Y con la fila vacía que dejaba el QR, ninguno de los dos la veía
          // y los dos insertaban: tres filas para un atleta.
          //
          // Ahora el filtro se aplica en memoria y, si no hay fila con esa columna, se
          // reusa cualquier inscripción activa. `extras` sigue siendo solo las
          // duplicadas del MISMO tipo: cancelar la complementaria acá le borraría al
          // atleta el equipo o el plan que la escuela ya le había puesto.
          const survivor = withCol[0] ?? rows[0] ?? null;

          // `extras` era `withCol.slice(1)`: TODA otra fila con esa columna se
          // cancelaba. Pero un atleta en dos disciplinas tiene dos filas con
          // team_id (Boxeo y Fútbol, Porrismo y Natación, INTERMEDIO y NUEVA ERA)
          // y ninguna es duplicada: guardar el editor le borraba una disciplina
          // y sus cobros. Ahora solo se cancela el duplicado EXACTO —misma
          // columna, mismo valor—, que es el caso que revienta el índice único
          // parcial (23505) y el que cobra dos veces lo mismo.
          const extras = survivor?.[col]
            ? withCol.filter(r => r.id !== survivor.id && r[col] === survivor[col])
            : [];
          return { survivor, extras };
        };

        /**
         * Deja UNA sola inscripción activa antes de que los bloques de equipo y plan
         * escriban nada, heredando en la que sobrevive los datos de las que se van.
         *
         * Sin esto, un atleta que ya venía con el par partido (una fila de roster y
         * otra de plan, 80 casos en producción al 2026-08-03) se quedaba partido para
         * siempre: cada bloque encontraba "su" fila y ninguno las unía. El generador
         * del mes recorre inscripciones, así que cada fila era un cobro.
         */
        const consolidateEnrollments = async () => {
          const { data, error } = await applyAthleteFilter(
            supabase.from('enrollments')
              .select('id, team_id, offering_plan_id, monthly_fee, status')
              .eq('school_id', schoolId).in('status', ['active', 'pending'])
              .order('status', { ascending: true })
              .order('created_at', { ascending: true })
          );
          if (error) throw new Error(`Error leyendo inscripciones: ${error.message}`);
          const allOpen = (data as any[]) ?? [];

          // 'pending' es el placeholder del QR ("espera el primer pago"). Si el
          // atleta YA tiene una inscripción activa, esa fila no es una segunda
          // disciplina: es el rastro de un alta por QR que la escuela resolvió
          // creando otra inscripción, y se cierra. Medido el 2026-09-25: 12
          // atletas en 3 escuelas con el par pending + active, 6 de ellos en
          // Besser en una sola semana. Sin ninguna activa, la pending es la que
          // sobrevive y los bloques de abajo la activan al ponerle equipo o plan.
          const activeRows = allOpen.filter(r => r.status === 'active');
          const stalePending = activeRows.length ? allOpen.filter(r => r.status === 'pending') : [];
          if (stalePending.length) {
            await cancelExtraEnrollments(stalePending);
            req.log?.warn?.(
              { athleteId: id, schoolId, cancelled: stalePending.map(r => r.id) },
              'Inscripción pending del QR cerrada: el atleta ya tiene una activa',
            );
          }
          const rows = activeRows.length ? activeRows : allOpen;
          if (rows.length <= 1) return;

          // Fusionar solo cuando las filas NO compiten por la misma columna.
          //
          // La fusión hereda UN equipo y UN plan, así que con dos filas que
          // apuntan a equipos distintos (o a planes distintos) hay que descartar
          // uno: eso no es reparar una inscripción partida, es borrarle al atleta
          // una disciplina que la escuela le puso a propósito. En la base al
          // 2026-08-10 son 15 de 17 casos (Fútbol+Tenis, Boxeo+Fútbol,
          // Porrismo+Natación, INTERMEDIO+NUEVA ERA…), todos legítimos.
          //
          // Cuando no compiten —fila fantasma del QR sin equipo ni plan, o el par
          // partido (una fila con equipo, otra con plan)— la fusión no pierde
          // nada: el equipo y el plan sobreviven juntos en la fila que queda.
          // El duplicado EXACTO (mismo equipo o mismo plan repetido) también
          // entra acá, y es el que hay que fusionar.
          const distinctValues = (col: string) =>
            new Set(rows.map(r => r[col]).filter(Boolean)).size;
          if (distinctValues('team_id') > 1 || distinctValues('offering_plan_id') > 1) {
            req.log?.warn?.(
              { athleteId: id, schoolId, enrollments: rows.map(r => r.id) },
              'Atleta con inscripciones en varias disciplinas: no se fusionan',
            );
            return;
          }

          const [keep, ...rest] = rows;
          const inheritedTeam = keep.team_id ?? rest.find(r => r.team_id)?.team_id ?? null;

          // La cuota sigue al PLAN. Con `keep.monthly_fee ?? …` la fila de roster
          // ganaba con su 0 —el `??` solo atrapa null— y la fusionada quedaba con plan
          // y cuota cero, o sea un atleta activo al que no se le cobra nada.
          const planRow = keep.offering_plan_id ? keep : (rest.find(r => r.offering_plan_id) ?? null);
          const inheritedPlan = planRow?.offering_plan_id ?? null;
          const inheritedFee = planRow
            ? (planRow.monthly_fee ?? null)
            : (keep.monthly_fee ?? rest.find(r => r.monthly_fee != null)?.monthly_fee ?? null);

          // Cancelar ANTES de mover los datos a `keep`: los índices únicos son
          // parciales (WHERE status='active'), así que escribir el plan en la fila que
          // queda con la duplicada todavía activa revienta con 23505.
          await cancelExtraEnrollments(rest);

          await supabase.from('enrollments')
            .update({
              team_id: inheritedTeam,
              offering_plan_id: inheritedPlan,
              monthly_fee: inheritedFee,
              updated_at: new Date().toISOString(),
            })
            .eq('id', keep.id).eq('school_id', schoolId);

          // Los planes que se van y NO quedaron en la fusionada dejan de cobrar; si
          // no, el atleta arrastra una mensualidad viva de un plan que ya no tiene.
          await cancelPendingPlanPayments({
            schoolId, athleteCol, athleteId: id,
            planIds: rest
              .map(r => r.offering_plan_id)
              .filter((pid: string | null): pid is string => !!pid && pid !== inheritedPlan),
          });

          req.log?.warn?.(
            { athleteId: id, schoolId, kept: keep.id, cancelled: rest.map(r => r.id) },
            'Inscripciones duplicadas fusionadas en una sola',
          );
        };

        // Va antes de los dos bloques: después de esto hay como máximo una activa, así
        // que ambos escriben sobre la misma fila en vez de crear una cada uno.
        await consolidateEnrollments();

        // Si la fila que sobrevive es la 'pending' del QR, ponerle equipo o plan
        // desde el editor es la escuela dándola de alta: se activa la MISMA fila.
        // El cobro que emitió el QR no se toca acá; se avisa para que lo revisen.
        const PENDING_ACTIVATED_MSG =
          'La inscripción venía pendiente del primer pago (alta por QR) y quedó activa al asignarle equipo o plan. Revisa su cobro pendiente.';
        const notePendingActivated = () => {
          if (!warnings.includes(PENDING_ACTIVATED_MSG)) warnings.push(PENDING_ACTIVATED_MSG);
        };

        // ── Enrollment de EQUIPO ────────────────────────────────────────────────
        if (enrollment.team_id !== undefined) {
          const teamStartDate: string = enrollment.team_start_date || todayInZone();
          // Plan manda: si hay plan seleccionado, el equipo es SOLO roster y no
          // genera cobro propio (evita el doble cobro equipo+plan).
          const hasPlan = !!enrollment.offering_plan_id;
          // Con plan, la cuota del equipo se guarda en 0: el cobro lo define el
          // plan y una cuota fantasma en el equipo reaparecía en la vista
          // (school_athletes) y en el editor. Sin plan, un 0 explícito es
          // "equipo sin cobro" y se respeta tal cual.
          const teamFee: number | null = hasPlan ? 0 : (enrollment.team_monthly_fee ?? null);

          const { survivor: existingTeam, extras: extraTeams } = await readActiveEnrollments('team');
          await cancelExtraEnrollments(extraTeams);

          const oldTeamId: string | null = existingTeam?.team_id || null;

          if (existingTeam) {
            const activatePending = existingTeam.status === 'pending' && !!enrollment.team_id;
            await supabase.from('enrollments')
              .update({ team_id: enrollment.team_id || null, start_date: teamStartDate, monthly_fee: teamFee, updated_at: new Date().toISOString(), ...feeManualPatch, ...(activatePending ? { status: 'active' } : {}) })
              .eq('id', existingTeam.id).eq('school_id', schoolId);
            if (activatePending) notePendingActivated();

            if (hasPlan) {
              // Con plan, el equipo NO cobra: cancelar cualquier cobro pendiente
              // de equipo (sin plan) de este atleta.
              await applyAthleteFilter(
                supabase.from('payments').update({ status: 'cancelled', updated_at: new Date().toISOString() })
                  .eq('school_id', schoolId).not('team_id', 'is', null).is('offering_plan_id', null).eq('status', 'pending')
              );
            } else if (oldTeamId && oldTeamId !== enrollment.team_id) {
              // Equipo cambió: cancelar pagos pending del equipo anterior
              await applyAthleteFilter(
                supabase.from('payments').update({ status: 'cancelled', updated_at: new Date().toISOString() })
                  .eq('school_id', schoolId).eq('team_id', oldTeamId).eq('status', 'pending')
              );
              // Crear pago nuevo para el equipo nuevo (solo si tiene cuota > 0).
              // Igual que en el cambio de plan: el cobro va al mes en que se
              // cambia, no al de la fecha de inscripción vieja.
              if (enrollment.team_id) {
                const { data: teamData } = await supabase.from('teams').select('name, price_monthly').eq('id', enrollment.team_id).maybeSingle();
                const amount = teamFee ?? Number(teamData?.price_monthly ?? 0);
                if (amount > 0) await createPendingPayment(
                  enrollment.team_id, null, amount,
                  `Mensualidad ${teamData?.name || 'Equipo'}`,
                  billingStartForChange(teamStartDate),
                );
              }
            } else if (teamFee !== null && teamFee <= 0) {
              // Cuota de equipo en 0 = sin cobro por equipo: se cancelan los
              // pendientes (payments_amount_positive prohíbe amount = 0).
              await applyAthleteFilter(
                supabase.from('payments').update({ status: 'cancelled', updated_at: new Date().toISOString() })
                  .eq('school_id', schoolId).eq('team_id', oldTeamId || enrollment.team_id).eq('status', 'pending')
              );
            } else {
              // Mismo equipo: actualizar SOLO el monto de los cobros pendientes.
              //
              // Ya NO se reescribe due_date. Antes se ponía teamStartDate + 1 mes,
              // así que cada guardado del atleta le corría el vencimiento (editar
              // hoy 30/07 lo mandaba al 30/08) y rompía la fecha única del mes.
              // Cuándo vence el cobro lo define el generador del mes (open_month
              // con payment_cutoff_day); cambiar una cuota no es motivo para
              // mover la fecha de pago de una familia.
              if (teamFee !== null) {
                await repricePendingCharges(
                  applyAthleteFilter(
                    supabase.from('payments').select('id, discount_pct, sibling_discount_applied, amount')
                      .eq('school_id', schoolId).eq('team_id', oldTeamId || enrollment.team_id).eq('status', 'pending')
                  ),
                  teamFee,
                );
              }
            }
          } else if (enrollment.team_id) {
            const row: any = { school_id: schoolId, status: 'active', team_id: enrollment.team_id, start_date: teamStartDate, monthly_fee: teamFee, ...feeManualPatch };
            row[athleteCol] = id;
            const { error } = await supabase.from('enrollments').insert(row);
            if (error) throw new Error(`Error creando enrollment equipo: ${error.message}`);
            // Cobro del equipo solo si NO hay plan y hay cuota > 0.
            if (!hasPlan) {
              const { data: teamData } = await supabase.from('teams').select('name, price_monthly').eq('id', enrollment.team_id).maybeSingle();
              const amount = teamFee ?? Number(teamData?.price_monthly ?? 0);
              if (amount > 0) await createPendingPayment(enrollment.team_id, null, amount, `Mensualidad ${teamData?.name || 'Equipo'}`, teamStartDate);
            }
          }
        }

        // ── Enrollment de PLAN ──────────────────────────────────────────────────
        if (enrollment.offering_plan_id !== undefined) {
          const planStartDate: string = enrollment.plan_start_date || todayInZone();
          const planFee: number | null = enrollment.plan_monthly_fee ?? null;
          // FIX 2026-10-05 (H-08, informe Monster): asignar un plan ya NO escribe
          // `expires_at = inicio + 30`. Ese vencimiento regalado, sin que nadie
          // hubiera pagado, ponía a correr fn_expire_overdue_enrollments, que
          // CANCELA la inscripción a los 30 + gracia + 7 días aunque la escuela
          // siga cobrando el mes con open_month. La vigencia la otorga el PAGO
          // (fn_extend_enrollment_on_payment_paid: GREATEST(expires_at, hoy) +
          // duration_days), que es la decisión de producto "un pago = un periodo"
          // (docs/plan-vigencia-por-periodo-pagado.md). Sin pago, NULL = no vence.

          const { survivor: existingPlan, extras: extraPlans } = await readActiveEnrollments('plan');
          await cancelExtraEnrollments(extraPlans);

          // Los planes de las filas descartadas que NO son el plan final dejan
          // de cobrar: sus cobros pendientes se anulan (si no, el atleta queda
          // con dos mensualidades vivas de planes distintos).
          await cancelPendingPlanPayments({
            schoolId, athleteCol, athleteId: id,
            planIds: extraPlans
              .map(r => r.offering_plan_id)
              .filter((pid: string | null): pid is string => !!pid && pid !== enrollment.offering_plan_id),
          });

          const oldPlanId: string | null = existingPlan?.offering_plan_id || null;

          if (existingPlan) {
            const activatePending = existingPlan.status === 'pending' && !!enrollment.offering_plan_id;

            // Cambio de plan sobre una inscripción activa con plan: en escuelas con
            // banco de horas se calcula la vista previa ANTES de mover el plan (lee el
            // plan viejo y lo pagado del período) y NO se reescribe start_date si el
            // formulario no mandó fecha — en ciclo rolling_30 el período del banco
            // cuelga de start_date y reescribirla abriría un período nuevo en 0,
            // perdiendo las horas ya usadas.
            const isPlanSwap = existingPlan.status === 'active' && !!oldPlanId
              && !!enrollment.offering_plan_id && oldPlanId !== enrollment.offering_plan_id;
            const planChangePreview = isPlanSwap
              ? await previewPlanChange({
                  schoolId, athleteCol, athleteId: id, newPlanId: enrollment.offering_plan_id,
                })
              : null;
            const planStartForUpdate: string =
              isPlanSwap && planChangePreview?.applies && !enrollment.plan_start_date && existingPlan.start_date
                ? existingPlan.start_date
                : planStartDate;

            await supabase.from('enrollments')
              .update({ offering_plan_id: enrollment.offering_plan_id || null, start_date: planStartForUpdate, monthly_fee: planFee, updated_at: new Date().toISOString(), ...feeManualPatch, ...(activatePending ? { status: 'active' } : {}) })
              .eq('id', existingPlan.id).eq('school_id', schoolId);
            if (activatePending) notePendingActivated();

            const accionPlan = accionCobroDePlan(oldPlanId, enrollment.offering_plan_id || null, planFee);
            if (accionPlan === 'cambio') {
              // Plan cambió —o se ASIGNA por primera vez a una inscripción que
              // solo tenía equipo (FIX 2026-10-05, H-08): antes ese caso caía en
              // "mismo plan", solo actualizaba montos de cobros que no existían y
              // el atleta quedaba con plan y sin mensualidad (la de equipo ya la
              // había anulado el bloque de arriba).
              if (oldPlanId) {
                // Cancelar pagos pending del plan anterior
                await applyAthleteFilter(
                  supabase.from('payments').update({ status: 'cancelled', updated_at: new Date().toISOString() })
                    .eq('school_id', schoolId).eq('offering_plan_id', oldPlanId).eq('status', 'pending')
                    .or(PLAN_PERIOD_CHARGE_FILTER) // B4: no tocar inscripción/seguro/excedente
                );
              }
              // El cobro del período sin plata que no era `pending` del plan viejo
              // (vencido, o del cierre de mes sin plan ligado) también se anula: si
              // sobrevive, el cobro del plan nuevo choca con el índice único y no nace.
              const periodCleanup = enrollment.offering_plan_id
                ? await cancelUnpaidPeriodCharges({
                    schoolId, athleteCol, athleteId: id,
                    startDate: billingStartForChange(planStartDate),
                  })
                : { cancelled: 0, withPayments: 0 };
              if (periodCleanup.withPayments > 0) {
                warnings.push('El cobro de este mes ya tiene pagos o abonos y NO se anuló: revisa su saldo antes de cobrar el plan nuevo.');
              }
              if (enrollment.offering_plan_id) {
                // Banco de horas: las horas usadas pasan al plan nuevo y, si el atleta
                // ya pagó el período, se emite el cobro que eligió el admin (parcial o
                // completo). Sin banco de horas o sin pago previo, cobro habitual.
                const planChange = planChangePreview
                  ? await applyPlanChangeEffects({
                      schoolId, athleteCol, athleteId: id,
                      enrollmentId: existingPlan.id,
                      newPlanId: enrollment.offering_plan_id,
                      chargeMode: enrollment.plan_change_charge === 'partial' ? 'partial'
                        : enrollment.plan_change_charge === 'full' ? 'full' : undefined,
                      preview: planChangePreview,
                    })
                  : null;

                if (!planChange?.handledCharge) {
                  const { data: planData } = await supabase.from('offering_plans').select('name, price').eq('id', enrollment.offering_plan_id).maybeSingle();
                  const amount = planFee ?? planData?.price ?? 0;
                  const created = await createPendingPayment(
                    null, enrollment.offering_plan_id, amount,
                    `Plan ${planData?.name || 'Plan'}`,
                    billingStartForChange(planStartDate),
                  );
                  if (!created && amount > 0) {
                    warnings.push('No se emitió el cobro del plan nuevo porque el atleta ya tiene un cobro activo en este período. Revísalo en Pagos.');
                  }
                }
              }
            } else if (accionPlan === 'sin_cobro') {
              // Plan sin cobro: cancelar pendientes (amount = 0 rompe el
              // constraint payments_amount_positive).
              await applyAthleteFilter(
                supabase.from('payments').update({ status: 'cancelled', updated_at: new Date().toISOString() })
                  .eq('school_id', schoolId).eq('offering_plan_id', oldPlanId || enrollment.offering_plan_id).eq('status', 'pending')
                    .or(PLAN_PERIOD_CHARGE_FILTER) // B4: no tocar inscripción/seguro/excedente
              );
            } else {
              // Mismo plan: actualizar SOLO el monto de los cobros pendientes.
              //
              // Ya NO se reescribe due_date. Antes se le metía `expiresAtStr`,
              // que es plan_start_date + 30 días — o sea el vencimiento del PLAN
              // usado como fecha de pago del cobro. Son cosas distintas, y el
              // efecto era que cada edición movía el vencimiento del alumno
              // (por eso convivían cobros del mismo agosto venciendo 29 y 30).
              if (planFee !== null) {
                // El descuento de cada cobro viaja con él (payments.discount_pct): no
                // se pisa con la cuota completa del plan.
                await repricePendingCharges(
                  applyAthleteFilter(
                    supabase.from('payments').select('id, discount_pct, sibling_discount_applied, amount')
                      .eq('school_id', schoolId).eq('offering_plan_id', oldPlanId || enrollment.offering_plan_id).eq('status', 'pending')
                      .or(PLAN_PERIOD_CHARGE_FILTER) // B4: no tocar inscripción/seguro/excedente
                  ),
                  planFee,
                );
              }
            }
          } else if (enrollment.offering_plan_id) {
            const row: any = { school_id: schoolId, status: 'active', offering_plan_id: enrollment.offering_plan_id, start_date: planStartDate, monthly_fee: planFee, ...feeManualPatch };
            row[athleteCol] = id;
            const { error } = await supabase.from('enrollments').insert(row);
            if (error) throw new Error(`Error creando enrollment plan: ${error.message}`);
            const { data: planData } = await supabase.from('offering_plans').select('name, price').eq('id', enrollment.offering_plan_id).maybeSingle();
            const amount = planFee ?? planData?.price ?? 0;
            await createPendingPayment(null, enrollment.offering_plan_id, amount, `Plan ${planData?.name || 'Plan'}`, planStartDate);
          }
        }

        // ── Guard: ninguna inscripción activa puede quedar sin equipo NI plan ───
        //
        // Las dos ramas de arriba actualizan por separado y ambas escriben
        // `|| null` (equipo ~L829, plan ~L913). Guardar un atleta sin equipo
        // cuando su fila no tenía plan —o al revés— la dejaba HUÉRFANA: activa,
        // sin referenciar nada, y **conservando su monthly_fee** (la rama de
        // equipo escribe `monthly_fee: teamFee` en el mismo UPDATE).
        //
        // El daño era invisible por partida doble: `school_athletes` la ignora
        // (sus LATERAL exigen team_id o offering_plan_id, así que el listado se
        // ve impecable) mientras `open_month` **sí** la factura, porque su
        // cascada cae hasta children.monthly_fee cuando no hay plan ni equipo.
        // Resultado: cobros duplicados que nadie podía ver en pantalla.
        //
        // Auditoría 2026-07-31: 26 filas así en producción, hasta 3 por atleta.
        // Combinaciones válidas: equipo+plan, solo plan, solo equipo. La cuarta
        // no existe en el negocio → aquí se cierra, y la migración del CHECK
        // (D19) la vuelve imposible a nivel de tabla.
        // Ver docs/plan-f0-inscripciones-y-cobros-duplicados.md §1.A
        const { data: orphaned, error: orphanErr } = await applyAthleteFilter(
          supabase.from('enrollments')
            .select('id')
            .eq('school_id', schoolId)
            .eq('status', 'active')
            .is('team_id', null)
            .is('offering_plan_id', null)
        );
        if (orphanErr) throw new Error(`Error verificando inscripciones huérfanas: ${orphanErr.message}`);

        if (orphaned?.length) {
          const today = todayInZone();
          const { error: cancelErr } = await supabase.from('enrollments')
            .update({ status: 'cancelled', end_date: today, updated_at: new Date().toISOString() })
            .in('id', (orphaned as any[]).map(r => r.id))
            .eq('school_id', schoolId);
          if (cancelErr) throw new Error(`Error cancelando inscripción huérfana: ${cancelErr.message}`);

          // No se anulan cobros aquí: los pendientes de una huérfana no traen
          // team_id ni offering_plan_id, así que no hay forma de distinguirlos
          // de otros cobros del atleta sin arriesgar cancelar el equivocado.
          // Se avisa y la escuela decide.
          warnings.push(
            'El atleta quedó sin equipo y sin plan, así que su inscripción se cerró y dejará de generar cobros. ' +
            'Si sigue activo, asígnale un equipo o un plan. Revisa sus cobros pendientes.'
          );
          req.log?.warn?.(
            { athleteId: id, schoolId, cancelled: (orphaned as any[]).map(r => r.id) },
            'Inscripción huérfana cancelada por el guard del editor de atletas'
          );
        }
      }

      // Auditoría — misma razón que en students-create-one.route.ts: reabre un
      // permiso que el resto de las escuelas tiene cerrado, así que queda rastro.
      if (req.role === 'coach') {
        const { error: auditErr } = await supabase.from('audit_logs').insert({
          school_id:  schoolId,
          profile_id: req.user?.id || null,
          table_name: athlete_type === 'child' ? 'children' : athlete_type === 'adult' ? 'profiles' : 'unregistered_athletes',
          record_id:  id,
          action:     'COACH_EDIT_ATHLETE',
          new_data:   { profile, enrollment },
        });
        if (auditErr) req.log?.error({ err: auditErr }, 'Error registrando auditoría de edición por coach');
      }

      return res.json({ success: true, warnings });

    } catch (err: any) {
      if (err instanceof ZkPinError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      req.log?.error?.({ err: err.message }, 'Error en PUT /students/:id');
      return res.status(500).json({ error: err.message || 'Error interno.' });
    }
  }
);

export default router;

