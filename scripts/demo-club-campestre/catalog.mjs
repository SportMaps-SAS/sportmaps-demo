// ============================================================
// Catálogo del tenant demo "Club Campestre Demo".
//
// Este archivo es SOLO datos: disciplinas, categorías, horarios, usuarios y
// nombres de relleno. El motor que los escribe está en seed.mjs.
//
// Convenciones:
//   - `day` en los horarios usa 0=Dom … 6=Sáb (igual que Date.getDay() y que
//     el SchedulePicker de OfferingsManagement.tsx, que es quien lee
//     offering_plans.metadata.schedule).
//   - Los precios son COP sin decimales.
//   - `key` de cada entidad es lo que alimenta el UUID determinista (ver duid()
//     en seed.mjs): cambiar un key crea una entidad NUEVA en vez de actualizar
//     la existente.
// ============================================================

// Fotos por deporte, alineadas con frontend/src/lib/sportImages.ts. Todas
// verificadas (HTTP 200) y revisadas a ojo: la que el front usaba para piscina
// responde 404, por eso acá van explícitas y no se improvisan.
const U = (id, w = 800) => `https://images.unsplash.com/${id}?auto=format&fit=crop&q=80&w=${w}`;
export const IMG = {
    banner: U('photo-1592919505780-303950717480', 2000),  // campo de golf abierto
    logo: U('photo-1587174486073-ae5e5cff23aa', 512),     // hoyo de golf (emblema)
    golf: U('photo-1535131749006-b7f58c99034b'),
    tenis: U('photo-1622279457486-62dcc4a431d6'),
    padel: U('photo-1587280501635-68a0e82cd5ff'),
    futbol: U('photo-1575361204480-aadea25e6e68'),
    voleibol: U('photo-1612872087720-bb876e2e67d1'),
    baloncesto: U('photo-1546519638-68e109498ffc'),
    natacion: U('photo-1530549387789-4c1017266635'),
    gimnasio: U('photo-1534438327276-14e5300c3a48'),
};

export const CLUB = {
    key: 'club',
    name: 'Club Campestre Demo',
    // El logo NO se escribe directo: un trigger obliga a pasar por la RPC
    // update_school_branding, que además solo acepta URLs del bucket
    // school-assets. El seed baja esta imagen, la sube al bucket y llama la RPC.
    logo_source: IMG.logo,
    cover_image_url: IMG.banner,
    branding: { primary_color: '#1f6f3f', secondary_color: '#c9a227' },
    slug: 'club-campestre-demo',
    school_type: 'club',
    business_model: 'both',
    // 'aggregator' = el checkout usa las llaves Wompi del BFF, que en este
    // entorno son SANDBOX (WOMPI_ENV=sandbox). Con 'direct' habría que cargarle
    // credenciales propias cifradas a la escuela y el checkout quedaría
    // fail-closed (sin fallback a ENV), rompiendo el pago en vivo de la demo.
    payment_mode: 'aggregator',
    city: 'Bogotá',
    address: 'Km 8 Vía La Calera, Bogotá D.C.',
    phone: '+57 601 555 0180',
    email: 'gerencia@demo.sportmaps.co',
    nit: '900.123.456-7',
    cuota_social: 180000,
    description:
        'Club social y deportivo multideporte con 8 unidades deportivas: golf, tenis, pádel, '
        + 'fútbol, voleibol, baloncesto, natación y gimnasio. Tenant de DEMOSTRACIÓN.',
};

