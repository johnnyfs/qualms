import { Text } from "ink";
import type { MenuFrame } from "./menuState.js";

interface Props {
  readonly frame: MenuFrame;
}

export function MenuFooter({ frame }: Props) {
  const parts: string[] = ["shift+tab: dsl", "1-9: pick"];
  if (frame.backOption) {
    parts.push(`0: ${frame.backOption.kind === "stop_talking" ? "stop talking" : "back"}`);
  }
  return <Text dimColor>{`  ${parts.join("  ·  ")}`}</Text>;
}
