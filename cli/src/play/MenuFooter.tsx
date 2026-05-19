import { Text } from "ink";
import type { MockupMenuFrame } from "./mockupState.js";

interface Props {
  readonly frame: MockupMenuFrame;
}

export function MenuFooter({ frame }: Props) {
  const parts: string[] = [
    "↑↓: navigate",
    "pgup/pgdn: page",
    "enter: select",
    "1-9: pick",
    "?: help",
  ];
  parts.push("shift+tab: coauthor", "ctrl+d: quit");
  return <Text dimColor>{`  ${parts.join("  ·  ")}`}</Text>;
}