// ── 1. Disciplinas = sedes (school_branches) ────────────────────────────────
// Cada disciplina es una unidad deportiva con su propia matrícula, mensualidad,
// categorías (teams), instalaciones y horarios. El coordinador de la disciplina
// queda scoped a esta sede vía school_members.branch_id.
export const DISCIPLINAS = [
    {
        key: 'golf', name: 'Golf', sport: 'Golf', img: IMG.golf, matricula: 250000, mensualidad: 320000,
        facilities: [
            { key: 'tee', name: 'Tee de práctica', type: 'Campo de Golf', capacity: 20 },
            { key: 'campo18', name: 'Campo 18 hoyos', type: 'Campo de Golf', capacity: 72 },
        ],
        categorias: [
            { key: 'infantil', name: 'Infantil', age: [6, 11], fill: 1 },
            { key: 'juvenil', name: 'Juvenil', age: [12, 17], fill: 2 },
            { key: 'adultos', name: 'Adultos', age: [18, 70], adult: true, fill: 1 },
            { key: 'alto', name: 'Alto Rendimiento', age: [14, 35], adult: true, fill: 0 },
        ],
        horarios: [
            { cat: 'juvenil', days: [2, 4], start: '16:00', end: '18:00', facility: 'tee' },
            { cat: 'adultos', days: [6], start: '07:00', end: '09:00', facility: 'campo18' },
        ],
    },
    {
        key: 'tenis', name: 'Tenis', sport: 'Tenis', img: IMG.tenis, matricula: 200000, mensualidad: 280000,
        facilities: [
            { key: 'canchas13', name: 'Canchas 1-3', type: 'Cancha de Tenis', capacity: 18 },
            { key: 'canchas46', name: 'Canchas 4-6', type: 'Cancha de Tenis', capacity: 18 },
        ],
        categorias: [
            { key: 'formativa', name: 'Escuela Formativa', age: [6, 12], fill: 2 },
            { key: 'juvenil_comp', name: 'Juvenil Competitivo', age: [13, 17], fill: 2 },
            { key: 'adultos', name: 'Adultos', age: [18, 70], adult: true, fill: 1 },
            { key: 'torneos', name: 'Torneos', age: [14, 60], adult: true, fill: 1 },
        ],
        horarios: [
            { cat: 'formativa', days: [1, 3, 5], start: '15:30', end: '17:00', facility: 'canchas13' },
            { cat: 'juvenil_comp', days: [2, 4], start: '17:00', end: '19:00', facility: 'canchas46' },
        ],
    },
    {
        key: 'padel', name: 'Pádel', sport: 'Pádel', img: IMG.padel, matricula: 150000, mensualidad: 220000,
        facilities: [
            { key: 'cubierta1', name: 'Cancha cubierta 1', type: 'Cancha de Pádel', capacity: 8 },
            { key: 'cubierta2', name: 'Cancha cubierta 2', type: 'Cancha de Pádel', capacity: 8 },
        ],
        categorias: [
            { key: 'recreativo', name: 'Recreativo', age: [18, 70], adult: true, fill: 2 },
            { key: 'intermedio', name: 'Intermedio', age: [18, 70], adult: true, fill: 1 },
            { key: 'competitivo', name: 'Competitivo', age: [18, 55], adult: true, fill: 1 },
        ],
        horarios: [
            { cat: 'intermedio', days: [3], start: '19:00', end: '20:30', facility: 'cubierta1' },
            { cat: 'recreativo', days: [1], start: '19:00', end: '20:30', facility: 'cubierta2' },
        ],
    },
    {
        key: 'futbol', name: 'Fútbol', sport: 'Fútbol', img: IMG.futbol, matricula: 120000, mensualidad: 180000,
        facilities: [
            { key: 'mini', name: 'Cancha mini fútbol', type: 'Cancha de Fútbol', capacity: 30 },
            { key: 'futbol11', name: 'Cancha fútbol 11', type: 'Cancha de Fútbol', capacity: 60 },
        ],
        categorias: [
            { key: 'sub8', name: 'Sub-8', age: [6, 8], fill: 2 },
            { key: 'sub10', name: 'Sub-10', age: [9, 10], fill: 2 },
            { key: 'sub12', name: 'Sub-12', age: [11, 12], fill: 2 },
            { key: 'sub15', name: 'Sub-15', age: [13, 15], fill: 3 },
            { key: 'mayores', name: 'Mayores', age: [18, 45], adult: true, fill: 1 },
        ],
        horarios: [
            { cat: 'sub10', days: [6], start: '08:00', end: '10:00', facility: 'mini' },
            { cat: 'sub15', days: [2, 4], start: '16:00', end: '18:00', facility: 'futbol11' },
        ],
    },
    {
        key: 'voleibol', name: 'Voleibol', sport: 'Voleibol', img: IMG.voleibol, matricula: 100000, mensualidad: 160000,
        facilities: [
            { key: 'cancha_voley', name: 'Cancha voleibol', type: 'Cancha de Voleibol', capacity: 24 },
        ],
        categorias: [
            { key: 'infantil', name: 'Infantil', age: [8, 12], fill: 1 },
            { key: 'juvenil', name: 'Juvenil', age: [13, 17], fill: 2 },
            { key: 'mixto', name: 'Mixto Adultos', age: [18, 60], adult: true, fill: 1 },
        ],
        horarios: [
            { cat: 'juvenil', days: [1, 3], start: '17:00', end: '18:30', facility: 'cancha_voley' },
            { cat: 'infantil', days: [5], start: '16:00', end: '17:30', facility: 'cancha_voley' },
        ],
    },
    {
        key: 'baloncesto', name: 'Baloncesto', sport: 'Baloncesto', img: IMG.baloncesto, matricula: 100000, mensualidad: 160000,
        facilities: [
            { key: 'cancha_basket', name: 'Cancha básquet', type: 'Cancha de Baloncesto', capacity: 24 },
        ],
        categorias: [
            { key: 'infantil', name: 'Infantil', age: [8, 12], fill: 1 },
            { key: 'juvenil', name: 'Juvenil', age: [13, 17], fill: 2 },
            { key: 'mixto', name: 'Mixto Adultos', age: [18, 60], adult: true, fill: 1 },
        ],
        horarios: [
            { cat: 'juvenil', days: [2, 4], start: '18:00', end: '19:30', facility: 'cancha_basket' },
            { cat: 'infantil', days: [6], start: '10:00', end: '11:30', facility: 'cancha_basket' },
        ],
    },
    {
        key: 'natacion', name: 'Natación', sport: 'Natación', img: IMG.natacion, matricula: 130000, mensualidad: 200000,
        facilities: [
            { key: 'carriles12', name: 'Piscina carriles 1-2', type: 'Piscina', capacity: 16 },
            { key: 'piscina_full', name: 'Piscina completa', type: 'Piscina', capacity: 40 },
        ],
        categorias: [
            { key: 'infantil', name: 'Infantil', age: [4, 8], fill: 2 },
            { key: 'formativo', name: 'Formativo', age: [9, 14], fill: 2 },
            { key: 'competitivo', name: 'Competitivo', age: [12, 22], fill: 1 },
            { key: 'libre_adultos', name: 'Libre Adultos', age: [18, 70], adult: true, fill: 1 },
        ],
        horarios: [
            { cat: 'infantil', days: [1, 3, 5], start: '16:00', end: '17:00', facility: 'carriles12' },
            { cat: 'competitivo', days: [1, 2, 3, 4, 5], start: '05:30', end: '07:00', facility: 'piscina_full' },
        ],
    },
    {
        key: 'gimnasio', name: 'Gimnasio', sport: 'Gimnasio', img: IMG.gimnasio, matricula: 0, mensualidad: 150000,
        facilities: [
            { key: 'sala_maquinas', name: 'Sala de máquinas', type: 'Gimnasio', capacity: 40 },
            { key: 'salon_dirigido', name: 'Salón de clases dirigidas', type: 'Gimnasio', capacity: 25 },
        ],
        categorias: [
            { key: 'libre', name: 'Libre', age: [16, 70], adult: true, fill: 1 },
            { key: 'dirigido', name: 'Dirigido (personal trainer)', age: [16, 70], adult: true, fill: 1 },
        ],
        horarios: [
            { cat: 'dirigido', days: [1, 3, 5], start: '06:00', end: '07:00', facility: 'salon_dirigido' },
            { cat: 'libre', days: [1, 2, 3, 4, 5], start: '06:00', end: '08:00', facility: 'sala_maquinas' },
        ],
    },
];

