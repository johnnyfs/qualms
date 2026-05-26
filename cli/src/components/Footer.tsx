import { Text } from "ink";

interface Props {
  readonly mode?: "dsl" | "play" | "adaptive" | "coauthor";
}

export function Footer({ mode = "dsl" }: Props) {
  if (mode === "play") {
    return <Text dimColor>/help  /look  /mode adaptive  /quit  •  shift+tab cycles mode</Text>;
  }
  if (mode === "adaptive") {
    return <Text dimColor>/help  /look  /trace  /cancel  /mode coauthor  /quit  •  shift+tab cycles mode</Text>;
  }
  if (mode === "coauthor") {
    return <Text dimColor>/help  /about  /save  /revert  /cancel  /mode dsl  /quit  •  shift+tab cycles mode</Text>;
  }
  return <Text dimColor>/help  /about  /save  /revert  /show  /reload  /mode play  /mode adaptive  /quit  •  shift+tab cycles mode</Text>;
}
