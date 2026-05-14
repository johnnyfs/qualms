import { Box, Text } from "ink";
import type { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import { currentLocation, visibleEntities } from "./resolve.js";

interface Props {
  readonly model: language.StoryModel;
  readonly config: PlayConfig;
  readonly names: NameIndex;
}

export function RoomPanel({ model, config, names }: Props) {
  const location = currentLocation(model, config);
  if (!location) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
        <Text color="red">
          (no location: {config.player} has no {config.visibility.locationFact} fact)
        </Text>
      </Box>
    );
  }
  const title = names.titleName(location);
  const description = config.descriptions.get(location);
  const visible = visibleEntities(model, config);
  const presentations: string[] = [];
  for (const id of visible.ids) {
    if (id === location) continue;
    const presentation = config.presentations.get(id);
    if (presentation) presentations.push(presentation);
  }
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold>{title}</Text>
      {description ? (
        <>
          <Text> </Text>
          <Text>{description}</Text>
        </>
      ) : null}
      {presentations.length > 0 ? <Text> </Text> : null}
      {presentations.map((line, i) => (
        <Text key={i}>· {line}</Text>
      ))}
    </Box>
  );
}
