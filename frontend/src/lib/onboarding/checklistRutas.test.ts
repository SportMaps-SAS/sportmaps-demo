// ============================================================================
// Contrato: cada enlace de los checklists del onboarding apunta a una pantalla
// que existe. Si un rediseño (p. ej. la V2 del dueño) renombra una ruta o la
// mueve, este test falla en CI en vez de dejar un paso del checklist que lleva
// a una pantalla vacía sin avisar.
//
// Fuente de rutas: las declaraciones `path="…"` de frontend/src/App.tsx. Se
// compara la ruta sin query ni hash (`/payments-automation?tab=config` →
// `/payments-automation`); si una query pasa a ser obligatoria, eso ya es de la
// pantalla, no del enrutador.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSchoolChecklist,
  buildSchoolNextLevel,
  buildVenueChecklist,
  buildParentChecklist,
} from './onboardingChecklists';
import { getStepsForRole } from './getStepsForRole';

const RAIZ_FRONTEND = resolve(__dirname, '../../..');
const APP_TSX = readFileSync(resolve(RAIZ_FRONTEND, 'src/App.tsx'), 'utf8');
const JOB_AVISOS = readFileSync(resolve(RAIZ_FRONTEND, '../bff/src/jobs/solicitudes-union-avisos.job.ts'), 'utf8');

/** Todas las rutas declaradas, normalizadas con `/` inicial y sin barra final. */
function rutasDeclaradas(fuente: string): Set<string> {
  const rutas = new Set<string>();
  for (const m of fuente.matchAll(/path="([^"]*)"/g)) {
    const bruta = m[1];
    if (bruta === '*' || bruta === '') continue;
    const normal = '/' + bruta.replace(/^\/+/, '').replace(/\/+$/, '');
    rutas.add(normal === '/' ? '/' : normal);
  }
  return rutas;
}

/** `/payments-automation?tab=config#x` → `/payments-automation`. */
function soloRuta(href: string): string {
  return href.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/';
}

const RUTAS = rutasDeclaradas(APP_TSX);

/** Todos los enlaces que los checklists pueden mostrar, con las variantes que cambian el destino. */
function enlacesDeLosChecklists(): Array<{ origen: string; href: string }> {
  const out: Array<{ origen: string; href: string }> = [];
  const agrega = (origen: string, items: Array<{ id: string; href: string }>) =>
    items.forEach((i) => out.push({ origen: `${origen}:${i.id}`, href: i.href }));

  for (const modelo of [undefined, 'teams', 'plans', 'both'] as const) {
    agrega(`academia(modelo=${modelo ?? 'sin definir'})`, buildSchoolChecklist({ business_model: modelo }));
  }
  agrega('academia/siguiente-nivel', buildSchoolNextLevel({}));
  agrega('club', buildVenueChecklist({}, { linkShared: false }));
  for (const pendiente of [false, true]) {
    agrega(`acudiente(invitación pendiente=${pendiente})`,
      buildParentChecklist({ has_pending_invitation: pendiente }, { viewedPayments: false }));
  }
  // Los mismos pasos, tal como los entrega getStepsForRole al panel.
  for (const rol of ['school', 'school_admin', 'parent']) {
    agrega(`getStepsForRole(${rol})`, getStepsForRole(rol, { has_school: true }));
  }
  return out;
}

describe('enlaces de los checklists del onboarding', () => {
  it('la prueba lee un número razonable de rutas de App.tsx (no pasa en vacío)', () => {
    expect(RUTAS.size).toBeGreaterThan(100);
    expect(RUTAS.has('/')).toBe(true);
  });

  it('cada enlace de cada checklist apunta a una ruta declarada en App.tsx', () => {
    const rotos = enlacesDeLosChecklists()
      .filter((e) => !RUTAS.has(soloRuta(e.href)))
      .map((e) => `${e.origen} → ${e.href}`);
    expect(rotos, `Enlaces sin ruta en App.tsx:\n  ${rotos.join('\n  ')}`).toEqual([]);
  });

  it('ningún enlace lleva de vuelta a /dashboard (el clic debe resolver el paso)', () => {
    const vueltas = enlacesDeLosChecklists().filter((e) => soloRuta(e.href) === '/dashboard');
    expect(vueltas).toEqual([]);
  });

  it('los enlaces son rutas internas absolutas', () => {
    for (const e of enlacesDeLosChecklists()) {
      expect(e.href.startsWith('/'), e.origen).toBe(true);
      expect(e.href.startsWith('//'), e.origen).toBe(false);
    }
  });

  it('el aviso de WhatsApp de solicitudes (BFF) lleva a una pantalla que existe', () => {
    const m = JOB_AVISOS.match(/RUTA_BANDEJA\s*=\s*'([^']+)'/);
    expect(m, 'no se encontró RUTA_BANDEJA en el job de avisos').not.toBeNull();
    expect(RUTAS.has(soloRuta(m![1]))).toBe(true);
  });

  it('el detector de rutas distingue una ruta inexistente (control negativo)', () => {
    expect(RUTAS.has('/esta-ruta-no-existe')).toBe(false);
    expect(RUTAS.has(soloRuta('/students?bandeja=por-asignar'))).toBe(true);
  });
});
