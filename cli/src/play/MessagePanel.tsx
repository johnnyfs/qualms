import { Box, Text } from "ink";
import type { language } from "@quealm/qualms";
import type { AboutLine } from "../aboutText.js";
import { formatMockupResult } from "./mockupState.js";

interface Props {
  readonly result?: language.LanguagePlayResult;
  readonly error?: string;
  readonly info?: readonly AboutLine[];
}

export function MessagePanel({ result, error, info }: Props) {
  if (!result && !error && !info) return null;
  const failed = Boolean(error) || result?.status === "failed";
  const isInfo = !failed && !result && Boolean(info);
  const borderColor = failed ? "red" : isInfo ? "cyan" : "green";
  const mark = failed ? "x" : isInfo ? "?" : "ok";
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      <Text color={borderColor} bold>{mark}</Text>
      {info
        ? info.map((line, i) => (
            <Text key={i} bold={Boolean(line.bold)}>
              {line.text}
            </Text>
          ))
        : formatMockupResult(result, error).map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
    </Box>
  );
}
