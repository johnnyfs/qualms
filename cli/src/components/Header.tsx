import { Box, Text } from "ink";
import type { language } from "@quealm/qualms";
import { relative } from "node:path";

interface Props {
  readonly model: language.StoryModel;
  readonly storyPaths: readonly string[];
}

export function Header({ model, storyPaths }: Props) {
  const display =
    storyPaths.length === 0
      ? "(empty model)"
      : storyPaths.map((p) => relative(process.cwd(), p) || p).join(", ");
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text>
        <Text bold>qualms-cli</Text>
        <Text dimColor>{` — ${display}`}</Text>
      </Text>
      <Text dimColor>
        {`traits ${model.traits.size}  relations ${model.relations.size}  predicates ${model.predicates.size}  actions ${model.actions.size}  entities ${model.entities.size}  facts ${model.listFacts().length}`}
      </Text>
    </Box>
  );
}
