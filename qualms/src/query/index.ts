export type {
  Expression,
  IntrospectionRelation,
  MetaType,
  NamedPredicate,
  Query,
  Term,
  TraitFilter,
  Value,
} from "./ast.js";
export {
  INTROSPECTION_RELATIONS,
  META_TYPES,
  isIntrospectionRelation,
  isMetaType,
} from "./ast.js";
export {
  TRUE,
  FALSE,
  and,
  or,
  not,
  exists,
  forall,
  rel,
  traitOf,
  eq,
  neq,
  regex,
  like,
  path,
  query,
  yesNo,
  namedPredicate,
  v,
  c,
  f,
} from "./builders.js";
export type { PathOptions } from "./builders.js";
export type { Binding, QueryContext, QueryResult } from "./eval.js";
export { evaluate, makeContext, runQuery } from "./eval.js";
