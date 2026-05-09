import { GameDefinition, yaml, dsl } from "../src/index.js";

const def = new GameDefinition();
yaml.loadFileIntoDefinition(def, "/home/johnnyfs/Projects/qualms/qualms/prelude/core.qualms.yaml", "prelude");
console.log(dsl.emitDsl(def, "prelude"));
