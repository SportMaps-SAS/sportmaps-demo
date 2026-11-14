import { Link } from 'react-router-dom';
import { ArrowLeft, Shield } from 'lucide-react';
import { SALES_PHONE_TEL, SALES_PHONE_DISPLAY } from '@/lib/salesContact';

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background animate-in fade-in duration-500">
      {/* Header */}
      <div className="bg-gradient-to-br from-primary/15 via-primary/10 to-background border-b border-border/40">
        <div className="max-w-3xl mx-auto px-4 py-10">
          <Link to="/register" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground text-sm mb-6 transition-colors font-medium">
            <ArrowLeft className="w-4 h-4" /> Volver al registro
          </Link>
          <div className="flex items-center gap-3 mb-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Shield className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Politica de Privacidad y Aviso de Privacidad</h1>
          </div>
          <p className="text-muted-foreground text-sm">Tratamiento de Datos Personales · Ultima actualizacion: 29 de octubre de 2026 · Version 2.3 · Ley 1581 de 2012 (Colombia)</p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-10 space-y-8 text-sm text-muted-foreground leading-relaxed">

        <section className="bg-[#248223]/5 border border-[#248223]/20 rounded-xl p-4">
          <p>
            En SportMaps nos comprometemos a proteger la privacidad y los datos personales de nuestros Usuarios conforme a la <strong className="text-foreground">Ley Estatutaria 1581 de 2012</strong>, el <strong className="text-foreground">Decreto 1377 de 2013</strong>, el <strong className="text-foreground">Decreto 1074 de 2015</strong> y demás normas concordantes de la República de Colombia. Al registrarte y aceptar esta Política, autorizas de manera <strong className="text-foreground">expresa, previa, libre e informada</strong> el tratamiento de tus datos personales en los términos aquí descritos.
          </p>
          <p className="mt-2">
            Esta Política constituye también el <strong className="text-foreground">Aviso de Privacidad</strong> a que se refiere el artículo 2.2.2.25.3.2 del Decreto 1074 de 2015, y su aceptación se registra de manera auditable con fecha, hora, dirección IP y versión aceptada.
          </p>
        </section>

        {/* 1. Responsable */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">1. Responsable del Tratamiento</h2>
          <p>
            El responsable del tratamiento de los datos personales recolectados a través de la Plataforma es:
          </p>
          <p className="mt-2">
            <strong className="text-foreground">SportMaps Technology S.A.S.</strong><br />
            NIT: en trámite<br />
            Domicilio: Bogotá D.C., Colombia<br />
            Correo de contacto:{' '}
            <a href="mailto:privacidad@sportmaps.co" className="text-[#248223] hover:underline">privacidad@sportmaps.co</a>
          </p>
        </section>

        {/* 2. Encargados del tratamiento */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">2. Encargados del Tratamiento</h2>
          <p>
            De conformidad con el artículo 3, literal d) de la Ley 1581 de 2012, SportMaps ha designado a diversos proveedores como <strong className="text-foreground">Encargados del Tratamiento</strong>, quienes realizan operaciones sobre los datos personales por cuenta de SportMaps y bajo acuerdos que garantizan el cumplimiento de la ley. Estos encargados son descritos en la Sección 8 (Compartición de Datos con Terceros).
          </p>
          <p className="mt-2">
            Las escuelas, academias, entrenadores y organizadores registrados en la Plataforma también actúan como <strong className="text-foreground">responsables independientes</strong> respecto de los datos personales que recolectan y tratan directamente por fuera de la Plataforma (por ejemplo, en sus instalaciones físicas). SportMaps no se hace responsable por el tratamiento de datos que dichos terceros realicen fuera del alcance de la Plataforma.
          </p>
        </section>

        {/* 3. Datos recopilados por rol */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">3. Datos que Recopilamos</h2>
          <p>Recopilamos datos personales según el rol del usuario dentro de la Plataforma:</p>

          <div className="mt-4 space-y-4">
            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Todos los usuarios (datos comunes):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Nombre completo o razón social</li>
                <li>Correo electrónico</li>
                <li>Número de teléfono</li>
                <li>Fecha de nacimiento (personas naturales)</li>
                <li>Rol seleccionado dentro de la Plataforma</li>
                <li>Dirección IP y datos de sesión (autenticación)</li>
                <li>Fecha y hora de aceptación de Términos y Política de Privacidad</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Escuelas y academias deportivas (school, school_admin):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Razón social y NIT/RUC de la institución</li>
                <li>Certificado de existencia y representación legal</li>
                <li>Dirección física de sedes</li>
                <li>Datos bancarios para recepción de pagos (cifrados)</li>
                <li>Información de horarios, programas y equipos</li>
                <li>Logo e imagen institucional</li>
                <li>Nombre, cargo y correo del administrador de la cuenta</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Entrenadores (coach):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Experiencia profesional y certificaciones deportivas</li>
                <li>Especialidad deportiva</li>
                <li>Disponibilidad horaria</li>
                <li>Aceptación del Código de Conducta del Entrenador</li>
                <li>Historial de asistencia y sesiones impartidas</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Padres y acudientes (parent):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Relación con el menor (padre, madre, acudiente legal)</li>
                <li>Datos de los hijos/menores a su cargo</li>
                <li>Historial de pagos e inscripciones</li>
                <li>Comunicaciones con escuelas y entrenadores</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Atletas y deportistas (athlete):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Perfil deportivo (deporte, posición, nivel)</li>
                <li>Historial de asistencia y rendimiento</li>
                <li>Entrenamientos, objetivos y estadísticas</li>
                <li>Reservas de clases y canchas</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Menores de edad (a través del acudiente):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Nombre completo del menor</li>
                <li>Fecha de nacimiento y edad</li>
                <li>Información médica relevante para la práctica deportiva</li>
                <li>Documento de identidad (cuando aplique para eventos)</li>
                <li>Registros de asistencia y rendimiento deportivo</li>
                <li>Fotografías (solo para identificación en eventos, con autorización)</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Organizadores de eventos (organizer):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Nombre de la organización o razón social</li>
                <li>Datos fiscales y de facturación</li>
                <li>Información de eventos creados (fecha, sede, categorías, precios)</li>
                <li>Documentos de identidad de atletas inscritos en sus eventos</li>
                <li>Registros de inscripciones y delegaciones</li>
                <li>Historial financiero de eventos (ingresos, comisiones)</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Profesionales de bienestar (wellness_professional):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Especialidad profesional y certificaciones</li>
                <li>Número de tarjeta profesional o registro</li>
                <li>Historial de citas y evaluaciones realizadas</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Dueños de tienda (store_owner):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Nombre comercial y razón social de la tienda</li>
                <li>NIT/RUC para facturación</li>
                <li>Catálogo de productos publicados</li>
                <li>Historial de pedidos y transacciones</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-4">
              <p className="font-medium text-foreground mb-2">Entrenadores personales (personal_trainer):</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Certificaciones y especialidades</li>
                <li>Disponibilidad y tarifas</li>
                <li>Historial de sesiones con clientes</li>
                <li>Planes de entrenamiento creados</li>
              </ul>
            </div>
          </div>

          <p className="mt-4 text-xs italic">
            El Usuario responde, en cualquier caso, por la veracidad, exactitud y vigencia de los datos facilitados. SportMaps se reserva el derecho de excluir de sus servicios a todo Usuario que haya facilitado datos falsos o inexactos, sin perjuicio de las demás acciones legales que procedan.
          </p>
        </section>

        {/* 4. Datos sensibles */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">4. Tratamiento de Datos Sensibles</h2>
          <p>
            De conformidad con el artículo 5 de la Ley 1581 de 2012, algunos datos tratados por la Plataforma pueden tener el carácter de <strong className="text-foreground">datos sensibles</strong>, en particular información sobre la salud del Usuario o del menor a su cargo (alergias, condiciones médicas, limitaciones físicas) que resulta indispensable para la práctica deportiva segura.
          </p>
          <p className="mt-2">
            El tratamiento de estos datos es <strong className="text-foreground">facultativo</strong> y requiere autorización expresa del titular o, en caso de menores, de su representante legal. El Usuario tiene derecho a no suministrar datos sensibles; sin embargo, la omisión de información médica relevante podrá limitar el alcance de los servicios que SportMaps y sus aliados puedan prestar.
          </p>
          <p className="mt-2">
            SportMaps adopta medidas de seguridad reforzadas sobre estos datos: acceso restringido, cifrado, y uso exclusivo para las finalidades declaradas.
          </p>
        </section>

        {/* 5. Finalidad */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">5. Finalidad del Tratamiento</h2>
          <p>Los datos personales serán utilizados para las siguientes finalidades:</p>

          <div className="mt-3 space-y-3">
            <div>
              <p className="font-medium text-foreground">Finalidades principales (necesarias para el servicio):</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Gestionar la cuenta, autenticación y perfil del Usuario dentro de la Plataforma.</li>
                <li>Asignar y administrar roles, permisos y accesos según el tipo de usuario.</li>
                <li>Procesar inscripciones, matrículas, pagos de mensualidades y transacciones.</li>
                <li>Registrar y visualizar asistencia, progreso y rendimiento deportivo.</li>
                <li>Facilitar la comunicación entre escuelas, entrenadores, padres y atletas.</li>
                <li>Gestionar eventos deportivos, inscripciones, delegaciones y verificación de documentos.</li>
                <li>Generar reportes operativos, financieros y de rendimiento para los usuarios autorizados.</li>
                <li>Cumplir obligaciones legales, tributarias, contables y regulatorias colombianas (DIAN, SIC, SARLAFT).</li>
                <li>Atender peticiones, quejas, reclamos y solicitudes (PQRS) presentadas por los Usuarios.</li>
                <li>Prevenir fraudes, proteger la seguridad de la Plataforma y aplicar medidas contra el abuso.</li>
              </ul>
            </div>

            <div>
              <p className="font-medium text-foreground">Uso de datos entre roles y registros futuros:</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li><strong className="text-foreground">Vinculación entre roles:</strong> Los datos proporcionados al registrarse pueden ser utilizados para facilitar la conexión con otros usuarios de la Plataforma según el rol. Por ejemplo, un padre puede ser vinculado a la escuela donde inscribe a su hijo; un atleta puede ser visible para el entrenador de su equipo.</li>
                <li><strong className="text-foreground">Inscripciones y eventos:</strong> Al inscribirse en un evento, los datos de perfil (nombre, documento de identidad, categoría deportiva) serán compartidos con el organizador del evento para fines de gestión, verificación y logística.</li>
                <li><strong className="text-foreground">Registros futuros:</strong> Si el Usuario cambia de rol o agrega un rol adicional dentro de la Plataforma, los datos ya proporcionados podrán ser reutilizados para pre-llenar su nuevo perfil.</li>
                <li><strong className="text-foreground">Historial unificado:</strong> El historial de actividad (asistencia, pagos, inscripciones, eventos) se mantiene asociado a la cuenta y puede ser consultado desde cualquier rol activo.</li>
                <li><strong className="text-foreground">Directorio deportivo:</strong> Los perfiles de escuelas, entrenadores y organizadores pueden aparecer en el directorio público de SportMaps (sección "Explorar") con la información que cada Usuario elija hacer visible.</li>
              </ul>
            </div>

            <div>
              <p className="font-medium text-foreground">Finalidades secundarias (opcionales, consentimiento granular):</p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Enviar comunicaciones promocionales, newsletters y noticias sobre SportMaps (solo con consentimiento previo y revocable en cualquier momento).</li>
                <li>Mejorar la Plataforma mediante análisis agregado y anónimo de uso.</li>
                <li>Realizar encuestas de satisfacción sobre el servicio.</li>
                <li>Recomendar contenido, escuelas, eventos o entrenadores con base en la actividad del Usuario.</li>
              </ul>
              <p className="mt-2 text-xs italic">
                La revocatoria del consentimiento para finalidades secundarias no afecta la prestación del servicio principal ni el tratamiento necesario para las finalidades primarias.
              </p>
            </div>
          </div>

          <p className="mt-4 text-[#8a3a00] bg-orange-50 border border-orange-200 rounded-lg p-3">
            <strong>SportMaps NO vende, alquila ni comercializa datos personales a terceros con fines publicitarios o de marketing.</strong>
          </p>
        </section>

        {/* 6. Menores */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">6. Tratamiento de Datos de Menores de Edad</h2>
          <p>
            De conformidad con el <strong className="text-foreground">Artículo 7 de la Ley 1581 de 2012</strong> y el artículo 12 del Decreto 1377 de 2013, el tratamiento de datos de menores de edad es excepcional y debe respetar sus derechos prevalentes.
          </p>
          <div className="mt-3 bg-[#248223]/5 border border-[#248223]/20 rounded-xl p-4">
            <p>
              <strong className="text-foreground">Los menores de edad no tienen cuenta propia en SportMaps.</strong> La Plataforma no está dirigida a niños y no permite que un menor se registre por sí mismo: el formulario de registro exige la fecha de nacimiento y solo admite personas mayores de edad.
            </p>
            <p className="mt-2">
              Los menores existen únicamente como deportistas a cargo del perfil de su padre, madre o acudiente. Es el acudiente quien inicia sesión, consulta la información del menor, autoriza el tratamiento de sus datos y realiza los pagos a la escuela. El menor no recibe credenciales de acceso ni comunicaciones directas de SportMaps.
            </p>
          </div>
          <p className="mt-2">
            Al registrar a un menor en la Plataforma, el acudiente declara bajo gravedad de juramento:
          </p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Ser el padre, madre o representante legal del menor.</li>
            <li>Contar con la autoridad suficiente para autorizar el tratamiento de sus datos.</li>
            <li>Haber escuchado la opinión del menor cuando su edad y madurez lo permitan.</li>
            <li>Autorizar expresamente el tratamiento de los datos del menor para los fines descritos en esta Política.</li>
          </ul>
          <p className="mt-2">Esto incluye:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Registro de asistencia y rendimiento deportivo por parte de entrenadores y escuelas.</li>
            <li>Compartir datos de identificación del menor con organizadores de eventos en los que participe.</li>
            <li>Generación de reportes de progreso visibles para el acudiente y la escuela.</li>
            <li>Almacenamiento de información médica relevante para la práctica deportiva segura.</li>
          </ul>
          <p className="mt-2">
            El representante legal puede revocar esta autorización en cualquier momento escribiendo a{' '}
            <a href="mailto:privacidad@sportmaps.co" className="text-[#248223] hover:underline">privacidad@sportmaps.co</a>.
          </p>
        </section>

        {/* 7. Consentimiento */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">7. Obtención del Consentimiento</h2>
          <p>El consentimiento para el tratamiento de datos se obtiene de las siguientes formas:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong className="text-foreground">Al registrarse:</strong> mediante la aceptación explícita (casilla obligatoria) de esta Política de Privacidad y los Términos y Condiciones antes de crear la cuenta.</li>
            <li><strong className="text-foreground">Al inscribirse en eventos:</strong> al confirmar la inscripción en un evento, el Usuario autoriza compartir sus datos con el organizador.</li>
            <li><strong className="text-foreground">Al activar SportMaps Pay:</strong> las escuelas aceptan términos adicionales de tratamiento de datos financieros al habilitar la pasarela de pagos.</li>
            <li><strong className="text-foreground">Newsletter y comunicaciones promocionales:</strong> la suscripción es opcional, requiere consentimiento separado y puede revocarse en cualquier momento desde las preferencias del usuario.</li>
            <li><strong className="text-foreground">Actualizaciones de política:</strong> al iniciar sesión con posterioridad a la publicación de una nueva versión, el Usuario deberá reaceptar los documentos actualizados.</li>
          </ul>
          <p className="mt-2">
            SportMaps registra la fecha, hora, dirección IP y versión del documento aceptado para efectos probatorios conforme a la ley.
          </p>
        </section>

        {/* 8. Compartición */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">8. Compartición de Datos con Terceros</h2>
          <p>Podemos compartir datos personales únicamente en los siguientes casos:</p>

          <div className="mt-3 space-y-3">
            <div className="bg-muted/30 rounded-lg p-3">
              <p className="font-medium text-foreground">Dentro de la Plataforma (entre usuarios):</p>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>Las escuelas pueden ver los datos de los atletas inscritos y sus acudientes.</li>
                <li>Los entrenadores pueden ver los datos de los atletas de sus equipos.</li>
                <li>Los padres pueden ver los datos de sus hijos y las escuelas donde están inscritos.</li>
                <li>Los organizadores de eventos pueden ver datos de atletas y delegaciones inscritas.</li>
                <li>Los perfiles públicos de escuelas y organizadores son visibles en la sección "Explorar".</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-3">
              <p className="font-medium text-foreground">Proveedores de servicio externos (Encargados del Tratamiento):</p>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li><strong className="text-foreground">Wompi (Bancolombia):</strong> pasarela de pago para procesar transacciones financieras.</li>
                <li><strong className="text-foreground">Supabase:</strong> proveedor de base de datos, autenticación e infraestructura en la nube.</li>
                <li><strong className="text-foreground">Resend:</strong> servicio de envío de correos electrónicos transaccionales (confirmaciones, recordatorios).</li>
                <li><strong className="text-foreground">Vercel:</strong> plataforma de hosting y despliegue de la aplicación web.</li>
                <li><strong className="text-foreground">Sentry:</strong> monitoreo de errores técnicos (datos anonimizados).</li>
                <li><strong className="text-foreground">Render:</strong> alojamiento de nuestros servicios de backend.</li>
                <li><strong className="text-foreground">Google Firebase:</strong> notificaciones push a la aplicación móvil.</li>
                <li><strong className="text-foreground">Meta Platforms:</strong> mensajería a través de la WhatsApp Business Platform, cuando la escuela habilita ese canal.</li>
                <li><strong className="text-foreground">Anthropic (Claude), Google (Gemini), Groq y OpenAI:</strong> proveedores de inteligencia artificial para la lectura automática de comprobantes de pago y hojas de matrícula, y para Mapi, el asistente automático con IA de los canales de atención. Usamos varios proveedores con conmutación automática para garantizar la disponibilidad del servicio. El detalle de qué datos reciben está en la Sección 8.2.</li>
              </ul>
            </div>

            <div className="bg-muted/30 rounded-lg p-3">
              <p className="font-medium text-foreground">Por obligación legal:</p>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>Autoridades judiciales o administrativas colombianas cuando la ley lo exija.</li>
                <li>La Superintendencia de Industria y Comercio (SIC) en ejercicio de sus funciones.</li>
                <li>La DIAN para efectos tributarios cuando corresponda.</li>
                <li>La Unidad de Información y Análisis Financiero (UIAF) en el marco del cumplimiento SARLAFT.</li>
              </ul>
            </div>
          </div>

          <p className="mt-3">
            Todos los proveedores externos están sujetos a acuerdos de confidencialidad y tratamiento de datos compatibles con esta Política y la legislación colombiana. SportMaps exige garantías contractuales de seguridad y uso restringido de los datos a las finalidades acordadas.
          </p>

          {/* 8.1 Canal de WhatsApp — el tratamiento propio de ese canal, que
              antes solo estaba descrito en la politica publicada en la landing. */}
          <h3 className="text-base font-semibold text-foreground mt-5 mb-2">8.1. Canal de Atención por WhatsApp</h3>
          <div className="space-y-3">
            <p>
              Cuando una escuela habilita el canal de WhatsApp, la atención se presta sobre la
              <strong className="text-foreground"> WhatsApp Business Platform de Meta Platforms, Inc.</strong> El tratamiento en ese canal funciona así:
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li>
                <strong className="text-foreground">La conversación la inicia el titular.</strong> SportMaps responde dentro de la
                ventana de servicio de 24 horas definida por Meta. Fuera de esa ventana solo se envían
                plantillas previamente aprobadas por Meta y de contenido transaccional (avisos de cobro,
                confirmaciones de pago, resultado de la validación de un comprobante).
              </li>
              <li>
                <strong className="text-foreground">Qué se conserva.</strong> El número de teléfono, el contenido de los mensajes
                intercambiados y los archivos que el titular adjunte (imágenes o PDF de comprobantes de pago),
                para que la escuela pueda revisar, validar y dejar trazabilidad del pago.
              </li>
              <li>
                <strong className="text-foreground">Lectura automatizada.</strong> Los comprobantes se procesan con los proveedores de
                inteligencia artificial indicados en esta sección, con la única finalidad de extraer el monto,
                la fecha y el número de referencia y contrastarlos contra el cobro correspondiente. El
                detalle, incluida la aprobación automática que una escuela puede activar, está en la
                Sección 8.2.
              </li>
              <li>
                <strong className="text-foreground">Revocatoria del consentimiento.</strong> El titular puede escribir
                <strong className="text-foreground"> STOP</strong> en cualquier momento para dejar de recibir mensajes automatizados.
                La solicitud se registra como un estado permanente de la cuenta, no como un evento aislado, y
                se respeta en envíos posteriores. Esto no afecta los demás derechos reconocidos en la Sección 10.
              </li>
              <li>
                <strong className="text-foreground">Costos.</strong> El costo de los mensajes corre por cuenta de la escuela y de su
                operador. SportMaps no cobra al titular por mensaje enviado o recibido.
              </li>
            </ul>
          </div>

          {/* 8.2 Asistente con IA — agregado en la v2.2 (2026-10-04) porque el bot
              empezó a enviar al proveedor de IA el historial reciente de la
              conversación, incluido lo que la escuela escribió desde su celular.
              Eso es una transmisión de datos a un encargado fuera de Colombia y la
              Ley 1581 exige informarla de forma previa y expresa.
              Fuente de verdad técnica: bff/src/services/llm.service.ts (chat),
              ocr.service.ts (comprobantes) y enrollment-ocr.service.ts (matrículas).
              Si cambia un proveedor allá, cambia este texto.
              Lo de "no entrenar" se afirma SOLO de Anthropic, Groq y OpenAI porque sus
              términos de API lo garantizan (Groq y OpenAI verificados 2026-10-04;
              Anthropic agregado en la v2.3, 2026-10-29: es el proveedor principal del
              bot desde octubre y la v2.2 no lo nombraba — auditoría D-01). De Google NO se afirma: sus
              términos solo lo garantizan en la modalidad PAGA de la API de Gemini y,
              al redactar esto, no estaba confirmado que la cuenta de SportMaps lo sea. */}
          <h3 className="text-base font-semibold text-foreground mt-6 mb-2">8.2. Mapi, el Asistente Automático con Inteligencia Artificial</h3>
          <div className="space-y-3">
            <p>
              Cuando una escuela activa a Mapi, el asistente automático, en su WhatsApp, algunas respuestas las
              redacta un sistema de <strong className="text-foreground">inteligencia artificial (IA)</strong> y no una persona.
              Mapi se presenta siempre como <strong className="text-foreground">«asistente automático»</strong> de la
              escuela al iniciar la conversación. La IA también se usa para leer los comprobantes de pago y,
              cuando la escuela lo utiliza, las fotos de hojas de matrícula.
            </p>

            <p className="font-medium text-foreground">Qué datos recibe el proveedor de IA</p>
            <ul className="list-disc list-inside space-y-1">
              <li>
                <strong className="text-foreground">Tu mensaje y el contexto de la conversación:</strong> el mensaje que
                escribes y hasta los ocho mensajes anteriores de esa misma conversación en las últimas 24 horas,
                incluidos los que la escuela te haya escrito desde su propio teléfono. Se incluyen para que la
                respuesta no contradiga lo que la escuela ya te dijo.
              </li>
              <li>
                <strong className="text-foreground">La información que Mapi consulta para responderte:</strong> el
                nombre de los deportistas a tu cargo, el estado de sus cobros (concepto, periodo, valor, fecha de
                vencimiento y pagos registrados), la información de la escuela (sedes, horarios, contacto) y los
                medios de pago que la escuela publicó. Solo se consultan los datos asociados al número de
                teléfono verificado con el que escribes.
              </li>
              <li>
                <strong className="text-foreground">Comprobantes de pago:</strong> la imagen o el PDF que envías, para extraer
                el valor, la fecha, el banco, la referencia y la cuenta de destino.
              </li>
              <li>
                <strong className="text-foreground">Hojas de matrícula:</strong> cuando la escuela inscribe deportistas a
                partir de la foto de su formato de matrícula, la imagen se procesa para leer los datos del
                deportista y del acudiente. Esa hoja puede contener <strong className="text-foreground">datos de menores de
                edad y datos sensibles de salud</strong> (EPS y tipo de sangre), que se tratan conforme a las
                Secciones 4 y 6.
              </li>
            </ul>

            <p className="font-medium text-foreground">Para qué se usan</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Responder tus consultas sobre pagos, horarios y medios de pago de la escuela.</li>
              <li>Leer los comprobantes y aplicarlos al cobro que corresponde.</li>
              <li>Prellenar la inscripción del deportista a partir de la hoja de matrícula, para que la escuela la revise.</li>
              <li>Enviarte avisos relacionados con tus cobros y pagos.</li>
            </ul>
            <p>
              Estos datos no se usan para publicidad, no se venden y no se usan para crear perfiles distintos
              de la relación que tienes con tu escuela.
            </p>

            <p className="font-medium text-foreground">Proveedores de IA y procesamiento fuera de Colombia</p>
            <p>
              Usamos <strong className="text-foreground">Anthropic (Claude)</strong>, <strong className="text-foreground">Google (Gemini)</strong>,{' '}
              <strong className="text-foreground">Groq</strong> y <strong className="text-foreground">OpenAI</strong>, con conmutación automática: si uno no
              está disponible, la solicitud pasa al siguiente. Mapi también responde a personas que todavía no
              tienen cuenta y escriben al WhatsApp de una escuela para pedir información; en su primer mensaje
              se presenta como asistente automático y enlaza esta Política. Estos proveedores actúan como <strong className="text-foreground">Encargados del
              Tratamiento</strong> y procesan los datos en servidores ubicados <strong className="text-foreground">fuera de
              Colombia</strong>, principalmente en los Estados Unidos. Esto constituye una transmisión internacional
              de datos, regulada en la Sección 14.
            </p>
            <p>
              Anthropic, Groq y OpenAI establecen en los términos de sus servicios de API que no usan los datos
              que reciben para entrenar ni mejorar sus modelos, salvo que el cliente lo autorice; SportMaps no ha
              dado esa autorización. Cada proveedor puede conservar temporalmente las solicitudes según sus propios
              términos para detectar abusos y garantizar la operación del servicio (Groq y OpenAI declaran hasta
              30 días).
            </p>

            <p className="font-medium text-foreground">Decisiones automatizadas</p>
            <p>
              Si la escuela activó la <strong className="text-foreground">aprobación automática de comprobantes</strong>, un
              comprobante cuyo valor no supere el tope que la escuela definió puede quedar aprobado sin revisión
              de una persona, siempre que la lectura coincida con el cobro. Cuando la lectura no coincide o hay
              dudas, el comprobante queda para revisión de la escuela. Puedes pedir en cualquier momento que una
              persona de la escuela revise un pago o una respuesta de Mapi.
            </p>
            <p>
              Las respuestas de Mapi son informativas y pueden contener errores. El estado de cuenta que
              registra la escuela es el que vale.
            </p>

            <p className="font-medium text-foreground">Cuánto tiempo se conservan</p>
            <p>
              Dentro de SportMaps, los mensajes, comprobantes y hojas de matrícula se conservan junto con la
              conversación y el pago, para que la escuela tenga trazabilidad, durante los plazos de la Sección 12.
              En los proveedores de IA se aplican los plazos descritos arriba.
            </p>

            <p className="font-medium text-foreground">Cómo hablar con una persona y ejercer tus derechos</p>
            <ul className="list-disc list-inside space-y-1">
              <li>
                Toca el botón <strong className="text-foreground">«Hablar con alguien»</strong> o escribe que quieres hablar con una
                persona: la conversación pasa al equipo de la escuela.
              </li>
              <li>
                Escribe <strong className="text-foreground">STOP</strong> para dejar de recibir mensajes automatizados.
              </li>
              <li>
                Si no quieres que tus comprobantes pasen por la lectura automática, puedes pedirle a la escuela que
                registre tu pago de forma manual.
              </li>
              <li>
                Para conocer, actualizar, rectificar o suprimir tus datos, o revocar la autorización, escribe a{' '}
                <a href="mailto:privacidad@sportmaps.co" className="text-[#248223] hover:underline">privacidad@sportmaps.co</a>{' '}
                siguiendo el procedimiento de la Sección 11.
              </li>
            </ul>
          </div>
        </section>

        {/* 9. Seguridad */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">9. Seguridad de los Datos y Notificación de Incidentes</h2>
          <p>SportMaps implementa medidas técnicas, administrativas y organizativas razonables para proteger los datos personales:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Cifrado en tránsito mediante TLS/HTTPS en todas las comunicaciones.</li>
            <li>Almacenamiento seguro en Supabase (infraestructura certificada ISO 27001, SOC 2 Type II).</li>
            <li>Control de acceso por roles (RLS — Row Level Security) — cada usuario solo ve la información que le corresponde según su rol.</li>
            <li>Contraseñas almacenadas con algoritmos de hash irreversible (bcrypt).</li>
            <li>Datos bancarios de las instituciones almacenados de forma cifrada.</li>
            <li>Autenticación segura con tokens JWT y sesiones con expiración automática.</li>
            <li>Datos de tarjetas de crédito y débito procesados exclusivamente por la pasarela de pagos y nunca almacenados en servidores de SportMaps.</li>
            <li>Auditoría de accesos privilegiados y monitoreo de eventos de seguridad.</li>
            <li>Copias de respaldo periódicas y planes de continuidad del negocio.</li>
          </ul>
          <p className="mt-3">
            <strong className="text-foreground">Notificación de incidentes:</strong> En caso de producirse un incidente de seguridad que comprometa gravemente datos personales, SportMaps notificará a los Usuarios afectados y a la Superintendencia de Industria y Comercio (SIC) dentro de los plazos y términos establecidos por la normatividad vigente, incluyendo el detalle del incidente, datos afectados y medidas correctivas.
          </p>
        </section>

        {/* 10. Derechos */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">10. Derechos del Titular (Ley 1581 de 2012)</h2>
          <p>Como titular de tus datos personales tienes derecho a:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong className="text-foreground">Conocer</strong> qué datos tuyos tratamos y la finalidad de su tratamiento.</li>
            <li><strong className="text-foreground">Actualizar</strong> tus datos cuando sean incorrectos o estén desactualizados.</li>
            <li><strong className="text-foreground">Rectificar</strong> información inexacta o incompleta.</li>
            <li><strong className="text-foreground">Suprimir</strong> tus datos cuando no sean necesarios para los fines declarados o cuando haya vencido el término de tratamiento, salvo las excepciones legales.</li>
            <li><strong className="text-foreground">Revocar</strong> la autorización de tratamiento en cualquier momento.</li>
            <li><strong className="text-foreground">Solicitar prueba</strong> de la autorización otorgada, salvo cuando la ley no lo exija.</li>
            <li><strong className="text-foreground">Acceder gratuitamente</strong> a tus datos al menos una vez al mes calendario.</li>
            <li><strong className="text-foreground">Presentar quejas</strong> ante la Superintendencia de Industria y Comercio (SIC) por violación a la ley.</li>
            <li><strong className="text-foreground">Ser informado</strong> sobre el uso que se da a tus datos personales.</li>
          </ul>
        </section>

        {/* 11. Procedimiento */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">11. Procedimiento para Ejercer Derechos (Consultas y Reclamos)</h2>
          <p>
            Para ejercer los derechos descritos en la Sección 10, el titular (o su representante legal debidamente acreditado) puede enviar una solicitud por los siguientes canales:
          </p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Correo electrónico:{' '}
              <a href="mailto:privacidad@sportmaps.co" className="text-[#248223] hover:underline">privacidad@sportmaps.co</a>
            </li>
            <li>Formulario PQRS disponible dentro de la Plataforma.</li>
            <li>Comunicación escrita dirigida al domicilio de SportMaps Technology S.A.S. en Bogotá D.C.</li>
          </ul>
          <p className="mt-2">La solicitud debe contener como mínimo:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Nombre completo del titular y documento de identidad.</li>
            <li>Correo electrónico registrado en la Plataforma.</li>
            <li>Descripción clara del derecho a ejercer y los hechos que motivan la solicitud.</li>
            <li>Dirección o medio para recibir respuesta.</li>
            <li>Documentos que soporten la solicitud (si aplica).</li>
          </ul>
          <p className="mt-3">
            <strong className="text-foreground">Plazos de respuesta conforme a los artículos 14 y 15 de la Ley 1581 de 2012:</strong>
          </p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong className="text-foreground">Consultas</strong> (acceso, conocer datos): respuesta en máximo <strong className="text-foreground">10 días hábiles</strong>, prorrogables por 5 días hábiles adicionales.</li>
            <li><strong className="text-foreground">Reclamos</strong> (corrección, actualización, supresión, revocatoria): respuesta en máximo <strong className="text-foreground">15 días hábiles</strong>, prorrogables por 8 días hábiles adicionales.</li>
          </ul>
          <p className="mt-3">
            Si el reclamo resulta incompleto, SportMaps solicitará al titular la información faltante dentro de los 5 días hábiles siguientes. Transcurridos 2 meses sin que el titular subsane, se entenderá desistido el reclamo.
          </p>
        </section>

        {/* 12. Retención */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">12. Retención y Eliminación de Datos</h2>
          <p>
            SportMaps conserva los datos personales mientras el Usuario mantenga una cuenta activa en la Plataforma, y por los términos adicionales que exija la ley. Tras la eliminación de la cuenta:
          </p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Los datos personales serán eliminados o anonimizados en un plazo de <strong className="text-foreground">30 días hábiles</strong>, salvo que la ley exija su conservación.</li>
            <li>Los registros contables, financieros y fiscales se conservarán por <strong className="text-foreground">10 años</strong> conforme al Código de Comercio colombiano (Art. 28) y al Estatuto Tributario.</li>
            <li>Los registros de consentimiento (fecha, hora, IP y versión de aceptación) se conservarán como prueba legal durante el término de prescripción de las acciones correspondientes.</li>
            <li>Los datos anonimizados (sin posibilidad de reidentificación) podrán conservarse indefinidamente para fines estadísticos.</li>
            <li>Los datos requeridos por órdenes judiciales o administrativas se conservarán por el término que éstas dispongan.</li>
          </ul>
          <div className="mt-4 bg-[#248223]/5 border border-[#248223]/20 rounded-xl p-4">
            <p className="font-medium text-foreground">Cómo pedir la eliminación de tu cuenta</p>
            <p className="mt-2">
              Desde la aplicación: <strong className="text-foreground">Ajustes → Seguridad → Zona de Peligro → Eliminar Cuenta</strong>. Al confirmar, cancelamos de inmediato tus cobros recurrentes y desactivamos tus medios de pago, y el borrado se ejecuta a los 30 días; puedes cancelar la solicitud dentro de ese plazo.
            </p>
            <p className="mt-2">
              Sin instalar la aplicación: consulta el detalle y el procedimiento por correo en{' '}
              <Link to="/eliminar-cuenta" className="text-[#248223] hover:underline">sportmaps.co/eliminar-cuenta</Link>.
            </p>
          </div>
        </section>

        {/* 13. Cookies */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">13. Cookies y Tecnologías de Rastreo</h2>
          <p>SportMaps utiliza las siguientes tecnologías:</p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><strong className="text-foreground">Cookies de sesión:</strong> estrictamente necesarias para la autenticación y el funcionamiento de la Plataforma. Se eliminan al cerrar sesión.</li>
            <li><strong className="text-foreground">LocalStorage:</strong> para almacenar preferencias del usuario (tema, idioma) de forma local en su dispositivo.</li>
            <li><strong className="text-foreground">Tokens JWT:</strong> para mantener la sesión autenticada de forma segura.</li>
          </ul>
          <p className="mt-2">
            <strong className="text-foreground">No utilizamos</strong> cookies de rastreo publicitario, píxeles de seguimiento ni compartimos datos de navegación con redes publicitarias o de marketing.
          </p>
        </section>

        {/* 14. Transferencia internacional */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">14. Transferencia y Transmisión Internacional de Datos</h2>
          <p>
            Los proveedores de infraestructura y de procesamiento de SportMaps (Supabase, Vercel, Render, Resend, Sentry, Anthropic, Google, Meta Platforms, OpenAI y Groq) tienen servidores ubicados fuera del territorio colombiano. Los datos se tratan en los <strong className="text-foreground">Estados Unidos</strong> y en la <strong className="text-foreground">Unión Europea</strong>. Al aceptar esta Política, el Usuario autoriza expresamente la <strong className="text-foreground">transferencia y/o transmisión internacional</strong> de sus datos personales a estos proveedores, para las finalidades descritas en la Sección 8.
          </p>
          <p className="mt-2">
            De conformidad con el artículo 26 del Decreto 1377 de 2013, SportMaps garantiza que los países de destino cuentan con niveles adecuados de protección de datos o, en su defecto, suscribe acuerdos contractuales que aseguran estándares equivalentes a los exigidos por la legislación colombiana. Cuando el país de destino no figura entre los declarados con nivel adecuado de protección por la Superintendencia de Industria y Comercio, la transferencia se ampara en la autorización expresa e informada del titular y en los términos contractuales aceptados con cada encargado, que restringen el uso de los datos a la prestación del servicio contratado. Lo que cada proveedor de inteligencia artificial garantiza sobre el entrenamiento de modelos y la conservación de los datos se detalla en la Sección 8.2.
          </p>
        </section>

        {/* 15. Cambios */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">15. Cambios en esta Política</h2>
          <p>
            SportMaps puede actualizar esta Política periódicamente. Notificaremos los cambios relevantes mediante:
          </p>
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li>Correo electrónico al email registrado en la cuenta.</li>
            <li>Aviso visible dentro de la Plataforma al iniciar sesión.</li>
            <li>Actualización de la fecha "Última actualización" y versión en este documento.</li>
          </ul>
          <p className="mt-2">
            En caso de cambios sustanciales en las finalidades del tratamiento, SportMaps solicitará una nueva autorización expresa al titular.
          </p>
          <p className="mt-2">
            La versión vigente siempre estará disponible en{' '}
            <Link to="/politica-de-privacidad" className="text-[#248223] hover:underline">sportmaps.co/politica-de-privacidad</Link>. El uso continuado de la Plataforma tras la notificación constituye aceptación de la versión actualizada.
          </p>
        </section>

        {/* 16. Contacto */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-3">16. Contacto y Autoridad de Control</h2>
          <p>
            <strong className="text-foreground">Oficial de Protección de Datos — SportMaps Technology S.A.S.</strong><br />
            Bogotá D.C., Colombia<br />
            <a href="mailto:privacidad@sportmaps.co" className="text-[#248223] hover:underline">privacidad@sportmaps.co</a><br />
            Línea de atención: <a href={SALES_PHONE_TEL} className="text-[#248223] hover:underline">{SALES_PHONE_DISPLAY}</a>
          </p>
          <p className="mt-3">
            Si consideras que SportMaps ha vulnerado tus derechos como titular de datos, puedes presentar una queja ante la <strong className="text-foreground">Superintendencia de Industria y Comercio (SIC)</strong>, autoridad de control en materia de protección de datos personales en Colombia:{' '}
            <a href="https://www.sic.gov.co" target="_blank" rel="noopener noreferrer" className="text-[#248223] hover:underline">www.sic.gov.co</a>
          </p>
        </section>

        <div className="border-t pt-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} SportMaps Technology S.A.S. · Política de Privacidad conforme a la Ley 1581 de 2012 · Colombia<br />
          Versión 2.3 · 29 de octubre de 2026
        </div>
      </div>
    </div>
  );
}
