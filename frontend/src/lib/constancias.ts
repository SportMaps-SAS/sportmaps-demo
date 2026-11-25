/**
 * Constancias — palabras y datos compartidos por las pantallas de la escuela,
 * de la familia y la página pública. Sin React.
 *
 * El catálogo de variables es el mismo del BFF (bff/src/services/constancias.ts,
 * VARIABLES_CONSTANCIA): si se agrega una allá, se agrega acá.
 */

export type TipoConstancia = 'study' | 'conduct' | 'medical' | 'payment' | 'federation' | 'custom';

export const TIPOS_CONSTANCIA: Array<{ value: TipoConstancia; label: string }> = [
  { value: 'study', label: 'Estudio / inscripción' },
  { value: 'conduct', label: 'Conducta' },
  { value: 'medical', label: 'Médica' },
  { value: 'payment', label: 'Paz y salvo' },
  { value: 'federation', label: 'Federación / liga' },
  { value: 'custom', label: 'Personalizada' },
];

/** «study» → «Estudio / inscripción». Nunca se muestra la clave técnica. */
export function etiquetaTipo(kind: string | null | undefined): string {
  return TIPOS_CONSTANCIA.find((t) => t.value === kind)?.label ?? 'Constancia';
}

export const VARIABLES_CONSTANCIA: Array<{ clave: string; etiqueta: string; grupo: 'Deportista' | 'Inscripción' | 'Escuela' | 'Documento' }> = [
  { clave: 'atleta.nombre', etiqueta: 'Nombre', grupo: 'Deportista' },
  { clave: 'atleta.tipo_doc', etiqueta: 'Tipo de documento', grupo: 'Deportista' },
  { clave: 'atleta.documento', etiqueta: 'Número de documento', grupo: 'Deportista' },
  { clave: 'atleta.fecha_nac', etiqueta: 'Fecha de nacimiento', grupo: 'Deportista' },
  { clave: 'atleta.edad', etiqueta: 'Edad', grupo: 'Deportista' },
  { clave: 'atleta.genero', etiqueta: 'Género', grupo: 'Deportista' },
  { clave: 'atleta.identificacion', etiqueta: '«identificado(a) con TI …»', grupo: 'Deportista' },
  { clave: 'atleta.inscrito', etiqueta: '«inscrito/inscrita»', grupo: 'Deportista' },
  { clave: 'atleta.activo', etiqueta: '«activo/activa»', grupo: 'Deportista' },
  { clave: 'equipo', etiqueta: 'Equipo o categoría', grupo: 'Inscripción' },
  { clave: 'sede', etiqueta: 'Sede', grupo: 'Inscripción' },
  { clave: 'inscripcion.inicio', etiqueta: 'Desde', grupo: 'Inscripción' },
  { clave: 'inscripcion.vence', etiqueta: 'Vigente hasta', grupo: 'Inscripción' },
  { clave: 'escuela.nombre', etiqueta: 'Nombre', grupo: 'Escuela' },
  { clave: 'escuela.ciudad', etiqueta: 'Ciudad', grupo: 'Escuela' },
  { clave: 'escuela.direccion', etiqueta: 'Dirección', grupo: 'Escuela' },
  { clave: 'escuela.telefono', etiqueta: 'Teléfono', grupo: 'Escuela' },
  { clave: 'folio', etiqueta: 'Folio', grupo: 'Documento' },
  { clave: 'fecha_emision', etiqueta: 'Fecha de expedición', grupo: 'Documento' },
];

const CLAVES = new Set([...VARIABLES_CONSTANCIA.map((v) => v.clave), 'fecha_actual', 'inscripcion.estado']);

/** Variables escritas en el texto que no existen (p. ej. {{atleta.nombres}}). */
export function variablesDesconocidas(texto: string): string[] {
  const out = new Set<string>();
  for (const m of String(texto ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (!CLAVES.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** Inserta `{{clave}}` en la posición del cursor y devuelve el texto y el cursor nuevo. */
export function insertarVariable(texto: string, inicio: number, fin: number, clave: string): { texto: string; cursor: number } {
  const token = `{{${clave}}}`;
  const a = Math.max(0, Math.min(inicio, texto.length));
  const b = Math.max(a, Math.min(fin, texto.length));
  return { texto: texto.slice(0, a) + token + texto.slice(b), cursor: a + token.length };
}

/** Plantillas sugeridas: la escuela las crea con un toque y las ajusta. */
export const PLANTILLAS_SUGERIDAS: Array<{
  name: string;
  kind: TipoConstancia;
  title: string;
  body_template: string;
  footer_text: string;
}> = [
  {
    name: 'Constancia de inscripción',
    kind: 'study',
    title: 'CONSTANCIA DE INSCRIPCIÓN',
    body_template:
      '{{escuela.nombre}} hace constar que {{atleta.nombre}}, {{atleta.identificacion}}, se encuentra {{atleta.inscrito}} como deportista en {{equipo}} ({{sede}}) desde el {{inscripcion.inicio}}.\n\nLa presente constancia se expide a solicitud del interesado el {{fecha_emision}}.',
    footer_text: 'Documento generado electrónicamente. Verifique su autenticidad escaneando el código QR.',
  },
  {
    name: 'Constancia de deportista activo',
    kind: 'federation',
    title: 'CONSTANCIA DE DEPORTISTA ACTIVO',
    body_template:
      '{{escuela.nombre}} certifica que {{atleta.nombre}}, {{atleta.identificacion}}, de {{atleta.edad}} años, es deportista {{atleta.activo}} de nuestra institución en la categoría {{equipo}}.\n\nSe expide para los fines que el interesado considere pertinentes, el {{fecha_emision}}.',
    footer_text: 'Documento generado electrónicamente. Verifique su autenticidad escaneando el código QR.',
  },
];

export type EstadoConstancia = 'pending_payment' | 'pending_review' | 'issued' | 'revoked';

/** Estado para la escuela. 'pending_payment' es heredado (hoy no se cobra): va como «Por aprobar». */
export function estadoEscuela(status: string): { label: string; cls: string } {
  switch (status) {
    case 'issued': return { label: 'Emitida', cls: 'bg-green-100 text-green-800' };
    case 'revoked': return { label: 'Anulada', cls: 'bg-gray-200 text-gray-700' };
    case 'pending_review':
    case 'pending_payment':
      return { label: 'Por aprobar', cls: 'bg-blue-100 text-blue-800' };
    default: return { label: 'En proceso', cls: 'bg-gray-100 text-gray-700' };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /cert/:x — el QR trae el token (uuid); un folio digitado no lo es. */
export function parametroVerificacion(x: string | undefined | null): { p_folio: string | null; p_qr_token: string | null } {
  const v = String(x ?? '').trim();
  if (!v) return { p_folio: null, p_qr_token: null };
  return UUID_RE.test(v) ? { p_folio: null, p_qr_token: v } : { p_folio: v.toUpperCase(), p_qr_token: null };
}

/** Lista de datos faltantes que devuelve el BFF al generar el PDF, en una frase. */
export function fraseFaltantes(faltantes: Array<{ etiqueta: string }> | null | undefined): string | null {
  const l = (faltantes ?? []).map((f) => f.etiqueta.toLowerCase());
  if (l.length === 0) return null;
  if (l.length === 1) return `Faltó un dato en la ficha: ${l[0]}.`;
  return `Faltaron datos en la ficha: ${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}.`;
}
