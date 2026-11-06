/**
 * /unirse?codigo=BES-4K7Q — unirse a una escuela con una cuenta que ya existe
 * (spec docs/specs/codigo-de-escuela-union-por-codigo.md §3 «Familia o deportista»).
 *
 * Requiere sesión. Sin sesión guarda el código (localStorage, se borra al cerrar
 * sesión) y ofrece entrar o crear cuenta: al volver, el inicio o el onboarding
 * lo traen de regreso aquí.
 *
 * Pasos: código → «¿Es esta tu escuela?» → ¿para quién? + datos → enviada.
 * No crea inscripción ni cobro: la escuela asigna la categoría desde «Por asignar».
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ArrowLeft, CheckCircle2, KeyRound, Loader2, MapPin, Search, User, Users } from 'lucide-react';
import { todayColombia } from '@/lib/dateUtils';
import { schoolJoinApi, type FichaCandidata, type JoinCodePreview, type ReclamarFichaResult } from '@/lib/api/schoolJoin';
import { DocumentosHijo } from '@/components/parent/v2/hijos/DocumentosHijo';
import {
  adultChildWarning, clearPendingJoinCode, formatJoinCode, isJoinCodeShape, joinErrorMessage,
  normalizeDocNumber, normalizeJoinCode, readPendingJoinCode, savePendingJoinCode, validateJoinRequestForm,
  type ForWhom, type JoinRequestErrors,
} from '@/lib/schoolJoinCode';

type Step = 'code' | 'confirm' | 'find' | 'claimed' | 'form' | 'done';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background flex items-start sm:items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

export default function JoinSchoolByCodePage() {
  const { user, profile, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const urlCode = searchParams.get('codigo') ?? '';

  const [step, setStep] = useState<Step>('code');
  const [code, setCode] = useState(() => formatJoinCode(urlCode || readPendingJoinCode() || ''));
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [school, setSchool] = useState<JoinCodePreview | null>(null);

  const [forWhom, setForWhom] = useState<ForWhom | null>(null);
  const [name, setName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [category, setCategory] = useState('');
  // Documento del deportista: el dato único con el que la escuela lo cruza con su ficha.
  const [docType, setDocType] = useState('TI');
  const [docNum, setDocNum] = useState('');
  const [noDoc, setNoDoc] = useState(false);
  const [errors, setErrors] = useState<JoinRequestErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentName, setSentName] = useState('');

  // Ficha precargada por la escuela (documento o correo de la cuenta).
  const [doc, setDoc] = useState('');
  const [candidates, setCandidates] = useState<FichaCandidata[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<ReclamarFichaResult | null>(null);
  const [showDoc, setShowDoc] = useState(false);

  const today = todayColombia();

  // Sin sesión: guardar el código para retomarlo después del registro/login.
  useEffect(() => {
    if (loading) return;
    if (!user && urlCode) savePendingJoinCode(urlCode);
    // Con sesión, el código ya está en la pantalla: no hace falta guardarlo más.
    if (user) clearPendingJoinCode();
  }, [user, loading, urlCode]);

  // Con código en el enlace, buscar la escuela de una vez.
  useEffect(() => {
    if (!user || loading || step !== 'code') return;
    if (urlCode && isJoinCodeShape(urlCode)) void lookUp(urlCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading]);

  // Por defecto: un acudiente pide para su hijo(a); un deportista, para sí.
  useEffect(() => {
    if (!profile || forWhom) return;
    setForWhom(profile.role === 'athlete' ? 'self' : profile.role === 'parent' ? 'child' : null);
  }, [profile, forWhom]);

  // «Para mí» precarga nombre y fecha de la cuenta; «para mi hijo(a)» empieza vacío.
  useEffect(() => {
    if (forWhom === 'self') {
      setName((n) => n || profile?.full_name || '');
      setBirthDate((d) => d || profile?.date_of_birth || '');
    }
  }, [forWhom, profile?.full_name, profile?.date_of_birth]);

  const warning = useMemo(
    () => adultChildWarning({ forWhom, name, birthDate, category }, today),
    [forWhom, name, birthDate, category, today],
  );

  async function lookUp(raw: string) {
    setCodeError(null);
    if (!isJoinCodeShape(raw)) {
      setCodeError('El código tiene 3 letras y 4 caracteres, por ejemplo BES-4K7Q.');
      return;
    }
    setChecking(true);
    try {
      const res = await schoolJoinApi.preview(normalizeJoinCode(raw));
      if (!res.ok) {
        setCodeError(res.message ?? 'Ese código no existe.');
        return;
      }
      setSchool(res);
      setCode(formatJoinCode(res.code ?? raw));
      setStep('confirm');
    } catch (e) {
      setCodeError(joinErrorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  /** Busca la ficha cargada por la escuela. Sin documento busca solo por el correo confirmado de la cuenta. */
  async function findFicha(withDoc: string | null) {
    setFindError(null);
    setSearching(true);
    try {
      const rows = await schoolJoinApi.buscarFicha(normalizeJoinCode(code), withDoc?.trim() || null);
      setCandidates(rows ?? []);
      setSearched(true);
    } catch (e) {
      setFindError(joinErrorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  function goFind() {
    setCandidates([]);
    setSearched(false);
    setFindError(null);
    setShowDoc(false);
    setStep('find');
    void findFicha(null); // primero por el correo de la cuenta
  }

  async function claim(c: FichaCandidata) {
    setFindError(null);
    setClaimingId(c.ficha_id);
    try {
      const res = await schoolJoinApi.reclamarFicha({
        code: normalizeJoinCode(code), fichaId: c.ficha_id, source: c.source, doc: doc.trim() || null,
      });
      setClaimed(res);
      qc.invalidateQueries({ queryKey: ['my-school-join-status'] });
      setStep('claimed');
    } catch (e) {
      setFindError(joinErrorMessage(e));
    } finally {
      setClaimingId(null);
    }
  }

  async function send() {
    setSubmitError(null);
    const errs = validateJoinRequestForm({ forWhom, name, birthDate, category, docNumber: docNum, docType, noDoc }, today);
    setErrors(errs);
    if (Object.keys(errs).length || !forWhom) return;
    setSending(true);
    try {
      const res = await schoolJoinApi.submit({
        code: normalizeJoinCode(code),
        forWhom,
        name: name.replace(/\s+/g, ' ').trim(),
        birthDate,
        category: category.trim() || null,
        docNumber: noDoc ? null : normalizeDocNumber(docNum) || null,
        docType: noDoc ? null : docType,
      });
      if (!res.ok) {
        setSubmitError(res.message ?? 'No se pudo enviar la solicitud.');
        return;
      }
      setSentName(name.trim());
      qc.invalidateQueries({ queryKey: ['my-school-join-status'] });
      setStep('done');
    } catch (e) {
      setSubmitError(joinErrorMessage(e));
    } finally {
      setSending(false);
    }
  }

  const resetForAnother = () => {
    setForWhom('child');
    setName('');
    setBirthDate('');
    setCategory('');
    setDocNum('');
    setNoDoc(false);
    setErrors({});
    setSubmitError(null);
    setStep('form');
  };

  if (loading) {
    return <Shell><div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div></Shell>;
  }

  // ── Sin sesión ────────────────────────────────────────────────────────────
  if (!user) {
    const back = `/unirse${urlCode ? `?codigo=${encodeURIComponent(formatJoinCode(urlCode))}` : ''}`;
    return (
      <Shell>
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-2">
              <KeyRound className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>Únete a tu escuela</CardTitle>
            <CardDescription>
              {urlCode
                ? <>Tienes el código <strong className="font-mono">{formatJoinCode(urlCode)}</strong>. Entra o crea tu cuenta con el <strong>mismo correo que le diste a tu escuela</strong>: así encontramos tus datos ya cargados y solo terminas de completarlos.</>
                : 'Primero entra o crea tu cuenta. Después ingresas el código que te dio tu escuela.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-semibold text-center">¿Quién se inscribe?</p>
            <Button asChild className="w-full">
              <Link to="/register?role=parent">Es un menor de edad (soy su acudiente)</Link>
            </Button>
            <Button asChild className="w-full">
              <Link to="/register?role=athlete">Soy el atleta, mayor de 18</Link>
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to={`/login?redirectTo=${encodeURIComponent(back)}`}>Ya tengo cuenta: entrar</Link>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── Con sesión ────────────────────────────────────────────────────────────
  return (
    <Shell>
      <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => navigate('/dashboard')}>
        <ArrowLeft className="h-4 w-4 mr-1" /> Ir al inicio
      </Button>

      {step === 'code' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" /> Código de tu escuela</CardTitle>
            <CardDescription>Pídeselo a tu escuela. Tiene 3 letras y 4 caracteres, por ejemplo BES-4K7Q.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => { e.preventDefault(); void lookUp(code); }}
            >
              <Input
                value={code}
                onChange={(e) => { setCode(e.target.value.toUpperCase()); setCodeError(null); }}
                placeholder="BES-4K7Q"
                autoCapitalize="characters"
                autoComplete="off"
                inputMode="text"
                maxLength={12}
                className="font-mono text-2xl tracking-widest text-center h-14 text-[16px] sm:text-2xl"
                aria-invalid={!!codeError}
                autoFocus
              />
              {codeError && <p className="text-sm text-destructive">{codeError}</p>}
              <Button type="submit" className="w-full" disabled={checking || !code.trim()}>
                {checking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Buscar mi escuela
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step === 'confirm' && school && (
        <Card>
          <CardHeader className="text-center">
            <Avatar className="mx-auto h-20 w-20 border">
              {school.logo_url && <AvatarImage src={school.logo_url} className="object-cover" />}
              <AvatarFallback className="text-2xl">{(school.school_name ?? '?').charAt(0)}</AvatarFallback>
            </Avatar>
            <CardTitle className="mt-3">¿Es {school.school_name}?</CardTitle>
            {school.city && (
              <CardDescription className="flex items-center justify-center gap-1">
                <MapPin className="h-3.5 w-3.5" /> {school.city}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {school.already_member && (
              <Alert><AlertDescription>Ya haces parte de esta escuela. Puedes seguir si quieres unir a otra persona (por ejemplo, a otro hijo).</AlertDescription></Alert>
            )}
            {!!school.pending_requests && (
              <Alert><AlertDescription>Ya tienes {school.pending_requests === 1 ? 'una solicitud' : `${school.pending_requests} solicitudes`} en revisión con esta escuela.</AlertDescription></Alert>
            )}
            <Button className="w-full" onClick={goFind}>Sí, es mi escuela</Button>
            <Button variant="outline" className="w-full" onClick={() => { setSchool(null); setStep('code'); }}>
              No, cambiar el código
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'find' && school && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Search className="h-5 w-5 text-primary" /> Busca tu ficha</CardTitle>
            <CardDescription>
              Si {school.school_name} ya cargó al deportista, lo encontramos y te ahorramos volver a escribir los datos.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {searching && !searched && (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Buscando con el correo de tu cuenta…
              </p>
            )}

            {findError && <Alert variant="destructive"><AlertDescription>{findError}</AlertDescription></Alert>}

            {candidates.length > 0 && (
              <p className="text-sm font-medium">Encontramos esto con tu correo. ¿Es correcto?</p>
            )}

            {candidates.map((c) => (
              <div key={c.ficha_id} className="rounded-xl border p-3 space-y-2">
                <div>
                  <p className="font-semibold">{c.nombre}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.tipo === 'menor' ? 'Menor de edad' : 'Mayor de edad'}{c.team_name ? ` · ${c.team_name}` : ''}
                  </p>
                </div>
                {c.puede_reclamar ? (
                  <Button className="w-full" disabled={!!claimingId} onClick={() => void claim(c)}>
                    {claimingId === c.ficha_id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {c.tipo === 'menor' ? 'Sí, es mi hijo(a)' : 'Sí, soy yo'}
                  </Button>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Es un deportista mayor de edad: solo puede reclamarla quien tenga el mismo correo que la escuela
                    registró. Si es tu ficha, envía la solicitud y {school.school_name} la aprueba.
                  </p>
                )}
              </div>
            ))}

            {searched && candidates.length === 0 && !searching && !findError && !showDoc && (
              <p className="text-sm text-muted-foreground">
                Con ese correo no encontramos una ficha. Si tienes el documento del deportista, búscala abajo; si no, envía tus datos y la escuela te registra.
              </p>
            )}

            {candidates.length > 0 && !showDoc && (
              <Button type="button" variant="ghost" className="w-full" onClick={() => setShowDoc(true)}>
                No es: buscar por documento
              </Button>
            )}

            {(showDoc || !!findError || (searched && candidates.length === 0 && !searching)) && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void findFicha(doc); }}>
              <Label htmlFor="join-doc">Documento del deportista</Label>
              <div className="flex gap-2">
                <Input
                  id="join-doc"
                  value={doc}
                  onChange={(e) => setDoc(e.target.value)}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="Número de documento"
                  className="text-[16px] sm:text-sm"
                />
                <Button type="submit" disabled={searching || doc.replace(/\D/g, '').length < 5}>
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Buscar'}
                </Button>
              </div>
            </form>
            )}

            <Button variant={candidates.length ? 'outline' : 'default'} className="w-full" onClick={() => setStep('form')}>
              {candidates.length ? 'No es ninguna: enviar mis datos' : 'No la encuentro: enviar mis datos a la escuela'}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => setStep('confirm')}>Atrás</Button>
          </CardContent>
        </Card>
      )}

      {step === 'claimed' && school && claimed && (
        <Card>
          <CardHeader className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
            <CardTitle className="mt-2">¡Listo, {claimed.athlete_name.split(' ')[0]}!</CardTitle>
            <CardDescription>
              Ya quedaste unido(a) a {claimed.school_name} con los datos que la escuela tenía.
              {claimed.kind === 'child' ? ' Sube ahora los soportes (todos son opcionales; puedes hacerlo después).' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {claimed.kind === 'child' && claimed.child_id && (
              <DocumentosHijo childId={claimed.child_id} idDocumentUrl={null} />
            )}
            {/* Recarga completa (no navigate): los roles de la persona se calculan al cargar la app,
                y recién se le vinculó un hijo o una matrícula. Así el selector de rol aparece ya. */}
            {claimed.kind === 'child' && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => { setClaimed(null); goFind(); }}
              >
                Tengo otro hijo(a) en {claimed.school_name}: buscarlo
              </Button>
            )}
            <Button className="w-full" onClick={() => window.location.assign('/dashboard')}>Continuar</Button>
          </CardContent>
        </Card>
      )}

      {step === 'form' && school && (
        <Card>
          <CardHeader>
            <CardTitle>¿Para quién es?</CardTitle>
            <CardDescription>Así {school.school_name} sabe a quién asignar la categoría.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="¿Para quién es?">
                {([
                  { v: 'self' as const, label: 'Para mí', hint: 'Yo entreno', icon: User },
                  { v: 'child' as const, label: 'Para mi hijo(a)', hint: 'Soy acudiente', icon: Users },
                ]).map(({ v, label, hint, icon: Icon }) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={forWhom === v}
                    onClick={() => {
                      if (forWhom !== v) { setName(''); setBirthDate(''); }
                      setForWhom(v);
                      setErrors((x) => ({ ...x, forWhom: undefined }));
                    }}
                    className={`rounded-xl border-2 p-3 text-left transition-colors ${forWhom === v ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
                  >
                    <Icon className="h-5 w-5 text-primary mb-1" />
                    <span className="block font-semibold text-sm">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint}</span>
                  </button>
                ))}
              </div>
              {errors.forWhom && <p className="text-sm text-destructive">{errors.forWhom}</p>}

              <div className="space-y-2">
                <Label htmlFor="join-name">{forWhom === 'child' ? 'Nombre completo de tu hijo(a)' : 'Tu nombre completo'} *</Label>
                <Input id="join-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} className="text-[16px] sm:text-sm" />
                {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
              </div>

              <div className="space-y-2">
                <Label htmlFor="join-dob">Fecha de nacimiento *</Label>
                <Input id="join-dob" type="date" value={birthDate} max={today} onChange={(e) => setBirthDate(e.target.value)} className="text-[16px] sm:text-sm" />
                {errors.birthDate && <p className="text-sm text-destructive">{errors.birthDate}</p>}
                {warning && <p className="text-xs text-amber-700 dark:text-amber-400">{warning}</p>}
              </div>

              <div className="space-y-2">
                <Label htmlFor="join-doc-num">Documento {forWhom === 'child' ? 'de tu hijo(a)' : 'tuyo'} *</Label>
                <div className="flex gap-2">
                  <select
                    aria-label="Tipo de documento"
                    value={docType}
                    onChange={(e) => setDocType(e.target.value)}
                    disabled={noDoc}
                    className="h-10 rounded-md border border-input bg-background px-2 text-[16px] sm:text-sm"
                  >
                    <option value="RC">RC</option>
                    <option value="TI">TI</option>
                    <option value="CC">CC</option>
                    <option value="CE">CE</option>
                    <option value="PP">PP</option>
                  </select>
                  <Input
                    id="join-doc-num"
                    value={docNum}
                    onChange={(e) => setDocNum(e.target.value)}
                    disabled={noDoc}
                    inputMode="text"
                    autoComplete="off"
                    placeholder="Número, sin puntos"
                    className="text-[16px] sm:text-sm"
                  />
                </div>
                {errors.docNumber && <p className="text-sm text-destructive">{errors.docNumber}</p>}
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={noDoc} onChange={(e) => setNoDoc(e.target.checked)} />
                  No lo tengo a la mano (la escuela te lo pedirá)
                </label>
                <p className="text-xs text-muted-foreground">Con el documento la escuela encuentra su ficha sin equivocarse.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="join-cat">Categoría o grupo (opcional)</Label>
                <Input
                  id="join-cat"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  maxLength={120}
                  placeholder="Ej.: Sub-16, Voleibol femenino"
                  className="text-[16px] sm:text-sm"
                />
                <p className="text-xs text-muted-foreground">Es una sugerencia: la escuela decide la categoría.</p>
              </div>

              {submitError && <Alert variant="destructive"><AlertDescription>{submitError}</AlertDescription></Alert>}

              <Button type="submit" className="w-full" disabled={sending}>
                {sending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Enviar solicitud
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={() => setStep('find')} disabled={sending}>
                Atrás
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step === 'done' && school && (
        <Card>
          <CardHeader className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
            <CardTitle className="mt-2">Solicitud enviada</CardTitle>
            <CardDescription>
              {school.school_name} te asignará la categoría{forWhom === 'child' && sentName ? ` de ${sentName}` : ''}. Te
              avisamos cuando lo haga y tu inicio mostrará la escuela.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button className="w-full" onClick={() => navigate('/dashboard')}>Ir al inicio</Button>
            <Button variant="outline" className="w-full" onClick={resetForAnother}>Unir a otro hijo(a)</Button>
          </CardContent>
        </Card>
      )}
    </Shell>
  );
}
