/**
 * Estado de cuenta imprimible CON LA MARCA DE LA ESCUELA: logo, colores, mes a mes
 * con fecha límite, fecha de pago, cómo pagó, puntualidad y asistencia. Es el
 * documento que la escuela o la familia guarda como PDF (Imprimir → Guardar como
 * PDF). Se arma 100 % en el navegador: ventana nueva + window.print(), como el
 * anterior (`statementPrint.ts`), que sigue sirviendo a la pantalla clásica.
 *
 * Modelo visual: el ejemplo de Besser (encabezado de marca, raya del color
 * principal y del secundario, cuatro cifras, tabla mes a mes, asistencia con
 * barras). Plan: docs/specs/estado-de-cuenta-envio-a-familias.md §4.3.
 *
 * Reglas:
 *   · Los montos que importan (facturado, pagado, por pagar, mora) son los de la
 *     RPC (`statement.summary`); la tabla muestra el dato de cada cobro, no suma nada.
 *   · Nunca sale la ruta de un comprobante ni un enlace: solo si hay o no.
 *   · «Sin registrar» (medio de pago) solo lo ve la escuela; la familia no.
 *   · Todo texto variable va escapado (va a `document.write`). Los colores solo
 *     entran si son hex de 6 dígitos; el logo solo si es https.
 */
import { formatCurrency } from '@/lib/utils';
import { textoSobre } from '@/lib/colorContraste';
import {
  agruparPorMes, asistenciaPorMes, comoPago, estadoCobro, puntualidad, resumenCuenta, tituloCobro, valorCobro,
  abonoDe, textoAsistencia, type AsistenciaMes, type CobroCuenta,
} from './estadoCuentaModel';
import type { StatementData } from './statementPrint';

export interface MarcaEscuela {
  nombre: string | null;
  logoUrl: string | null;
  colorPrimario: string;
  colorSecundario: string;
  /** Fondo del ícono (el que el generador eligió mirando el logo). Si viene, es el fondo del encabezado. */
  fondoLogo?: string | null;
  mostrarMarcaSportmaps: boolean;
}

export const MARCA_SPORTMAPS: MarcaEscuela = {
  nombre: null, logoUrl: null, colorPrimario: '#248223', colorSecundario: '#FB9F1E', fondoLogo: null, mostrarMarcaSportmaps: true,
};

export interface EntradaEstadoImprimible {
  statement: StatementData;
  cobros: CobroCuenta[];
  months: number;
  marca: MarcaEscuela;
  /** `escuela` ve «Sin registrar» y las notas del medio de pago; `familia` no. */
  modo: 'escuela' | 'familia';
  now?: Date;
}

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: string | null | undefined, porDefecto: string) => (v && HEX.test(v) ? v : porDefecto);
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dia = (d: string) => new Date(d.length <= 10 ? `${d}T00:00:00` : d);
const fechaCorta = (d: string | null, now: Date) => {
  if (!d) return '—';
  const x = dia(d);
  return `${x.getDate()} ${MES_CORTO[x.getMonth()]}${x.getFullYear() !== now.getFullYear() ? ` ${x.getFullYear()}` : ''}`;
};
const fechaLarga = (now: Date) => `${now.getDate()} de ${MES_LARGO[now.getMonth()]} de ${now.getFullYear()}`;

