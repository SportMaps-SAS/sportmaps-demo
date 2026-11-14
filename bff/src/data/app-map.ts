/**
 * Mapa de la app por rol, para el bot de soporte in-app (Mapi,
 * `services/inapp-support-bot.service.ts`). Se inyecta en el system prompt
 * para que pueda responder "¿dónde / cómo hago X?" con la ruta exacta del
 * menú y los botones que el usuario ve en pantalla.
 *
 * DERIVADO DEL CÓDIGO del frontend al 2026-10-06, no inventado:
 *   - frontend/src/config/navigation.ts      (menús por rol; OJO: hay DOS
 *     árboles para la escuela, `school` y `school_admin`)
 *   - frontend/src/components/AppSidebar.tsx (qué rol usa cada menú y qué
 *     ítems se esconden: Membresías, Deportes y Categorías, pagos)
 *   - frontend/src/config/routePermissions.ts, frontend/src/App.tsx
 *   - frontend/src/config/module-catalog.ts  (módulos que el Super Admin
 *     puede apagar por escuela → ModuleGate)
 *   - frontend/src/lib/permissions.ts         (PermissionGate por rol)
 *   - las páginas de cada ítem (títulos, botones, title="...")
 *
 * HAY QUE ACTUALIZARLO cuando cambien los menús o los textos de los botones:
 * una indicación equivocada es peor que ninguna. Regla al editar: si una
 * etiqueta no se puede confirmar en el código, la tarea no entra.
 * Las rutas usan las etiquetas DEL MENÚ; si el título de la pantalla es
 * distinto se aclara entre paréntesis.
 * Donde un artículo de ayuda contradice al código, este mapa sigue al código.
 *
 * 2026-10-27: entrenador, acudiente y deportista pasaron a la V2 (pestañas
 * abajo + «Más»), derivada de frontend/src/components/{coach,parent,athlete}/v2,
 * lib/acudienteTabs.ts y components/v2/RutasSegunRol.tsx. La V1 queda en
 * `vistaAnterior` (la V2 se apaga por flag). Excepción a la regla de arriba:
 * «Pizarra» (primer ítem de Más > Entrenamiento y botón en Hoy) y el grupo
 * «Comunicación» (antes «Se usan poco») entran en el paquete del mismo día.
 */

export interface AppMapEntry {
    tarea: string;
    pasos: string;
    palabrasClave?: string[];
    /** slug de bff/src/data/help-articles.ts (se enlaza como /ayuda/<slug>) */
    articulo?: string;
    /** ModuleKey de frontend/src/config/module-catalog.ts si el ítem se puede apagar por escuela */
    modulo?: string;
}

export interface AppMapRole {
    rol: string;
    resumen: string;
    /** El menú lateral tal como lo ve el usuario, una línea por grupo/ítem. */
    menu: string;
    tareas: AppMapEntry[];
    /**
     * Menú de la versión anterior (V1) para los roles con V2 (entrenador,
     * acudiente, deportista). La V2 está prendida por defecto y se apaga por
     * flag (VITE_ENTRENADOR_V2 / VITE_ACUDIENTE_V2 / VITE_DEPORTISTA_V2 = false):
     * el BFF no sabe cuál ve el usuario, así que Mapi responde con la V2 y usa
     * esto solo si el usuario dice que no ve esas pestañas.
     */
    vistaAnterior?: string;
    /** Cosas que suelen pedir y este rol NO puede hacer (y quién sí). */
    noPuede: string[];
}

const SOPORTE =
    'Chat de soporte: botón redondo con la cara del lémur Mapi abajo a la derecha (en todas las pantallas) → ventana "Mapi · Soporte SportMaps". Es ESTE mismo chat: a quien ya está hablando con Mapi no lo mandes a abrirlo; ofrécele pasar su caso a una persona.';

const CONFIG_PERSONAL: AppMapEntry[] = [
    {
        tarea: 'Cambiar contraseña',
        pasos: 'Configuración > pestaña "Seguridad" > "Nueva Contraseña" y "Confirmar Nueva Contraseña" > "Actualizar Contraseña".',
        palabrasClave: ['contraseña', 'clave', 'password'],
    },
    {
        tarea: 'Editar mis datos personales / notificaciones',
        pasos: 'Configuración > pestaña "Perfil" > "Guardar Cambios". Notificaciones: pestaña "Notificaciones" > "Actualizar Preferencias".',
        palabrasClave: ['perfil', 'nombre', 'teléfono', 'notificaciones'],
    },
    {
        tarea: 'Eliminar mi cuenta',
        pasos: 'Configuración > pestaña "Seguridad" > "Zona de Peligro" > "Eliminar Cuenta" > "Sí, eliminar mi cuenta". Se borra a los 30 días; se puede deshacer con "Cancelar la eliminación".',
        palabrasClave: ['eliminar cuenta', 'borrar cuenta', 'darme de baja'],
    },
];

/**
 * Las mismas tareas de cuenta con la entrada de cada app: en la V2 la
 * configuración vive en «Más» con otro nombre ("Mi cuenta" del acudiente,
 * "Mis datos y configuración" del entrenador, "Configuración" del deportista).
 */
function configPersonal(entrada: string): AppMapEntry[] {
    return CONFIG_PERSONAL.map((t) => ({ ...t, pasos: t.pasos.replace(/^Configuración/, entrada) }));
}

