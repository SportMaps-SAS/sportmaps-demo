/**
 * Jugadores del torneo — PURO (salvo `readSpreadsheet`, que carga exceljs bajo demanda).
 * Lee lo que el organizador o el delegado pega o sube (CSV, Excel, lista) y lo convierte en filas
 * para POST …/teams/:teamId/players, SIEMPRE con vista previa antes de guardar.
 */

export type BaseField = 'photo_url' | 'full_name' | 'nickname' | 'position' | 'shirt_number' | 'document_number' | 'birth_date' | 'phone';
export interface CustomField { key: string; label: string; type: 'text' | 'date' | 'bool' | 'select'; options?: string[]; required?: boolean }
export interface PlayerForm { required: BaseField[]; custom: CustomField[] }

export interface PlayerDto {
  id: string; team_id: string; full_name: string; nickname: string | null; position: string | null; shirt_number: number | null;
  document_number: string | null; birth_date: string | null; phone: string | null; photo_url: string | null;
  extra: Record<string, unknown>; suspended: boolean; suspended_reason: string | null; from_school: boolean;
}

export interface PlayerDraft {
  full_name: string; nickname?: string; position?: string; shirt_number?: string; document_number?: string;
  birth_date?: string; phone?: string; photo_url?: string; extra?: Record<string, string>;
}

export const BASE_LABEL: Record<BaseField, string> = {
  photo_url: 'Foto', full_name: 'Nombre', nickname: 'Apodo', position: 'Posición', shirt_number: 'Número',
  document_number: 'Documento', birth_date: 'Fecha de nacimiento', phone: 'Teléfono',
};

/** Columnas que se muestran en el formulario y la planilla (sin la foto). */
export const SHEET_FIELDS: BaseField[] = ['full_name', 'shirt_number', 'nickname', 'position', 'document_number', 'birth_date', 'phone'];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

const ALIASES: Record<Exclude<BaseField, 'photo_url'>, string[]> = {
  full_name: ['nombre', 'nombres', 'nombre completo', 'jugador', 'jugadora', 'deportista', 'nombre y apellido', 'nombres y apellidos', 'name'],
  shirt_number: ['numero', 'no', 'n', '#', 'dorsal', 'camiseta', 'num'],
  nickname: ['apodo', 'alias'],
  position: ['posicion', 'pos', 'rol'],
  document_number: ['documento', 'doc', 'cedula', 'cc', 'ti', 'identificacion', 'numero de documento', 'documento de identidad'],
  birth_date: ['fecha de nacimiento', 'nacimiento', 'fecha nacimiento', 'f nacimiento', 'fecha nac', 'nac'],
  phone: ['telefono', 'celular', 'cel', 'tel', 'whatsapp', 'movil'],
};

/** Encabezado → campo (base o propio). null = columna ignorada. */
export function mapHeader(h: string, form: PlayerForm): { kind: 'base'; key: BaseField } | { kind: 'custom'; key: string } | null {
  const n = norm(h);
  if (!n) return null;
  for (const [key, list] of Object.entries(ALIASES) as Array<[BaseField, string[]]>) if (list.includes(n)) return { kind: 'base', key };
  const c = form.custom.find((f) => norm(f.label) === n || f.key === n.replace(/ /g, '_'));
  return c ? { kind: 'custom', key: c.key } : null;
}

/** «13/05/2013», «2013-05-13», «13-05-2013» o el número de serie de Excel → AAAA-MM-DD. Si no se entiende, tal cual. */
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (/^\d{5}$/.test(s)) { // serie de Excel (días desde 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return s;
}

