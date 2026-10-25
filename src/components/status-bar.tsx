import { Box, Text } from 'ink';

export function StatusBar({ message, keys }: { message: string; keys: string[] }) {
  return (
    <Box>
      <Text dimColor>{[message, ...keys].join(' · ')}</Text>
    </Box>
  );
}
