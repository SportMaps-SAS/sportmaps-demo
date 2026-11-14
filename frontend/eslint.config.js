import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Tokens de tamaño (docs/design-tokens.md): avisa — NO falla el CI — cuando
// un className trae un ancho/alto/espacio en píxeles fijos (w-[300px],
// max-h-[85vh] no entra: solo px). La deuda existente sale como warning; lo
// nuevo debería usar un token (max-w-page, h-touch, pb-nav-safe, …).
const PX_ARBITRARIO = String.raw`/\b(?:min-|max-)?(?:w|h|size|top|left|right|bottom|inset|gap(?:-[xy])?|p[xytrbl]?|m[xytrbl]?)-\[\d+px\]/`;
const MSG_PX = "Usa un token de tamaño (docs/design-tokens.md) en vez de píxeles fijos";

export default tseslint.config(
  // .vercel/ y dev-dist/ son salidas de build (gitignoradas o generadas): el sw.js
  // de .vercel/output trae un comentario /* eslint-env */, que en ESLint 10 es error.
  { ignores: ["dist", "dev-dist", ".vercel", "android", "src/integrations/supabase/types.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // eslint-plugin-react-hooks 7 (el primero compatible con ESLint 10) mete en
      // "recommended" las reglas del React Compiler (set-state-in-effect, refs,
      // immutability, purity…: ~510 errores en el código actual). Se fijan aquí
      // las dos reglas que traía la v5; adoptar las del compilador es otra tarea.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Nueva en eslint:recommended de ESLint 10. Avisa — no bloquea — mientras
      // se limpian los ~15 casos existentes (valor inicial pisado antes de usarse).
      "no-useless-assignment": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-restricted-syntax": [
        "warn",
        { selector: `Literal[value=${PX_ARBITRARIO}]`, message: MSG_PX },
        { selector: `TemplateElement[value.raw=${PX_ARBITRARIO}]`, message: MSG_PX },
      ],
    },
  },
);
