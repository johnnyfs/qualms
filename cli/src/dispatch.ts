import { language } from "@quealm/qualms";

const { parseProgram, parseRelationAtom } = language;

export type Classification =
  | { readonly kind: "call"; readonly atom: ReturnType<typeof parseRelationAtom> }
  | { readonly kind: "program"; readonly program: ReturnType<typeof parseProgram> }
  | { readonly kind: "error"; readonly message: string };

export function classifyInput(source: string): Classification {
  try {
    const atom = parseRelationAtom(source);
    return { kind: "call", atom };
  } catch {
    // fall through — try the program parser, which handles set/entity/etc.
  }
  try {
    const program = parseProgram(source);
    return { kind: "program", program };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