export const APP_MAP: Record<string, AppMapRole> = {
    // ─── Escuela (owner / school / school_admin) ────────────────────────────
    school: {
        rol: 'Escuela (dueño o administrador)',
        resumen:
            'Administra la escuela completa. El administrador (school_admin) ve el mismo menú salvo "Mi Perfil Público". Algunos ítems pueden no aparecer: el Super Admin puede apagar módulos por escuela, Contabilidad / Facturación electrónica / Control de Acceso / Mis Torneos dependen de que el plan los incluya, y si la escuela no cobra por SportMaps se ocultan Pagos, Finanzas y Recordatorios (y aparece "Membresías"). "Deportes y Categorías" solo aparece si la escuela tiene más de un deporte.',
        menu: [
            'Principal: Dashboard · Deportistas · Matrículas por revisar · Entrenadores · Invitaciones',
            'Gestión Deportiva: Equipos y Planes (Mis Equipos, Deportes y Categorías, Membresías, Mis Planes) · Calendario · Entrenamiento (Métricas y Rendimiento, Gestión de Rutinas) · Informe Mensual · Asistencias (Supervisión, Histórico, Encuestas) · Resultados · Mis Torneos · Dotación',
            'Finanzas: Pagos · Modo Recepción · Contabilidad (Contabilidad, Proveedores, Nómina, Estado de resultados, Presupuesto) · Facturación electrónica',
            'Reportes: Finanzas · Reportes · Panel de Reportes',
            'Documentos e Identidad: Carnets (Carnets Digitales, Plantillas de Carnets) · Constancias · QR de Inscripción',
            'Comunicación: WhatsApp · Recordatorios · Plantillas de Mensajes',
            'Sedes e Instalaciones: Sedes · Instalaciones · Control de Acceso',
            'Cuenta: Mi Perfil Público · Facturación (plan de SportMaps) · Configuración',
        ].join('\n'),
        tareas: [
            {
                tarea: 'Crear un equipo',
                pasos: 'Gestión Deportiva > Equipos y Planes > Mis Equipos > botón "Nuevo Equipo" > "Nombre del Equipo" y "Deporte" (obligatorios), opcional "Precio Mensual", "Entrenadores Asignados", "Ubicación / Sede" > "Crear Equipo".',
                palabrasClave: ['equipo', 'grupo', 'categoría', 'crear equipo'],
                modulo: 'gestion_deportiva_equipos_planes',
            },
            {
                tarea: 'Editar un equipo (nombre, precio, sede)',
                pasos: 'Mis Equipos > ícono lápiz "Editar Equipo" en la fila del equipo (en vista de tarjetas: "Gestionar / Editar") > cambia los datos > "Guardar Cambios".',
                palabrasClave: ['editar equipo', 'renombrar', 'cambiar nombre', 'mensualidad del equipo'],
                modulo: 'gestion_deportiva_equipos_planes',
            },
            {
                tarea: 'Asignar un entrenador a un equipo',
                pasos: 'Mis Equipos > lápiz "Editar Equipo" > campo "Entrenadores Asignados" > elige el entrenador (se pueden poner varios) > "Guardar Cambios". No se hace desde Entrenadores.',
                palabrasClave: ['asignar coach', 'asignar entrenador', 'entrenador del equipo'],
                modulo: 'gestion_deportiva_equipos_planes',
            },
            {
                tarea: 'Inscribir / sacar deportistas de un equipo',
                pasos: 'Mis Equipos > ícono "Gestionar Deportistas" en la fila del equipo > ventana "Inscribir Deportistas" > busca al deportista > "Inscribir" (o "Remover"). Si ya está en otro equipo te ofrece agregarlo también o moverlo.',
                palabrasClave: ['inscribir', 'agregar al equipo', 'mover de equipo', 'cambiar de equipo'],
                modulo: 'gestion_deportiva_equipos_planes',
            },
            {
                tarea: 'Archivar o eliminar un equipo',
                pasos: 'Mis Equipos > menú "⋯" (Más acciones) del equipo > "Archivar" (se recupera con "Reactivar" desde "Archivados"). "Eliminar permanente" solo funciona si el equipo no tiene deportistas ni inscripciones; si tiene, archívalo.',
                palabrasClave: ['archivar', 'eliminar equipo', 'borrar equipo'],
                modulo: 'gestion_deportiva_equipos_planes',
            },
            {
                tarea: 'Registrar un deportista nuevo',
                pasos: 'Deportistas (la pantalla dice "Atletas") > "Agregar Atleta" > llena "Nombre completo", acudiente, "Equipo", "Plan", "Mensualidad" > "Agregar Atleta". Se crea el primer cobro y se invita al acudiente.',
                palabrasClave: ['nuevo atleta', 'nuevo deportista', 'alumno', 'matricular', 'inscribir alumno'],
                articulo: 'registrar-nuevo-atleta',
            },
            {
                tarea: 'Editar los datos de un deportista',
                pasos: 'Deportistas > menú "Más acciones" de la fila > "Editar" > "Guardar Cambios". El cambio de equipo también se hace con el campo "Equipo" de esa ventana.',
                palabrasClave: ['editar atleta', 'datos del alumno', 'fecha de nacimiento', 'documento'],
            },
            {
                tarea: 'Dar de baja / inactivar un deportista',
                pasos: 'Deportistas > menú "Más acciones" > "Inactivar". Cancela su plan y anula sus cobros pendientes. Se revierte con "Reactivar" (pestaña "Inactivos"). Si es por vacaciones: "🏖️ Vacaciones / pausa" (si la escuela lo tiene activo).',
                palabrasClave: ['dar de baja', 'retirar', 'inactivar', 'baja', 'se retiró', 'pausa', 'vacaciones'],
            },
            {
                tarea: 'Importar deportistas en lote',
                pasos: 'Deportistas > "Importar CSV" > "Descargar plantilla" > llena el archivo .csv > súbelo > "Importar N deportista(s)". Solo acepta CSV (no Excel directo: guárdalo como CSV).',
                palabrasClave: ['importar', 'excel', 'csv', 'masivo', 'cargar lista'],
            },
            {
                tarea: 'Revisar hojas de matrícula recibidas por foto/WhatsApp',
                pasos: 'Principal > Matrículas por revisar > en cada hoja: "Crear atleta", "Vincular a {nombre}" (si ya existe) o "Descartar". Nunca se crea solo.',
                palabrasClave: ['hoja de matrícula', 'foto', 'formulario de inscripción'],
            },
            {
                tarea: 'Ver el estado de cuenta de un deportista',
                pasos: 'Deportistas > menú "Más acciones" > "Ver estado de cuenta" (botón "Imprimir" para PDF/papel).',
                palabrasClave: ['estado de cuenta', 'cuánto debe', 'historial de pagos del alumno'],
            },
            {
                tarea: 'Invitar a un acudiente (padre/madre)',
                pasos: 'Invitaciones > "Nueva Invitación" > tipo "👨‍👩‍👧 Acudiente" > email o WhatsApp, "Nombre del menor a inscribir", "Equipo / Grupo", "Mensualidad / Cobro inicial" > "Crear & Copiar Link" o "Crear & Enviar WA". Atajo: Deportistas > "Más acciones" > "Invitar Acudiente".',
                palabrasClave: ['invitar padre', 'invitar acudiente', 'vincular padre', 'link para el papá'],
            },
            {
                tarea: 'Reenviar o cancelar una invitación',
                pasos: 'Invitaciones > en la fila: "Copiar link", "Enviar por WhatsApp", "Reenviar email" o "Cancelar invitación". Para todas las pendientes: "Enviar a los que faltan" / "Reenviar a todas".',
                palabrasClave: ['reenviar invitación', 'no le llegó', 'cancelar invitación'],
            },
            {
                tarea: 'Agregar un entrenador / dar acceso a staff',
                pasos: 'Entrenadores > "Contratar Entrenador" > "Nombre Completo", "Correo Electrónico", "Deportes que dicta", deja activo "Enviar invitación por correo" > "Contratar Entrenador". Para un administrador: Invitaciones > "Nueva Invitación" > tipo "🔑 Administrador".',
                palabrasClave: ['entrenador', 'coach', 'profesor', 'staff', 'administrador', 'dar acceso'],
            },
            {
                tarea: 'Inactivar o editar un entrenador',
                pasos: 'Entrenadores > íconos de la fila: "Editar información", "Inactivar" / "Reactivar", "Gestionar disponibilidad", "Eliminar permanentemente".',
                palabrasClave: ['quitar entrenador', 'inactivar coach'],
            },
            {
                tarea: 'Crear un plan / mensualidad con precio',
                pasos: 'Equipos y Planes > Mis Planes > "Nuevo Plan" > "Nombre del Plan", "Tipo de Oferta" > "🚀 Crear Plan". Luego en la tarjeta del plan: "Agregar Tarifa" > "Nombre de la tarifa", "Precio", "Duración" > "🚀 Crear Tarifa". El precio mensual de un equipo se pone aparte en "Editar Equipo" > "Precio Mensual".',
                palabrasClave: ['plan', 'mensualidad', 'tarifa', 'precio', 'paquete de clases'],
                modulo: 'gestion_deportiva_equipos_planes',
            },
            {
                tarea: 'Tomar o corregir asistencia (como escuela)',
                pasos: 'Asistencias > Supervisión > elige el equipo o plan > marca Presente / Ausente / Tarde / Excusado > "Guardar" > opcional "Finalizar". Consultar meses anteriores: Asistencias > Histórico.',
                palabrasClave: ['asistencia', 'lista', 'quién vino', 'faltas'],
                articulo: 'tomar-asistencia-coach',
            },
            {
                tarea: 'Crear una encuesta de asistencia',
                pasos: 'Asistencias > Encuestas > "Nueva encuesta" > título, fecha y clases del día > "Crear encuesta" > "Copiar link" para compartirla.',
                palabrasClave: ['encuesta', 'confirmar asistencia'],
            },
            {
                tarea: 'Crear un evento o entrenamiento en el calendario',
                pasos: 'Gestión Deportiva > Calendario > "Nuevo Evento" > "Título", "Para quién" (equipo o toda la escuela), "Tipo de Evento" (Entrenamiento, Partido, Reunión…), inicio y fin > "Crear Evento".',
                palabrasClave: ['calendario', 'evento', 'horario', 'partido', 'reunión'],
                modulo: 'gestion_deportiva_calendario',
            },
            {
                tarea: 'Informe Mensual a las familias',
                pasos: 'Gestión Deportiva > Informe Mensual > elige mes > "Generar borradores de {mes}" > en "Nota del equipo" elige equipo y escribe > "Guardar nota" > "Publicar N informes" > revisa con "Ver PDF" > "Enviar los publicados". En "Quién publica y envía" decides si lo hace la administración o cada entrenador.',
                palabrasClave: ['informe mensual', 'reporte a padres', 'boletín'],
                articulo: 'informe-mensual-coach',
                modulo: 'gestion_deportiva_informe_mensual',
            },
            {
                tarea: 'Registrar un pago manual (efectivo o transferencia)',
                pasos: 'Finanzas > Pagos (pantalla "Gestión de Pagos") > "Registrar pago" > "Efectivo" o "Transferencia" > "Deportista / Atleta" > "Aplicar a" (un cobro pendiente o nuevo) > "Mes que cubre", "Monto ($ COP)", "Fecha del pago" > "Confirmar Registro".',
                palabrasClave: ['registrar pago', 'pago en efectivo', 'me pagó', 'transferencia', 'pago manual'],
                modulo: 'finanzas_pagos',
            },
            {
                tarea: 'Aprobar o rechazar un comprobante que subió un padre',
                pasos: 'Finanzas > Pagos > pestaña "Cobros" > "Cobros por Aprobar" > "Ver"/"Comprobante" para mirarlo > "Aprobar" > "Pago completo" o "Registrar abono" > "Aprobar $X". Para rechazar: "Rechazar" (aplica de inmediato). "Glosar" abre una aclaración con la familia.',
                palabrasClave: ['comprobante', 'aprobar pago', 'validar pago', 'rechazar', 'glosa'],
                modulo: 'finanzas_pagos',
            },
            {
                tarea: 'Ver quién debe (cartera, pendientes, vencidos)',
                pasos: 'Reportes > Finanzas > pestaña "Cartera" (o "Antigüedad por atleta"). Desde ahí "Enviar WhatsApp" a cada deudor.',
                palabrasClave: ['cartera', 'deudores', 'morosos', 'pendientes', 'vencidos', 'quién debe'],
                modulo: 'reportes_finanzas',
            },
            {
                tarea: 'Generar los cobros del mes',
                pasos: 'Finanzas > Pagos > pestaña "Config" > "Apertura del Mes — Generar Cobros" > "Ver vista previa del mes a abrir" > "Confirmar y generar N pago(s)". Automático: en "Reglas de Cobro" activa "Generar cobros automáticos" > "Guardar Cambios".',
                palabrasClave: ['generar cobros', 'mensualidades del mes', 'abrir mes', 'cobros automáticos'],
                modulo: 'finanzas_pagos',
            },
            {
                tarea: 'Enviar recordatorios de cobro',
                pasos: 'Comunicación > Recordatorios (pantalla "Recordatorios de Cobro") > selecciona > "Enviar (N)", o "Enviar todos por email", o el ícono verde de WhatsApp en la fila. Automáticos: Finanzas > Pagos > "Config" > "Recordatorios" > "Enviar recordatorios".',
                palabrasClave: ['recordatorio', 'cobrar', 'avisar que debe'],
                modulo: 'documentos_recordatorios',
            },
            {
                tarea: 'Configurar medios de pago (cuentas, Nequi, QR, link de pago, pago online)',
                pasos: 'Finanzas > Pagos > pestaña "Config" > "Datos de Pago para Transferencia" ("Agregar llave": Bre-B, Nequi, Daviplata, Llave de transferencia o "Link de pago (Wompi)"; también "Código QR para Transferencia") > "Guardar Cambios". Pago online con tarjeta/PSE: tarjeta "SportMaps Pay" > "Activar pagos online" > "Guardar configuración de pagos".',
                palabrasClave: ['medios de pago', 'cuenta bancaria', 'nequi', 'wompi', 'link de pago', 'pse', 'tarjeta'],
                modulo: 'finanzas_pagos',
            },
            {
                tarea: 'Facturación electrónica (DIAN)',
                pasos: 'Finanzas > Facturación electrónica (si la escuela tiene Contabilidad, está como pestaña dentro de Contabilidad) > tarjeta "Facturador electrónico" > "Configurar". Emitir en lote: "Emitir facturas de un periodo" > "Emitir facturas del rango". Por pago: al registrar un pago, activa "¿Desea factura electrónica?". Anular una factura aceptada: "Facturas emitidas" > "Anular" (nota crédito).',
                palabrasClave: ['factura electrónica', 'dian', 'factus', 'facturar', 'nota crédito'],
                modulo: 'finanzas_facturacion_electronica',
            },
            {
                tarea: 'Emitir carnets digitales',
                pasos: 'Documentos e Identidad > Carnets > Carnets Digitales > pestaña "Emitir nuevo" > "Emitir" en la fila (o "Emitir seleccionados") > "Plantilla", "Vence el" > "Emitir". Imprimir: pestaña "Carnets emitidos" > "Descargar PDF". Diseño: pestaña "Plantillas".',
                palabrasClave: ['carnet', 'credencial', 'qr del atleta', 'imprimir carnets'],
                modulo: 'documentos_carnets',
            },
            {
                tarea: 'Crear un QR de inscripción',
                pasos: 'Documentos e Identidad > QR de Inscripción > "Nuevo QR" > "Nombre interno", tipo (equipo, plan o sede), monto, opcional "Exigir primer pago al inscribirse" > "Crear". Descarga: "Ver QR" o "Poster PDF".',
                palabrasClave: ['qr', 'inscripción por qr', 'flyer', 'auto-inscripción'],
                modulo: 'documentos_qr_inscripcion',
            },
            {
                tarea: 'Aprobar constancias',
                pasos: 'Documentos e Identidad > Constancias > en "Solicitudes y constancias emitidas" > "Emitir" en la solicitud pendiente; "PDF" para descargar. Las constancias las solicita la familia.',
                palabrasClave: ['constancia', 'certificado'],
                modulo: 'documentos_constancias',
            },
            {
                tarea: 'Crear o editar una sede',
                pasos: 'Sedes e Instalaciones > Sedes (pantalla "Gestión de Sedes") > "Nueva Sede" > "Nombre de la Sede", dirección, ciudad > "Crear Sede". Editar: "Editar" en la sede > "Guardar Cambios".',
                palabrasClave: ['sede', 'sucursal'],
                modulo: 'sedes_sedes',
            },
            {
                // Fuente: students/ClasePruebaPanel.tsx, school/CanalesClasePrueba.tsx, payment/ClasesDePruebaDialog.tsx (2026-11-14).
                tarea: 'Clases de prueba: registrar, ver quién vino, cobrar y pasar a deportista',
                pasos: 'Deportistas > pestaña "Clase de prueba" (ahí caen también las que agenda el bot de WhatsApp) > "Registrar clase de prueba". Cada fila trae la fecha de la clase y "Asistió" / "No vino". "Completar datos" abre el alta normal y lo pasa a deportista. "Configurar" (solo administración): "Recibir clases de prueba", "Valor de la clase de prueba", canales "En la escuela" y "WhatsApp". Cobrarla: Finanzas > Pagos > "Clases de prueba" > "Registrar pago" > "Guardar pago". El ENTRENADOR la ve en su app en Sesiones > "Semana" y ahí marca "Asistió" / "No vino" y el "Grupo recomendado"; solo ve las de sus equipos: si no le aparece, revisa que esté en "Entrenadores Asignados" del equipo del cupo (Mis Equipos > lápiz "Editar Equipo").',
                palabrasClave: ['clase de prueba', 'clases de prueba', 'prueba', 'cortesía', 'prospecto', 'entrenador no ve', 'profe no ve'],
            },
            {
                tarea: 'Instalaciones, reservas y agenda de clases de prueba con un entrenador',
                pasos: 'Sedes e Instalaciones > Instalaciones > pestañas "Instalaciones" ("Agregar Instalación"), "Reservas" (aprobar/reprogramar/cancelar) y "Clases de Prueba" ("Agendar Clase de Prueba").',
                palabrasClave: ['cancha', 'reserva', 'clase de prueba', 'instalación'],
                modulo: 'sedes_instalaciones',
            },
            {
                tarea: 'Cambiar logo y colores de la escuela',
                pasos: 'Cuenta > Configuración > sección Academia "Marca" > "Cambiar Logo" y "Color Principal" / "Color Secundario" > "Guardar Identidad Visual". Requiere el adicional de marca propia en el plan.',
                palabrasClave: ['logo', 'colores', 'marca', 'personalizar'],
            },
            {
                tarea: 'Datos de la academia y perfil público',
                pasos: 'Cuenta > Configuración > "Información Academia" / "Servicios". Página pública: Cuenta > Mi Perfil Público > pestañas General / Planes / Contacto > "Publicar perfil".',
                palabrasClave: ['perfil público', 'datos de la escuela', 'nit', 'dirección'],
            },
            {
                tarea: 'Ver o cambiar el plan de SportMaps',
                pasos: 'Cuenta > Facturación > "Ver planes" o "Elegir <Plan>" (abre la página de precios). "Módulos activos" es solo informativo.',
                palabrasClave: ['plan sportmaps', 'suscripción', 'upgrade', 'pagar sportmaps'],
            },
            {
                tarea: 'Reportes',
                pasos: 'Reportes > Reportes ("Reportes Gerenciales": "Exportar CSV", "Imprimir") o Reportes > Panel de Reportes (pestañas Finanzas, Deportistas, Sedes, Equipos, Entrenadores). Exportar pagos: Finanzas > Pagos > "Exportar Reporte".',
                palabrasClave: ['reporte', 'exportar', 'estadísticas', 'informe financiero'],
            },
        ],
        noPuede: [
            'Activar o desactivar módulos del menú: solo el equipo de SportMaps (Super Admin). Si un módulo dice "no está disponible para tu escuela", escribe a soporte.',
            'Conectar la pasarela Wompi/MercadoPago (cuenta de comercio propia): lo hace el equipo de SportMaps; la escuela solo activa "SportMaps Pay" y registra sus llaves de transferencia.',
            'Anular un cobro ya emitido desde un botón: no existe; "Rechazar" solo aplica a comprobantes en revisión, e "Inactivar" a un deportista anula sus cobros pendientes. Para otros casos, soporte.',
            'Cambiar de plan dentro de la app: "Elegir plan" abre la página de precios / ventas.',
        ],
    },

    // ─── Entrenador de la escuela (V2) ──────────────────────────────────────
    // Fuente: frontend/src/components/coach/v2/* (CoachHomeV2, CoachTeamsV2 y
    // equipos/*, CoachSessionsV2, CoachAttendanceV2, CoachEvaluateV2,
    // coachMasModel.ts), lib/acudienteTabs.ts (PESTANAS_ENTRENADOR) y
    // components/v2/RutasSegunRol.tsx. 2026-10-27: Mapi seguía dando rutas de la
    // V1 («Asistencias > Supervisión», «Equipos Regulares»).
    coach: {
        rol: 'Entrenador',
        resumen:
            'Entrenador de una escuela: ve solo los equipos que le asignaron. Si no ve ningún equipo ("Todavía no tienes equipos."), el administrador debe asignarlo al equipo. La app del entrenador va por pestañas abajo (en el computador, las mismas en el menú de la izquierda); NO hay menú lateral con secciones.',
        menu: [
            'Pestañas: Hoy · Equipos · Sesiones · Asistencia · Más',
            'Hoy: "Lo que toca ahora" con su botón ("Tomar lista", "Evaluar al equipo" o "Preparar el entreno de mañana"), botón "Pizarra", "Plan de hoy", "Pendientes" (Evaluar · Publicar · Convocar · "Más tarde")',
            'Equipos: "Mis equipos" > toca el equipo > pestañas "Deportistas" · "Partidos y convocatorias" · "Evaluar"',
            'Sesiones: "Hoy" · "Semana" (aquí salen las clases de prueba asignadas) · "Plan del mes"',
            'Asistencia: "Tomar lista" · "Historial"',
            'Más: Mi trabajo (Agenda y citas, Calendario, Informe mensual, Informes del entreno) · Entrenamiento (Pizarra, Rutinas, Mi dotación, Salud del equipo) · Comunicación (Mensajes, Anuncios, Encuestas) · Ayuda (Escribirle a la escuela, Preguntarle a Mapi, Centro de ayuda) · Cuenta (Notificaciones, Mis datos y configuración, Mi perfil, Cambiar de escuela o rol, Cerrar sesión)',
        ].join('\n'),
        vistaAnterior:
            'Menú lateral: Dashboard · Mis Equipos · Sesiones de Entrenamiento · Mis Planes · Mi Dotación · Mis Deportistas · Calendario; Gestión: Gestión de Rutinas · Asistencias (Supervisión, Encuestas) · Resultados · Reportes · Informe Mensual; Comunicación: Mensajes · Anuncios · Configuración. Asistencia: Asistencias > Supervisión > el equipo en "Equipos Regulares" > "Guardar asistencia". Editar equipo: Mis Equipos > lápiz "Editar Equipo" > "Guardar Cambios". Evaluar: Sesiones de Entrenamiento > Roster > "Evaluar Lote". (La ve quien entra como entrenador con una cuenta de escuela.)',
        tareas: [
            {
                tarea: 'Tomar asistencia',
                pasos: 'Pestaña Asistencia > "Tomar lista" > el equipo sale solo (para otro: "Cambiar") > todos arrancan en "Vino": toca al que no vino para pasarlo a Faltó → Excusa → Tarde > "Guardar lista" > "Cerrar y evaluar" (cierra la lista, a las familias de los que vinieron les llega la encuesta del entreno, y abre la evaluación; si no se cierra, se cierra sola a las 11:55 p. m.). Para ayer: selector "Hoy" / "Ayer" (solo si la escuela lo permite; más atrás no se puede). Sin señal, "Guardar en el teléfono": sube sola cuando vuelva.',
                palabrasClave: ['asistencia', 'lista', 'pasar lista', 'faltas', 'tomar lista', 'supervisión'],
                articulo: 'tomar-asistencia-coach',
            },
            {
                tarea: 'Corregir una lista ya guardada',
                pasos: 'Asistencia > "Historial" > "Corregir" en el entreno (se puede hasta el día siguiente; después la corrige la escuela). Una lista cerrada se abre con "Reabrir para corregir".',
                palabrasClave: ['corregir asistencia', 'me equivoqué', 'cambiar asistencia', 'reabrir'],
                articulo: 'tomar-asistencia-coach',
            },
            {
                tarea: 'Asistencia escaneando el carnet (QR)',
                pasos: 'Asistencia > "Tomar lista" > "Escanear carnets en la entrada" > apunta la cámara al QR del carnet. Marca presente; escanear dos veces no duplica.',
                palabrasClave: ['escanear', 'qr', 'carnet', 'check-in'],
                articulo: 'tomar-asistencia-coach',
            },
            {
                tarea: 'Planillas de asistencia en papel',
                pasos: 'Asistencia > "Historial" > aviso "N planillas de papel por revisar" > "Revisar".',
                palabrasClave: ['planilla', 'papel', 'foto de la lista'],
            },
            {
                tarea: 'Evaluar el entreno (cómo le fue a cada uno)',
                pasos: '"Cerrar y evaluar" en Asistencia después de guardar (o el pendiente "Evaluar" de Hoy, o Equipos > el equipo > "Evaluar" > "Evaluar"; si la lista sigue abierta, "Cerrar la lista y evaluar") > todos arrancan en "Normal": toca "Bien" o "Le costó" (o "A todos: Bien") > opcional "Nota para las familias (opcional)" > "Guardar evaluación". Las familias reciben «Así le fue hoy».',
                palabrasClave: ['evaluar', 'evaluación', 'métricas', 'rendimiento', 'calificar', 'notas', 'evaluar lote'],
                articulo: 'evaluaciones-jugadores',
            },
            {
                tarea: 'Ver los deportistas de mi equipo / escribirle al acudiente / felicitar',
                pasos: 'Equipos > toca el equipo > "Deportistas" > toca al deportista > "Escribir al acudiente" (WhatsApp), "Felicitar" (> "Enviar a la familia", uno por día) o "Ver ficha".',
                palabrasClave: ['mis alumnos', 'deportistas', 'ficha', 'acudiente', 'felicitar', 'whatsapp del papá'],
            },
            {
                tarea: 'Agregar, quitar o mover deportistas de un equipo',
                pasos: 'En la app del entrenador los inscribe la escuela ("La escuela los inscribe"). Si la escuela te dio permiso de crear o editar deportistas: Equipos > equipo > deportista > "Ver ficha" > "Ver todo en Mis deportistas".',
                palabrasClave: ['agregar al equipo', 'inscribir', 'quitar del equipo', 'mover de equipo', 'nuevo deportista'],
            },
            {
                tarea: 'Editar un equipo (cambiar el nombre, horario o precio)',
                pasos: 'Desde la app del entrenador no se edita el equipo: lo hace el administrador de la escuela. (Solo en la vista anterior: Mis Equipos > lápiz "Editar Equipo" > "Guardar Cambios".)',
                palabrasClave: ['editar equipo', 'renombrar', 'cambiar nombre del equipo', 'horario del equipo'],
            },
            {
                tarea: 'Programar un partido, convocar y registrar el resultado',
                pasos: 'Equipos > el equipo > "Partidos y convocatorias" > "+ Partido" > datos > "Programar y convocar". Convocar: toca a quien no va > "Convocar a N" (o "Convocar y avisar a N familias"). Resultado: "Abrir partido: resultado, evaluación y reporte" (o el partido en "Falta el resultado") > marcador > "Guardar resultado". Lista completa: "Ver todos los partidos".',
                palabrasClave: ['partido', 'convocar', 'convocatoria', 'resultado', 'marcador', 'goles', 'rival'],
                articulo: 'partidos-entrenador',
            },
            {
                tarea: 'Pizarra táctica / alineación',
                pasos: 'Más > Entrenamiento > "Pizarra" (o el botón "Pizarra" en Hoy). Para un partido: Equipos > equipo > "Partidos y convocatorias" > "Armar la alineación en la pizarra".',
                palabrasClave: ['pizarra', 'alineación', 'táctica', 'formación', 'jugada'],
            },
            {
                tarea: 'Ver o planear una sesión de entrenamiento',
                pasos: 'Pestaña Sesiones > "Hoy" · "Semana" · "Plan del mes". Planear: "Semana" > el día > "Planear" (abre la planificación completa "Métricas y Rendimiento") > elige el equipo > "Crear Sesión" (si hay mesociclo activo: "Agregar sesión" en el día). En la cancha: "Abrir en la cancha".',
                palabrasClave: ['sesión', 'entrenamiento', 'planificar clase', 'planear', 'modo cancha'],
                articulo: 'sesiones-entrenador-v2',
                modulo: 'gestion_deportiva_entrenamiento_metricas',
            },
            {
                // Fuente: coach/v2/semana/ClasesPruebaDelDia.tsx y la RPC clases_prueba_semana (2026-11-14).
                tarea: 'Clases de prueba que me asignaron (verlas, marcar si vino, recomendar grupo)',
                pasos: 'Pestaña Sesiones > "Semana" > en el día de la clase sale una tarjeta amarilla con campana: "Clase de prueba · hora · equipo", el nombre y si pagó. Después de la clase, ahí mismo: "Asistió" o "No vino" y "Grupo recomendado" > "Elige el grupo" (la escuela lo ve en Deportistas > "Clase de prueba"). Solo salen las de TUS equipos: si no aparece, el cupo quedó en otro equipo o no estás asignado a ese equipo (lo corrige la administración). Si dice "Falta el comprobante: la clase todavía no está confirmada", aún no se marca. El teléfono de la familia no sale: lo tiene la escuela. En la vista anterior (menú lateral) no salen. NO es la lista de Asistencia: quien viene a prueba todavía no está en el equipo.',
                palabrasClave: ['clase de prueba', 'clases de prueba', 'prueba', 'cortesía', 'prospecto', 'niño nuevo', 'grupo recomendado', 'asistió', 'no vino'],
                articulo: 'sesiones-entrenador-v2',
            },
            {
                tarea: 'Plan del mes / mesociclo (periodización)',
                pasos: 'Sesiones > "Plan del mes" > "Crear el plan" (o "Editar el plan"). En la planificación completa: "Crear Mesociclo" / "Nuevo mesociclo", "Agregar sesión", "Duplicar semana anterior".',
                palabrasClave: ['mesociclo', 'periodización', 'microciclo', 'planificación', 'plan del mes'],
                articulo: 'sesiones-entrenador-v2',
                modulo: 'gestion_deportiva_entrenamiento_metricas',
            },
            {
                tarea: 'Escribir y publicar el Informe Mensual',
                pasos: 'Equipos > el equipo > "Evaluar" > tarjeta "Informe de {mes}" > "Escribir la nota del equipo" (o "Completar N") > "Publicar los N". También en Más > "Informe mensual". Si la escuela publica, tú solo escribes la nota del equipo.',
                palabrasClave: ['informe mensual', 'nota del equipo', 'reporte a padres', 'publicar informe'],
                articulo: 'informe-mensual-coach',
                modulo: 'gestion_deportiva_informe_mensual',
            },
            {
                tarea: 'Informes del entreno (asistencia, nómina, goleadores)',
                pasos: 'Más > "Informes del entreno" > pestañas Asistencia, Nómina, Resultados, Goleadores > "Exportar PDF". Informe grupal: Equipos > equipo > "Evaluar" > "Informe del entreno para todo el equipo".',
                palabrasClave: ['reporte', 'goleadores', 'exportar', 'informe del entreno'],
                articulo: 'reportes-coach',
            },
            {
                tarea: 'Crear un evento en el calendario',
                pasos: 'Más > "Calendario" > "Nuevo Evento" > "Título", "Para quién" (tu equipo), "Tipo de Evento" > "Crear Evento".',
                palabrasClave: ['calendario', 'evento', 'horario'],
                modulo: 'gestion_deportiva_calendario',
            },
            {
                tarea: 'Anuncios, mensajes y encuestas',
                pasos: 'Más > Comunicación > "Anuncios" ("Nuevo Anuncio" > "Enviar Anuncio"), "Mensajes" o "Encuestas".',
                palabrasClave: ['anuncio', 'aviso', 'comunicado', 'mensajes', 'encuesta'],
            },
            {
                tarea: 'Rutinas, dotación y salud del equipo',
                pasos: 'Más > Entrenamiento > "Rutinas" ("NUEVA RUTINA"), "Mi dotación" ("Tomar dotación"; en "Por aceptar": "Acepto" o "Diferencia"; "Devolver") o "Salud del equipo" (quién puede entrenar).',
                palabrasClave: ['rutina', 'ejercicios', 'dotación', 'implementos', 'balones', 'uniforme', 'salud', 'lesión'],
            },
            {
                tarea: 'Agenda y citas (disponibilidad)',
                pasos: 'Más > Mi trabajo > "Agenda y citas" (si la escuela tiene el módulo). Las citas del día salen en Hoy ("Tu agenda").',
                palabrasClave: ['agenda', 'citas', 'disponibilidad', 'mis planes'],
                modulo: 'gestion_deportiva_disponibilidad_coach',
            },
            ...configPersonal('Más > "Mis datos y configuración"'),
        ],
        noPuede: [
            'Crear, editar, archivar o eliminar equipos: el administrador de la escuela.',
            'Asignarse a un equipo: el administrador, desde el equipo > "Entrenadores Asignados".',
            'Inscribir o mover deportistas entre equipos: la escuela (salvo que te haya dado permiso en Mis deportistas).',
            'Registrar pagos, aprobar comprobantes, crear cobros o ver valores de la cartera: la administración (el entrenador solo ve si el deportista está al día).',
            'Invitar entrenadores o administradores, ni gestionar el staff: la administración de la escuela.',
            'Corregir listas de asistencia de más de un día atrás: la escuela.',
            'Crear encuestas de asistencia: la administración de la escuela.',
        ],
    },

    // ─── Acudiente (V2) ─────────────────────────────────────────────────────
    // Fuente: frontend/src/components/parent/v2/*, pages/MyChildrenPage.tsx +
    // parent/v2/hijos/*, pages/ParentMorePage.tsx, AcuPagosV2 + MyPaymentsPage.
    parent: {
        rol: 'Acudiente (padre/madre)',
        resumen:
            'Ve a sus hijos, paga mensualidades, sube comprobantes y recibe informes. La app va por pestañas abajo (en el computador, las mismas en el menú de la izquierda); NO hay menú lateral con secciones. Si la escuela no cobra por SportMaps, Pagos no tiene cobros.',
        menu: [
            'Pestañas: Inicio · Calendario · Hijos · Pagos · Más (Tienda y Mis compras solo si la escuela vende)',
            'Inicio: saldo con "Pagar $X", próximo entreno, tarjeta de cada hijo con "Ver cómo va", "¿Ya tienes escuela?" (código), invitaciones pendientes',
            'Calendario: "Próximos" · "Torneos" · "Mes"',
            'Hijos: elige al hijo > "Progreso" · "Asistencia" · "Informes" · "Ficha y salud"; botón "Agregar hijo"',
            'Pagos: "Por pagar" · "Pagados"; "Ya transferí: subir el comprobante"',
            'Más: Mi familia (Inscripciones y planes, Mis eventos y torneos, Carnets, Constancias, Tienda del club, Mis compras, Salud de mis hijos, Mis citas) · Ayuda (Escribirle al club, Mensajes, Centro de ayuda) · Cuenta (Notificaciones, Mi cuenta, Cerrar sesión)',
        ].join('\n'),
        vistaAnterior:
            'Menú lateral: Principal (Dashboard, Mis Hijos, Calendario Familiar) · Seguimiento (Progreso Deportivo, Asistencias, Pagos) · Mi Actividad (Mensajes, Mis Inscripciones, Mis Eventos, Mis Citas, Carnets de mis hijos, Mis Constancias, Configuración). Pagos: pestaña "Pendientes" > "PAGAR".',
        tareas: [
            {
                tarea: 'Pagar una mensualidad en línea',
                pasos: 'Pestaña Pagos > "Por pagar" (los cobros ya vienen marcados; desmarca el que quieras dejar) > "Pagar $X" (o "Pagar N cobros") > "Pagar online (Wompi)" (o MercadoPago, según la escuela) > "Pagar online $X". Atajo: Inicio > "Pagar $X".',
                palabrasClave: ['pagar', 'pse', 'tarjeta', 'mensualidad', 'pago en línea', 'nequi'],
                articulo: 'acudiente-pagos-comprobante',
            },
            {
                tarea: 'Subir un comprobante de transferencia / Nequi',
                pasos: 'Pagos > "Ya transferí: subir el comprobante" > elige "Transferencia / Nequi / Daviplata" (revisa que no quede "Pagar online") > mira los datos de la cuenta > "Sube tu comprobante:" > "Pagar $X". Queda "En revisión" hasta que la escuela lo valide.',
                palabrasClave: ['comprobante', 'transferencia', 'nequi', 'daviplata', 'subir pago', 'ya pagué', 'ya transferí'],
                articulo: 'acudiente-pagos-comprobante',
            },
            {
                tarea: 'Abonar (pago parcial) o adelantar un pago',
                pasos: 'Solo si la escuela acepta abonos: sube el comprobante por el valor que pagaste (queda como abono), o Pagos > "¿Quieres adelantar un pago? Pagar otro concepto" > el hijo > "Otro Concepto / Abono libre".',
                palabrasClave: ['abono', 'abonar', 'pago parcial', 'adelantar'],
            },
            {
                tarea: 'Ver recibos, facturas y estado de cuenta',
                pasos: 'Pagos > "Pagados" > "Recibo" o "Factura" en el pago. Abajo: "Estado de cuenta de {hijo}" > "Imprimir".',
                palabrasClave: ['recibo', 'factura', 'historial', 'estado de cuenta', 'cuánto debo'],
                articulo: 'acudiente-pagos-comprobante',
            },
            {
                tarea: 'La escuela pidió aclarar un pago',
                pasos: 'Pagos > "Por pagar" > el cobro con "Necesita aclaración" > "Responder a la escuela". Si dice "Rechazado: vuelve a subir el comprobante", súbelo otra vez.',
                palabrasClave: ['aclaración', 'rechazado', 'glosa', 'en revisión'],
            },
            {
                tarea: 'Aceptar la invitación de la escuela (vincular a mi hijo)',
                pasos: 'Inicio > aviso "¡Tienes una invitación pendiente!" > "Aceptar Invitación" (desde Hijos: "Ir a aceptar la invitación"). Si la escuela ya cargó a tu hijo, no lo registres a mano.',
                palabrasClave: ['invitación', 'vincular', 'no veo a mi hijo'],
                articulo: 'inscripcion-padre-paso-a-paso',
            },
            {
                tarea: 'Unirme a mi escuela con el código',
                pasos: 'Inicio (o Hijos) > "¿Ya tienes escuela?" > escribe el código (ej. CAM-ABUP) > "Buscar mi escuela" > "Sí, es mi escuela" > "Para mi hijo(a)" o "Para mí" > datos > "Enviar solicitud". La escuela asigna la categoría.',
                palabrasClave: ['código', 'unirme', 'código de la escuela', 'no tengo escuela'],
                articulo: 'unirse-escuela-con-codigo',
            },
            {
                tarea: 'Registrar un hijo a mano',
                pasos: 'Hijos > "Agregar hijo" (si no tienes ninguno: "Registrar a mi hijo") > datos > "Siguiente" > "Añadir Hijo".',
                palabrasClave: ['agregar hijo', 'registrar hijo', 'añadir hijo'],
                articulo: 'inscripcion-padre-paso-a-paso',
            },
            {
                tarea: 'Corregir los datos de mi hijo o subir documentos',
                pasos: 'Hijos > el hijo > "Ficha y salud" > "Corregir un dato" > "Guardar Cambios". Documentos: en la misma pestaña, "Subir" (o "Ver" / "Cambiar").',
                palabrasClave: ['editar hijo', 'documento', 'datos de mi hijo', 'eps', 'alergias'],
                articulo: 'acudiente-ficha-del-hijo',
            },
            {
                tarea: 'Ver el informe mensual',
                pasos: 'Hijos > el hijo > "Informes" > "Abrir" > "Descargar PDF". Ahí también están los informes de partidos.',
                palabrasClave: ['informe', 'boletín', 'nota del entrenador', 'reporte mensual', 'informe del partido'],
                articulo: 'acudiente-ficha-del-hijo',
            },
            {
                tarea: 'Ver asistencia y progreso',
                pasos: 'Hijos > el hijo > "Asistencia" o "Progreso" (o Inicio > "Ver cómo va").',
                palabrasClave: ['asistencia', 'faltas', 'progreso', 'evaluaciones'],
                articulo: 'acudiente-ficha-del-hijo',
            },
            {
                tarea: 'Ver el carnet de mi hijo',
                pasos: 'Más > "Carnets" (o Hijos > "Ficha y salud" > "Mostrar carnet") > toca el carnet.',
                palabrasClave: ['carnet', 'credencial', 'qr'],
            },
            {
                tarea: 'Ver horarios, partidos y torneos',
                pasos: 'Pestaña Calendario > "Próximos" (día por día), "Torneos" ("Inscribir a {hijo}") o "Mes".',
                palabrasClave: ['horario', 'calendario', 'cuándo entrena', 'partido', 'torneo'],
            },
            {
                tarea: 'Pedir una constancia',
                pasos: 'Más > "Constancias" > "Pedir una constancia" > ¿Para quién? y ¿Qué constancia? > "Pedirla". La escuela la aprueba.',
                palabrasClave: ['constancia', 'certificado'],
            },
            {
                tarea: 'Pausa por vacaciones o lesión',
                pasos: 'Hijos > el hijo > "Ficha y salud" > "Solicitar pausa (vacaciones / lesión)" > motivo y meses > "Enviar solicitud" (si la escuela lo tiene activo).',
                palabrasClave: ['pausa', 'vacaciones', 'lesión', 'congelar'],
            },
            {
                tarea: 'Inscripciones, eventos, salud, citas y mensajes',
                pasos: 'Más > "Inscripciones y planes", "Mis eventos y torneos", "Salud de mis hijos", "Mis citas" o "Mensajes". WhatsApp del club: Más > "Escribirle al club".',
                palabrasClave: ['inscripciones', 'eventos', 'salud', 'citas', 'mensajes', 'whatsapp'],
            },
            ...configPersonal('Más > "Mi cuenta"'),
        ],
        noPuede: [
            'Cambiar el equipo, el horario o el plan del hijo: lo hace la escuela.',
            'Eliminar a un hijo ya inscrito en una escuela ni retirarlo: la escuela (o soporte).',
            'Cambiar el valor de la mensualidad o anular un cobro: la escuela.',
            'Aprobar su propio comprobante: la escuela lo valida.',
            'Crear eventos en el calendario: la escuela o el entrenador.',
        ],
    },

    // ─── Deportista (V2) ────────────────────────────────────────────────────
    // Fuente: frontend/src/components/athlete/v2/* (AthleteHomeV2,
    // AthleteTrainingV2, AthleteProgressV2, AthleteCardV2, AthletePaymentsV2,
    // AthleteMorePage).
    athlete: {
        rol: 'Atleta',
        resumen: 'Deportista con cuenta propia (adulto o menor con acceso). La app va por pestañas abajo; NO hay menú lateral con secciones. Si es menor, los pagos los maneja el acudiente ("Tus pagos los maneja tu acudiente").',
        menu: [
            'Pestañas: Hoy · Entrenos · Progreso · Carnet · Más (Tienda y Mis compras solo si la escuela vende)',
            'Hoy: saldo con "Pagar $X", próximo entreno con "Mostrar mi carnet", convocatorias ("Voy" / "No puedo ir"), torneos abiertos ("Inscribirme")',
            'Entrenos: "Próximos" · "Plan del mes" · "Para la casa"; "Ver todos mis entrenamientos"; "Mis torneos y eventos"',
            'Progreso: "Cómo me fue" · "En qué mejoro" · "Informes" · "Felicitaciones"',
            'Más: Mi plata (Pagos) · Mi actividad (Inscripciones y planes, Calendario del mes, Torneos y eventos, Mis objetivos, Mis documentos) · Bienestar (Mi salud, Mis citas, Mis medidas) · Tienda (Tienda del club, Mis compras) · Ayuda (Escribirle al club, Centro de ayuda) · Cuenta (Notificaciones, Mis datos, Configuración, Cerrar sesión)',
        ].join('\n'),
        vistaAnterior:
            'Menú lateral: Principal (Dashboard, Mi Calendario, Mis Pagos) · Mi Rendimiento (Estadísticas, Objetivos, Entrenamientos) · Actividad Deportiva (Mis Inscripciones, Mis Eventos) · Bienestar · Documentos (Mis Carnets) · Cuenta (Configuración).',
        tareas: [
            {
                tarea: 'Pagar un cobro o subir comprobante',
                pasos: 'Hoy > "Pagar $X", o Más > "Pagos" > "Por pagar" > "Pagar $X" > "Pagar online (Wompi)" o "Transferencia / Nequi / Daviplata" con "Sube tu comprobante:". Si ya transferiste: "Ya transferí: subir el comprobante".',
                palabrasClave: ['pagar', 'comprobante', 'mensualidad', 'transferencia'],
            },
            {
                tarea: 'Ver mi estado de cuenta o mis recibos',
                pasos: 'Más > "Pagos" > "Pagados" ("Recibo" / "Factura"); abajo "Mi estado de cuenta" y "Descargar mi historial".',
                palabrasClave: ['estado de cuenta', 'cuánto debo', 'recibo', 'factura'],
            },
            {
                tarea: 'Ver mi carnet',
                pasos: 'Pestaña Carnet > toca el código para agrandarlo; "Guardar imagen" o "Compartir". También Hoy > "Mostrar mi carnet".',
                palabrasClave: ['carnet', 'qr'],
            },
            {
                tarea: 'Responder una convocatoria',
                pasos: 'Hoy > tarjeta de la convocatoria > "Voy" o "No puedo ir" ("Cambiar" para corregir). Si eres menor, responde tu acudiente.',
                palabrasClave: ['convocatoria', 'partido', 'voy', 'no puedo ir'],
            },
            {
                tarea: 'Ver mi progreso e informes',
                pasos: 'Pestaña Progreso > "Cómo me fue", "En qué mejoro" o "Informes" ("Descargar el informe (PDF)"). Todo: "Ver todas mis estadísticas".',
                palabrasClave: ['progreso', 'informe', 'estadísticas', 'evaluación'],
            },
            {
                tarea: 'Objetivos personales',
                pasos: 'Más > "Mis objetivos" > "Nuevo Objetivo" > "Crear objetivo".',
                palabrasClave: ['objetivo', 'meta'],
            },
            {
                tarea: 'Registrar una actividad libre',
                pasos: 'Entrenos > "Ver todos mis entrenamientos" > "Actividad libre" > datos > "Guardar".',
                palabrasClave: ['actividad', 'entrené', 'registrar entrenamiento'],
            },
            {
                tarea: 'Inscribirme a un torneo o evento',
                pasos: 'Hoy > torneos abiertos > "Inscribirme", o desde la página del evento. Mis inscritos: Entrenos > "Mis torneos y eventos" (o Más > "Torneos y eventos").',
                palabrasClave: ['evento', 'torneo', 'inscripción'],
                articulo: 'atleta-inscribirse-evento',
            },
            {
                tarea: 'Unirme a mi escuela con el código',
                pasos: 'Hoy > "¿Ya tienes escuela?" > código > "Buscar mi escuela" > "Sí, es mi escuela" > "Para mí" > "Enviar solicitud".',
                palabrasClave: ['código', 'unirme', 'no tengo escuela'],
                articulo: 'unirse-escuela-con-codigo',
            },
            ...configPersonal('Más > "Configuración"'),
        ],
        noPuede: [
            'Cambiarse de equipo o de plan: la escuela.',
            'Aprobar sus pagos o cambiar el valor de la mensualidad: la escuela.',
            'Subir sus documentos todavía (dice "Pronto"); si es menor, los sube el acudiente.',
            'Ver el plan de SportMaps de la escuela (Facturación): solo la administración.',
        ],
    },

    // ─── Auditoría / reportes (solo lectura) ────────────────────────────────
    reporter: {
        rol: 'Auditoría (reportes, solo lectura)',
        resumen: 'Usuario de solo lectura de la escuela para revisar cartera y reportes.',
        menu: ['Reportes: Dashboard · Panel de Reportes · Calendario', 'Cuenta: Notificaciones · Facturación · Configuración'].join(
            '\n',
        ),
        tareas: [
            {
                tarea: 'Ver cartera y reportes',
                pasos: 'Reportes > Panel de Reportes > pestañas Finanzas, Deportistas, Sedes, Equipos, Entrenadores.',
                palabrasClave: ['cartera', 'reporte', 'pagado', 'pendiente', 'vencido'],
                modulo: 'reportes_panel',
            },
            ...CONFIG_PERSONAL.slice(0, 2),
        ],
        noPuede: [
            'Registrar o aprobar pagos, editar deportistas o equipos: la administración de la escuela.',
        ],
    },

    // ─── Profesional de bienestar ───────────────────────────────────────────
    wellness_professional: {
        rol: 'Profesional de bienestar',
        resumen: 'Nutricionista, fisioterapeuta, psicólogo, etc. Ofrece servicios en el marketplace y lleva a sus atletas.',
        menu: [
            'Principal: Dashboard Vendedor · Mis Atletas · Agenda',
            'Marketplace: Mis Servicios · Citas Reservadas',
            'Evaluaciones: Nueva Evaluación · Historial Médico · Seguimientos',
            'Recursos: Planes Nutricionales · Reportes',
            'Perfil: Mi Perfil Público · Facturación · Configuración',
        ].join('\n'),
        tareas: [
            {
                tarea: 'Publicar un servicio',
                pasos: 'Marketplace > Mis Servicios > "Nuevo Servicio" > ventana "Crear servicio profesional" (3 pasos con "Siguiente") > "Publicar en marketplace".',
                palabrasClave: ['servicio', 'publicar', 'consulta'],
            },
            {
                tarea: 'Ver las citas reservadas',
                pasos: 'Marketplace > Citas Reservadas (pantalla "Mis Citas"): secciones "Proximas" y "Pasadas". Citas de hoy y mañana: Principal > Agenda.',
                palabrasClave: ['citas', 'agenda', 'reservas'],
            },
            {
                tarea: 'Registrar una evaluación de un atleta',
                pasos: 'Principal > Mis Atletas > "Nueva Evaluación" > "Nombre del Atleta", "Tipo de Evaluación", medidas > "Guardar Evaluación".',
                palabrasClave: ['evaluación', 'medidas', 'imc', 'peso'],
            },
            {
                tarea: 'Editar mi perfil público',
                pasos: 'Perfil > Mi Perfil Público > pestañas General / Tarifas / Contacto > "Guardar" > "Publicar perfil".',
                palabrasClave: ['perfil público', 'tarifas', 'publicar perfil'],
            },
            ...CONFIG_PERSONAL.slice(0, 2),
        ],
        noPuede: [
            'Editar un servicio ya publicado: la edición aún no está disponible ("Edicion proximamente"); se puede desactivar y crear uno nuevo.',
            'Confirmar o cancelar citas desde la app: no hay botón; escribe a soporte si lo necesitas.',
            'Crear evaluaciones desde el ítem "Nueva Evaluación" del menú: hoy abre la Agenda; usa Mis Atletas > "Nueva Evaluación".',
        ],
    },

    // ─── Entrenador personal independiente ──────────────────────────────────
    personal_trainer: {
        rol: 'Entrenador personal (independiente)',
        resumen: 'Entrenador que trabaja por su cuenta con clientes propios (no es el entrenador de una escuela).',
        menu: [
            'Principal: Dashboard · Mis Clientes · Disponibilidad',
            'Negocio: Mis Planes · Mis Rutinas · Pagos',
            'Mi Actividad: Mis Inscripciones',
            'Perfil: Mi Perfil Público · Facturación · Configuración',
        ].join('\n'),
        tareas: [
            {
                tarea: 'Gestionar mis clientes',
                pasos: 'Principal > Mis Clientes (pantalla "Gestión de Clientes").',
                palabrasClave: ['clientes', 'alumnos'],
                articulo: 'trainer-clientes',
            },
            {
                tarea: 'Configurar mis horarios disponibles',
                pasos: 'Principal > Disponibilidad > pestaña "Configurar Horarios". Sesiones agendadas: pestaña "Mis Sesiones".',
                palabrasClave: ['disponibilidad', 'horarios', 'agenda'],
                articulo: 'trainer-disponibilidad-tarifas',
            },
            {
                tarea: 'Rutinas',
                pasos: 'Negocio > Mis Rutinas.',
                palabrasClave: ['rutina', 'ejercicios'],
                articulo: 'trainer-rutinas',
            },
            {
                tarea: 'Perfil público',
                pasos: 'Perfil > Mi Perfil Público > "Guardar" > "Publicar perfil".',
                palabrasClave: ['perfil público', 'link'],
                articulo: 'trainer-perfil-publico',
            },
            ...CONFIG_PERSONAL.slice(0, 2),
        ],
        noPuede: ['Gestionar equipos o deportistas de una escuela: eso es del rol entrenador de escuela, que asigna la escuela.'],
    },

    // ─── Tienda / vendedor (store_owner y external_vendor) ──────────────────
    store_owner: {
        rol: 'Tienda (vendedor)',
        resumen:
            'Vende productos en el marketplace. Todo lo de tienda depende de que la tienda de SportMaps esté activa; si no, la pantalla dice "Tienda no disponible".',
        menu: [
            'Principal: Dashboard Vendedor · Mis Productos · Pedidos',
            'Inventario: Stock · Proveedores · Categorías',
            'Ventas: Clientes · Reportes · Promociones',
            'Perfil: Mi Perfil Público · Facturación · Configuración',
        ].join('\n'),
        tareas: [
            {
                tarea: 'Publicar un producto',
                pasos: 'Principal > Mis Productos > "Nuevo Producto" > 4 pasos (¿Qué vas a vender?, Información básica, Variantes y stock, Listo para publicar) > "Publicar ahora" (o "Guardar borrador").',
                palabrasClave: ['producto', 'publicar', 'catálogo'],
            },
            {
                tarea: 'Gestionar pedidos',
                pasos: 'Principal > Pedidos > filtra (Por cobrar, Pagados, En curso…) > acciones del pedido: "Aprobar pago", "Rechazar comprobante", "Preparar pedido", "Marcar enviado", "Marcar entregado", "Cancelar pedido".',
                palabrasClave: ['pedido', 'orden', 'envío', 'entregar'],
            },
            {
                tarea: 'Completar la verificación / activar la tienda',
                pasos: 'Se abre sola si falta: "Activar Mi Tienda" > pasos Negocio / Pagos / Verificación > "Activar y continuar" > "Enviar y continuar".',
                palabrasClave: ['verificación', 'activar tienda', 'onboarding'],
            },
            ...CONFIG_PERSONAL.slice(0, 2),
        ],
        noPuede: ['Activar la tienda de SportMaps si está apagada para toda la plataforma: depende del equipo de SportMaps.'],
    },

    // ─── Organizador de eventos ─────────────────────────────────────────────
    organizer: {
        rol: 'Organizador de eventos',
        resumen: 'Crea y gestiona torneos/eventos con inscripciones y pagos.',
        menu: [
            'Principal: Dashboard · Crear Evento',
            'Gestión: Mis Eventos · Calendario · Finanzas · Reportes',
            'Cuenta: Perfil · Facturación · Configuración',
        ].join('\n'),
        tareas: [
            {
                tarea: 'Crear un evento',
                pasos: 'Principal > Crear Evento ("Crear Evento Deportivo") > pasos Info Básica, Categorías, Paquetes, Fechas, Pagos > "Finalizar y Crear Evento".',
                palabrasClave: ['crear evento', 'torneo', 'competencia'],
            },
            {
                tarea: 'Publicar, cerrar inscripciones o cancelar un evento',
                pasos: 'Gestión > Mis Eventos > "Gestionar" > botones de estado: "Publicar Evento", "Cerrar Inscripciones", "Cancelar Evento", "Marcar Completado", "Reabrir" > "Confirmar".',
                palabrasClave: ['publicar', 'cerrar inscripciones', 'cancelar evento'],
            },
            {
                tarea: 'Aprobar o rechazar inscripciones',
                pasos: 'Mis Eventos > "Gestionar" > pestaña "Inscripciones" > "Aprobar" / "Rechazar". Compartir: "Copiar enlace del evento".',
                palabrasClave: ['inscripciones', 'aprobar inscripción', 'link del evento'],
            },
            {
                tarea: 'Editar un evento',
                pasos: 'Mis Eventos > "Gestionar" > pestaña "Editar" > "Guardar Cambios".',
                palabrasClave: ['editar evento', 'cambiar fecha'],
            },
            {
                tarea: 'Reportes del evento',
                pasos: 'Gestión > Reportes > "Exportar CSV".',
                palabrasClave: ['reporte', 'exportar', 'inscritos'],
            },
        ],
        noPuede: ['Gestionar equipos o cobros de una escuela: eso lo hace la escuela en su propia cuenta.'],
    },
};

