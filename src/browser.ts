import { execFile } from 'node:child_process';

/** Opens a URL in the system browser. Best effort: failures are ignored. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

/** An account's profile page on X. */
export const profileUrl = (handle: string) => `https://x.com/${encodeURIComponent(handle)}`;