// ── 2. Staff ────────────────────────────────────────────────────────────────
// `member_role` va a school_members.role: 'owner' y 'admin' sin branch son
// globales; 'admin' CON branch queda scoped a esa disciplina
// (useSchoolContext.ts:208 → isScopedAdmin).
// `signup_role` es lo que se manda en user_metadata.role: el trigger
// handle_new_user lo mapea a profiles.role ('school' para todo lo administrativo).
export const STAFF = [
    {
        key: 'gerencia', email: 'gerencia@demo.sportmaps.co', full_name: 'Ricardo Mendoza',
        signup_role: 'school', member_role: 'owner', branch: null, is_owner: true,
        phone: '+57 310 555 0101', cargo: 'Gerencia General',
    },
    {
        // Rol `reporter`, que la UI llama "Auditor" (AdminUsersPage.tsx). Es el
        // único perfil acotado a consulta: ve cartera consolidada, morosos y
        // reportes exportables en /reporter-dashboard, y NO puede editar
        // deportistas, horarios ni configuración (la matriz `reporter` del BFF
        // solo trae permisos :view). Antes estaba como `admin`, que abre el mismo
        // panel completo que el dueño — demasiado para una administradora
        // financiera de un club cliente.
        // Contrapartida: /finances y /accounting (conciliación, nómina,
        // proveedores) siguen siendo solo de los roles admin → esa parte se
        // muestra con Ricardo.
        key: 'finanzas', email: 'finanzas@demo.sportmaps.co', full_name: 'Patricia Vargas',
        signup_role: 'reporter', member_role: 'reporter', branch: null,
        phone: '+57 310 555 0102', cargo: 'Auditora — Finanzas (solo lectura)',
    },
    {
        key: 'coord_golf', email: 'golf@demo.sportmaps.co', full_name: 'Andrés Salazar',
        signup_role: 'school_admin', member_role: 'admin', branch: 'golf',
        phone: '+57 310 555 0103', cargo: 'Coordinador de Golf',
    },
    {
        key: 'coord_tenis', email: 'tenis@demo.sportmaps.co', full_name: 'Camila Restrepo',
        signup_role: 'school_admin', member_role: 'admin', branch: 'tenis',
        phone: '+57 310 555 0104', cargo: 'Coordinadora de Tenis',
    },
    {
        key: 'coord_natacion', email: 'natacion@demo.sportmaps.co', full_name: 'Jorge Pineda',
        signup_role: 'school_admin', member_role: 'admin', branch: 'natacion',
        phone: '+57 310 555 0105', cargo: 'Coordinador de Natación',
    },
    {
        key: 'porteria', email: 'porteria@demo.sportmaps.co', full_name: 'Puesto Portería Principal',
        signup_role: 'school_admin', member_role: 'admin', branch: null,
        phone: '+57 310 555 0106', cargo: 'Control de Acceso',
    },
];