/** Alias de roles que comparten el mismo mapa. */
const ALIAS: Record<string, string> = {
    owner: 'school',
    school_admin: 'school',
    staff: 'coach',
    external_vendor: 'store_owner',
};

// ─── Selección por pregunta ─────────────────────────────────────────────────
// El mapa completo de escuela pesa ~4.000 tokens y Groq (respaldo) tiene un
// tope de 8.000 tokens por minuto: con el mapa entero cabían ~2 preguntas por
// minuto (QA 2026-10-06). Con la pregunta a mano, solo las tareas que
// coinciden van con sus pasos; el resto va como lista de nombres, para que el
// modelo sepa que existen y el usuario pueda pedir detalle en el siguiente
// mensaje.

const MAX_TAREAS_DETALLADAS = 7;
const SIGLAS = new Set(['qr', 'pdf', 'pse', 'nit']);

const normalizar = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const palabras = (s: string) => normalizar(s).split(/[^a-z0-9ñ]+/).filter((w) => w.length > 2 || SIGLAS.has(w));
/** ¿Difieren en a lo sumo una letra (sobra, falta o cambia)? Para "asitencia" vs "asistencia". */
function unaLetra(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let dif = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++dif > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else { i++; j++; }
    }
    return dif + (a.length - i) + (b.length - j) <= 1;
}

