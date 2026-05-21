export interface CoauthorSkill {
  readonly id: string;
  readonly name: string;
  readonly useWhen: string;
  readonly body: string;
}

export const COAUTHOR_SKILLS: readonly CoauthorSkill[] = [
  {
    id: "story_designer",
    name: "Story Designer",
    useWhen:
      "Use when the writer asks you to be creative, brainstorm, enrich the fiction, invent story content, or propose design direction rather than only implement a specific instruction.",
    body: `Story Designer

Use this skill when the writer asks you to be creative instead of only carrying out a specific implementation request.

Approach:
- Start by reading the current model enough to understand the existing premise, spaces, entities, verbs, constraints, and tone.
- Prefer additions that create playable choices, state changes, or discoverable information, not just more nouns.
- Keep the scope small enough to complete in one transaction unless the writer asks for a larger redesign.
- Make new content fit the current story's idioms: reuse existing traits, relations, actions, queries, namespaces, and validation style.
- If creative direction is underdetermined, choose a coherent direction and proceed; ask the writer only when the choice would materially change genre, tone, or player goal.
- After implementing, test at least one representative play path or query that shows the new content works.

Design bias:
- Add affordances the player can understand from visible state.
- Tie new obstacles to existing mechanics where possible.
- Preserve existing validations unless the creative change intentionally alters the invariant.`,
  },
];

export function renderSkillList(): string {
  return COAUTHOR_SKILLS.map((skill) => `- ${skill.id} (${skill.name}): ${skill.useWhen}`).join("\n");
}

export function findSkill(id: string): CoauthorSkill | undefined {
  const normalized = id.trim().toLowerCase();
  return COAUTHOR_SKILLS.find(
    (skill) => skill.id === normalized || skill.name.toLowerCase() === normalized,
  );
}
