import { Box, Text } from "ink";
import type { language } from "@quealm/qualms";
import { formatMockupResult } from "./mockupState.js";

interface Props {
  readonly result?: language.LanguagePlayResult;
  readonly error?: string;
}

export function MessagePanel({ result, error }: Props) {
  if (!result && !error) return null;
  const failed = Boolean(error) || result?.status === "failed";
  const borderColor = failed ? "red" : "green";
  const mark = failed ? "x" : "ok";
  const lines = formatMockupResult(result, error);
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      <Text color={borderColor} bold>{mark}</Text>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