/**
 * ¿La palabra del usuario `q` coincide con la del mapa `w`? Por prefijo común
 * de 4 letras ("pagos"/"pago", "equipos"/"equipo") o, en palabras largas, por
 * una letra de diferencia (errores de tipeo: "asitencia").
 */
function coincide(q: string, w: string): boolean {
    if (q === w) return true;
    // "entreno"/"entrenamiento", "inscribir"/"inscripción"
    if (q.length >= 5 && w.length >= 5 && q.slice(0, 5) === w.slice(0, 5)) return true;
    // "pagos"/"pago", "plan"/"planes"
    if (q.length >= 4 && w.length >= 4 && q.slice(0, 4) === w.slice(0, 4) && Math.abs(q.length - w.length) <= 2) return true;
    return q.length >= 6 && unaLetra(q, w);
}

/**
 * Qué tareas van con sus pasos. Primero, cada palabra DISTINTIVA de la
 * pregunta trae sus dos mejores tareas; después se llenan los cupos por
 * puntaje total. Sumar puntajes a secas no alcanzaba: "crear" está en casi
 * todas las tareas y "CREAR PAGOS" traía crear equipo, sede y QR, y el pago
 * de último (QA 2026-10-06).
 */
function seleccionar(tareas: AppMapEntry[], consulta: string[]): AppMapEntry[] {
    const textos = tareas.map((t) => ({
        fuerte: palabras(`${t.tarea} ${(t.palabrasClave || []).join(' ')}`),
        debil: palabras(t.pasos),
    }));
    const n = tareas.length;
    const porPalabra = consulta.map((q) => textos.map((x) =>
        (x.fuerte.some((w) => coincide(q, w)) ? 3 : 0) + (x.debil.some((w) => coincide(q, w)) ? 1 : 0)));
    // Palabras que aparecen en más de la mitad de las tareas ("que", "para",
    // "como", "crear") no distinguen nada y no reservan cupo.
    const df = porPalabra.map((ps) => ps.filter((p) => p > 0).length);
    const peso = df.map((d) => (d ? Math.log((n + 1) / d) : 0));
    const total = textos.map((_, j) => porPalabra.reduce((s, ps, i) => s + ps[j] * peso[i], 0));

    const elegidas: number[] = [];
    const agregar = (j: number) => { if (!elegidas.includes(j) && elegidas.length < MAX_TAREAS_DETALLADAS) elegidas.push(j); };
    porPalabra.forEach((ps, i) => {
        if (!df[i] || df[i] > n / 2) return;
        ps.map((p, j) => ({ p, j })).filter((x) => x.p > 0)
            .sort((a, b) => b.p - a.p || total[b.j] - total[a.j])
            .slice(0, 2)
            .forEach((x) => agregar(x.j));
    });
    total.map((p, j) => ({ p, j })).filter((x) => x.p > 0).sort((a, b) => b.p - a.p).forEach((x) => agregar(x.j));
    return elegidas.map((j) => tareas[j]);
}

