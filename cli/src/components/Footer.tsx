import { Text } from "ink";

interface Props {
  readonly mode?: "dsl" | "play";
}

export function Footer({ mode = "dsl" }: Props) {
  if (mode === "play") {
    return <Text dimColor>/help  /look  /mode dsl  /quit  •  shift+tab cycles mode  •  tab completes</Text>;
  }
  return <Text dimColor>/help  /show  /reload  /mode play  /quit  •  shift+tab cycles mode</Text>;
}
