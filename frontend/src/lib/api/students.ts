// Students API service — uses Supabase directly (table: children)
// Per NAMING_DICTIONARY.md: tabla=children, UI=deportistas
//
// MIGRACIÓN BFF (Feb 2026):
//   - Lecturas (GET):  siguen via Supabase SDK directo ← sin cambios
//   - bulkUpload:      migrado al BFF → POST /api/v1/students/bulk
//     Motivos: validación server-side, school_id forzado, reporte fila por fila
//
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from './bffClient';

const isValidUUID = (id: string | null | undefined): boolean => {
  if (!id) return false;
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return regex.test(id);
};

export interface Student {
  id: string;
  full_name: string;
  athlete_type?: 'child' | 'adult' | 'unregistered';
  email?: string;
  phone?: string;
  date_of_birth?: string;
  gender?: 'male' | 'female' | 'other';
  grade?: string;
  school_id: string;
  parent_id?: string | null;
  parent_name?: string;
  parent_email?: string;
  parent_phone?: string;
  emergency_contact?: string;
  medical_notes?: string;
  medical_info?: string;
  sport?: string;
  team_name?: string;
  avatar_url?: string;
  status: 'active' | 'inactive' | 'suspended';
  enrollment_date?: string;
  created_at: string;
  updated_at: string;
}

export interface StudentCreate {
  full_name: string;
  date_of_birth: string;
  school_id: string;
  grade?: string;
  emergency_contact?: string;
  parent_id?: string;
  medical_info?: string;
  sport?: string;
  team_name?: string;
  avatar_url?: string;
}

export interface StudentUpdate {
  full_name?: string;
  date_of_birth?: string;
  grade?: string;
  emergency_contact?: string;
  medical_info?: string;
  sport?: string;
  team_name?: string;
  avatar_url?: string;
  school_id?: string;
  status?: 'active' | 'inactive' | 'suspended';
  team_id?: string;
  branch_id?: string;
  monthly_fee?: number;
  doc_type?: string;
  doc_number?: string;
  tshirt_size?: string | null;
  blood_type?: string | null;
  eps_name?: string | null;
  dorsal?: string | null;
}

// ── Tipos de respuesta del BFF ────────────────────────────────────────────────
export interface BulkUploadResponse {
  success: boolean;
  message: string;
  summary: {
    total: number;
    inserted: number;
    updated: number;
    skipped: number;
  };
  // Detalle de filas que no se procesaron (duplicados sin upsert, etc.)
  skipped: Array<{ document_id: string; reason: string }>;
  // Compatibilidad con código existente que lea .success / .failed / .errors
  /** @deprecated usar summary.inserted */
  failed: number;
  /** @deprecated usar skipped */
  errors: Array<{ row: number; error: string }>;
  /** @deprecated usar summary */
  students: Student[];
}

export interface BulkUploadOptions {
  /** Si true, actualiza deportistas con document_id existente. Default: false */
  upsert?: boolean;
  /** Branch ID por defecto para deportistas sin columna 'sede' en el CSV */
  defaultBranchId?: string | null;
}

export interface StudentViewRow {
  id: string;
  full_name: string;
  date_of_birth: string;
  avatar_url?: string;
  sport?: string;
  parent_id?: string;
  school_id: string;
  created_at: string;
  emergency_contact?: string;
  parent_name?: string;
  parent_phone?: string;
  parent_email?: string;
  parent_avatar?: string;
  enrollment_id?: string;
  team_id?: string;
  branch_id?: string;
  enrollment_status?: string;
  team_name?: string;
  team_sport?: string;
  price_monthly?: number;
  monthly_fee?: number;
  enrollment_start_date?: string | null;
  plan_start_date?: string | null;
  team_monthly_fee?: number | null;
  plan_monthly_fee?: number | null;
  fee_is_manual?: boolean;
  fee_reason?: string | null;
  branch_name?: string;
  medical_info?: string | null;
  display_parent_name?: string;
  status?: 'active' | 'inactive' | 'suspended';
  is_active?: boolean;
  doc_type?: string | null;
  doc_number?: string | null;
  tshirt_size?: string | null;
  blood_type?: string | null;
  eps_name?: string | null;
  dorsal?: string | null;
}

