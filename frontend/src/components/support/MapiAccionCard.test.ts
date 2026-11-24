import { describe, it, expect } from "vitest";
import { accionVigente } from "./MapiAccionCard";

describe("accionVigente", () => {
    const ahora = Date.parse("2026-11-23T15:00:00Z");
    it("pendiente y sin vencer: muestra Confirmar", () => {
        expect(accionVigente({ estado: "draft", expiraEn: "2026-11-23T15:30:00Z" }, ahora)).toBe(true);
    });
    it("vencida aunque la base siga diciendo draft: sin botones", () => {
        expect(accionVigente({ estado: "draft", expiraEn: "2026-11-23T14:59:00Z" }, ahora)).toBe(false);
    });
    it.each(["executed", "partial", "failed", "cancelled", "expired", "superseded", "executing"])("%s: sin botones", (estado) => {
        expect(accionVigente({ estado, expiraEn: "2026-11-23T15:30:00Z" }, ahora)).toBe(false);
    });
});
