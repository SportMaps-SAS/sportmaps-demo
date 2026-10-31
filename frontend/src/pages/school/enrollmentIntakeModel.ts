/**
 * Lógica pura de la bandeja de hojas de matrícula (EnrollmentIntakeInboxPage, V2).
 *
 * Decide qué se le pide a la escuela en cada ficha y si ya se puede crear al
 * deportista. Sin React ni red: se prueba en enrollmentIntakeModel.test.ts.
 *
 * Los campos obligatorios NO cambian frente a la pantalla anterior:
 *   menor  → nombre, documento, correo y celular del acudiente
 *   adulto → nombre y documento
 * Lo nuevo es que el correo y el celular se revisan por forma (antes bastaba
 * con que no estuvieran vacíos) y que el tipo de documento ya no arranca en CC
 * para un menor.
 */

export interface EnrollmentFormResult {
    athleteFullName: string | null;
    docType: string | null;
    docNumber: string | null;
    dateOfBirth: string | null;
    dateOfBirthRaw: string | null;
    ageOnForm: number | null;
    category: string | null;
    guardianFullName: string | null;
    guardianDocType?: string | null;
    guardianDocNumber: string | null;
    guardianPhone: string | null;
    guardianEmail: string | null;
    athleteEmail: string | null;
    athletePhone: string | null;
    epsName: string | null;
    bloodType: string | null;
    formDate?: string | null;
    authorizations?: Array<{ text: string; checked: boolean | null }>;
    isEnrollmentForm: boolean;
    missingFields: string[];
    provider: string;
}

export interface IntakeItem {
    id: string;
    source?: 'whatsapp' | 'app';
    status: string;
    extracted: EnrollmentFormResult | null;
    photoUrl: string | null;
    duplicateOfChildId: string | null;
    duplicateOfChildName: string | null;
    duplicateOfIntakeId: string | null;
    rejectionReason: string | null;
    createdAt: string;
}

export type CampoFicha =
    | 'athleteFullName' | 'docType' | 'docNumber' | 'dateOfBirth' | 'guardianFullName'
    | 'guardianPhone' | 'guardianEmail' | 'athleteEmail' | 'athletePhone' | 'epsName' | 'bloodType';

export type FormState = Record<CampoFicha, string>;

/**
 * Los mismos que acepta POST /students/create-one para un menor
 * (`z.enum(['TI','CC','CE','PP'])`) y que ofrece el alta manual. RC no está:
 * mandarlo da 400 sin decir qué campo falla. Sumarlo es decisión de producto.
 */
export const TIPOS_DOC = ['TI', 'CC', 'CE', 'PP'] as const;
export const GRUPOS_SANGUINEOS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'] as const;

/** Etiqueta corta para «Falta: …» en el pie de la ficha. */
export const ETIQUETA_FALTA: Partial<Record<CampoFicha, string>> = {
    athleteFullName: 'nombre del deportista',
    docNumber: 'documento',
    guardianEmail: 'correo del acudiente',
    guardianPhone: 'celular del acudiente',
    guardianFullName: 'nombre del acudiente',
    dateOfBirth: 'fecha de nacimiento',
    athletePhone: 'celular del deportista',
    athleteEmail: 'correo del deportista',
};

/** Edad en años cumplidos a la fecha `hoy`; null si la fecha no se puede leer. */
export function edadEn(fechaIso: string | null | undefined, hoy: Date = new Date()): number | null {
    if (!fechaIso || !/^\d{4}-\d{2}-\d{2}/.test(fechaIso)) return null;
    const [a, m, d] = fechaIso.slice(0, 10).split('-').map(Number);
    // '2010-13-45' tiene forma de fecha pero no existe: la IA a veces lee así un manuscrito.
    const real = new Date(a, m - 1, d);
    if (real.getFullYear() !== a || real.getMonth() !== m - 1 || real.getDate() !== d) return null;
    let edad = hoy.getFullYear() - a;
    if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) edad--;
    return Number.isFinite(edad) && edad >= 0 ? edad : null;
}

export function esMayorDeEdad(item: IntakeItem, hoy: Date = new Date()): boolean {
    const e = item.extracted;
    if (!e) return false;
    if (e.ageOnForm != null) return e.ageOnForm >= 18;
    const edad = edadEn(e.dateOfBirth, hoy);
    return edad != null && edad >= 18;
}

/** 'C.C.', 'cc', 'PASAPORTE', 'PA' → el código que acepta el BFF; null si no es ninguno. */
export function normalizarTipoDoc(leido: string | null | undefined): (typeof TIPOS_DOC)[number] | null {
    const t = (leido ?? '').replace(/[\s.]/g, '').toUpperCase();
    if (!t) return null;
    if (t === 'PA' || t === 'PASAPORTE') return 'PP';
    return (TIPOS_DOC as readonly string[]).includes(t) ? (t as (typeof TIPOS_DOC)[number]) : null;
}

/**
 * Tipo de documento con que arranca la ficha: lo leído si el BFF lo acepta; si
 * no (vacío, RC, algo ilegible), CC para un adulto y TI para un menor. Antes un
 * menor sin tipo leído arrancaba en CC.
 */
