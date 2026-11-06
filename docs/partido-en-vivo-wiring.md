# Partido en vivo F2-b: conexión pendiente

Lo que ya quedó conectado (archivos limpios al momento de editar):
- `frontend/src/App.tsx`: import lazy `PartidoEnVivoPage` y ruta `partido-en-vivo/:matchId` (junto a `partidos/:matchId`).
- `frontend/src/config/routePermissions.ts`: `/partido-en-vivo/:matchId` para coach, school, admin, school_admin, super_admin.

## Pendiente: botón «Llevar en vivo» en el detalle del partido

`frontend/src/components/partidos/PartidoFlujo.tsx` estaba modificado por otra sesión (`git status` = ` M`), así que NO se editó.
Punto de entrada: dentro del `<header>` del componente `PartidoFlujo`, después del bloque `<div className="min-w-0 flex-1">…</div>`
(el que muestra «Contra {rival}»). `useLiveMatchEnabled` ya está importado en ese archivo (línea 28) y `useNavigate` no.

Cambios a aplicar:

```tsx
// 1) imports
import { useNavigate } from 'react-router-dom';
import { Radio } from 'lucide-react';   // o añadir Radio al import de lucide-react existente

// 2) dentro de PartidoFlujo(), junto a los demás hooks
const navigate = useNavigate();
const vivoHabilitado = useLiveMatchEnabled();
// (si la otra sesión ya declaró `const vivo = useLiveMatchEnabled()` en este componente, reutilízalo)

// 3) en el <header>, tras el <div className="min-w-0 flex-1">…</div>
{vivoHabilitado && m && m.status !== 'cancelled' && puedeEditar && (
  <Button
    className="min-h-touch h-11 shrink-0 rounded-xl"
    onClick={() => navigate(`/partido-en-vivo/${encodeURIComponent(m.id)}`)}
  >
    <Radio className="mr-1.5 h-4 w-4" />Llevar en vivo
  </Button>
)}
```

Notas:
- Solo con flag (`live_match_enabled`) y partido ya creado (`m` definido), y rol que puede editar partidos.
- Un partido ya `played` sin `match_live` lo rechaza `start_live_match` (MATCH_ALREADY_PLAYED); si se prefiere, ocultar el botón con `m.status === 'played'`.
- `PartidoPage.tsx` no necesita cambios.
