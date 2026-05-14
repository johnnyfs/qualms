import { Box, Text } from "ink";
import type { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import type { VerbTable } from "./verbs.js";
import { formatResult } from "./resultFormatter.js";

interface Props {
  readonly model: language.StoryModel;
  readonly config: PlayConfig;
  readonly names: NameIndex;
  readonly verbs: VerbTable;
  readonly atom?: language.RelationAtom;
  readonly result?: language.LanguagePlayResult;
  readonly queryResult?: language.LanguageQueryResult;
}

export function MessagePanel({
  model,
  config,
  names,
  verbs,
  atom,
  result,
  queryResult,
}: Props) {
  if (!atom || (!result && !queryResult)) return null;
  const failed =
    (result && result.status !== "passed") ||
    (queryResult && queryResult.status !== "passed");
  const message = formatResult(atom, {
    model,
    config,
    names,
    verbs,
    ...(result ? { result } : {}),
    ...(queryResult ? { queryResult } : {}),
  });
  const borderColor = failed ? "red" : "green";
  const mark = failed ? "✗" : "✓";
  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={borderColor} bold>
        {mark}
      </Text>
      <Text>{message}</Text>
    </Box>
  );
}
