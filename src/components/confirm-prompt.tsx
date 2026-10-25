import { Box, Text, useInput } from 'ink';

interface ConfirmPromptProps {
  title: string;
  /** The cost estimate shown before anything is fetched. */
  estimate: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks the user to confirm a bulk fetch after showing its estimated cost. */
export function ConfirmPrompt({ title, estimate, onConfirm, onCancel }: ConfirmPromptProps) {
  useInput((input, key) => {
    if (input === 'y' || key.return) onConfirm();
    else if (input === 'n' || key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      <Text>Estimated cost: {estimate}</Text>
      <Text dimColor>y / enter to continue · n / esc to cancel</Text>
    </Box>
  );
}
