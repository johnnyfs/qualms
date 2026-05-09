import { GameDefinition, dsl, instantiate } from "../src/index.js";

const def = new GameDefinition();
dsl.loadDslFile(def, "/home/johnnyfs/Projects/qualms/qualms/prelude/core.qualms", "prelude");
const state = instantiate(def);
console.log(`Loaded prelude: ${def.traits.size} traits, ${def.relations.size} relations, ${def.actions.size} actions, ${def.kinds.size} kinds, ${def.rules.length} rules, ${def.rulebooks.size} rulebooks`);
console.log(`State entities: ${state.entities.size}`);
console.log("Traits:", [...def.traits.keys()].join(", "));
console.log("Kinds:", [...def.kinds.keys()].join(", "));
console.log("Top-level relations:", [...def.relations.values()].filter(r => !r.module || r.module === "prelude").map(r => r.id).join(", "));
