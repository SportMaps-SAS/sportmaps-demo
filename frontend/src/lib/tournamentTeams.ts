/**
 * Equipos del torneo (internos por inscripción y rivales externos) — PURO.
 * Convierte la lista que el organizador pega (WhatsApp, Excel, notas) en equipos para
 * POST /api/v1/tournament-live/school/:id/teams/external.
 */

export interface PastedTeam { team_name: string; club_name?: string }

/** Máximo que acepta el BFF por envío. */
export const MAX_PASTE = 64;

const BULLET = /^\s*(?:\d+\s*[.)\-–]\s*|[-–•*·]\s*)/;

/**
 * Una línea = un equipo. Acepta viñetas o numeración («1. Águilas», «- Titanes») y, si viene
 * separado por tabulador, « | » o « / », la segunda parte es el club («Águilas Sub 14 | Club Águilas»).
 * Quita repetidos (sin importar mayúsculas) y líneas vacías.
 */
export function parsePastedTeams(text: string): PastedTeam[] {
  const out: PastedTeam[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(BULLET, '').trim();
    if (!line) continue;
    const parts = line.split(/\t|\s+\|\s+|\s+\/\s+/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const name = (parts[0] ?? '').slice(0, 80);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parts[1] ? { team_name: name, club_name: parts[1].slice(0, 120) } : { team_name: name });
  }
  return out;
}

/** Sigla sugerida de hasta 4 letras: iniciales («Club Águilas Doradas» → «CAD») o las primeras letras. */
export function suggestShortName(name: string): string {
  const words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3);
  return words.map((w) => w[0]).join('').slice(0, 4);
}
