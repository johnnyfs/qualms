import { parseStatements } from "../src/query/index.js";

try {
  const stmts = parseStatements(`
    def action Unequip(actor: ref<Actor>, item: ref<Equipment>) {
      requires: ?- true;
      default: [ item.Equipment.equipped_by := null; ];
    };
  `);
  console.log("OK", stmts.length);
} catch (e) {
  console.error("FAIL:", (e as Error).message);
}
