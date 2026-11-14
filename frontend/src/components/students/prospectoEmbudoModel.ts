/**
 * Línea de detalle del prospecto que pasó por el embudo del bot (lógica pura de
 * ProspectoDetalleEmbudo). null = prospecto de siempre: la fila no cambia.
 */
import type { ProspectoClasePrueba } from '@/hooks/useClasePrueba';
import { estadoDePago, fechaCortaConDia, hora12, lineaPerfil, pesos, textoRespuestas } from '@/lib/clasePruebaTextos';

export type Tono = 'ok' | 'pendiente' | 'neutro';

export interface DetalleEmbudo {
  perfil: string | null;
  agenda: string | null;
  estado: { texto: string; tono: Tono } | null;
}

/** null = el prospecto no pasó por el embudo (no se dibuja nada). */
export function detalleEmbudo(p: ProspectoClasePrueba): DetalleEmbudo | null {
  const respuestas = textoRespuestas(p.respuestas);
  const pago = estadoDePago(p.pago);
  const delEmbudo = respuestas.length > 0 || !!p.sede || !!p.grupo || !!p.profe || !!p.estado_cupo || pago != null;
  if (!delEmbudo) return null;

  const nombres = p.profe?.trim() ?? '';
  const profe = !nombres ? null : /^profes?\b/i.test(nombres) ? nombres : `${nombres.includes(',') ? 'Profes' : 'Profe'} ${nombres}`;
  // La clase agendada ya sale en la etiqueta «Clase 31 oct 08:00»; la del cupo separado no.
  const separada = p.estado_cupo === 'separado'
    ? [fechaCortaConDia(p.separado_fecha), hora12(p.separado_hora)].filter(Boolean).join(', ') || null
    : null;
  const agenda = [p.sede?.trim(), p.grupo?.trim(), profe, separada].filter(Boolean).join(' · ') || null;

  let estado: DetalleEmbudo['estado'] = null;
  if (pago === 'pagado') {
    const monto = Number(p.pago?.monto);
    estado = { texto: monto > 0 ? `Pagó ${pesos(monto)}` : 'Pagó', tono: 'ok' };
  } else if (pago === 'en_revision') {
    estado = { texto: 'Pago en revisión', tono: 'pendiente' };
  } else if (p.estado_cupo === 'separado') {
    const h = p.separado_hasta ? local(p.separado_hasta) : null;
    const hasta = h ? [fechaCortaConDia(h.fecha), hora12(h.hora)].filter(Boolean).join(', ') : '';
    estado = { texto: `Cupo separado · sin comprobante${hasta ? ` · hasta ${hasta}` : ''}`, tono: 'pendiente' };
  } else if (p.estado_cupo === 'agendada') {
    estado = { texto: 'Agendada', tono: 'neutro' };
  }

  return {
    perfil: lineaPerfil({ nacimiento: p.birth_date, sexo: p.gender, respuestas: p.respuestas }) || null,
    agenda,
    estado,
  };
}

/** «2026-11-01T02:00:00Z» → fecha y hora en el reloj de quien mira (31 oct, 21:00 en Colombia). */
function local(iso: string): { fecha: string; hora: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dos = (n: number) => String(n).padStart(2, '0');
  return { fecha: `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`, hora: `${dos(d.getHours())}:${dos(d.getMinutes())}` };
}
