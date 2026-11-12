import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Users, GraduationCap, School, Check, User, Activity, ShoppingBag, CalendarDays, Loader2, Dumbbell, Store } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface RoleSelectionProps {
  onNavigate: (page: string) => void;
  onRoleSelect: (role: string) => void;
}

interface RoleOption {
  id: string; // This corresponds to the 'name' in DB (e.g., 'school', 'athlete')
  title: string; // display_name
  description: string;
  icon: React.ElementType;
  bgColor: string;
  iconColor: string;
}

// Fallback usado si la tabla `roles` esta vacia o la consulta falla.
// Refleja el seed de migracion 20260511000002.
const FALLBACK_ROLES: RoleOption[] = [
  { id: "athlete",              title: "Deportista",              description: "Reservas y tienda",                            icon: Users,         bgColor: "bg-primary/10",    iconColor: "text-primary" },
  { id: "parent",               title: "Padre / Madre",           description: "Gestión de hijos y pagos",                     icon: User,          bgColor: "bg-emerald-50",    iconColor: "text-emerald-600" },
  { id: "coach",                title: "Entrenador",              description: "Clases, agenda y pagos",                       icon: GraduationCap, bgColor: "bg-secondary/10",  iconColor: "text-secondary" },
  { id: "personal_trainer",     title: "Entrenador Personal",     description: "Sesiones, planes y asesorías",                 icon: Dumbbell,      bgColor: "bg-red-50",        iconColor: "text-red-500" },
  { id: "school_admin",         title: "Escuela / Centro",        description: "Entrenadores, agenda y cobros",                icon: School,        bgColor: "bg-orange-50",     iconColor: "text-orange-500" },
  { id: "wellness_professional",title: "Profesional de Bienestar",description: "Fisioterapia, nutrición, psicología",          icon: Activity,      bgColor: "bg-green-50",      iconColor: "text-green-500" },
  { id: "external_vendor",      title: "Vendedor / Marca",        description: "Tienda, marca o distribuidor deportivo",       icon: Store,         bgColor: "bg-purple-50",     iconColor: "text-purple-600" },
  { id: "organizer",            title: "Organizador de Eventos",  description: "Torneos y eventos",                            icon: CalendarDays,  bgColor: "bg-yellow-50",     iconColor: "text-yellow-500" },
];

