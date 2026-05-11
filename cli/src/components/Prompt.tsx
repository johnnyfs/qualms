import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface Props {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}

export function Prompt({ value, onChange, onSubmit }: Props) {
  return (
    <Box>
      <Text color="cyan">{"> "}</Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
}
