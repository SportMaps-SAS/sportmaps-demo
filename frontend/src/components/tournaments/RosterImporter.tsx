import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Camera, Download, FileSpreadsheet, Plus, Trash2 } from 'lucide-react';
import { comprimirParaSubir } from '@/lib/imageCompression';
import {
  BASE_LABEL, draftProblems, readSpreadsheet, rowsToDrafts, splitTable, templateCsv,
  type PlayerDraft, type PlayerForm,
} from '@/lib/tournamentPlayers';

type Mode = 'one' | 'paste' | 'sheet' | 'photo';

interface Props {
  form: PlayerForm;
  /** Guarda las filas ya revisadas. Lanza Error con el mensaje del BFF si falla. */
  onSave: (drafts: PlayerDraft[]) => Promise<void>;
  /** Foto de la nómina en papel → jugadores (OCR: nombre y, si aparecen, dorsal, documento, nacimiento y posición). */
  readPhoto?: (base64: string, mime: string) => Promise<{ players: Array<Pick<PlayerDraft, 'full_name' | 'shirt_number' | 'document_number' | 'birth_date' | 'position'>> }>;
  busyLabel?: string;
}

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'one', label: 'Uno a uno' }, { key: 'paste', label: 'Pegar lista' },
  { key: 'sheet', label: 'Planilla (Excel o CSV)' }, { key: 'photo', label: 'Foto de la planilla' },
];

const toBase64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ''));
  r.onerror = () => reject(new Error('No se pudo leer la foto'));
  r.readAsDataURL(f);
});

/**
 * Subir jugadores de cuatro formas, siempre con vista previa y corrección antes de guardar.
 * Lo usan el organizador (jugadores de un equipo) y el delegado (link de inscripción).
 */
