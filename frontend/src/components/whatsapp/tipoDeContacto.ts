/**
 * Tipo de contacto que la escuela marca a mano (2026-10-13).
 *
 * Espejo de `bff/src/services/whatsapp-tipo-contacto.ts`. Las cinco marcas
 * (personal, negocio, otro club, plataforma, staff) significan lo mismo para el
 * asistente: NO es familia — no le habla, no guarda el contenido y sus fotos no
 * llenan la bandeja de comprobantes. «Familia» = sin marca: el número se
 * clasifica solo con el próximo mensaje.
 *
 * «También es familia»: la persona marcada (p. ej. el esposo de la dueña) es
 * además acudiente. Sus comprobantes de pago sí se aplican; sus fotos
 * personales no.
 */

export const MARCAS = ['personal', 'negocio', 'otro_club', 'plataforma', 'equipo'] as const;
export type MarcaDeContacto = typeof MARCAS[number];
export type OpcionDeTipo = 'familia' | MarcaDeContacto;

export const OPCIONES_DE_TIPO: { valor: OpcionDeTipo; texto: string; ayuda: string }[] = [
    { valor: 'familia', texto: 'Familia', ayuda: 'Acudiente o deportista. Mapi lo atiende (sin marca).' },
    { valor: 'personal', texto: 'Personal', ayuda: 'Familia o amigos de quien dirige la escuela.' },
    { valor: 'negocio', texto: 'Negocio', ayuda: 'Proveedor, tienda, restaurante, agencia…' },
    { valor: 'otro_club', texto: 'Otro club', ayuda: 'Otro club o escuela deportiva.' },
    { valor: 'plataforma', texto: 'Plataforma', ayuda: 'El número de SportMaps u otra plataforma.' },
    { valor: 'equipo', texto: 'Staff', ayuda: 'Profe, secretaria o personal de la escuela cuyo número no está en su perfil.' },
];

export const TEXTO_DE_MARCA: Record<MarcaDeContacto, string> = {
    personal: 'personal', negocio: 'negocio', otro_club: 'otro club', plataforma: 'plataforma', equipo: 'staff',
};

export function esMarcaNoFamilia(kind: string | null | undefined): kind is MarcaDeContacto {
    return !!kind && (MARCAS as readonly string[]).includes(kind);
}

/** ¿Marcado como no-familia y SIN «también es familia»? (no se le escribe, no se guarda contenido) */
export function esSoloNoFamilia(kind: string | null | undefined, tambienFamilia?: boolean | null): boolean {
    return esMarcaNoFamilia(kind) && tambienFamilia !== true;
}

export interface RespuestaDeTipo {
    ok: boolean;
    contact_kind: string | null;
    tambien_familia?: boolean;
    filas_cerradas?: number;
}

/** Ruta y cuerpo del PATCH …/tipo. */
export function pedidoDeTipo(schoolId: string, conversacionId: string, tipo: OpcionDeTipo, tambienFamilia: boolean) {
    return {
        ruta: `/api/v1/whatsapp/${schoolId}/conversaciones/${conversacionId}/tipo`,
        cuerpo: { tipo, tambien_familia: tipo === 'familia' ? false : tambienFamilia },
    };
}

/** El aviso después de marcar. */
export function textoDelResultado(tipo: OpcionDeTipo, filasCerradas: number): { title: string; description: string } {
    if (tipo === 'familia') {
        return { title: 'Se quitó la marca', description: 'El número vuelve a clasificarse solo con su próximo mensaje.' };
    }
    const cerradas = filasCerradas > 0
        ? ` Se ${filasCerradas === 1 ? 'cerró 1 fila' : `cerraron ${filasCerradas} filas`} de la bandeja de comprobantes.`
        : '';
    return {
        title: `Marcado como ${TEXTO_DE_MARCA[tipo]}`,
        description: `Mapi no le responde y sus fotos ya no llegan a la bandeja.${cerradas}`,
    };
}
