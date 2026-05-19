import { Box, Text } from "ink";
import type { MockupMenuFrame } from "./mockupState.js";

interface Props {
  readonly frame: MockupMenuFrame;
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly windowSize: number;
  readonly borderColor?: string;
}

export function MenuPanel({
  frame,
  selectedIndex,
  scrollOffset,
  windowSize,
  borderColor = "yellow",
}: Props) {
  const total = frame.options.length;
  const visible = frame.options.slice(scrollOffset, scrollOffset + windowSize);
  const hiddenAbove = scrollOffset;
  const hiddenBelow = Math.max(0, total - scrollOffset - windowSize);
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {frame.headers.map((header, i) => (
        <Text key={i} bold={i === 0}>
          {header}
        </Text>
      ))}
      <Text> </Text>
      {hiddenAbove > 0 ? (
        <Text dimColor>{`  ↑ ${hiddenAbove} more above`}</Text>
      ) : null}
      {visible.map((option, i) => {
        const absoluteIndex = scrollOffset + i;
        const selected = absoluteIndex === selectedIndex;
        const marker = selected ? "▶" : " ";
        const label = labelOf(option);
        return (
          <Text
            key={absoluteIndex}
            bold={selected}
            inverse={selected}
            color={selected ? "yellow" : undefined}
          >
            {`${marker} ${i + 1}. ${label}`}
          </Text>
        );
      })}
      {hiddenBelow > 0 ? (
        <Text dimColor>{`  ↓ ${hiddenBelow} more below`}</Text>
      ) : null}
    </Box>
  );
}

function labelOf(option: { label?: string; verbId?: string; id?: string }): string {
  if ("label" in option && typeof option.label === "string") return option.label;
  if ("verbId" in option && typeof option.verbId === "string") return option.verbId;
  if ("id" in option && typeof option.id === "string") return option.id;
  return "";
}
