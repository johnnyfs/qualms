import { Text } from "ink";
import type { MenuFrame } from "./menuState.js";

interface Props {
  readonly frame: MenuFrame;
}

export function MenuFooter({ frame }: Props) {
  const parts: string[] = [
    "↑↓: navigate",
    "pgup/pgdn: page",
    "enter: select",
    "1-9: pick",
  ];
  if (frame.backOption) {
    parts.push(`0: ${frame.backOption.label}`);
  }
  parts.push("shift+tab: dsl", "ctrl+d: quit");
  return <Text dimColor>{`  ${parts.join("  ·  ")}`}</Text>;
}
