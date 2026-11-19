import { useState, useMemo, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useCart } from '@/contexts/CartContext';
import { useStoreEnabled } from '@/hooks/useStoreEnabled';
import {
  useExplorarGlobal,
  type ExploreCategory,
  type ExploreItem,
  type ServiceType,
} from '@/hooks/useExplorarGlobal';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Search,
  ShoppingCart,
  Clock,
  MapPin,
  ChevronLeft,
  ChevronRight,
  Store,
  Heart,
  Filter,
  Star,
  Calendar,
  Users,
  GraduationCap,
  Stethoscope,
  Trophy,
  Package,
  Sparkles,
  Tag,
  CheckCircle2,
  Loader2,
  X,
  Baby,
  UserCircle,
  Map as MapIcon,
  LayoutGrid,
  Dumbbell,
  type LucideIcon,
  Compass,
  ArrowLeft,
} from 'lucide-react';
import { ServiceBookingModal } from '@/components/marketplace/ServiceBookingModal';
import { UnifiedExploreMap } from '@/components/marketplace/UnifiedExploreMap';
import { ExploreMapInteractive } from '@/components/explore/ExploreMapInteractive';

// ── Category config ──────────────────────────────────────────────────────────

const CATEGORIES: { key: ExploreCategory; label: string; icon: React.ElementType; color: string }[] = [
  { key: 'all',      label: 'Todo',          icon: Sparkles,      color: 'bg-gradient-to-r from-primary to-purple-500' },
  { key: 'services', label: 'Profesionales', icon: Stethoscope,   color: 'bg-emerald-500' },
  { key: 'trainers', label: 'Entrenadores',  icon: Dumbbell,      color: 'bg-violet-500' },
  { key: 'events',   label: 'Eventos',       icon: Trophy,        color: 'bg-amber-500' },
  { key: 'schools',  label: 'Escuelas',      icon: GraduationCap, color: 'bg-blue-500' },
  { key: 'products', label: 'Productos',     icon: Package,       color: 'bg-rose-500' },
];

const SERVICE_TYPES: { value: ServiceType; label: string; icon: string }[] = [
  { value: 'Fisioterapia',       label: 'Fisioterapia',       icon: '🏥' },
  { value: 'Nutricion',          label: 'Nutricion',          icon: '🥗' },
  { value: 'Psicologia',         label: 'Psicologia',         icon: '🧠' },
  { value: 'Medicina_Deportiva', label: 'Medicina Deportiva', icon: '⚕️' },
  { value: 'Entrenamiento',      label: 'Entrenamiento',      icon: '💪' },
];

// Imagen con respaldo: si la URL remota falla (p. ej. Unsplash ya no la sirve) muestra el icono de la categoría.
function CardImg({ src, alt, className, Icon }: { src: string; alt: string; className: string; Icon: LucideIcon }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="w-full h-full flex items-center justify-center" role="img" aria-label={alt}>
        <Icon className="h-12 w-12 text-muted-foreground/40" />
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} loading="lazy" onError={() => setFailed(true)} />;
}

// ── Item Cards ───────────────────────────────────────────────────────────────