function renderTarea(t: AppMapEntry): string {
    return `- ${t.tarea}: ${t.pasos}${t.articulo ? ` (guía: /ayuda/${t.articulo})` : ''}`;
}

function renderRol(r: AppMapRole, consulta?: string): string {
    let tareas: string;
    const q = [...new Set(palabras(consulta || ''))];
    const detalle = q.length ? seleccionar(r.tareas, q) : [];
    // Sin pregunta, o si nada coincide ("hola", una frase rara): mapa entero.
    // Mejor gastar tokens que dejar al modelo sin rutas e inventando.
    if (!detalle.length) {
        tareas = r.tareas.map(renderTarea).join('\n');
    } else {
        const resto = r.tareas.filter((t) => !detalle.includes(t)).map((t) => t.tarea);
        tareas = [
            ...detalle.map(renderTarea),
            resto.length ? `Otras tareas que también puede hacer (sin detalle aquí): ${resto.join(' · ')}` : '',
        ].filter(Boolean).join('\n');
    }
    const noPuede = r.noPuede.map((n) => `- ${n}`).join('\n');
    const anterior = r.vistaAnterior
        ? ['VISTA ANTERIOR (úsala SOLO si el usuario dice que no ve esas pestañas):', r.vistaAnterior]
        : [];
    return [
        `### ${r.rol}`, r.resumen, r.vistaAnterior ? 'MENÚ (pestañas de la app):' : 'MENÚ LATERAL:', r.menu,
        'CÓMO HACER:', tareas, ...anterior, 'NO PUEDE (y quién sí):', noPuede,
    ].join('\n');
}

/**
 * Bloque de texto plano con el mapa de la app de los roles dados, para el
 * system prompt. Ignora roles desconocidos, deduplica (incluyendo alias) y
 * devuelve '' si ninguno aplica. Con `consulta`, detalla solo las tareas que
 * coinciden con ella (ver arriba).
 */
export function appMapParaRol(roles: string[], consulta?: string): string {
    const vistos = new Set<string>();
    const bloques: string[] = [];
    for (const raw of roles || []) {
        const key = ALIAS[raw] ?? raw;
        if (vistos.has(key) || !APP_MAP[key]) continue;
        vistos.add(key);
        bloques.push(renderRol(APP_MAP[key], consulta));
    }
    if (!bloques.length) return '';
    return ['MAPA DE LA APP (rutas del menú y botones reales; úsalo para "¿dónde/cómo hago X?"):', ...bloques, SOPORTE].join('\n\n');
}