export const COACHES = [
    {
        key: 'coach_tenis', email: 'entrenador.tenis@demo.sportmaps.co', full_name: 'Felipe Torres',
        signup_role: 'coach', member_role: 'coach', branch: 'tenis',
        specialty: 'Tenis — formación competitiva', phone: '+57 311 555 0201',
        teams: [{ disciplina: 'tenis', cat: 'juvenil_comp' }],
    },
    {
        key: 'coach_natacion', email: 'entrenadora.natacion@demo.sportmaps.co', full_name: 'Laura Gómez',
        signup_role: 'coach', member_role: 'coach', branch: 'natacion',
        specialty: 'Natación — iniciación infantil', phone: '+57 311 555 0202',
        teams: [{ disciplina: 'natacion', cat: 'infantil' }],
    },
    // Agregado el 2026-10-26 para probar y documentar el Entrenador V2 (partidos
    // con goles/tarjetas solo salen en fútbol). Se crea con add-coach.mjs, sin
    // volver a correr el seed completo.
    {
        key: 'coach_futbol', email: 'entrenador.futbol@demo.sportmaps.co', full_name: 'Andrés Ríos',
        signup_role: 'coach', member_role: 'coach', branch: 'futbol',
        specialty: 'Fútbol — formación Sub-12 y Sub-15', phone: '+57 311 555 0203',
        teams: [{ disciplina: 'futbol', cat: 'sub15' }, { disciplina: 'futbol', cat: 'sub12' }],
    },
];

// ── 3. Usuarios finales nominales ───────────────────────────────────────────
export const PARENTS = [
    {
        key: 'mherrera', email: 'mherrera@demo.sportmaps.co', full_name: 'Mauricio Herrera',
        phone: '+57 320 555 0301', cuota_social: 'paid',
        children: [
            {
                key: 'sofia', full_name: 'Sofía Herrera', age: 9, gender: 'F',
                enrollments: [{ disciplina: 'natacion', cat: 'infantil', pay: 'al_dia', method: 'wompi_card' }],
                zk_pin: null,
            },
            {
                key: 'tomas', full_name: 'Tomás Herrera', age: 13, gender: 'M',
                enrollments: [
                    { disciplina: 'futbol', cat: 'sub15', pay: 'al_dia', method: 'wompi_nequi' },
                    { disciplina: 'tenis', cat: 'juvenil_comp', pay: 'mora_1', method: null },
                ],
                zk_pin: null,
            },
        ],
    },
];

