# Parche: minutos del paso Evaluar desde `match_live_report` (PartidoFlujo)

`frontend/src/components/partidos/PartidoFlujo.tsx` estaba modificado por otra sesión al editar, así que NO se tocó. Aplicar a mano (3 cambios, solo con flag; sin flag `useMinutosVivo` devuelve `null` y todo queda igual).

1. Import (junto a los demás):

```ts
import { useMinutosVivo } from '@/components/partido-vivo/informe/useInformeVivo';
```

2. En `PasoEvaluar`, tras `const guardadas = useEvaluacionPartido(partido.id);`:

```ts
const vivo = useMinutosVivo(partido.id, schoolId); // null con flag apagado o sin registro en vivo
const minutosBase = (j: Jugadora): number | '' => vivo?.get(claveSujeto(j)) ?? j.minutos ?? '';
```

3. Reemplazar el uso de `j.minutos` por `minutosBase(j)` en dos sitios:

```ts
const minutosDe = (j: Jugadora): number | '' => {
  const k = claveSujeto(j);
  return k in minutos ? minutos[k] : minutosBase(j);
};
...
const cambiosMin = evaluables.filter((j) => j.filaId && claveSujeto(j) in minutos && minutosDe(j) !== minutosBase(j));
```

Efecto: el evaluador ve los minutos del registro en vivo (publicados > en vivo > calculados). Solo se escribe `minutes_played` si el evaluador edita el campo; la columna se llena sola al publicar el informe (D-P1=A, `_live_write_minutes`).

Informe en `MatchReportDialog`: ya integrado (`InformeVivoPanel`, solo con `live_match_enabled`). `PasoReporte` abre ese diálogo, no requiere cambios.
