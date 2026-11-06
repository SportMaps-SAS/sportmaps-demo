/**
 * A quién se le pagó, según lo que leyó el OCR del comprobante (destinationName +
 * destination). Pensado para Dynasty, que recibe en tres lugares: la cuenta de
 * Giovanni, la llave de Milena y las cuentas del club. En otras escuelas ningún
 * destino calza y la etiqueta no sale (devuelve null).
 */
export type DestinoComprobante = { clave: 'giovani' | 'milena' | 'club' | 'otro'; etiqueta: string };

const plano = (s: string | null | undefined) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function destinoDelComprobante(nombre: string | null | undefined, cuenta: string | null | undefined): DestinoComprobante | null {
  const n = plano(nombre);
  const c = String(cuenta ?? '').replace(/\D/g, '');
  if (!n && !c) return null;
  if (/giovan|hector.*avila|avila.*saldana/.test(n) || c.endsWith('5309')) return { clave: 'giovani', etiqueta: 'Giovani' };
  if (/milena|sandra.*barrera|san mil bar|sandra dinasty/.test(n) || c.endsWith('8969') || c.endsWith('4471')) return { clave: 'milena', etiqueta: 'Llave de Milena' };
  if (/dynasty|dinasty|dyn |boleivol|clu dep|club deportivo/.test(n + ' ') || /(5111|3578|1411|9230)$/.test(c)) return { clave: 'club', etiqueta: 'Cuenta del club' };
  return null;
}
