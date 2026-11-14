import { describe, it, expect } from 'vitest';
import { getNavigationByRole, getVendorNavGroup } from '@/config/navigation';
import {
  BARRA_COACH_PRODUCCION, ENTRADAS_MAS, MENU_COACH_CLASICO, RUTAS_EN_BARRA_COACH, RUTAS_UNIDAS, RUTA_PIZARRA,
  aplanar, armarMas, menuClasicoFiltrado, rutasDeMas,
} from './coachMasModel';

// Lo mismo que arma CoachMorePage: menú clásico podado + menú actual del coach.
const menuCon = (mod: (k: string) => boolean) => [...menuClasicoFiltrado(mod), ...getNavigationByRole('coach', () => true, mod as never, true)];
const todoPrendido = () => menuCon(() => true);

describe('«Más» del entrenador: ninguna entrada del coach se pierde', () => {
  it('cada ruta del menú lateral del coach queda en la barra V2 o en «Más»', () => {
    const menu = todoPrendido();
    const enMas = new Set(rutasDeMas(armarMas({ menu })));
    const rutas = [...MENU_COACH_CLASICO.map((i) => i.href), ...aplanar(menu.flatMap((g) => g.items)).map((i) => i.href)].filter((r) => r !== '/mas');
    expect(rutas.length).toBeGreaterThan(10);
    // Una ruta unida a otra fila cuenta si la fila destino está en «Más».
    const perdidas = rutas.filter((r) => !RUTAS_EN_BARRA_COACH[r] && !enMas.has(r) && !enMas.has(RUTAS_UNIDAS[r]));
    expect(perdidas).toEqual([]);
  });

  it('cada pestaña de la barra inferior de producción del coach sigue alcanzable', () => {
    const enMas = new Set(rutasDeMas(armarMas({ menu: todoPrendido() })));
    for (const r of BARRA_COACH_PRODUCCION) expect(RUTAS_EN_BARRA_COACH[r] || enMas.has(r) || enMas.has(RUTAS_UNIDAS[r])).toBeTruthy();
  });

  it('Mensajes, Anuncios y Encuestas quedan en «Comunicación» (decisión 1; antes «Se usan poco»)', () => {
    const grupos = armarMas({ menu: todoPrendido() });
    const g = grupos.find((x) => x.grupo === 'Comunicación');
    expect(g?.filas.map((f) => f.to)).toEqual(['/messages', '/announcements', '/dashboard/polls']);
    expect(grupos.some((x) => (x.grupo as string) === 'Se usan poco')).toBe(false);
  });

  it('«Pizarra» va primera en «Entrenamiento», aunque el menú no la traiga', () => {
    for (const menu of [todoPrendido(), [{ items: [] }]]) {
      const g = armarMas({ menu }).find((x) => x.grupo === 'Entrenamiento');
      expect(g?.filas[0]).toMatchObject({ label: 'Pizarra', to: RUTA_PIZARRA });
    }
  });

  it('«Mi perfil» y «Mis datos y configuración» son una sola fila', () => {
    const cuenta = armarMas({ menu: todoPrendido() }).find((x) => x.grupo === 'Cuenta')!;
    const rutas = cuenta.filas.map((f) => f.to);
    expect(rutas).toContain('/settings');
    expect(rutas).not.toContain('/profile');
    expect(cuenta.filas.find((f) => f.to === '/settings')?.label).toBe('Mi perfil y configuración');
    // «/profile» no se pierde ni cae en «Otros»: queda unida a Configuración.
    expect(armarMas({ menu: todoPrendido() }).some((x) => x.grupo === 'Otros' && x.filas.some((f) => f.to === '/profile'))).toBe(false);
  });

  it('subtítulos: Calendario y Agenda se distinguen; los informes dicen qué son', () => {
    expect(ENTRADAS_MAS['/coach-plans'].nota).toBe('Citas 1 a 1');
    expect(ENTRADAS_MAS['/calendar'].nota).toBeTruthy();
    expect(ENTRADAS_MAS['/informe-mensual'].nota).toBeTruthy();
    expect(ENTRADAS_MAS['/coach-reports'].nota).toBeTruthy();
  });

  it('respeta el moduleKey: con la agenda apagada no aparece «Agenda y citas»', () => {
    const menu = menuCon((k) => k !== 'gestion_deportiva_disponibilidad_coach');
    const rutas = rutasDeMas(armarMas({ menu }));
    expect(rutas).not.toContain('/coach-plans');
    expect(rutasDeMas(armarMas({ menu: todoPrendido() }))).toContain('/coach-plans');
  });

  it('«Mis servicios» solo si los activó; ayuda, cuenta y cambiar de escuela/rol', () => {
    const sinServicios = armarMas({ menu: todoPrendido() });
    expect(sinServicios.some((g) => g.grupo === 'Mis servicios')).toBe(false);
    expect(sinServicios.flatMap((g) => g.filas).some((f) => f.to === '/elegir-rol')).toBe(false);

    const servicios = getVendorNavGroup({ canSellProducts: false, canSellServices: true, verificationStatus: 'verified', storeEnabled: false });
    const con = armarMas({ menu: todoPrendido(), servicios, whatsapp: 'https://wa.me/573000000000', puedeCambiar: true });
    const filas = con.flatMap((g) => g.filas);
    expect(con.find((g) => g.grupo === 'Mis servicios')?.filas[0]).toMatchObject({ label: 'Mi tienda y servicios', to: '/vendor/dashboard' });
    expect(filas.map((f) => f.to ?? f.href ?? f.accion)).toEqual(expect.arrayContaining([
      'https://wa.me/573000000000', 'mapi', '/ayuda', '/notifications', '/settings', '/elegir-rol', 'salir',
    ]));
    expect(con[con.length - 1].grupo).toBe('Cuenta');
    expect(con[con.length - 1].filas.at(-1)).toMatchObject({ label: 'Cerrar sesión', peligro: true });
  });

  it('una ruta nueva del menú que no conocemos no se pierde: cae en «Otros»', () => {
    const menu = [{ items: [{ title: 'Módulo nuevo', href: '/algo-nuevo' }] }];
    const g = armarMas({ menu }).find((x) => x.grupo === 'Otros');
    expect(g?.filas).toEqual([{ label: 'Módulo nuevo', to: '/algo-nuevo' }]);
  });
});
