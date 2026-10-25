import { Box, Text } from 'ink';

export function Header({ title }: { title: string }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">
        {title}
      </Text>
    </Box>
  );
}