export interface StudentStats {
  total: number;
  active: number;
  inactive: number;
  by_grade: Record<string, number>;
}

// ── Columnas que acepta el BFF (mapeadas desde headers del CSV) ───────────────
interface BFFStudentRow {
  first_name: string;
  last_name: string;
  document_id: string;
  grade?: string;
  medical_info?: string;
  branch?: string;
  team: string;
  sport: string;
  date_of_birth?: string;
  gender?: string;
  parent_name: string;
  parent_email: string;
  parent_phone: string;
  monthly_fee?: number;
}

class StudentsAPI {
  /**
   * Create a new student (child) in Supabase
   */
  async createStudent(student: StudentCreate): Promise<Student> {
    const { data, error } = await supabase
      .from('children')
      .insert({
        full_name: student.full_name,
        date_of_birth: student.date_of_birth,
        school_id: student.school_id,
        grade: student.grade,
        emergency_contact: student.emergency_contact,
        parent_id: student.parent_id || null,
        medical_info: student.medical_info,
        // children no tiene sport ni team_name (el equipo va por team_id /
        // inscripción): mandarlos hacía fallar el insert con «column not found».
        avatar_url: student.avatar_url,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating student:', error);
      throw new Error(error.message || 'Failed to create student');
    }

    return this.mapChildToStudent(data);
  }

  /**
   * Get enriched students data for School Management UI (uses 'school_athletes' view).
   * Acepta filtros opcionales por team o branch. Pasar un string sigue funcionando
   * como filtro por teamId (compat), pero lo ideal es usar el objeto.
   */
  async getSchoolView(
    schoolId: string,
    filter?: string | { teamId?: string | null; branchId?: string | null; includeInactive?: boolean }
  ) {
    const { teamId, branchId, includeInactive } =
      typeof filter === 'string'
        ? { teamId: filter, branchId: undefined, includeInactive: false }
        : { teamId: filter?.teamId, branchId: filter?.branchId, includeInactive: filter?.includeInactive ?? false };

    let query = supabase
      .from('school_athletes' as any)
      .select('*')
      .eq('school_id', schoolId);

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    if (teamId) query = query.eq('enrolled_team_id', teamId);
    if (branchId) query = query.eq('branch_id', branchId);

    const { data: ownAthletes, error } = await query;
    if (error) throw error;

    // Complemento multi-school — children enrollados en esta escuela
    // pero cuyo children.school_id apunta a otra escuela
    // Con una sede elegida (selector multisede), el complemento solo trae a los
    // niños cuya inscripción es en un equipo de ESA sede: sin esto aparecían en
    // todas las sedes porque no traen branch_id.
    const { data: crossEnrollments } = await supabase
      .from('enrollments')
      .select('child_id, teams:teams!enrollments_team_id_fkey(branch_id)')
      .eq('school_id', schoolId)
      .eq('status', 'active')
      .not('child_id', 'is', null);

    const ownIds = new Set((ownAthletes ?? []).map((a: any) => a.id));
    const crossIds = [...new Set((crossEnrollments ?? [])
      .filter((e: any) => !branchId || e.teams?.branch_id === branchId)
      .map((e: any) => e.child_id as string)
      .filter((id: string) => !ownIds.has(id)))];

    if (crossIds.length === 0) return ownAthletes ?? [];

    const crossData = await bffClient.post<any[]>(
      `/api/v1/students/children-by-ids`,
      { ids: crossIds },
      { 'x-school-id': schoolId }
    );

    // Normalizar al shape de school_athletes para que el modal los trate igual
    const extra = (crossData ?? []).map((c: any) => ({
      id: c.id,
      full_name: c.full_name,
      date_of_birth: c.date_of_birth,
      avatar_url: c.avatar_url,
      school_id: schoolId,
      athlete_type: 'child',
      is_active: true,
      email: null,
      parent_email: null,
      medical_info: c.medical_info ?? null,
      enrolled_team_id: null,
      branch_id: branchId ?? null,
    }));

    return [...(ownAthletes ?? []), ...extra];
  }

  /**
   * Lista atletas de un equipo específico.
   */
  async getByTeam(schoolId: string, teamId: string) {
    return this.getSchoolView(schoolId, { teamId });
  }

  /**
   * Busca atletas por nombre en la vista unificada.
   */
  async searchAthletes(schoolId: string, term: string) {
    const { data, error } = await supabase
      .from('school_athletes' as any)
      .select('*')
      .eq('school_id', schoolId)
      .eq('is_active', true)
      .ilike('full_name', `%${term}%`);
    if (error) throw error;
    return data ?? [];
  }

  /**
   * Lista atletas SIN enrollment activo en el equipo dado.
   * Usado por EnrollTeamStudentModal para mostrar quién puede inscribirse.
   */
  async getAvailableForTeam(schoolId: string, teamId: string) {
    const { data, error } = await supabase
      .from('school_athletes' as any)
      .select('*')
      .eq('school_id', schoolId)
      .eq('is_active', true)
      .or(`enrolled_team_id.is.null,enrolled_team_id.neq.${teamId}`);
    if (error) throw error;
    return data ?? [];
  }

  /**
   * Get students filtered by school, search term, etc.
   */
  async getStudents(params?: {
    school_id?: string;
    status?: string;
    grade?: string;
    search?: string;
    skip?: number;
    limit?: number;
  }): Promise<Student[]> {
    try {
      let query = supabase
        .from('children')
        .select('*, profiles:parent_id(full_name, phone, avatar_url)')
        .order('created_at', { ascending: false });

      if (params?.school_id) {
        query = query.eq('school_id', params.school_id);
      }
      if (params?.grade) {
        query = query.eq('grade', params.grade);
      }
      if (params?.search) {
        query = query.ilike('full_name', `%${params.search}%`);
      }

      const offset = params?.skip ?? 0;
      const limit = params?.limit ?? 100;
      query = query.range(offset, offset + limit - 1);

      const { data, error } = await query;

      if (error) {
        console.warn('Error fetching students from Supabase:', error.message);
        return [];
      }

      return (data || []).map((child: any) => this.mapChildToStudent(child));
    } catch (error) {
      console.warn('Error fetching students:', error);
      return [];
    }
  }

  /**
   * Get a single student by ID
   */
  async getStudent(id: string): Promise<Student> {
    const { data, error } = await supabase
      .from('children')
      .select('*, profiles:parent_id(full_name, phone, avatar_url)')
      .eq('id', id)
      .single();

    if (error || !data) {
      throw new Error(error?.message || 'Student not found');
    }

    return this.mapChildToStudent(data);
  }

  /**
   * Update a student
   */
  async updateStudent(
    id: string,
    updates: StudentUpdate & { athlete_type?: 'child' | 'adult' | 'unregistered' }
  ): Promise<any> {
    const status = updates.status;
    const athleteType = updates.athlete_type;
    const schoolId = updates.school_id;

    // 1. Si es Adulto
    if (athleteType === 'adult') {
      if (!schoolId) {
        throw new Error('School ID is required to update adult status');
      }
      
      const dbStatus = status === 'active' ? 'active' : 'inactive';
      
      const { data, error } = await supabase
        .from('school_members')
        .update({
          status: dbStatus,
          updated_at: new Date().toISOString()
        })
        .eq('profile_id', id)
        .eq('school_id', schoolId)
        .eq('role', 'athlete')
        .select()
        .maybeSingle();

      if (error) {
        throw new Error(error.message || 'Failed to update adult athlete status');
      }
      
      return data;
    }

    // 2. Si es Unregistered
    if (athleteType === 'unregistered') {
      const { data, error } = await supabase
        .from('unregistered_athletes')
        .update({
          is_active: status === 'active',
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (error || !data) {
        throw new Error(error?.message || 'Failed to update unregistered athlete status');
      }
      return data;
    }

    // 3. Si es Child (comportamiento original)
    const dbUpdates: any = {
      ...updates,
      updated_at: new Date().toISOString(),
    };

    // Remover campos que no pertenecen a la tabla 'children'
    delete dbUpdates.athlete_type;
    delete dbUpdates.school_id;

    if (updates.status !== undefined) {
      dbUpdates.is_active = updates.status === 'active';
      delete dbUpdates.status;
    }

    const { data, error } = await supabase
      .from('children')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      throw new Error(error?.message || 'Failed to update student');
    }

    return this.mapChildToStudent(data);
  }

  /**
   * Delete a student
   */
  async deleteStudent(id: string): Promise<void> {
    const { error } = await supabase
      .from('children')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(error.message || 'Failed to delete student');
    }
  }

  /**
   * Bulk upload students from CSV — parseado client-side, enviado al BFF.
   *
   * ANTES: insertaba fila por fila directo a Supabase (N queries, sin validación).
   * AHORA: parsea el CSV, arma el array, y hace UNA sola llamada al BFF.
   *        El BFF valida, inyecta school_id, detecta duplicados y retorna reporte.
   *
   * Compatible con el contrato anterior: retorna { success, failed, errors, students }
   */
  async bulkUpload(
    file: File,
    schoolId: string,  // Mantenido por compatibilidad — el BFF lo ignora y usa el JWT
    options: BulkUploadOptions = {},
  ): Promise<BulkUploadResponse> {

    // ── 1. Parsear el CSV (igual que antes) ───────────────────────────────
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length < 2) {
      return {
        success: false,
        message: 'El archivo CSV está vacío o solo tiene encabezados.',
        summary: { total: 0, inserted: 0, updated: 0, skipped: 0 },
        skipped: [],
        failed: 0, errors: [], students: [],
      };
    }

    const delimiter = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(delimiter).map(h => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/^\uFEFF/, ''));
    const parseErrors: Array<{ row: number; error: string }> = [];
    const seenDocIds = new Set<string>();
    const uniqueStudents: BFFStudentRow[] = [];