function ServiceCard({ item, onBook }: { item: ExploreItem; onBook: (item: ExploreItem) => void }) {
  return (
    <Card className="group overflow-hidden cursor-pointer hover:shadow-xl transition-all duration-300 border-border/50 hover:border-emerald-400/50">
      <div className="relative aspect-[4/3] bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 overflow-hidden">
        {item.image_url ? (
          <CardImg src={item.image_url} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" Icon={Stethoscope} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Stethoscope className="h-12 w-12 text-emerald-300" />
          </div>
        )}
        <Badge className="absolute top-2.5 left-2.5 bg-emerald-600 text-white border-0 shadow-lg">
          {item.service_type?.replace('_', ' ') || 'Servicio'}
        </Badge>
        {item.vendor_verified && (
          <div className="absolute top-2.5 right-2.5 bg-white/90 dark:bg-black/70 rounded-full p-1">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          </div>
        )}
        {item.is_courtesy && (
          <Badge className="absolute bottom-2.5 left-2.5 bg-purple-600 text-white border-0">
            Cortesia disponible
          </Badge>
        )}
      </div>
      <CardContent className="p-4 space-y-2">
        <h3 className="font-semibold text-sm line-clamp-2 group-hover:text-emerald-600 transition-colors">{item.name}</h3>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserCircle className="h-3.5 w-3.5" />
          <span className="truncate">{item.vendor_name}</span>
        </div>
        {item.vendor_city && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            <span>{item.vendor_city}</span>
          </div>
        )}
        {item.duration_minutes && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>{item.duration_minutes} min</span>
          </div>
        )}
        <Separator className="my-1" />
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-emerald-600">
            {item.price === 0 ? 'Gratis' : `$${item.price.toLocaleString('es-CO')}`}
          </span>
          <Button
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={(e) => { e.stopPropagation(); onBook(item); }}
          >
            Reservar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EventCard({ item, onRegister }: { item: ExploreItem; onRegister: (item: ExploreItem) => void }) {
  const navigate = useNavigate();

  return (
    <Card
      className="group overflow-hidden cursor-pointer hover:shadow-xl transition-all duration-300 border-border/50 hover:border-amber-400/50"
      onClick={() => navigate(`/event/${item.id}`)}
    >
      <div className="relative aspect-[4/3] bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 overflow-hidden">
        {item.image_url ? (
          <CardImg src={item.image_url} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" Icon={Trophy} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Trophy className="h-12 w-12 text-amber-300" />
          </div>
        )}
        <Badge className="absolute top-2.5 left-2.5 bg-amber-600 text-white border-0 shadow-lg">
          {item.event_type || 'Evento'}
        </Badge>
        {item.event_date && (
          <div className="absolute bottom-2.5 left-2.5 bg-white/95 dark:bg-black/80 rounded-lg px-2.5 py-1.5 shadow-lg">
            <p className="text-[10px] uppercase tracking-wider text-amber-600 font-bold">
              {new Date(item.event_date + 'T00:00:00').toLocaleDateString('es-CO', { month: 'short' })}
            </p>
            <p className="text-lg font-black leading-tight">
              {new Date(item.event_date + 'T00:00:00').getDate()}
            </p>
          </div>
        )}
      </div>
      <CardContent className="p-4 space-y-2">
        <h3 className="font-semibold text-sm line-clamp-2 group-hover:text-amber-600 transition-colors">{item.name}</h3>
        {item.vendor_city && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            <span>{item.vendor_city}</span>
          </div>
        )}
        {item.capacity && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span>{item.registrations_count ?? 0} / {item.capacity} inscritos</span>
          </div>
        )}
        <Separator className="my-1" />
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-amber-600">
            {item.price === 0 ? 'Gratis' : `$${item.price.toLocaleString('es-CO')}`}
          </span>
          <Button
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 text-white"
            onClick={(e) => { e.stopPropagation(); onRegister(item); }}
          >
            Inscribirme
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SchoolCard({ item }: { item: ExploreItem }) {
  const navigate = useNavigate();
  return (
    <Card
      className="group overflow-hidden cursor-pointer hover:shadow-2xl transition-all duration-500 border border-border/50 hover:border-primary/40 bg-card/80 backdrop-blur-sm"
      onClick={() => navigate(`/schools/${item.id}`)}
    >
      <div className="relative h-48 bg-gradient-to-br from-primary/10 via-primary/5 to-secondary/10 overflow-hidden">
        {item.image_url ? (
          <CardImg src={item.image_url} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" Icon={Trophy} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/20 to-secondary/20">
            <Trophy className="h-14 w-14 text-primary/30" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

        {item.vendor_verified && (
          <Badge className="absolute top-3 right-3 bg-white/95 text-primary border-0 shadow-lg text-xs font-semibold px-2.5 py-1">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Verificada
          </Badge>
        )}

        {item.vendor_logo && (
          <div className="absolute bottom-3 left-3">
            <img src={item.vendor_logo} alt="" className="w-10 h-10 rounded-lg border-2 border-white shadow-lg object-cover bg-white" />
          </div>
        )}

        {item.price > 0 && (
          <div className="absolute bottom-3 right-3 bg-black/60 backdrop-blur-sm text-white text-xs font-bold px-2.5 py-1.5 rounded-lg">
            Desde ${item.price.toLocaleString('es-CO')}
          </div>
        )}
      </div>

      <CardContent className="p-4 space-y-3">
        <div>
          <h3 className="font-bold text-base line-clamp-1 group-hover:text-primary transition-colors">
            {item.name}
          </h3>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
            <MapPin className="h-3 w-3" />
            <span className="line-clamp-1">{item.vendor_city || 'Colombia'}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 rounded-full">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            <span className="text-xs font-bold text-amber-700 dark:text-amber-300">
              {(item.rating || 0).toFixed(1)}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {item.review_count || 0} reseñas
          </span>
        </div>

        {item.sports && item.sports.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.sports.slice(0, 3).map((sport) => (
              <Badge key={sport} variant="secondary" className="text-[10px] font-medium px-2 py-0.5">
                {sport}
              </Badge>
            ))}
            {item.sports.length > 3 && (
              <Badge variant="outline" className="text-[10px] px-2 py-0.5">
                +{item.sports.length - 3}
              </Badge>
            )}
          </div>
        )}

        <Button className="w-full h-9 text-xs font-semibold shadow-sm group-hover:shadow-md transition-shadow" size="sm">
          Ver programas
          <Sparkles className="h-3.5 w-3.5 ml-1.5" />
        </Button>
      </CardContent>
    </Card>
  );
}

