import { describe, expect, it } from 'vitest';
import { clasesCascaronV2 } from './cascaronV2';

describe('clasesCascaronV2', () => {
  it('V2: sin hamburguesa en el celular (la barra inferior manda), sí en escritorio', () => {
    expect(clasesCascaronV2({ v2: true, pathname: '/teams', fabVisible: true }).trigger).toBe('hidden md:inline-flex');
  });

  it('roles sin V2 (escuela, admin…) conservan el menú lateral en el celular', () => {
    expect(clasesCascaronV2({ v2: false, pathname: '/dashboard', fabVisible: true }).trigger).toBe('');
  });

  it('la escuela no se repite en la barra en el Inicio V2; en las demás pantallas sí', () => {
    expect(clasesCascaronV2({ v2: true, pathname: '/dashboard', fabVisible: true }).mostrarEscuelaEnBarra).toBe(false);
    expect(clasesCascaronV2({ v2: true, pathname: '/teams', fabVisible: true }).mostrarEscuelaEnBarra).toBe(true);
    expect(clasesCascaronV2({ v2: false, pathname: '/dashboard', fabVisible: true }).mostrarEscuelaEnBarra).toBe(true);
  });

  it('con la burbuja de Mapi visible el final de las listas sube por encima de ella; oculta, el aire normal', () => {
    expect(clasesCascaronV2({ v2: false, pathname: '/x', fabVisible: true }).main).toContain('9rem');
    expect(clasesCascaronV2({ v2: false, pathname: '/x', fabVisible: true }).main).toContain('sm:pb-28');
    expect(clasesCascaronV2({ v2: false, pathname: '/x', fabVisible: true }).main).toContain('lg:pb-28');
    const oculta = clasesCascaronV2({ v2: true, pathname: '/x', fabVisible: false }).main;
    expect(oculta).toContain('5rem');
    expect(oculta).toContain('sm:pb-6');
  });
});
