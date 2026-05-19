import { Text } from "ink";

interface Props {
  readonly mode?: "dsl" | "play" | "coauthor";
}

export function Footer({ mode = "dsl" }: Props) {
  if (mode === "play") {
    return <Text dimColor>/help  /look  /mode coauthor  /quit  •  shift+tab cycles mode</Text>;
  }
  if (mode === "coauthor") {
    return <Text dimColor>/help  /about  /cancel  /mode dsl  /quit  •  shift+tab cycles mode</Text>;
  }
  return <Text dimColor>/help  /about  /show  /reload  /mode play  /quit  •  shift+tab cycles mode</Text>;
}
