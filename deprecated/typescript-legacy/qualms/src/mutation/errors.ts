export type MutationErrorCategory =
  | "validation"
  | "unknown_target"
  | "prelude_protected"
  | "type_mismatch"
  | "scope_error"
  | "derived_relation"
  | "duplicate";

export class MutationError extends Error {
  constructor(
    message: string,
    public readonly category: MutationErrorCategory,
  ) {
    super(message);
    this.name = "MutationError";
  }
}