export const ATHLETES = [
    {
        key: 'vcruz', email: 'vcruz@demo.sportmaps.co', full_name: 'Valentina Cruz',
        age: 34, gender: 'F', phone: '+57 320 555 0302', cuota_social: 'paid',
        zk_pin: 1001, autopay: true,
        enrollments: [
            { disciplina: 'golf', cat: 'adultos', pay: 'al_dia', method: 'wompi_card' },
            { disciplina: 'gimnasio', cat: 'dirigido', pay: 'al_dia', method: 'wompi_card' },
        ],
    },
    {
        key: 'dospina', email: 'dospina@demo.sportmaps.co', full_name: 'Daniel Ospina',
        age: 28, gender: 'M', phone: '+57 320 555 0303', cuota_social: 'overdue',
        zk_pin: 1002, autopay: false,
        enrollments: [
            { disciplina: 'padel', cat: 'intermedio', pay: 'mora_2', method: null },
        ],
    },
];

// No socia: solo se inscribe al torneo abierto de tenis.
export const EXTERNAL = {
    key: 'aruiz', email: 'aruiz.externa@demo.sportmaps.co', full_name: 'Alejandra Ruiz',
    age: 26, gender: 'F', phone: '+57 320 555 0304',
};

export const TORNEO = {
    key: 'torneo_tenis',
    title: 'Torneo Abierto de Tenis — Club Campestre Demo',
    slug: 'torneo-abierto-tenis-club-campestre-demo',
    sport: 'Tenis',
    price: 95000,
    capacity: 32,
    days_ahead: 24,           // se juega dentro de ~3 semanas
    start_time: '08:00',
    end_time: '18:00',
};

// ── 4. Padres de relleno (para colgar a los menores dummy) ──────────────────
export const FILLER_PARENTS = [
    { key: 'fp1', email: 'familia.rojas@demo.sportmaps.co', full_name: 'Claudia Rojas', phone: '+57 321 555 0401' },
    { key: 'fp2', email: 'familia.moreno@demo.sportmaps.co', full_name: 'Óscar Moreno', phone: '+57 321 555 0402' },
    { key: 'fp3', email: 'familia.castano@demo.sportmaps.co', full_name: 'Diana Castaño', phone: '+57 321 555 0403' },
    { key: 'fp4', email: 'familia.jaramillo@demo.sportmaps.co', full_name: 'Hernán Jaramillo', phone: '+57 321 555 0404' },
    { key: 'fp5', email: 'familia.quintero@demo.sportmaps.co', full_name: 'Marcela Quintero', phone: '+57 321 555 0405' },
];

// ── 5. Nombres de relleno ───────────────────────────────────────────────────
// Menores → filas en `children` (colgados de los FILLER_PARENTS).
export const FILLER_MINORS = [
    'Juan Esteban Rojas', 'Mariana Rojas', 'Samuel Moreno', 'Isabella Moreno',
    'Emiliano Castaño', 'Luciana Castaño', 'Martín Jaramillo', 'Valeria Jaramillo',
    'Santiago Quintero', 'Antonia Quintero', 'Nicolás Beltrán', 'Salomé Beltrán',
    'Matías Cárdenas', 'Renata Cárdenas', 'Tomás Duarte', 'Julieta Duarte',
    'Alejandro Peña', 'Manuela Peña', 'Sebastián Ríos', 'Sara Ríos',
    'Andrés Felipe Osorio', 'Camila Osorio', 'Juan Pablo Naranjo', 'Gabriela Naranjo',
    'Diego Alejandro Mesa', 'Sofía Mesa', 'Iván Zapata', 'Laura Zapata',
];

// Adultos → filas en `unregistered_athletes` (deportistas sin cuenta, como en
// los tenants reales). No consumen usuarios de auth.
export const FILLER_ADULTS = [
    'Carlos Andrés Buitrago', 'Mónica Lozano', 'Fernando Acosta', 'Adriana Cifuentes',
    'Rodrigo Villalba', 'Paola Andrade', 'Germán Escobar', 'Natalia Bermúdez',
    'Álvaro Sepúlveda', 'Liliana Guzmán', 'Mauricio Tovar', 'Sandra Rincón',
    'Jorge Iván Palacios',
];