const RoleSelection = ({ onNavigate, onRoleSelect }: RoleSelectionProps) => {
  const [selectedRole, setSelectedRole] = useState<string>("athlete");
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  // Mapeo de iconos y colores estáticos para mejorar la UI
  const getRoleMetadata = (roleName: string) => {
    switch (roleName) {
      case "school":
      case "school_admin":
        return { icon: School, bgColor: "bg-orange-50", iconColor: "text-orange-500", route: "school-register" };
      case "coach":
        return { icon: GraduationCap, bgColor: "bg-secondary/10", iconColor: "text-secondary", route: "coach-register" };
      case "athlete":
        return { icon: Users, bgColor: "bg-primary/10", iconColor: "text-primary", route: "athlete-register" };
      case "parent":
        return { icon: User, bgColor: "bg-emerald-50", iconColor: "text-emerald-600", route: "athlete-register" };
      case "wellness_professional":
        return { icon: Activity, bgColor: "bg-green-50", iconColor: "text-green-500", route: "wellness-register" };
      case "personal_trainer":
        return { icon: Dumbbell, bgColor: "bg-red-50", iconColor: "text-red-500", route: "trainer-register" };
      case "external_vendor":
        return { icon: Store, bgColor: "bg-purple-50", iconColor: "text-purple-600", route: "vendor-register" };
      case "store_owner":
        return { icon: ShoppingBag, bgColor: "bg-purple-50", iconColor: "text-purple-500", route: "store-register" };
      case "organizer":
        return { icon: CalendarDays, bgColor: "bg-yellow-50", iconColor: "text-yellow-500", route: "organizer/onboarding" };
      default:
        return { icon: Users, bgColor: "bg-gray-50", iconColor: "text-gray-500", route: "register-default" };
    }
  };

  useEffect(() => {
    const fetchRoles = async () => {
      try {
        setLoading(true);
        // Intentar cargar desde la tabla 'roles'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any)
          .from('roles')
          .select('*')
          .eq('is_visible', true)
          .order('display_name');

        if (error) throw error;

        if (data && data.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mappedRoles = data.map((r: any) => {
            const meta = getRoleMetadata(r.name);
            return {
              id: r.name, // Usamos 'name' como ID para compatibilidad con el resto de la app
              title: r.display_name,
              description: r.description || "",
              icon: meta.icon,
              bgColor: meta.bgColor,
              iconColor: meta.iconColor
            };
          });
          setRoles(mappedRoles);
        } else {
          // Fallback si la tabla está vacía o no existe aún
          console.warn("No roles found in DB, using default roles");
          setRoles(FALLBACK_ROLES);
        }

      } catch (err: unknown) {
        console.error("Error fetching roles:", err);
        // Fallback silencioso para no bloquear al usuario
        setRoles(FALLBACK_ROLES);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((err as any).code !== '42P01') { // Ignore "relation does not exist" if migration not run
          toast({ title: "Aviso", description: "Usando configuración local de roles.", variant: "default" });
        }
      } finally {
        setLoading(false);
      }
    };

    fetchRoles();
  }, [toast]);

  const handleRoleSelect = (roleId: string) => {
    setSelectedRole(roleId);
  };

  const handleContinue = () => {
    onRoleSelect(selectedRole);
    // Navegación inteligente basada en el rol
    if (["school", "school_admin"].includes(selectedRole)) {
      onNavigate("school-register");
    } else if (selectedRole === "coach") {
      onNavigate("coach-register");
    } else if (selectedRole === "athlete" || selectedRole === "parent") {
      onNavigate("athlete-register");
    } else if (selectedRole === "personal_trainer") {
      onNavigate("trainer-register");
    } else if (selectedRole === "external_vendor" || selectedRole === "store_owner") {
      onNavigate("vendor-register");
    } else if (selectedRole === "wellness_professional") {
      onNavigate("wellness-register");
    } else {
      // Roles sin pantalla dedicada — registro genérico
      onNavigate("athlete-register");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30 py-8" style={{ fontFamily: 'Inter, sans-serif' }}>
      <div className="container mx-auto px-4 max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold mb-2">Selecciona tu Rol</h1>
          <p className="text-muted-foreground">
            Elige cómo quieres usar SportMaps para personalizar tu experiencia
          </p>
        </div>

        <div className="space-y-4 mb-8">
          {roles.map((role) => {
            const Icon = role.icon;
            const isSelected = selectedRole === role.id;

            return (
              <Card
                key={role.id}
                className={`cursor-pointer transition-all duration-300 hover:shadow-card ${isSelected ? 'border-primary ring-2 ring-primary bg-primary/5' : 'hover:border-primary/50'
                  }`}
                onClick={() => handleRoleSelect(role.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className={`w-14 h-14 rounded-lg ${role.bgColor} ${role.iconColor} flex items-center justify-center`}>
                      <Icon className="w-7 h-7" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-foreground">{role.title}</h3>
                      <p className="text-sm text-muted-foreground">{role.description}</p>
                    </div>
                    {isSelected && (
                      <Check className="w-6 h-6 text-primary" />
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Button
          variant="hero"
          size="lg"
          className="w-full"
          onClick={handleContinue}
        >
          Continuar
        </Button>

        <div className="text-center mt-6">
          <p className="text-sm text-muted-foreground">
            ¿Ya tienes cuenta?{" "}
            <button
              className="text-primary font-medium hover:underline"
              onClick={() => onNavigate("login")}
            >
              Iniciar sesión
            </button>
          </p>
        </div>
      </div>
    </div>
  );
};

export default RoleSelection;