    // Elimina sufijo ".0" que Excel/pandas añade a campos numéricos (ej: "1109803617.0" → "1109803617")
    const stripDecimal = (val: string) => /^\d+\.0+$/.test(val) ? val.replace(/\.0+$/, '') : val;

    // Normaliza notas_medicas a JSON válido con has_allergies (P4)
    const normalizeMedicalInfo = (val: string): string | undefined => {
      if (!val) return undefined;
      try {
        const parsed = JSON.parse(val);
        // El BFF exige has_allergies:boolean. Si el JSON del CSV trae otros
        // campos (eps, rh, …) pero no has_allergies, lo agregamos sin perderlos.
        if (typeof parsed?.has_allergies !== 'boolean') {
          return JSON.stringify({ ...parsed, has_allergies: false });
        }
        return val;
      } catch { /* no es JSON */ }
      const lower = val.trim().toLowerCase();
      if (/^(ninguna?|none|no|-)$/.test(lower)) return JSON.stringify({ has_allergies: false });
      if (lower.includes('alergia') || lower.includes('allerg')) {
        return JSON.stringify({ has_allergies: true, allergy_type: val.trim(), allergy_severity: 'unknown', allergy_treatment: 'Consultar médico' });
      }
      return JSON.stringify({ has_allergies: false, notes: val.trim() });
    };

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => { row[h] = values[idx] || ''; });

      // Mapear headers en español e inglés (igual que antes)
      const firstName = row['first_name'] || row['nombre'] || '';
      const lastName = row['last_name'] || row['apellido'] || '';
      const docId = stripDecimal(row['document_id'] || row['documento'] || row['cedula'] || '');

      // full_name como fallback si el CSV no tiene first/last separados
      if (!firstName && !lastName) {
        const fullName = row['full_name'] || row['nombre_completo'] || '';
        if (!fullName) {
          parseErrors.push({ row: i + 1, error: 'Falta nombre del deportista' });
          continue;
        }
        if (!docId) {
          parseErrors.push({ row: i + 1, error: 'Falta documento (document_id / documento / cedula)' });
          continue;
        }
        if (seenDocIds.has(docId)) {
          parseErrors.push({ row: i + 1, error: `Documento duplicado: "${docId}" — se omitió la aparición repetida` });
          continue;
        }
        // Dividir en first/last por el primer espacio
        const parts = fullName.split(' ');
        const pName = row['parent_name'] || row['acudiente'] || row['nombre_acudiente'] || '';
        const pEmail = row['parent_email'] || row['correo_acudiente'] || row['email_acudiente'] || '';
        const pPhone = stripDecimal(row['parent_phone'] || row['telefono_acudiente'] || row['telefono'] || '');
        if (!pName || pName.length < 2) {
          parseErrors.push({ row: i + 1, error: 'Falta nombre del acudiente (columna: acudiente / parent_name)' });
          continue;
        }
        if (!pEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail)) {
          parseErrors.push({ row: i + 1, error: 'Email del acudiente inválido o faltante (columna: correo_acudiente / parent_email)' });
          continue;
        }
        if (!/^\d{10,}$/.test(pPhone)) {
          parseErrors.push({ row: i + 1, error: 'Teléfono del acudiente debe tener mínimo 10 dígitos (columna: telefono_acudiente)' });
          continue;
        }
        const teamName = row['team'] || row['equipo'] || '';
        if (!teamName) {
          parseErrors.push({ row: i + 1, error: 'Falta equipo (columna: equipo / team)' });
          continue;
        }
        const sportName = row['sport'] || row['deporte'] || '';
        if (!sportName) {
          parseErrors.push({ row: i + 1, error: 'Falta deporte (columna: deporte / sport)' });
          continue;
        }
        const dobRaw = row['date_of_birth'] || row['fecha_nacimiento'] || '';
        if (dobRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dobRaw)) {
          parseErrors.push({ row: i + 1, error: `Fecha de nacimiento inválida: "${dobRaw}" — usar formato YYYY-MM-DD` });
          continue;
        }
        const feeRaw = row['monthly_fee'] || row['mensualidad'] || '';
        const fee = feeRaw ? Number(feeRaw) : undefined;
        if (fee !== undefined && (isNaN(fee) || fee < 10000)) {
          parseErrors.push({ row: i + 1, error: `Mensualidad inválida: "${feeRaw}" — debe ser número ≥ $10,000 COP` });
          continue;
        }
        seenDocIds.add(docId);
        uniqueStudents.push({
          first_name: parts[0],
          last_name: parts.slice(1).join(' ') || '-',
          document_id: docId,
          grade: row['grade'] || row['grado'] || undefined,
          medical_info: normalizeMedicalInfo(row['medical_info'] || row['notas_medicas'] || ''),
          branch: row['branch'] || row['sede'] || undefined,
          team: teamName,
          sport: sportName,
          date_of_birth: dobRaw || undefined,
          gender: row['gender'] || row['genero'] || row['género'] || undefined,
          parent_name: pName,
          parent_email: pEmail,
          parent_phone: pPhone,
          monthly_fee: fee,
        });
        continue;
      }

      if (!docId) {
        parseErrors.push({ row: i + 1, error: 'Falta documento (document_id / documento / cedula)' });
        continue;
      }
      if (seenDocIds.has(docId)) {
        parseErrors.push({ row: i + 1, error: `Documento duplicado: "${docId}" — se omitió la aparición repetida` });
        continue;
      }

      const pName = row['parent_name'] || row['acudiente'] || row['nombre_acudiente'] || '';
      const pEmail = row['parent_email'] || row['correo_acudiente'] || row['email_acudiente'] || '';
      const pPhone = stripDecimal(row['parent_phone'] || row['telefono_acudiente'] || row['telefono'] || '');
      if (!pName || pName.length < 2) {
        parseErrors.push({ row: i + 1, error: 'Falta nombre del acudiente (columna: acudiente / parent_name)' });
        continue;
      }
      if (!pEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail)) {
        parseErrors.push({ row: i + 1, error: 'Email del acudiente inválido o faltante (columna: correo_acudiente / parent_email)' });
        continue;
      }
      if (!/^\d{10,}$/.test(pPhone)) {
        parseErrors.push({ row: i + 1, error: 'Teléfono del acudiente debe tener mínimo 10 dígitos (columna: telefono_acudiente)' });
        continue;
      }
      const teamName = row['team'] || row['equipo'] || '';
      if (!teamName) {
        parseErrors.push({ row: i + 1, error: 'Falta equipo (columna: equipo / team)' });
        continue;
      }
      const sportName = row['sport'] || row['deporte'] || '';
      if (!sportName) {
        parseErrors.push({ row: i + 1, error: 'Falta deporte (columna: deporte / sport)' });
        continue;
      }
      const dobRaw = row['date_of_birth'] || row['fecha_nacimiento'] || '';
      if (dobRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dobRaw)) {
        parseErrors.push({ row: i + 1, error: `Fecha de nacimiento inválida: "${dobRaw}" — usar formato YYYY-MM-DD` });
        continue;
      }
      const feeRaw = row['monthly_fee'] || row['mensualidad'] || '';
      const fee = feeRaw ? Number(feeRaw) : undefined;
      if (fee !== undefined && (isNaN(fee) || fee < 10000)) {
        parseErrors.push({ row: i + 1, error: `Mensualidad inválida: "${feeRaw}" — debe ser número ≥ $10,000 COP` });
        continue;
      }
      seenDocIds.add(docId);
      uniqueStudents.push({
        first_name: firstName,
        last_name: lastName,
        document_id: docId,
        grade: row['grade'] || row['grado'] || undefined,
        medical_info: normalizeMedicalInfo(row['medical_info'] || row['notas_medicas'] || ''),
        branch: row['branch'] || row['sede'] || undefined,
        team: teamName,
        sport: sportName,
        date_of_birth: dobRaw || undefined,
        gender: row['gender'] || row['genero'] || row['género'] || undefined,
        parent_name: pName,
        parent_email: pEmail,
        parent_phone: pPhone,
        monthly_fee: fee,
      });
    }

    // Si todos fallaron en el parseo, no llamamos al BFF
    if (uniqueStudents.length === 0) {
      return {
        success: false,
        message: `No se pudo parsear ningún deportista. ${parseErrors.length} errores.`,
        summary: { total: 0, inserted: 0, updated: 0, skipped: parseErrors.length },
        skipped: [],
        failed: parseErrors.length,
        errors: parseErrors,
        students: [],
      };
    }

    // ── 2. Llamar al BFF — UNA sola request en vez de N inserts ──────────
    const bffResponse = await bffClient.post<{
      success: boolean;
      message: string;
      summary: { total: number; inserted: number; updated: number; skipped: number };
      skipped: Array<{ document_id: string; reason: string }>;
    }>('/api/v1/students/bulk', {
      students: uniqueStudents,
      options: {
        upsert: options.upsert ?? false,
        defaultBranchId: options.defaultBranchId || null,
      },
    }, {
      'x-school-id': schoolId
    });

    // ── 3. Adaptar respuesta al contrato anterior ─────────────────────────
    return {
      // Nuevos campos
      success: bffResponse.success,
      message: bffResponse.message,
      summary: bffResponse.summary,
      skipped: bffResponse.skipped,
      // Campos legacy para componentes que aún los lean
      failed: bffResponse.summary.skipped + parseErrors.length,
      errors: parseErrors,  // solo errores de parseo CSV, los del BFF están en skipped
      students: [],            // el BFF no retorna los objetos completos (no los necesitamos)
    };
  }

  /**
   * Get student statistics for a school
   */
  async getStats(schoolId: string, branchId?: string | null, coachId?: string): Promise<StudentStats> {
    // Para coaches: conteo único via enrollments activos + children.team_id.
    // Se hace antes del check de schoolId para soportar coaches sin sede activa.
    if (coachId) {
      try {
        const [{ data: legacyTeams }, { data: junctionTeams }] = await Promise.all([
          supabase.from('teams').select('id').eq('coach_id', coachId),
          supabase.from('team_coaches').select('team_id').eq('coach_id', coachId),
        ]);
        const teamIds = [...new Set([
          ...(legacyTeams || []).map(t => t.id),
          ...(junctionTeams || []).map(t => t.team_id),
        ])];
        if (teamIds.length === 0) return { total: 0, active: 0, inactive: 0, by_grade: {} };

        // Build query — only filter by school_id if it's a valid UUID
        let coachQuery = supabase
          .from('school_athletes' as any)
          .select('id')
          .eq('is_active', true)
          .in('enrolled_team_id', teamIds);

        if (schoolId && isValidUUID(schoolId)) {
          coachQuery = coachQuery.eq('school_id', schoolId);
        }

        const { data: coachAthletes } = await coachQuery;

        const uniqueCount = coachAthletes?.length ?? 0;

        return { total: uniqueCount, active: uniqueCount, inactive: 0, by_grade: {} };
      } catch (error) {
        console.warn('Error fetching coach student stats:', error);
        return { total: 0, active: 0, inactive: 0, by_grade: {} };
      }
    }

    if (!schoolId || !isValidUUID(schoolId)) {
      return { total: 0, active: 0, inactive: 0, by_grade: {} };
    }
    try {
      // Se cuenta sobre las tres tablas base, NO sobre la vista `school_athletes`.
      // La vista arma cada atleta con 12 LEFT JOIN LATERAL (equipo, plan, cobro,
      // inscripción activa) y Postgres no los puede podar aunque solo se pidan dos
      // columnas: son joins, y con `LIMIT 1` sin prueba de unicidad no aplica join
      // removal. Bajar el roster entero para calcular dos números costaba 746 ms de
      // media y hasta 10,5 s (auditoría de lentitud del 2026-08-05).
      //
      // El conteo no necesita nada de los laterales: "activo" es columna plana en
      // cada rama de la vista.
      //   · menores        → children.is_active
      //   · adultos        → school_members.status = 'active', role = 'athlete'
      //   · no registrados → unregistered_athletes.is_active, sin los ya vinculados
      //
      // `count: 'exact', head: true` trae el conteo del servidor sin filas, así que
      // el techo de filas de PostgREST no lo afecta: el conteo en JS que había antes
      // se quedaba corto en una escuela de más de 1000 atletas.
      //
      // Divergencia conocida con la vista: su rama de adultos hace INNER JOIN a
      // `profiles`, y como `school_members.profile_id` apunta a `auth.users` y no a
      // `profiles`, un miembro sin fila visible ahí se le caía del total (ya pasó:
      // mig 20260730160000). Acá se cuenta la membresía, que es el registro
      // autoritativo. Si los dos números difieren, falta una fila de `profiles` —
      // conviene verlo, no esconderlo.
      const countAthletes = (table: string, build: (q: any) => any) =>
        build((supabase.from(table as any) as any).select('id', { count: 'exact', head: true }));

      const byBranch = await Promise.all([
        countAthletes('children', q => q.eq('school_id', schoolId)),
        countAthletes('children', q => q.eq('school_id', schoolId).eq('is_active', true)),
        countAthletes('school_members', q => q.eq('school_id', schoolId).eq('role', 'athlete')),
        countAthletes('school_members', q => q.eq('school_id', schoolId).eq('role', 'athlete').eq('status', 'active')),
        countAthletes('unregistered_athletes', q => q.eq('school_id', schoolId).is('linked_profile_id', null)),
        countAthletes('unregistered_athletes', q => q.eq('school_id', schoolId).is('linked_profile_id', null).eq('is_active', true)),
      ]);

      // Un error parcial no puede pasar por cero: seis counts donde uno falla darían
      // un total más chico y creíble, que es la peor forma de equivocarse.
      const failed = byBranch.find((r: any) => r.error);
      if (failed) throw (failed as any).error;

      const [childrenTotal, childrenActive, adultsTotal, adultsActive, unregTotal, unregActive] =
        byBranch.map((r: any) => r.count ?? 0);

      const total = childrenTotal + adultsTotal + unregTotal;
      const active = childrenActive + adultsActive + unregActive;

      return {
        total,
        active,
        inactive: total - active,
        by_grade: {}, // Grade data might not be supported without joining properly, returning empty for now.
      };
    } catch (error) {
      console.warn('Error fetching student stats:', error);
      return { total: 0, active: 0, inactive: 0, by_grade: {} };
    }
  }

  /**
   * Map a Supabase 'children' row to the Student interface
   */
  private mapChildToStudent(child: any): Student {
    const parentProfile = child.profiles;
    return {
      id: child.id,
      full_name: child.full_name,
      date_of_birth: child.date_of_birth,
      school_id: child.school_id || '',
      grade: child.grade,
      emergency_contact: child.emergency_contact,
      parent_id: child.parent_id,
      parent_name: parentProfile?.full_name || undefined,
      parent_phone: parentProfile?.phone || undefined,
      medical_notes: child.medical_info,
      medical_info: child.medical_info,
      sport: child.sport,
      team_name: child.team_name,
      avatar_url: child.avatar_url || parentProfile?.avatar_url,
      status: child.is_active !== false ? 'active' : 'inactive',
      created_at: child.created_at,
      updated_at: child.updated_at,
    } as Student;
  }
}

export const studentsAPI = new StudentsAPI();
