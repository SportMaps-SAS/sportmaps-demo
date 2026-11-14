import { useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Code2, Copy, MessageCircle, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { displayLink, EMBED_VIEW_LABEL, EMBED_VIEWS, embedSnippet, embedUrl, whatsappShareUrl, type EmbedView, type ShareScope } from './publicModel';

export interface ShareTarget { scope: ShareScope; label: string; title: string; url: string }
/** Para «Insertar en tu web»: el torneo y la categoría que se están viendo. */
export interface EmbedOptions { slug: string; categoryId: string | null; title: string }

/**
 * Hoja «Compartir»: QR grande, enlace copiable, WhatsApp y el menú nativo del celular si existe.
 * Puede compartir el torneo, la categoría o el partido (pastillas arriba cuando hay más de uno).
 */
export function ShareSheet({ open, onOpenChange, targets, embed }: { open: boolean; onOpenChange: (o: boolean) => void; targets: ShareTarget[]; embed?: EmbedOptions }) {
  const [scope, setScope] = useState<ShareScope>(targets[0]?.scope ?? 'tournament');
  const [copied, setCopied] = useState(false);
  const t = targets.find((x) => x.scope === scope) ?? targets[0];
  if (!t) return null;
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (d: ShareData) => Promise<void> }) : null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(t.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* sin permiso: el enlace sigue visible */ }
  };
  const native = async () => { try { await nav?.share?.({ title: t.title, text: `${t.title} — en vivo`, url: t.url }); } catch { /* cancelado */ } };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-h-[92vh] max-w-lg overflow-y-auto rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <SheetHeader className="text-left">
          <SheetTitle>Compartir</SheetTitle>
          <SheetDescription className="truncate">{t.title}</SheetDescription>
        </SheetHeader>
        {targets.length > 1 && (
          <div className="mt-3 flex gap-2" role="radiogroup" aria-label="Qué compartir">
            {targets.map((x) => (
              <button key={x.scope} type="button" role="radio" aria-checked={x.scope === t.scope} onClick={() => { setScope(x.scope); setCopied(false); }}
                className={cn('rounded-full px-3 py-1.5 text-sm font-medium', x.scope === t.scope ? 'bg-foreground text-background' : 'bg-muted')}>
                {x.label}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-center">
          <div className="rounded-xl bg-white p-3" data-testid="share-qr">
            <QRCodeSVG value={t.url} size={208} level="M" aria-label="Código QR del enlace" />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl border px-3 py-2">
          <a href={t.url} className="min-w-0 flex-1 truncate text-sm text-primary underline" data-testid="share-link">{displayLink(t.url)}</a>
          <Button size="icon" variant="ghost" onClick={copy} aria-label={copied ? 'Enlace copiado' : 'Copiar enlace'}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
        <p className="sr-only" aria-live="polite">{copied ? 'Enlace copiado' : ''}</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button asChild className="bg-[#25D366] text-white hover:bg-[#1ebe5b]">
            <a href={whatsappShareUrl(t.title, t.url)} target="_blank" rel="noopener noreferrer"><MessageCircle className="mr-2 h-4 w-4" aria-hidden /> WhatsApp</a>
          </Button>
          {typeof nav?.share === 'function'
            ? <Button variant="outline" onClick={native}><Share2 className="mr-2 h-4 w-4" aria-hidden /> Más opciones</Button>
            : <Button variant="outline" onClick={copy}><Copy className="mr-2 h-4 w-4" aria-hidden /> {copied ? 'Copiado' : 'Copiar'}</Button>}
        </div>
        {embed && <EmbedBlock embed={embed} />}
      </SheetContent>
    </Sheet>
  );
}

/** «Insertar en tu web»: elige la vista, fondo transparente opcional y copia el <iframe>. */
function EmbedBlock({ embed }: { embed: EmbedOptions }) {
  const [openBlock, setOpenBlock] = useState(false);
  const [vista, setVista] = useState<EmbedView>('posiciones');
  const [transparente, setTransparente] = useState(false);
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = embedUrl(origin, embed.slug, { vista, categoria: embed.categoryId, transparente });
  const code = embedSnippet(url, `${embed.title} · ${EMBED_VIEW_LABEL[vista]}`);
  const copy = async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* queda el texto para copiar a mano */ } };
  if (!openBlock) {
    return (
      <Button variant="ghost" className="mt-2 w-full" onClick={() => setOpenBlock(true)}>
        <Code2 className="mr-2 h-4 w-4" aria-hidden /> Insertar en tu web
      </Button>
    );
  }
  return (
    <section className="mt-4 space-y-2 border-t pt-3" aria-label="Insertar en tu web">
      <p className="text-sm font-semibold">Insertar en tu web</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Qué mostrar">
        {EMBED_VIEWS.map((v) => (
          <button key={v} type="button" role="radio" aria-checked={v === vista} onClick={() => setVista(v)}
            className={cn('rounded-full px-3 py-1 text-xs font-medium', v === vista ? 'bg-foreground text-background' : 'bg-muted')}>
            {EMBED_VIEW_LABEL[v]}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={transparente} onChange={(e) => setTransparente(e.target.checked)} /> Fondo transparente
      </label>
      <textarea readOnly value={code} rows={3} className="w-full resize-none rounded-lg border bg-muted/40 p-2 font-mono text-[11px]" aria-label="Código para insertar" data-testid="embed-code" onFocus={(e) => e.currentTarget.select()} />
      <div className="flex gap-2">
        <Button size="sm" onClick={copy}>{copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}{copied ? 'Código copiado' : 'Copiar código'}</Button>
        <Button size="sm" variant="outline" asChild><a href={url} target="_blank" rel="noopener noreferrer">Vista previa</a></Button>
      </div>
    </section>
  );
}

/** Botón que abre la hoja. */
export function ShareButton({ targets, embed, className, children }: { targets: ShareTarget[]; embed?: EmbedOptions; className?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" className={className} onClick={() => setOpen(true)} aria-haspopup="dialog">
        {children ?? <><Share2 className="mr-1.5 h-4 w-4" aria-hidden /> Compartir</>}
      </Button>
      {open && <ShareSheet open={open} onOpenChange={setOpen} targets={targets} embed={embed} />}
    </>
  );
}
