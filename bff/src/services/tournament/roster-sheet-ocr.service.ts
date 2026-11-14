/**
 * roster-sheet-ocr.service — foto de la NÓMINA de un equipo de torneo (lista de jugadores impresa o
 * escrita a mano) → filas para revisar. Antes se reutilizaba el OCR de planillas de ASISTENCIA
 * (attendance-sheet-ocr.service), cuyo prompt pide una cuadrícula de días y marca
 * `is_attendance_sheet:false` en cualquier otra hoja: una nómina impresa nítida volvía sin filas y
 * el BFF respondía 422 `sin_nombres` (E2E 2026-10-28, B4).
 *
 * Misma cadena de proveedores y modelos que attendance-sheet-ocr / enrollment-ocr (Gemini → OpenAI →
 * Groq con fallback, mismo `OCR_PROVIDER`), otro prompt y otro schema. El LLM SOLO transcribe; la
 * normalización (dorsal, documento, fecha) es determinista y vive acá. Nada se guarda sin revisión.
 */

export interface RosterSheetRow {
  name: string;
  shirt_number: string | null;
  document_number: string | null;
  /** AAAA-MM-DD o null si no se pudo leer una fecha válida. */
  birth_date: string | null;
  position: string | null;
  /** Nombre tachado / «Retirado(a)». */
  struck: boolean;
}

export interface RosterSheetResult {
  isRoster: boolean;
  title: string | null;
  team: string | null;
  rows: RosterSheetRow[];
  rawResponse?: string;
  provider: string;
}

const SYSTEM_PROMPT = `Eres un transcriptor de NOMINAS (listas de jugadores) de equipos deportivos colombianos.
La hoja puede ser impresa, una tabla de Excel fotografiada o escrita a mano; puede venir rotada o con perspectiva.
Devuelve UNICAMENTE un JSON valido, sin texto adicional, con este schema:
{
  "is_roster": true | false,
  "title": "<titulo impreso de la hoja>" | null,
  "team": "<nombre del equipo si aparece>" | null,
  "players": [{
    "name": "<nombre completo tal como esta escrito>",
    "shirt_number": "<dorsal / numero de camiseta>" | null,
    "document_number": "<documento de identidad (TI, CC, RC...) solo el numero>" | null,
    "birth_date": "<fecha de nacimiento tal como esta escrita>" | null,
    "position": "<posicion o rol si aparece>" | null,
    "struck": true | false
  }]
}
Reglas:
- Una entrada en players por cada jugador (fila). NO incluyas la fila de encabezados ni firmas, entrenadores o delegados.
- Transcribe SOLO lo que ves. Si una columna no existe en la hoja, pon null. No inventes datos.
- name: copialo tal cual (puede venir APELLIDOS NOMBRES).
- shirt_number: la columna "N.", "No.", "#", "Dorsal" o "Camiseta". No confundas el numero de fila con el dorsal si hay ambas columnas.
- document_number: solo digitos/letras del documento, sin puntos ni el tipo.
- birth_date: copia la fecha como esta (ej. 2012-03-04, 04/03/2012).
- struck: true si el nombre esta tachado o dice "Retirado/a".
- is_roster: false solo si la imagen claramente no es una lista de personas (comprobante de pago, foto de un partido, etc.).`;

const USER_PROMPT = 'Transcribe esta nomina de jugadores:';

// ─────────────────────────────────────────────────────────────────────────────
// Proveedores (mismo patrón y modelos que attendance-sheet-ocr.service.ts)
// ─────────────────────────────────────────────────────────────────────────────
async function viaGroq(b64: string, mime: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY no configurada');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.GROQ_OCR_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      temperature: 0, max_tokens: 6000, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [{ type: 'text', text: USER_PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

async function viaOpenAI(b64: string, mime: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no configurada');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', temperature: 0, max_tokens: 6000, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [{ type: 'text', text: USER_PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

async function viaGemini(b64: string, mime: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');
  // Alias, no versión fija (Google retira versiones puntuales de Flash sin aviso).
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST', signal: AbortSignal.timeout(45_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: USER_PROMPT }, { inlineData: { mimeType: mime, data: b64 } }] }],
      generationConfig: {
        temperature: 0,
        // Sin esto los tokens de "thinking" comen maxOutputTokens y el JSON sale truncado.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalización determinista
// ─────────────────────────────────────────────────────────────────────────────
const str = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() !== '' && v.trim().toLowerCase() !== 'null' ? v.replace(/\s+/g, ' ').trim() : null;
};

/** Dorsal: 0–999, sin «#» ni «No.». */
export function normShirt(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(?:#|n[o°º.]*\s*)?\s*(\d{1,3})$/i.exec(s);
  return m ? String(Number(m[1])) : null;
}

/** Documento: sin puntos, espacios ni guiones; 4 a 20 caracteres alfanuméricos. */
export function normDocument(v: unknown): string | null {
  const s = str(v)?.replace(/^(ti|cc|rc|ce|pa|pp|nuip)\.?\s*/i, '').replace(/[.\s-]/g, '');
  return s && /^[0-9A-Za-z]{4,20}$/.test(s) ? s : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const validYmd = (y: number, m: number, d: number) => {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Fecha de nacimiento → AAAA-MM-DD. Acepta AAAA-MM-DD, AAAA/MM/DD y DD/MM/AAAA (orden colombiano). */
export function normBirthDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) { const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) { const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]; return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null; }
  return null;
}

export function parseRosterJson(content: string, provider: string): RosterSheetResult {
  try {
    const data = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim());
    const list = Array.isArray(data.players) ? data.players : Array.isArray(data.rows) ? data.rows : [];
    const rows: RosterSheetRow[] = list
      .filter((r: any) => r && typeof r === 'object' && str(r.name ?? r.full_name))
      .map((r: any) => ({
        name: str(r.name ?? r.full_name)!,
        shirt_number: normShirt(r.shirt_number ?? r.number),
        document_number: normDocument(r.document_number ?? r.document),
        birth_date: normBirthDate(r.birth_date),
        position: str(r.position)?.slice(0, 40) ?? null,
        struck: r.struck === true,
      }));
    return { isRoster: data.is_roster !== false, title: str(data.title), team: str(data.team), rows, rawResponse: content, provider };
  } catch {
    console.warn(`[RosterSheetOCR] ${provider}: JSON no parseable (¿truncado?). len=${content.length}`);
    return { isRoster: true, title: null, team: null, rows: [], rawResponse: content, provider };
  }
}

function groqPuedeVer(): boolean { return Boolean(process.env.GROQ_OCR_MODEL); }

export async function extractRosterSheet(base64Image: string, mimeType = 'image/jpeg'): Promise<RosterSheetResult> {
  const order = (process.env.OCR_PROVIDER || 'gemini').toLowerCase();
  const providers: Record<string, () => Promise<string>> = {
    groq: () => viaGroq(base64Image, mimeType),
    openai: () => viaOpenAI(base64Image, mimeType),
    gemini: () => viaGemini(base64Image, mimeType),
  };
  const tryOrder = [order, 'gemini', 'openai', 'groq']
    .filter((v, i, a) => a.indexOf(v) === i && providers[v])
    .filter((v) => v !== 'groq' || groqPuedeVer());
  let lastErr: Error | null = null;
  for (const name of tryOrder) {
    try {
      return parseRosterJson(await providers[name](), name);
    } catch (err: any) {
      lastErr = err;
      console.warn(`[RosterSheetOCR] ${name} fallo, intentando siguiente:`, err.message);
    }
  }
  throw lastErr ?? new Error('Todos los providers de OCR fallaron');
}