/** Separa CSV/TSV respetando comillas. Detecta el separador (tab, punto y coma o coma). */
export function splitTable(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const first = lines[0];
  const sep = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  return lines.map((line) => {
    const out: string[] = [];
    let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

/** Tabla (con o sin encabezado) → borradores. Sin encabezado reconocible: una columna = nombre. */
export function rowsToDrafts(table: string[][], form: PlayerForm): PlayerDraft[] {
  if (table.length === 0) return [];
  const header = table[0].map((h) => mapHeader(h, form));
  const hasHeader = header.some((h) => h && h.kind === 'base' && h.key === 'full_name');
  const body = hasHeader ? table.slice(1) : table;
  const seen = new Set<string>();
  const out: PlayerDraft[] = [];
  for (const cells of body) {
    const d: PlayerDraft = { full_name: '' };
    if (!hasHeader) {
      d.full_name = (cells[0] ?? '').replace(/^\s*(?:\d+\s*[.)\-–]\s*|[-–•*·]\s*)/, '').trim();
      if (cells[1] && /^\d{1,3}$/.test(cells[1])) d.shirt_number = cells[1];
    } else {
      header.forEach((h, i) => {
        const v = (cells[i] ?? '').trim();
        if (!h || !v) return;
        if (h.kind === 'custom') { d.extra = { ...(d.extra ?? {}), [h.key]: v }; return; }
        (d as unknown as Record<string, string>)[h.key] = h.key === 'birth_date' ? normalizeDate(v) : v;
      });
    }
    d.full_name = d.full_name.replace(/\s+/g, ' ').trim();
    if (!d.full_name) continue;
    const k = d.full_name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

/** Problemas de una fila según el formulario (los mismos que rechazaría el BFF). */
export function draftProblems(d: PlayerDraft, form: PlayerForm): string[] {
  const p: string[] = [];
  for (const k of form.required) {
    const v = (d as unknown as Record<string, string | undefined>)[k];
    if (!v || !String(v).trim()) p.push(`Falta ${BASE_LABEL[k].toLowerCase()}`);
  }
  if (d.shirt_number && !/^\d{1,3}$/.test(d.shirt_number.trim())) p.push('El número debe ser de 0 a 999');
  if (d.birth_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.birth_date)) p.push('Fecha de nacimiento: usa AAAA-MM-DD o DD/MM/AAAA');
  for (const f of form.custom) {
    const v = d.extra?.[f.key];
    if (f.required && (!v || !v.trim())) p.push(`Falta «${f.label}»`);
    if (v && f.type === 'select' && !f.options?.includes(v)) p.push(`«${v}» no es una opción de «${f.label}»`);
  }
  return p;
}

/** Borrador → cuerpo para el BFF (números como número, vacíos fuera). */
export function draftToBody(d: PlayerDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { full_name: d.full_name.trim() };
  for (const k of ['nickname', 'position', 'document_number', 'birth_date', 'phone', 'photo_url'] as const) {
    const v = d[k]?.trim();
    if (v) out[k] = k === 'birth_date' ? normalizeDate(v) : v;
  }
  if (d.shirt_number?.trim()) out.shirt_number = Number(d.shirt_number.trim());
  if (d.extra && Object.keys(d.extra).length) out.extra = d.extra;
  return out;
}

/** Plantilla CSV para descargar, con los campos del formulario del torneo. */
export function templateCsv(form: PlayerForm): string {
  const cols = [...SHEET_FIELDS.map((k) => BASE_LABEL[k]), ...form.custom.map((c) => c.label)];
  return `${cols.join(',')}\nAna María Ruiz,7,Anita,Armadora,1020304050,13/05/2013,3001234567${','.repeat(form.custom.length)}\n`;
}

/** Excel (.xlsx) → tabla de texto. exceljs se carga solo cuando hace falta. */
export async function readSpreadsheet(file: File): Promise<string[][]> {
  if (/\.(csv|txt|tsv)$/i.test(file.name) || file.type === 'text/csv') return splitTable(await file.text());
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as unknown[]).slice(1).map((v) => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (v && typeof v === 'object' && 'text' in (v as object)) return String((v as { text: unknown }).text);
      if (v && typeof v === 'object' && 'result' in (v as object)) return String((v as { result: unknown }).result ?? '');
      return v == null ? '' : String(v);
    });
    rows.push(vals);
  });
  return rows;
}

/** Nombre de pila para listas impresas públicas no aplica: en lo impreso para el organizador va el nombre completo. */
export function firstName(full: string): string { return full.trim().split(/\s+/)[0] ?? ''; }