export function tipoDocPorDefecto(item: IntakeItem, hoy: Date = new Date()): string {
    return normalizarTipoDoc(item.extracted?.docType) ?? (esMayorDeEdad(item, hoy) ? 'CC' : 'TI');
}

export function formularioInicial(item: IntakeItem, hoy: Date = new Date()): FormState {
    const e = item.extracted;
    return {
        athleteFullName: e?.athleteFullName ?? '',
        docType: tipoDocPorDefecto(item, hoy),
        docNumber: e?.docNumber ?? '',
        // Una fecha imposible ('2010-13-45') no se precarga: el <input type="date"> la
        // mostraría vacía pero se mandaría igual al BFF. Se pide y la pista muestra lo leído.
        dateOfBirth: campoValido('dateOfBirth', e?.dateOfBirth, hoy) ? e!.dateOfBirth! : '',
        guardianFullName: e?.guardianFullName ?? '',
        guardianPhone: e?.guardianPhone ?? '',
        guardianEmail: e?.guardianEmail ?? '',
        athleteEmail: e?.athleteEmail ?? '',
        athletePhone: e?.athletePhone ?? '',
        epsName: e?.epsName ?? '',
        bloodType: e?.bloodType ?? '',
    };
}

export const soloDigitos = (v: string) => v.replace(/\D/g, '');

/** ¿El valor sirve para crear al deportista? Los opcionales sirven si no están vacíos. */
export function campoValido(campo: CampoFicha, valor: string | null | undefined, hoy: Date = new Date()): boolean {
    const v = (valor ?? '').trim();
    if (!v) return false;
    switch (campo) {
        case 'dateOfBirth':
            return edadEn(v, hoy) != null;
        case 'guardianEmail':
        case 'athleteEmail':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        case 'guardianPhone':
            // create-one exige /^\d{10,}$/ en parent_phone.
            return soloDigitos(v).length >= 10;
        case 'athletePhone':
            return soloDigitos(v).length >= 7;
        default:
            return true;
    }
}

export function camposObligatorios(mayorDeEdad: boolean): CampoFicha[] {
    return mayorDeEdad
        ? ['athleteFullName', 'docNumber']
        : ['athleteFullName', 'docNumber', 'guardianEmail', 'guardianPhone'];
}

/** Opcionales que, si se llenan, el BFF valida (un correo mal escrito da 400). */
const OPCIONALES_CON_FORMA: CampoFicha[] = ['dateOfBirth', 'athleteEmail', 'athletePhone'];

/**
 * Lo que impide crear, en el orden en que se muestra: obligatorios que no
 * sirven y opcionales escritos con forma inválida.
 */
export function camposQueFaltan(form: FormState, mayorDeEdad: boolean): CampoFicha[] {
    const obligatorios = camposObligatorios(mayorDeEdad);
    const malEscritos = OPCIONALES_CON_FORMA.filter(
        (c) => !obligatorios.includes(c) && (form[c] ?? '').trim() !== '' && !campoValido(c, form[c]),
    );
    return [...obligatorios.filter((c) => !campoValido(c, form[c])), ...malEscritos];
}

/**
 * Qué se pide como campo editable en «Falta completar». Se calcula UNA vez con
 * lo leído de la hoja: escribir no mueve los campos de lugar. Lo que la hoja sí
 * trajo queda en el resumen «Leído de la hoja», editable desde ahí.
 */
export function camposAPedir(item: IntakeItem, hoy: Date = new Date()): CampoFicha[] {
    const form = formularioInicial(item, hoy);
    const mayor = esMayorDeEdad(item, hoy);
    const candidatos: CampoFicha[] = mayor
        ? ['athleteFullName', 'docNumber', 'dateOfBirth', 'athletePhone', 'athleteEmail']
        : ['athleteFullName', 'docNumber', 'dateOfBirth', 'guardianFullName', 'guardianPhone', 'guardianEmail'];
    return candidatos.filter((c) => !campoValido(c, form[c]));
}

export type EstadoFicha = 'duplicada' | 'faltan' | 'lista';

/**
 * `esOtraPersona`: la escuela dijo «Es otra persona» frente al aviso de duplicado,
 * así que la ficha se trata como nueva (create-one igual revisa duplicados y da 409).
 */
export function estadoFicha(
    item: IntakeItem,
    form: FormState,
    hoy: Date = new Date(),
    { esOtraPersona = false }: { esOtraPersona?: boolean } = {},
): EstadoFicha {
    if (item.duplicateOfChildId && !esOtraPersona) return 'duplicada';
    return camposQueFaltan(form, esMayorDeEdad(item, hoy)).length ? 'faltan' : 'lista';
}

export function textoEstado(estado: EstadoFicha, faltan: number): string {
    if (estado === 'duplicada') return 'Ya existe';
    if (estado === 'lista') return 'Lista';
    return faltan === 1 ? 'Falta 1 dato' : `Faltan ${faltan} datos`;
}

/** «documento, correo del acudiente y celular del acudiente» */
export function listaLegible(campos: CampoFicha[]): string {
    const t = campos.map((c) => ETIQUETA_FALTA[c] ?? c);
    if (t.length <= 1) return t.join('');
    return `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}`;
}

export const MOTIVOS_DESCARTE = [
    'Foto ilegible',
    'No es una hoja de matrícula',
    'Ya está inscrito',
    'Se retiró',
] as const;
