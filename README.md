# TwitterTidy

A terminal UI for auditing the accounts you follow on X (Twitter), built with [Ink](https://github.com/vadimdemedes/ink). It lists everyone you follow in one table, and shows who follows you back and who has gone quiet, so you can decide whom to clean up.

It is read-only: it never follows, unfollows or posts.

## Features

- **One table of everyone you follow:** handle, follows-you-back, last tweet date, follower and following counts. You can sort, search and filter it, and it scrolls smoothly through thousands of rows.
- **Follow-back:** pulls your followers list once to work out who doesn't follow you back.
- **Last tweet dates:** a Following refresh dates each account's most recent post. Accounts it can't date can be checked one at a time or in a paced bulk run.
- **Inactive accounts:** flags accounts with no post in 12 months (configurable).
- **New and removed follows:** marks accounts you've followed since the last refresh, and keeps a view of accounts you no longer follow.
- **Profile details:** bio, location, join date and counts in a detail pane, or open the profile on x.com.
- **Predictable spend:** everything is cached locally in SQLite. Every bulk fetch shows an estimated cost and asks before it calls the API.

## Requirements

- Node.js 20 or later
- An [X developer](https://developer.x.com) app with OAuth 2.0 enabled and pay-per-use credits:
  - Callback URL: `http://127.0.0.1:8765/callback`, or use your own port (see `TWITTERTIDY_PORT` below).
  - Scopes: `tweet.read users.read follows.read offline.access`.

## Setup

```sh
npm install
npm run build
export X_CLIENT_ID=your-oauth2-client-id
export X_CLIENT_SECRET=your-client-secret   # only for confidential clients
npm start
```

The first run opens your browser to sign in to X. Tokens are refreshed automatically after that.

| Variable | Required | Meaning |
| --- | --- | --- |
| `X_CLIENT_ID` | Yes | Your app's OAuth 2.0 Client ID |
| `X_CLIENT_SECRET` | No | Set it if your app is a confidential client |
| `TWITTERTIDY_PORT` | No | Port for the local login callback (default `8765`) |

## Using it

Press `r` to pull your Following list, then `F` to pull your followers. The table only reads from the local cache, so browsing never costs anything.

| Key | Action |
| --- | --- |
| ↑ / ↓, PgUp / PgDn | Move |
| `1`–`5` | Sort by a column; press again to reverse |
| `/` | Search handles and names (Enter keeps it, Esc clears it) |
| `f` | Show only accounts that don't follow you back |
| `i` | Show only inactive accounts |
| `x` | Show accounts you no longer follow |
| Enter / Esc | Open / close the detail pane |
| `o` | Open the profile in your browser |
| `l` | Check the highlighted account's last tweet |
| Space | Mark a row; `b` checks the marked rows |
| `a` | Check every account whose last tweet date is unknown or stale |
| `r` / `F` | Refresh Following / followers |
| `q` | Quit |

### Costs

X charges per resource read. The app estimates each bulk fetch from these approximate prices, which you should confirm in the X Developer Console:

- A Following refresh costs about $0.015 per account: a following read, plus one post read for its most recent post.
- A followers refresh costs about $0.01 per account.
- A last-tweet check costs about $0.025 per account (5 posts). Protected, suspended, recently checked and never-posted accounts are skipped at no cost.

Bulk checks pace themselves under X's limit of 900 requests per 15 minutes. You can cancel one with Esc or `c`, and running it again carries on where it stopped. Setting a spend cap in the Developer Console is a good idea.

### Configuration

Optional settings live in `~/.config/twittertidy/config.json`:

```json
{ "inactiveMonths": 12 }
```

## Your data

Everything stays on your machine, in `~/.config/twittertidy/`:

- `tokens.json`: your X login (file mode `0600`)
- `cache.db`: the SQLite cache of accounts, followers and last tweet dates
- `config.json`: your settings, if any

Delete the folder to sign out and clear the cache.

## Development

```sh
npm run dev         # run from source with tsx
npm test            # vitest
npm run typecheck
npm run build
```

Tests use fakes and never call the X API.

## Licence

[MIT](LICENSE)
