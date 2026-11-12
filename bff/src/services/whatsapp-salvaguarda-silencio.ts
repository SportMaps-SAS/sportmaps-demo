/**
 * Salvaguarda del turno mudo (Monster 2026-11-11, @Andrey_0630): el bot calló 17 h ante «Hola! Me interesa
 * entrenar con ustedes» y nadie se enteró; el resultado del turno solo quedaba en un log.
 *
 * Cuando el turno de un desconocido termina en 'silencio' o 'error' y el mensaje TIENE contenido y señal de
 * escuela, se avisa a la escuela (un aviso por conversación y día). No se le escribe al cliente ni viaja su texto.
 *
 * Apagada por defecto, por escuela: WA_SALVAGUARDA_SILENCIO_SCHOOL_IDS (ids separados por coma).
 */
import { avisarEscalacionAlEquipo } from './whatsapp-escalaciones.service';

const MUDOS = new Set(['silencio', 'error']);

/** ¿Corre en esta escuela? Apagada si la variable no existe. Pura. */
export function salvaguardaHabilitada(
    schoolId: string, env: string | undefined = process.env.WA_SALVAGUARDA_SILENCIO_SCHOOL_IDS,
): boolean {
    if (!schoolId || !env) return false;
    return env.split(',').map((s) => s.trim()).filter(Boolean).includes(schoolId);
}

/**
 * ¿Un turno que terminó mudo dejó a alguien con intención sin respuesta? Pura.
 * 'error': el bot reventó con un mensaje con contenido → avisar. 'silencio': solo con señal de escuela
 * (el bot calla por decisión en saludos, cierres y charla personal, y eso no se toca).
 */
export function decidirSalvaguarda(a: {
    resultado: string; texto: string | null; botonId: string | null;
    conContenido: (t: string) => boolean; conSenal: (t: string) => boolean;
}): 'avisar' | 'nada' {
    if (!MUDOS.has(a.resultado) || a.botonId) return 'nada';
    const t = (a.texto || '').trim();
    if (!t || !a.conContenido(t)) return 'nada';
    return a.resultado === 'error' || a.conSenal(t) ? 'avisar' : 'nada';
}

const diaLocal = (ms: number) => new Date(ms - 5 * 3600_000).toISOString().slice(0, 10);

/** Un aviso por conversación y día (id determinístico en la base: los BFF no se pisan). No le escribe al cliente. */
export async function avisarSilencio(p: {
    schoolId: string; conversationId: string; contactWaId: string; contactName: string | null; ahora?: number;
}): Promise<number> {
    return avisarEscalacionAlEquipo({
        schoolId: p.schoolId, conversationId: p.conversationId, contactWaId: p.contactWaId, contactName: p.contactName,
        urgencia: 'normal', categoria: null, etapa: 'inicial', push: true, silencio: true,
        ancla: `silencio:${p.conversationId}:${diaLocal(p.ahora ?? Date.now())}`,
    });
}
