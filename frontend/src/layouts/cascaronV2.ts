/**
 * Decisiones del «cascarón» (AuthLayout) que dependen de si el rol tiene V2.
 * Pura para poder probarla sin montar el layout.
 *
 *  - 34: en el celular la V2 navega con la barra inferior; el menú lateral (y su
 *    botón de hamburguesa) solo queda en escritorio. Roles sin V2 (escuela,
 *    admin, etc.) siguen con el lateral también en el celular.
 *  - 27/32: el Inicio V2 trae su propia cabecera con la escuela; la barra
 *    superior no la repite ahí.
 *  - 39: con la burbuja de Mapi visible, el final de cualquier lista tiene aire
 *    para subir por encima de ella. Celular: barra inferior (4rem) + burbuja
 *    (bottom-20 + 3.5rem) ≈ 9rem. sm+: burbuja en bottom-6, 3.5rem → 7rem.
 */
export interface CascaronV2 {
  /** Clases extra del botón del menú lateral. */
  trigger: string;
  /** ¿Se muestra la escuela (logo + nombre) en la barra superior? */
  mostrarEscuelaEnBarra: boolean;
  /** Padding inferior de <main> (lg:pb-* explícito: el lg:p-6 de <main> lo pisaría). */
  main: string;
}

export function clasesCascaronV2(o: { v2: boolean; pathname: string; fabVisible: boolean }): CascaronV2 {
  const main = o.fabVisible
    ? 'pb-[calc(9rem+env(safe-area-inset-bottom))] sm:pb-28 lg:pb-28'
    : 'pb-[calc(5rem+env(safe-area-inset-bottom))] sm:pb-6 lg:pb-6';
  return {
    trigger: o.v2 ? 'hidden md:inline-flex' : '',
    mostrarEscuelaEnBarra: !(o.v2 && o.pathname === '/dashboard'),
    main,
  };
}
