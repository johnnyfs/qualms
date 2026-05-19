import { Box, Text } from "ink";
import type { language } from "@quealm/qualms";
import { formatMockupResult } from "./mockupState.js";

interface Props {
  readonly result?: language.LanguagePlayResult;
  readonly error?: string;
  readonly info?: readonly string[];
}

export function MessagePanel({ result, error, info }: Props) {
  if (!result && !error && !info) return null;
  const failed = Boolean(error) || result?.status === "failed";
  const isInfo = !failed && !result && Boolean(info);
  const borderColor = failed ? "red" : isInfo ? "cyan" : "green";
  const mark = failed ? "x" : isInfo ? "?" : "ok";
  const lines = info ?? formatMockupResult(result, error);
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      <Text color={borderColor} bold>{mark}</Text>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}
