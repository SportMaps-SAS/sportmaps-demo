import { describe, expect, it } from "vitest";
import { respuestaACalificar } from "./teSirvio";

const U = "11111111-1111-4111-8111-111111111111";
const B1 = "22222222-2222-4222-8222-222222222222";
const B2 = "33333333-3333-4333-8333-333333333333";
const msg = (id: string, author_type: "user" | "bot" | "agent") => ({ id, author_type, body: "x", created_at: "" });

describe("«¿Te sirvió?» va solo bajo la última respuesta de Mapi", () => {
    it("la última respuesta del bot mientras el caso está con Mapi", () => {
        expect(respuestaACalificar([msg(U, "user"), msg(B1, "bot"), msg(U, "user"), msg(B2, "bot")], "bot_handled")).toBe(B2);
    });

    it("no si el caso ya espera a una persona, lo resolvieron o lo tomó un agente", () => {
        const hilo = [msg(U, "user"), msg(B1, "bot")];
        expect(respuestaACalificar(hilo, "waiting_human")).toBeNull();
        expect(respuestaACalificar(hilo, "waiting_user")).toBeNull();
        expect(respuestaACalificar(hilo, "resolved")).toBeNull();
        expect(respuestaACalificar([msg(U, "user"), msg(B1, "agent")], "bot_handled")).toBeNull();
    });

    it("no si lo último es del usuario o un aviso local sin id de la base", () => {
        expect(respuestaACalificar([msg(B1, "bot"), msg(U, "user")], "bot_handled")).toBeNull();
        expect(respuestaACalificar([msg(U, "user"), msg("error-123", "bot")], "bot_handled")).toBeNull();
        expect(respuestaACalificar([], "bot_handled")).toBeNull();
    });
});