// ── 6. Mezcla de estados de cartera para el relleno ─────────────────────────
// ~80% al día, ~15% mora de 1 mes, ~5% mora de 2+ meses.
export const PAY_MIX = { al_dia: 0.80, mora_1: 0.15, mora_2: 0.05 };

// Métodos de pago históricos (mayo–julio) con su mezcla.
export const METHOD_MIX = [
    { key: 'wompi_card', weight: 0.40 },
    { key: 'wompi_nequi', weight: 0.25 },
    { key: 'transfer_ocr', weight: 0.25 },
    { key: 'cash', weight: 0.10 },
];

// Cómo se traduce cada método a las columnas reales de `payments`.
export const METHODS = {
    wompi_card: { payment_method: 'card', payment_channel: 'online', payment_provider: 'wompi' },
    wompi_nequi: { payment_method: 'other', payment_channel: 'online', payment_provider: 'wompi' },
    transfer_ocr: { payment_method: 'transfer', payment_channel: 'transfer', payment_provider: 'wompi', ocr: true },
    cash: { payment_method: 'cash', payment_channel: 'cash', payment_provider: 'wompi' },
};

// Bancos para los comprobantes con OCR.
export const BANCOS = ['Bancolombia', 'Davivienda', 'Banco de Bogotá', 'Nequi', 'BBVA'];

// ── 7. Addons a habilitar (para que la demo no choque con paywalls) ─────────
// OJO: 'mp' (MercadoPago) queda FUERA a propósito. El token de MP de este
// entorno es de PRODUCCIÓN (APP_USR-), así que un cobro por MP en la demo sería
// un cobro real. Wompi sí está en sandbox.
export const ADDONS = [
    'access_control', 'tournaments', 'accounting', 'whatsapp', 'wompi', 'store', 'invoicing',
];

// ── 8. Reservas de instalaciones ────────────────────────────────────────────
// Tarifa por hora de cada instalación (0 = no se alquila, solo uso interno).
// `rental` marca las que además se alquilan a terceros (empresas, colegios).
export const TARIFAS = {
    tee: { hora: 45000, rental: false },
    campo18: { hora: 180000, rental: true },
    canchas13: { hora: 60000, rental: true },
    canchas46: { hora: 70000, rental: true },
    cubierta1: { hora: 80000, rental: true },
    cubierta2: { hora: 80000, rental: true },
    mini: { hora: 120000, rental: true },
    futbol11: { hora: 240000, rental: true },
    cancha_voley: { hora: 90000, rental: true },
    cancha_basket: { hora: 90000, rental: true },
    carriles12: { hora: 70000, rental: false },
    piscina_full: { hora: 150000, rental: true },
    sala_maquinas: { hora: 0, rental: false },
    salon_dirigido: { hora: 60000, rental: true },
};

// Empresas/colegios que alquilan escenarios (booker_type='external', resv_type='rental').
export const ARRENDATARIOS = [
    'Colegio San Bartolomé', 'Empresa Nutresa — torneo interno', 'Liga de Tenis de Bogotá',
    'Universidad de los Andes', 'Grupo Bancolombia — bienestar', 'Colegio Anglo Colombiano',
];

// Motivos de cancelación (para que el histórico no se vea sintético).
export const MOTIVOS_CANCELACION = [
    'Lluvia — cancha no apta', 'El socio canceló con 24h de anticipación',
    'Cruce con torneo interno', 'Mantenimiento preventivo del escenario',
    'No se confirmó el pago del depósito',
];

// ── 9. Lectores biométricos ─────────────────────────────────────────────────
export const DEVICES = [
    {
        key: 'entry', serial_number: 'DEMOCAMP0001', device_name: 'Portería Principal — Entrada',
        direction: 'entry', location: 'Portería Principal', brand: 'ZKTeco',
    },
    {
        key: 'exit', serial_number: 'DEMOCAMP0002', device_name: 'Portería Principal — Salida',
        direction: 'exit', location: 'Portería Principal', brand: 'ZKTeco',
    },
];