/** Solo https: un logo que no lo sea no se carga en una ventana que luego se imprime. */
const logoSeguro = (u: string | null | undefined) => (u && /^https:\/\//i.test(u) ? u : null);

/** Mes largo capitalizado sin «de»: «Septiembre 2026». */
const mesCorto = (titulo: string) => titulo.replace(' de ', ' ');

const CHIP: Record<string, { bg: string; fg: string }> = {
  ok: { bg: '#d1fae5', fg: '#065f46' },
  aviso: { bg: '#ffedd5', fg: '#9a3412' },
  info: { bg: '#dbeafe', fg: '#1e40af' },
  peligro: { bg: '#fde8e8', fg: '#b91c1c' },
  neutro: { bg: '#eef2ee', fg: '#5b7a5b' },
};

const inicio = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function construirEstadoImprimible(e: EntradaEstadoImprimible): string {
  const now = e.now ?? new Date();
  const m = e.marca;
  const primario = hex(m.colorPrimario, MARCA_SPORTMAPS.colorPrimario);
  const secundario = hex(m.colorSecundario, MARCA_SPORTMAPS.colorSecundario);
  const fondo = m.fondoLogo && HEX.test(m.fondoLogo) ? m.fondoLogo : null;
  const bandaFondo = fondo ?? '#ffffff';
  const bandaTexto = fondo ? textoSobre(fondo) : '#111111';
  const logo = logoSeguro(m.logoUrl);
  const escuela = esc(m.nombre ?? 'SportMaps');
  const nombre = e.statement.athlete_name;
  const esEscuela = e.modo === 'escuela';

  // ── Filas: los meses del más viejo al más nuevo ──
  const meses = [...agruparPorMes(e.cobros, now)].reverse();
  let aTiempo = 0;
  let pagados = 0;
  const filas = meses.flatMap((mes) => [...mes.cobros].sort((a, b) => String(a.due_date ?? '').localeCompare(String(b.due_date ?? ''))).map((c) => {
    const est = estadoCobro(c, now);
    const punt = puntualidad(c, now, formatCurrency);
    const como = ['paid', 'approved', 'partial', 'awaiting_approval'].includes(c.status) ? comoPago(c) : null;
    const mostrarComo = !!como && (esEscuela || !como.sinRegistrar);
    const abono = abonoDe(c);
    if (c.status === 'paid' || c.status === 'approved') {
      pagados++;
      if (c.due_date && c.payment_date && inicio(dia(c.payment_date)) <= inicio(dia(c.due_date))) aTiempo++;
    }
    const cobrado = Number(c.amount || 0);
    const pagadoV = c.status === 'paid' || c.status === 'approved' ? valorCobro(c) : c.status === 'partial' ? Number(c.amount_paid || 0) : 0;
    const saldo = abono ? abono.falta : (['pending', 'overdue', 'rejected', 'failed'].includes(c.status) || (c.status === 'glosado') ? cobrado : 0);
    const fechaPago = c.payment_date
      ? `${fechaCorta(c.payment_date, now)}${c.status === 'partial' ? '<small>abono</small>' : c.status === 'awaiting_approval' ? '<small>comprobante enviado</small>' : ''}`
      : (['pending', 'overdue', 'rejected', 'failed'].includes(c.status) ? `<span class="rojo">Sin pagar</span>` : '—');
    const tono = CHIP[est.tono] ?? CHIP.neutro;
    const puntTexto = punt ? `<small class="${punt.tono === 'peligro' ? 'rojo' : punt.tono === 'ok' ? 'verde' : 'naranja'}">${esc(punt.label)}</small>` : '';
    const sinFechaDePago = (c.status === 'paid' || c.status === 'approved') && !c.payment_date;
    return `
      <tr>
        <td><b>${esc(mesCorto(mes.titulo))}</b><small>${esc(tituloCobro(c, nombre).replace(/\s*·.*$/, '') || 'Cobro')}</small></td>
        <td>${esc(fechaCorta(c.due_date, now))}</td>
        <td>${sinFechaDePago ? '<small>sin fecha registrada</small>' : fechaPago}</td>
        <td>${mostrarComo && como ? `${esc(como.label)}${esEscuela && como.nota ? `<small>${esc(como.nota)}</small>` : ''}` : '—'}</td>
        <td class="r">${esc(formatCurrency(cobrado))}</td>
        <td class="r">${pagadoV > 0 ? esc(formatCurrency(pagadoV)) : '—'}</td>
        <td class="r">${saldo > 0 ? `<b>${esc(formatCurrency(saldo))}</b>` : '—'}</td>
        <td><span class="chip" style="background:${tono.bg};color:${tono.fg}">${esc(est.label)}</span>${puntTexto}</td>
      </tr>`;
  })).join('');

  // ── Asistencia por mes ──
  const asist = [...asistenciaPorMes(e.statement.events).entries()].sort(([a], [b]) => a.localeCompare(b));
  const totalAsist: AsistenciaMes = asist.reduce((t, [, a]) => ({
    asistio: t.asistio + a.asistio, tarde: t.tarde + a.tarde, excusada: t.excusada + a.excusada, falto: t.falto + a.falto, total: t.total + a.total,
  }), { asistio: 0, tarde: 0, excusada: 0, falto: 0, total: 0 });
  const barra = (a: AsistenciaMes) => {
    const p = (n: number) => (a.total ? (n / a.total) * 100 : 0).toFixed(2);
    return `<span class="bar"><i class="p" style="width:${p(a.asistio)}%"></i><i class="e" style="width:${p(a.excusada)}%"></i><i class="f" style="width:${p(a.falto)}%"></i></span>`;
  };
  const filasAsist = asist.map(([k, a]) => {
    const [y, mm] = k.split('-').map(Number);
    return `<div class="fila-a"><span class="m">${esc(`${MES_LARGO[mm - 1][0].toUpperCase()}${MES_LARGO[mm - 1].slice(1)} ${y}`)}</span>${barra(a)}<span class="t"><b>${esc(textoAsistencia(a).split(' · ')[0])}</b>${esc(textoAsistencia(a).includes(' · ') ? ` · ${textoAsistencia(a).split(' · ').slice(1).join(' · ')}` : '')}</span></div>`;
  }).join('');
  const pct = totalAsist.total ? Math.round((totalAsist.asistio / totalAsist.total) * 100) : 0;

  // ── Arriba: la frase y las cifras (las de la RPC) ──
  const resumen = resumenCuenta(nombre, Number(e.statement.summary.total_open || 0), e.cobros, formatCurrency, now);
  const debe = Number(e.statement.summary.total_open || 0);
  const sub = esEscuela ? resumen.subtitulo?.replace(' Te avisamos cuando la escuela lo apruebe.', '') : resumen.subtitulo;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Estado de cuenta — ${esc(nombre)}</title>
<style>
  :root { --p: ${primario}; --s: ${secundario}; --ink: #111827; --mute: #6b7280; --line: #e5e7eb; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @page { size: Letter; margin: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; line-height: 1.45; color: var(--ink); background: #fff; }
  .band { background: ${bandaFondo}; color: ${bandaTexto}; padding: 18px 44px; display: flex; align-items: center; gap: 20px; }
  .band img { height: 84px; width: auto; display: block; }
  .band .club { font-size: 20px; font-weight: 700; letter-spacing: .03em; }
  .band .doc { color: var(--s); font-size: 14px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; }
  .band .per { font-size: 11px; opacity: .85; margin-top: 3px; }
  .stripe { height: 7px; background: var(--p); } .stripe2 { height: 3px; background: var(--s); }
  .body { padding: 20px 44px 8px; display: flex; flex-direction: column; gap: 14px; }
  .who { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; }
  .who .n { font-size: 24px; font-weight: 700; line-height: 1.15; }
  .who .m { color: var(--mute); font-size: 12px; margin-top: 2px; }
  .owe { text-align: right; } .owe .k { font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--p); }
  .owe .v { font-size: 28px; font-weight: 700; line-height: 1.1; } .owe .s { font-size: 12px; font-weight: 600; color: #b91c1c; }
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .stat { border: 1px solid var(--line); border-top: 3px solid var(--ink); border-radius: 10px; padding: 8px 11px; }
  .stat.r { border-top-color: var(--p); } .stat .k { font-size: 10px; color: var(--mute); } .stat .v { font-size: 14.5px; font-weight: 700; white-space: nowrap; }
  h3 { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; display: flex; align-items: center; gap: 10px; }
  h3::before { content: ""; width: 18px; height: 4px; border-radius: 2px; background: var(--p); } h3::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--mute); text-align: left; padding: 6px 7px; border-bottom: 2px solid var(--ink); }
  th.r, td.r { text-align: right; }
  td { padding: 7px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 11.5px; }
  tr { page-break-inside: avoid; } td small { display: block; color: var(--mute); font-size: 10px; }
  td small.rojo, .rojo { color: #b91c1c; font-weight: 600; } td small.verde { color: #065f46; font-weight: 600; } td small.naranja { color: #9a3412; font-weight: 600; }
  .chip { display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: 10px; font-weight: 600; white-space: nowrap; }
  .att { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .fila-a { display: grid; grid-template-columns: 112px 1fr 290px; gap: 12px; align-items: center; font-size: 11px; page-break-inside: avoid; }
  .fila-a .m { font-weight: 600; } .fila-a .t { color: #374151; } .fila-a .t b { color: var(--ink); }
  .bar { display: flex; height: 11px; border-radius: 6px; overflow: hidden; background: var(--line); } .bar i { display: block; height: 100%; }
  .bar .p { background: var(--ink); } .bar .e { background: var(--s); } .bar .f { background: var(--p); }
  .key { display: flex; gap: 14px; font-size: 10px; color: var(--mute); margin-top: 4px; } .key i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 4px; }
  .foot { margin: 14px 44px 20px; border-top: 2px solid var(--ink); padding-top: 8px; display: flex; justify-content: space-between; font-size: 9.5px; color: var(--mute); }
  .foot b { color: var(--ink); }
</style></head><body>
  <div class="band">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div><div class="club">${escuela}</div><div class="doc">Estado de cuenta</div><div class="per">Últimos ${e.months} ${e.months === 1 ? 'mes' : 'meses'} · generado el ${esc(fechaLarga(now))}</div></div>
  </div>
  <div class="stripe"></div><div class="stripe2"></div>
  <div class="body">
    <div class="who">
      <div><div class="n">${esc(nombre)}</div>${sub ? `<div class="m">${esc(sub)}</div>` : ''}</div>
      <div class="owe"><div class="k">Saldo pendiente</div><div class="v">${esc(formatCurrency(debe))}</div></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Facturado (histórico)</div><div class="v">${esc(formatCurrency(e.statement.summary.total_expected))}</div></div>
      <div class="stat"><div class="k">Pagado</div><div class="v">${esc(formatCurrency(e.statement.summary.total_settled))}</div></div>
      <div class="stat r"><div class="k">Por pagar</div><div class="v">${esc(formatCurrency(debe))}</div></div>
      <div class="stat"><div class="k">Pagos a tiempo</div><div class="v">${pagados ? `${aTiempo} de ${pagados}` : '—'}</div></div>
      <div class="stat"><div class="k">Asistencia</div><div class="v">${totalAsist.total ? `${totalAsist.asistio} de ${totalAsist.total} clases` : '—'}</div></div>
    </div>
    <div>
      <h3>Mes a mes</h3>
      ${filas ? `<table><thead><tr><th>Mes</th><th>Fecha límite</th><th>Fecha de pago</th><th>Cómo pagó</th><th class="r">Cobrado</th><th class="r">Pagado</th><th class="r">Saldo</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table>`
        : '<p style="margin-top:8px;color:#6b7280">Todavía no hay cobros para mostrar.</p>'}
    </div>
    ${filasAsist ? `<div><h3>Asistencia mes a mes</h3><div class="att">${filasAsist}
      <div class="fila-a" style="border-top:2px solid var(--ink);padding-top:6px"><span class="m">Total</span>${barra(totalAsist)}<span class="t"><b>Asistió a ${totalAsist.asistio} de ${totalAsist.total} clases (${pct} %)</b></span></div></div>
      <div class="key"><span><i style="background:var(--ink)"></i>Asistió</span><span><i style="background:var(--s)"></i>Excusada</span><span><i style="background:var(--p)"></i>Falta</span></div></div>` : ''}
  </div>
  <div class="foot"><span>Estado de cuenta de <b>${escuela}</b>. El saldo y las cifras de arriba son las del sistema a la fecha de generación.</span><span>${m.mostrarMarcaSportmaps ? 'Powered by SportMaps' : ''}</span></div>
</body></html>`;
}

/**
 * Abre la ventana de impresión con el documento. Espera a que cargue el logo
 * antes de imprimir. Devuelve false si el navegador bloqueó la ventana: quien
 * llama decide cómo avisarle a la persona.
 */
export function imprimirEstadoConMarca(entrada: EntradaEstadoImprimible): boolean {
  let win: Window | null = null;
  try { win = window.open('', '_blank'); } catch { win = null; }
  if (!win) return false;
  win.document.write(construirEstadoImprimible(entrada));
  win.document.close();
  const w = win;
  let impreso = false;
  const imprimir = () => {
    if (impreso) return; // la carga del logo y el tope de tiempo no deben abrir dos diálogos
    impreso = true;
    try { w.print(); } catch { /* algunos visores bloquean print(): queda la ventana */ }
  };
  const imgs = Array.from(w.document.images);
  if (imgs.every((i) => i.complete)) { setTimeout(imprimir, 300); return true; }
  let esperando = imgs.filter((i) => !i.complete).length;
  const listo = () => { esperando -= 1; if (esperando <= 0) setTimeout(imprimir, 150); };
  imgs.filter((i) => !i.complete).forEach((i) => { i.addEventListener('load', listo); i.addEventListener('error', listo); });
  setTimeout(imprimir, 3000); // tope: si el logo no carga, se imprime igual
  return true;
}