export function RosterImporter({ form, onSave, readPhoto, busyLabel = 'Guardando…' }: Props) {
  const [mode, setMode] = useState<Mode>('one');
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<PlayerDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const problems = useMemo(() => preview.map((d) => draftProblems(d, form)), [preview, form]);
  const bad = problems.filter((p) => p.length > 0).length;
  const extraCols = form.custom;

  const addOne = () => {
    if (!name.trim()) return;
    setPreview((p) => [...p, { full_name: name.trim(), ...(number.trim() ? { shirt_number: number.trim() } : {}) }]);
    setName(''); setNumber('');
  };

  const loadPaste = () => { setPreview((p) => [...p, ...rowsToDrafts(splitTable(pasted), form)]); setPasted(''); };

  const loadFile = async (f: File) => {
    setError(null);
    try {
      const rows = rowsToDrafts(await readSpreadsheet(f), form);
      if (rows.length === 0) setError('No encontramos jugadores en la planilla. Revisa que tenga una columna «Nombre».');
      setPreview((p) => [...p, ...rows]);
    } catch { setError('No pudimos leer el archivo. Guárdalo como .xlsx o .csv e inténtalo de nuevo.'); }
  };

  const loadPhoto = async (f: File) => {
    if (!readPhoto) return;
    setError(null); setBusy(true);
    try {
      const small = await comprimirParaSubir(f, 'documento');
      const r = await readPhoto(await toBase64(small), small.type || 'image/jpeg');
      setPreview((p) => [...p, ...r.players.map((x) => {
        const d: PlayerDraft = { full_name: x.full_name };
        for (const k of ['shirt_number', 'document_number', 'birth_date', 'position'] as const) if (x[k]) d[k] = String(x[k]);
        return d;
      })]);
    } catch (e) { setError((e as Error).message || 'No pudimos leer la foto.'); }
    finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    const blob = new Blob(['﻿', templateCsv(form)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'planilla-jugadores.csv'; a.click();
    URL.revokeObjectURL(a.href);
  };

  const setCell = (i: number, key: string, value: string, custom = false) => setPreview((p) => p.map((d, j) => {
    if (j !== i) return d;
    return custom ? { ...d, extra: { ...(d.extra ?? {}), [key]: value } } : { ...d, [key]: value };
  }));

  const save = async () => {
    if (preview.length === 0 || bad > 0) return;
    setBusy(true); setError(null);
    try { await onSave(preview); setPreview([]); }
    catch (e) { setError((e as Error).message || 'No se pudieron guardar.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3" data-testid="roster-importer">
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {MODES.filter((m) => m.key !== 'photo' || readPhoto).map((m) => (
          <Button key={m.key} type="button" size="sm" role="tab" aria-selected={mode === m.key} variant={mode === m.key ? 'default' : 'outline'} onClick={() => setMode(m.key)}>{m.label}</Button>
        ))}
      </div>

      {mode === 'one' && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addOne(); }}>
          <Input aria-label="Nombre del jugador" placeholder="Nombre del jugador" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="Número" placeholder="#" inputMode="numeric" className="w-16" maxLength={3} value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} />
          <Button type="submit" variant="outline" disabled={!name.trim()}><Plus className="mr-1 h-4 w-4" /> Agregar</Button>
        </form>
      )}
      {mode === 'paste' && (
        <div className="space-y-2">
          <Textarea aria-label="Lista de jugadores" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)}
            placeholder={'Un jugador por línea. También puedes pegar desde Excel con encabezados:\nNombre\tNúmero\tDocumento'} />
          <Button type="button" variant="outline" disabled={!pasted.trim()} onClick={loadPaste}>Revisar lista</Button>
        </div>
      )}
      {mode === 'sheet' && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}><FileSpreadsheet className="mr-1 h-4 w-4" /> Subir planilla</Button>
          <Button type="button" variant="ghost" onClick={downloadTemplate}><Download className="mr-1 h-4 w-4" /> Descargar plantilla</Button>
          <input ref={fileRef} type="file" accept=".xlsx,.csv,text/csv" className="hidden" aria-label="Archivo de planilla"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f); e.target.value = ''; }} />
          <p className="w-full text-xs text-muted-foreground">Columnas: {[...['full_name', 'shirt_number', 'document_number', 'birth_date'].map((k) => BASE_LABEL[k as keyof typeof BASE_LABEL]), ...extraCols.map((c) => c.label)].join(', ')}… Solo «Nombre» es obligatoria siempre.</p>
        </div>
      )}
      {mode === 'photo' && readPhoto && (
        <div className="space-y-1">
          <Button type="button" variant="outline" disabled={busy} onClick={() => photoRef.current?.click()}><Camera className="mr-1 h-4 w-4" /> {busy ? 'Leyendo la foto…' : 'Tomar o subir foto'}</Button>
          <input ref={photoRef} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Foto de la planilla"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadPhoto(f); e.target.value = ''; }} />
          <p className="text-xs text-muted-foreground">Leemos nombres, números, documentos y fechas de la nómina en papel. Revísalos antes de guardar.</p>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {preview.length > 0 && (
        <div className="space-y-2 rounded-md border p-2" data-testid="roster-preview">
          <p className="text-sm font-medium">Revisa antes de guardar · {preview.length} jugador{preview.length === 1 ? '' : 'es'}{bad > 0 ? ` · ${bad} con datos por corregir` : ''}</p>
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground">
                <th className="p-1">Nombre</th><th className="p-1">#</th><th className="p-1">Documento</th><th className="p-1">Nacimiento</th>
                {extraCols.map((c) => <th key={c.key} className="p-1">{c.label}</th>)}<th />
              </tr></thead>
              <tbody>
                {preview.map((d, i) => (
                  <tr key={i} className={problems[i].length ? 'bg-destructive/5' : ''}>
                    <td className="p-1"><Input className="h-8" aria-label={`Nombre fila ${i + 1}`} value={d.full_name} onChange={(e) => setCell(i, 'full_name', e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 w-14" aria-label={`Número fila ${i + 1}`} value={d.shirt_number ?? ''} onChange={(e) => setCell(i, 'shirt_number', e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 w-28" aria-label={`Documento fila ${i + 1}`} value={d.document_number ?? ''} onChange={(e) => setCell(i, 'document_number', e.target.value)} /></td>
                    <td className="p-1"><Input className="h-8 w-32" type="date" aria-label={`Nacimiento fila ${i + 1}`} value={d.birth_date ?? ''} onChange={(e) => setCell(i, 'birth_date', e.target.value)} /></td>
                    {extraCols.map((c) => (
                      <td key={c.key} className="p-1">
                        {c.type === 'select'
                          ? <select aria-label={`${c.label} fila ${i + 1}`} className="h-8 rounded border bg-background px-1" value={d.extra?.[c.key] ?? ''} onChange={(e) => setCell(i, c.key, e.target.value, true)}>
                              <option value="" />{c.options?.map((o) => <option key={o}>{o}</option>)}
                            </select>
                          : <Input className="h-8 w-28" type={c.type === 'date' ? 'date' : 'text'} aria-label={`${c.label} fila ${i + 1}`} value={d.extra?.[c.key] ?? ''} onChange={(e) => setCell(i, c.key, e.target.value, true)} />}
                      </td>
                    ))}
                    <td className="p-1">
                      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Quitar fila ${i + 1}`} onClick={() => setPreview((p) => p.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bad > 0 && <p className="text-xs text-destructive">{problems.find((p) => p.length)?.[0]}</p>}
          <div className="flex gap-2">
            <Button type="button" onClick={save} disabled={busy || bad > 0}>{busy ? busyLabel : `Guardar ${preview.length} jugador${preview.length === 1 ? '' : 'es'}`}</Button>
            <Button type="button" variant="ghost" onClick={() => setPreview([])}>Descartar</Button>
          </div>
        </div>
      )}
    </div>
  );
}
