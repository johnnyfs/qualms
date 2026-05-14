import { Box, Text } from "ink";
import type { MenuFrame } from "./menuState.js";

interface Props {
  readonly frame: MenuFrame;
  readonly selectedIndex: number;
}

export function MenuPanel({ frame, selectedIndex }: Props) {
  const numbered = frame.options.slice(0, 9);
  const overflow = frame.options.length > 9;
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      {frame.headers.map((header, i) => (
        <Text key={i} bold={i === 0}>
          {header}
        </Text>
      ))}
      <Text> </Text>
      {numbered.map((option, i) => {
        const selected = i === selectedIndex;
        const marker = selected ? "▶" : " ";
        const label = labelOf(option);
        return (
          <Text key={i} bold={selected} inverse={selected} color={selected ? "yellow" : undefined}>
            {`${marker} ${i + 1}. ${label}`}
          </Text>
        );
      })}
      {overflow ? <Text dimColor>  ...and more</Text> : null}
      {frame.backOption ? (
        <Text dimColor>{`  0. ${labelOf(frame.backOption)}`}</Text>
      ) : null}
    </Box>
  );
}

function labelOf(option: { kind: string; label?: string; verbId?: string; id?: string }): string {
  if ("label" in option && typeof option.label === "string") return option.label;
  if ("verbId" in option && typeof option.verbId === "string") return option.verbId;
  if ("id" in option && typeof option.id === "string") return option.id;
  return option.kind;
}
