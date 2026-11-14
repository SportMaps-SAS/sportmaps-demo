/**
 * Impresos del torneo (organizador): lista de equipos, nómina por equipo y carnés.
 * Listas = HTML simple en una ventana nueva + window.print() («Guardar como PDF» del navegador).
 * Carnés = el motor de Carnets Digitales (AthleteIdCard + exportCardsPdf), no uno nuevo.
 */
import type { CardData } from '@/components/cards/AthleteIdCard';
import type { CustomField, PlayerDto } from './tournamentPlayers';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PAGE_CSS = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 6px}p.sub{color:#555;margin:0 0 12px;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:8px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}
th{background:#f3f4f6}.page{page-break-after:always}.page:last-child{page-break-after:auto}.firma{margin-top:28px;font-size:12px}
@media print{body{margin:10mm}}`;

export interface PrintTeam { id: string; name: string; club_name: string | null; category: string; is_external: boolean; players?: number }

export function teamsListHtml(title: string, teams: PrintTeam[]): string {
  const byCat = new Map<string, PrintTeam[]>();
  for (const t of teams) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t]);
  const sections = [...byCat.entries()].map(([cat, list]) => `<h2>${esc(cat)} · ${list.length} equipo${list.length === 1 ? '' : 's'}</h2>
<table><thead><tr><th>#</th><th>Equipo</th><th>Club</th><th>Tipo</th><th>Jugadores</th></tr></thead><tbody>
${list.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td>${esc(t.club_name ?? '')}</td><td>${t.is_external ? 'Rival externo' : 'Inscrito'}</td><td>${t.players ?? ''}</td></tr>`).join('')}
</tbody></table>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Equipos · ${esc(title)}</title><style>${PAGE_CSS}</style></head>
<body><h1>${esc(title)}</h1><p class="sub">Lista de equipos · ${teams.length} en total</p>${sections}</body></html>`;
}

export interface RosterSheet { team: string; category: string; club: string | null; players: PlayerDto[] }

/** Nómina por equipo (una hoja por equipo), con documento: es un impreso del ORGANIZADOR. */
export function rosterHtml(title: string, sheets: RosterSheet[], opts: { showDocument?: boolean } = {}): string {
  const doc = opts.showDocument !== false;
  const pages = sheets.map((s) => `<section class="page"><h1>${esc(s.team)}</h1>
<p class="sub">${esc(title)} · ${esc(s.category)}${s.club ? ` · ${esc(s.club)}` : ''} · ${s.players.length} jugador${s.players.length === 1 ? '' : 'es'}</p>
<table><thead><tr><th>#</th><th>N.º</th><th>Nombre</th><th>Posición</th>${doc ? '<th>Documento</th>' : ''}<th>Nacimiento</th><th>Firma</th></tr></thead><tbody>
${s.players.map((p, i) => `<tr><td>${i + 1}</td><td>${p.shirt_number ?? ''}</td><td>${esc(p.full_name)}${p.suspended ? ' (suspendido)' : ''}</td><td>${esc(p.position ?? '')}</td>${doc ? `<td>${esc(p.document_number ?? '')}</td>` : ''}<td>${esc(p.birth_date ?? '')}</td><td style="width:120px"></td></tr>`).join('')}
</tbody></table><p class="firma">Delegado: ______________________________ &nbsp;&nbsp; Firma: ____________________</p></section>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Nómina · ${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${pages}</body></html>`;
}

/** Abre el impreso y lanza el diálogo de impresión (desde ahí también se guarda en PDF). */
export function printHtml(html: string): boolean {
  const w = window.open('', '_blank', 'noopener=no,width=900,height=700');
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* el usuario puede imprimir a mano */ } }, 300);
  return true;
}

export type CardField = 'shirt_number' | 'nickname' | 'document_number' | 'position' | 'phone';
export interface TournamentCardConfig { subtitle: string | null; color: string | null; fields: CardField[]; public_photo: boolean }
export const CARD_FIELD_LABEL: Record<CardField, string> = { shirt_number: 'Número', nickname: 'Apodo', document_number: 'Documento', position: 'Posición', phone: 'Teléfono' };

export interface TournamentCard { player: PlayerDto; team_name: string | null; team_logo_url: string | null; token: string; validate_url: string }

/** Valor de un campo propio de la ficha, legible en el carné («Sí»/«No», fecha DD/MM/AAAA). */
export function customValue(f: Pick<CustomField, 'type'>, v: unknown): string {
  if (v == null || v === '') return '';
  if (f.type === 'bool') return v === true ? 'Sí' : 'No';
  if (f.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split('-').reverse().join('/');
  return String(v);
}

/**
 * Carné de jugador del torneo con el mismo modelo de datos de Carnets Digitales.
 * `custom` = campos propios del formulario (EPS, talla…): van al REVERSO, junto a los de emergencia.
 */
export function toCardData(c: TournamentCard, cfg: TournamentCardConfig, t: { id: string; title: string; logo_url: string | null }, custom: CustomField[] = []): CardData {
  const rows = cfg.fields
    .filter((f) => f !== 'document_number')
    .map((f) => ({ label: CARD_FIELD_LABEL[f], value: c.player[f] == null ? '' : String(c.player[f]) }));
  return {
    found: true, status: 'active', viewer: 'staff', qr_token: c.token,
    school: { id: t.id, name: t.title, logo_url: t.logo_url },
    template: {
      id: `torneo-${t.id}`, name: 'Carné del torneo', accent_color: cfg.color ?? '#1E40AF', layout: 'classic',
      header_text: cfg.subtitle ?? 'Carné de jugador', footer_text: 'Escanea para validar en cancha',
      show_fields: { photo: true, team: true, doc_number: cfg.fields.includes('document_number'), branch: false, plan: false, valid_until: false, fee_status: false },
    },
    athlete: {
      kind: 'unregistered', full_name: c.player.full_name, avatar_url: c.player.photo_url,
      doc_type: 'Doc.', doc_number: cfg.fields.includes('document_number') ? c.player.document_number : null,
    },
    team_name: c.team_name,
    extra_rows: rows,
    back_rows: custom
      .map((f) => ({ label: f.label, value: customValue(f, c.player.extra?.[f.key]) }))
      .filter((r) => r.value !== ''),
  };
}