function TrainerCard({ item }: { item: ExploreItem }) {
  const navigate = useNavigate();
  const modalityLabel = item.modality === 'presencial' ? 'Presencial'
    : item.modality === 'virtual' ? 'Virtual'
    : item.modality === 'ambas' ? 'Presencial y Virtual'
    : null;

  return (
    <Card
      className="group overflow-hidden cursor-pointer hover:shadow-2xl transition-all duration-500 border border-border/50 hover:border-violet-400/50 bg-card/80 backdrop-blur-sm"
      onClick={() => item.trainer_user_id && navigate(`/entrenador/${item.trainer_user_id}`)}
    >
      <div className="relative h-48 bg-gradient-to-br from-violet-500/10 via-fuchsia-500/5 to-purple-500/10 overflow-hidden">
        {item.image_url ? (
          <CardImg src={item.image_url} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" Icon={Dumbbell} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Dumbbell className="h-14 w-14 text-violet-400/40" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />

        {modalityLabel && (
          <Badge className="absolute top-3 right-3 bg-white/95 text-violet-700 border-0 shadow-lg text-xs font-semibold px-2.5 py-1">
            {modalityLabel}
          </Badge>
        )}

        {item.price > 0 && (
          <div className="absolute bottom-3 right-3 bg-black/60 backdrop-blur-sm text-white text-xs font-bold px-2.5 py-1.5 rounded-lg">
            ${item.price.toLocaleString('es-CO')} / sesión
          </div>
        )}
      </div>

      <CardContent className="p-4 space-y-3">
        <div>
          <h3 className="font-bold text-base line-clamp-1 group-hover:text-violet-600 transition-colors">
            {item.name}
          </h3>
          {item.tagline && (
            <p className="text-xs text-muted-foreground line-clamp-1 mt-1">{item.tagline}</p>
          )}
          {item.vendor_city && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <MapPin className="h-3 w-3" />
              <span className="line-clamp-1">{item.vendor_city}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 rounded-full">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            <span className="text-xs font-bold text-amber-700 dark:text-amber-300">
              {(item.rating || 0).toFixed(1)}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {item.review_count || 0} reseñas
          </span>
          {item.experience_years != null && item.experience_years > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">{item.experience_years} años</span>
            </>
          )}
        </div>

        {(item.primary_sport || (item.specialties && item.specialties.length > 0)) && (
          <div className="flex flex-wrap gap-1.5">
            {item.primary_sport && (
              <Badge variant="secondary" className="text-[10px] font-medium px-2 py-0.5">
                {item.primary_sport}
              </Badge>
            )}
            {item.specialties?.slice(0, 2).map((s) => (
              <Badge key={s} variant="outline" className="text-[10px] px-2 py-0.5">{s}</Badge>
            ))}
          </div>
        )}

        <Button className="w-full h-9 text-xs font-semibold bg-violet-600 hover:bg-violet-700" size="sm">
          Ver perfil
          <Sparkles className="h-3.5 w-3.5 ml-1.5" />
        </Button>
      </CardContent>
    </Card>
  );
}

function ProductCard({ item, onAddToCart }: { item: ExploreItem; onAddToCart: (item: ExploreItem) => void }) {
  const navigate = useNavigate();

  return (
    <Card
      className="group overflow-hidden cursor-pointer hover:shadow-xl transition-all duration-300 border-border/50 hover:border-rose-400/50"
      onClick={() => navigate(`/marketplace/product/${item.id}`)}
    >
      <div className="relative aspect-[4/3] bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-950/30 dark:to-pink-950/30 overflow-hidden">
        {item.image_url ? (
          <CardImg src={item.image_url} alt={item.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" Icon={Package} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Package className="h-12 w-12 text-rose-300" />
          </div>
        )}
        <Badge className="absolute top-2.5 left-2.5 bg-rose-600 text-white border-0 shadow-lg">
          {item.category || 'Producto'}
        </Badge>
        {item.vendor_verified && (
          <div className="absolute top-2.5 right-2.5 bg-white/90 dark:bg-black/70 rounded-full p-1">
            <CheckCircle2 className="h-4 w-4 text-rose-600" />
          </div>
        )}
      </div>
      <CardContent className="p-4 space-y-2">
        <h3 className="font-semibold text-sm line-clamp-2 group-hover:text-rose-600 transition-colors">{item.name}</h3>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Store className="h-3.5 w-3.5" />
          <span className="truncate">{item.vendor_name}</span>
        </div>
        {item.stock != null && item.stock <= 5 && item.stock > 0 && (
          <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200">
            Quedan {item.stock}
          </Badge>
        )}
        <Separator className="my-1" />
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-rose-600">
            ${item.price.toLocaleString('es-CO')}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="border-rose-200 hover:bg-rose-50 text-rose-600"
            onClick={(e) => { e.stopPropagation(); onAddToCart(item); }}
          >
            <ShoppingCart className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}


// ── Section header (when category = 'all') ───────────────────────────────────

function SectionHeader({
  icon: Icon, label, color, count, onViewAll,
}: { icon: React.ElementType; label: string; color: string; count: number; onViewAll: () => void }) {
  if (count === 0) return null;
  return (
    <div className="flex items-center justify-between mt-8 mb-4">
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-lg text-white ${color}`}>
          <Icon className="h-4 w-4" />
        </div>
        <h2 className="text-lg font-bold">{label}</h2>
        <Badge variant="secondary" className="text-xs">{count}</Badge>
      </div>
      <Button variant="ghost" size="sm" onClick={onViewAll} className="text-xs">
        Ver todos <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
      </Button>
    </div>
  );
}


// ── Main Page ────────────────────────────────────────────────────────────────

export default function ExplorarGlobalPage() {
  const { user, profile } = useAuth();
  const { addItem } = useCart();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Tienda apagada (spec blindaje-dinero §1.3): sin pestaña ni resultados de
  // productos. Los servicios de wellness siguen.
  const { enabled: storeEnabled } = useStoreEnabled();
  const categories = storeEnabled ? CATEGORIES : CATEGORIES.filter((c) => c.key !== 'products');
  const [searchInput, setSearchInput] = useState('');
  const [bookingItem, setBookingItem] = useState<ExploreItem | null>(null);

  const initialCategory = (() => {
    const c = searchParams.get('category');
    const valid: ExploreCategory[] = ['all', 'services', 'trainers', 'events', 'schools', ...(storeEnabled ? ['products' as const] : [])];
    return valid.includes(c as ExploreCategory) ? (c as ExploreCategory) : 'all';
  })();

  const { data, isLoading, filters, updateFilters, nextPage, prevPage, clearFilters } = useExplorarGlobal({ category: initialCategory });

  // Si llegó con ?category=products o la tienda se apagó estando ahí.
  useEffect(() => {
    if (!storeEnabled && filters.category === 'products') updateFilters({ category: 'all' });
  }, [storeEnabled, filters.category, updateFilters]);

  const isParent = profile?.role === 'parent';
  const [viewMode, setViewMode] = useState<'grid' | 'map'>('grid');

  // Group items by type when showing 'all'
  const grouped = useMemo(() => {
    if (!data?.items || filters.category !== 'all') return null;
    return {
      services: data.items.filter((i) => i.item_type === 'service'),
      trainers: data.items.filter((i) => i.item_type === 'trainer'),
      events: data.items.filter((i) => i.item_type === 'event'),
      schools: data.items.filter((i) => i.item_type === 'school'),
      products: data.items.filter((i) => i.item_type === 'product'),
    };
  }, [data?.items, filters.category]);

  const handleSearch = () => {
    updateFilters({ q: searchInput || undefined });
  };

  const handleBook = (item: ExploreItem) => {
    if (!user) {
      navigate('/login?redirect=/explorar');
      return;
    }
    setBookingItem(item);
  };

  const handleRegisterEvent = (item: ExploreItem) => {
    if (!user) {
      navigate('/login?redirect=/explorar');
      return;
    }
    // Navigate to the individual registration page (already exists)
    navigate(`/events/${item.id}/register`);
  };

  const handleAddToCart = (item: ExploreItem) => {
    if (!user) {
      navigate('/login?redirect=/explorar');
      return;
    }
    addItem({
      id: `marketplace-product-${item.id}`,
      type: 'product',
      name: item.name,
      description: item.description || '',
      price: item.price,
      image: item.image_url || undefined,
      metadata: {
        productId: item.id,
        vendorName: item.vendor_name,
      },
    });
  };

  const activeFilterCount = [
    filters.q, filters.city, filters.service_type, filters.sport, filters.price_max,
  ].filter(Boolean).length;

  const quickSports = ['Fútbol', 'Natación', 'Tenis', 'Cheerleading', 'Baloncesto', 'Karate', 'Gimnasia'];
  const totalResults = data?.total ?? 0;

  const backTo = user ? '/dashboard' : '/';

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20">
      {/* ── Back nav ─────────────────────────────────────────────────────────── */}
      <div className="bg-background/80 backdrop-blur-md border-b sticky top-0 z-40 sticky-safe">
        <div className="container mx-auto px-4 py-3 max-w-7xl">
          <Link
            to={backTo}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver
          </Link>
        </div>
      </div>

      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary/90 to-emerald-600" />
        <div className="absolute inset-0 opacity-[0.07]" style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '28px 28px',
        }} />
        <div className="absolute -top-20 -right-20 w-64 h-64 bg-white/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-20 -left-20 w-64 h-64 bg-emerald-300/10 rounded-full blur-3xl" />

        <div className="container mx-auto px-4 py-10 md:py-14 relative z-10 max-w-7xl">
          <div className="max-w-3xl mx-auto text-center space-y-5">
            <div className="flex items-center justify-center gap-2">
              <Compass className="h-6 w-6 text-white/70 animate-pulse" />
              <Badge variant="secondary" className="bg-white/15 text-white border-white/20 hover:bg-white/25 text-xs backdrop-blur-sm">
                {totalResults > 0 ? `${totalResults} resultados` : 'Explora'}
              </Badge>
              {isParent && (
                <Badge variant="secondary" className="bg-white/15 text-white border-white/20 text-xs backdrop-blur-sm gap-1">
                  <Baby className="h-3 w-3" />
                  Modo padre
                </Badge>
              )}
            </div>

            <h1 className="text-3xl md:text-5xl font-extrabold text-white leading-tight tracking-tight">
              Encuentra todo en
              <span className="block bg-gradient-to-r from-amber-300 to-yellow-200 bg-clip-text text-transparent">
                un solo lugar
              </span>
            </h1>

            <p className="text-white/70 text-sm md:text-base max-w-lg mx-auto">
              Escuelas, entrenadores, fisioterapeutas, eventos y productos deportivos — explora y reserva al instante.
            </p>

            <div className="relative max-w-2xl mx-auto">
              <div className="absolute inset-0 bg-white/10 rounded-2xl blur-xl" />
              <div className="relative flex gap-2">
                <div className="flex-1 relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Busca fútbol, entrenador, cheerleading..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="pl-11 pr-4 h-12 text-sm bg-white rounded-xl border-0 shadow-2xl focus:ring-4 focus:ring-white/30"
                  />
                </div>
                <Button
                  onClick={handleSearch}
                  className="h-12 px-6 rounded-xl shadow-2xl bg-amber-500 hover:bg-amber-600 text-white font-semibold"
                >
                  Buscar
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              {quickSports.map((sport) => (
                <Badge
                  key={sport}
                  variant="outline"
                  className={`border-white/25 text-white hover:bg-white/20 cursor-pointer text-xs transition-all ${
                    filters.sport === sport ? 'bg-white/25 border-white/50' : ''
                  }`}
                  onClick={() => updateFilters({ sport: filters.sport === sport ? undefined : sport })}
                >
                  {sport}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Category pills ───────────────────────────────────────────────────── */}
      <div className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="container mx-auto px-4 max-w-7xl">
          <div className="flex items-center gap-2 py-3 overflow-x-auto scrollbar-hide">
            {categories.map((cat) => {
              const Icon = cat.icon;
              const active = filters.category === cat.key;
              return (
                <button
                  key={cat.key}
                  onClick={() => updateFilters({ category: cat.key })}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all
                    ${active
                      ? `${cat.color} text-white shadow-lg scale-105`
                      : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                    }`}
                >
                  <Icon className="h-4 w-4" />
                  {cat.label}
                </button>
              );
            })}

            <div className="flex-1" />

            {/* View mode toggle */}
            <div className="flex rounded-lg border overflow-hidden shrink-0">
              <button
                onClick={() => setViewMode('grid')}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Lista
              </button>
              <button
                onClick={() => setViewMode('map')}
                className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === 'map' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                <MapIcon className="h-3.5 w-3.5" />
                Mapa
              </button>
            </div>

            {/* Filter sheet trigger */}
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 shrink-0">
                  <Filter className="h-4 w-4" />
                  Filtros
                  {activeFilterCount > 0 && (
                    <Badge className="h-5 w-5 p-0 text-[10px] flex items-center justify-center rounded-full">
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-80">
                <SheetHeader>
                  <SheetTitle>Filtros</SheetTitle>
                  <SheetDescription>Refina tu busqueda</SheetDescription>
                </SheetHeader>
                <div className="space-y-5 mt-6">
                  {/* City */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Ciudad</label>
                    <Input
                      placeholder="Ej. Bogota, Medellin..."
                      value={filters.city || ''}
                      onChange={(e) => updateFilters({ city: e.target.value || undefined })}
                    />
                  </div>

                  {/* Service type (only for services) */}
                  {(filters.category === 'all' || filters.category === 'services') && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Tipo de servicio</label>
                      <Select
                        value={filters.service_type || '__all__'}
                        onValueChange={(v) => updateFilters({ service_type: (v === '__all__' ? undefined : v) as ServiceType | undefined })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Todos los tipos" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">Todos</SelectItem>
                          {SERVICE_TYPES.map((st) => (
                            <SelectItem key={st.value} value={st.value}>
                              {st.icon} {st.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Sport (for events & schools) */}
                  {(filters.category === 'all' || filters.category === 'events' || filters.category === 'schools') && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Deporte</label>
                      <Input
                        placeholder="Ej. Futbol, Natacion..."
                        value={filters.sport || ''}
                        onChange={(e) => updateFilters({ sport: e.target.value || undefined })}
                      />
                    </div>
                  )}

                  {/* Price max */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Precio maximo</label>
                    <Input
                      type="number"
                      placeholder="Ej. 200000"
                      value={filters.price_max || ''}
                      onChange={(e) => updateFilters({ price_max: e.target.value ? Number(e.target.value) : undefined })}
                    />
                  </div>

                  {/* Sort */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Ordenar por</label>
                    <Select
                      value={filters.order_by}
                      onValueChange={(v) => updateFilters({ order_by: v as any })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="newest">Mas recientes</SelectItem>
                        <SelectItem value="price_asc">Precio: menor a mayor</SelectItem>
                        <SelectItem value="price_desc">Precio: mayor a menor</SelectItem>
                        <SelectItem value="name">Nombre A-Z</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  <Button variant="outline" className="w-full" onClick={clearFilters}>
                    <X className="h-4 w-4 mr-2" />
                    Limpiar filtros
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>

      {/* ── Map View ────────────────────────────────────────────────────────── */}
      {/* Reemplazado UnifiedExploreMap (rota — RPC search_explore_map usa
          columnas inexistentes s.lat/active/rating) por ExploreMapInteractive
          que lee directo de school_branches + schools + school_settings. */}
      {viewMode === 'map' && (
        <div className="container mx-auto px-4 py-6 max-w-7xl">
          <ExploreMapInteractive
            category={filters.category}
            query={filters.q}
            city={filters.city}
            sport={filters.sport}
          />
        </div>
      )}

      {/* ── Grid View ────────────────────────────────────────────────────────── */}
      {viewMode === 'grid' && (
      <div className="container mx-auto px-4 py-6 max-w-7xl">

        {/* Active filters */}
        {activeFilterCount > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {filters.q && (
              <Badge variant="secondary" className="gap-1 pr-1">
                Busqueda: "{filters.q}"
                <button onClick={() => { setSearchInput(''); updateFilters({ q: undefined }); }}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"><X className="h-3 w-3" /></button>
              </Badge>
            )}
            {filters.city && (
              <Badge variant="secondary" className="gap-1 pr-1">
                Ciudad: {filters.city}
                <button onClick={() => updateFilters({ city: undefined })}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"><X className="h-3 w-3" /></button>
              </Badge>
            )}
            {filters.service_type && (
              <Badge variant="secondary" className="gap-1 pr-1">
                {filters.service_type.replace('_', ' ')}
                <button onClick={() => updateFilters({ service_type: undefined })}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"><X className="h-3 w-3" /></button>
              </Badge>
            )}
            {filters.sport && (
              <Badge variant="secondary" className="gap-1 pr-1">
                {filters.sport}
                <button onClick={() => updateFilters({ sport: undefined })}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20"><X className="h-3 w-3" /></button>
              </Badge>
            )}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <Card key={i} className="overflow-hidden">
                <div className="aspect-[4/3] bg-muted animate-pulse" />
                <CardContent className="p-4 space-y-2">
                  <div className="h-4 bg-muted animate-pulse rounded" />
                  <div className="h-3 bg-muted animate-pulse rounded w-2/3" />
                  <div className="h-6 bg-muted animate-pulse rounded w-1/3 mt-2" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Results: grouped mode ('all') */}
        {!isLoading && grouped && (
          <>
            {/* Services section */}
            <SectionHeader
              icon={Stethoscope} label="Profesionales de Salud" color="bg-emerald-500"
              count={grouped.services.length}
              onViewAll={() => updateFilters({ category: 'services' })}
            />
            {grouped.services.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {grouped.services.map((item) => (
                  <ServiceCard key={`svc-${item.id}`} item={item} onBook={handleBook} />
                ))}
              </div>
            )}

            {/* Trainers section */}
            <SectionHeader
              icon={Dumbbell} label="Entrenadores" color="bg-violet-500"
              count={grouped.trainers.length}
              onViewAll={() => updateFilters({ category: 'trainers' })}
            />
            {grouped.trainers.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {grouped.trainers.map((item) => (
                  <TrainerCard key={`trn-${item.id}`} item={item} />
                ))}
              </div>
            )}

            {/* Events section */}
            <SectionHeader
              icon={Trophy} label="Eventos y Competencias" color="bg-amber-500"
              count={grouped.events.length}
              onViewAll={() => updateFilters({ category: 'events' })}
            />
            {grouped.events.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {grouped.events.map((item) => (
                  <EventCard key={`evt-${item.id}`} item={item} onRegister={handleRegisterEvent} />
                ))}
              </div>
            )}

            {/* Schools section */}
            <SectionHeader
              icon={GraduationCap} label="Escuelas y Academias" color="bg-blue-500"
              count={grouped.schools.length}
              onViewAll={() => updateFilters({ category: 'schools' })}
            />
            {grouped.schools.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {grouped.schools.map((item) => (
                  <SchoolCard key={`sch-${item.id}`} item={item} />
                ))}
              </div>
            )}

            {/* Products section (solo con la tienda prendida) */}
            {storeEnabled && (
              <SectionHeader
                icon={Package} label="Productos Deportivos" color="bg-rose-500"
                count={grouped.products.length}
                onViewAll={() => updateFilters({ category: 'products' })}
              />
            )}
            {storeEnabled && grouped.products.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {grouped.products.map((item) => (
                  <ProductCard key={`prd-${item.id}`} item={item} onAddToCart={handleAddToCart} />
                ))}
              </div>
            )}

            {/* No results at all */}
            {grouped.services.length === 0 && grouped.trainers.length === 0 && grouped.events.length === 0 &&
             grouped.schools.length === 0 && grouped.products.length === 0 && (
              <EmptyState onClear={clearFilters} />
            )}
          </>
        )}

        {/* Results: flat mode (single category) */}
        {!isLoading && !grouped && data?.items && (
          <>
            <p className="text-sm text-muted-foreground mb-4">
              {data.total} resultado{data.total !== 1 ? 's' : ''}
            </p>
            {data.items.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {data.items.map((item) => {
                  switch (item.item_type) {
                    case 'service':
                      return <ServiceCard key={`svc-${item.id}`} item={item} onBook={handleBook} />;
                    case 'trainer':
                      return <TrainerCard key={`trn-${item.id}`} item={item} />;
                    case 'event':
                      return <EventCard key={`evt-${item.id}`} item={item} onRegister={handleRegisterEvent} />;
                    case 'school':
                      return <SchoolCard key={`sch-${item.id}`} item={item} />;
                    case 'product':
                      return <ProductCard key={`prd-${item.id}`} item={item} onAddToCart={handleAddToCart} />;
                  }
                })}
              </div>
            ) : (
              <EmptyState onClear={clearFilters} />
            )}

            {/* Pagination */}
            {data.pages > 1 && (
              <div className="flex items-center justify-center gap-4 mt-8">
                <Button variant="outline" size="sm" onClick={prevPage} disabled={data.page <= 1}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Anterior
                </Button>
                <span className="text-sm text-muted-foreground">
                  Pagina {data.page} de {data.pages}
                </span>
                <Button variant="outline" size="sm" onClick={nextPage} disabled={data.page >= data.pages}>
                  Siguiente <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      )}

      {/* ── Service Booking Modal ─────────────────────────────────────────── */}
      {bookingItem && (
        <ServiceBookingModal
          open={!!bookingItem}
          onOpenChange={(open) => { if (!open) setBookingItem(null); }}
          service={bookingItem}
          isParent={isParent}
        />
      )}
    </div>
  );
}


// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="text-center py-16">
      <Search className="h-16 w-16 mx-auto text-muted-foreground/30 mb-4" />
      <h3 className="text-lg font-semibold mb-2">No se encontraron resultados</h3>
      <p className="text-muted-foreground mb-4">Intenta con otros filtros o terminos de busqueda</p>
      <Button variant="outline" onClick={onClear}>Limpiar filtros</Button>
    </div>
  );
}
