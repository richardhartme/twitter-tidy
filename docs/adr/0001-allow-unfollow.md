# 1. Allow unfollowing from the app

Date: 26 October 2026

Status: accepted

## Context

v1 was read-only: it asked X for `tweet.read users.read follows.read offline.access` and promised never to follow, unfollow or post. Unfollowing was a v1 non-goal, deferred "behind a confirmation step; needs `follows.write` and a re-auth".

Auditing the Following list ends in unfollowing people, and doing that on x.com one profile at a time defeats the point of the table.

## Decision

- The app always asks for `follows.write`. A saved login that doesn't record the scopes it was granted, or lacks one the app asks for, sends the user through sign-in once more at launch. The X developer app must be set to Read and write.
- The app unfollows, and only unfollows: never follows, re-follows or posts. There is no undo.
- Every unfollow asks y/N first (No by default), single or batch, showing the handles, the count, the time at X's limit and the estimated cost.
- Unfollows are paced by their own limiter at 50 per 15 minutes, separate from the 900 for timeline reads.
- An unfollow is recorded in the cache at once (`removed_by = 'app'`), so the account leaves the table without a refresh.

## Consequences

- Existing users sign in again once after upgrading.
- The README's "read-only" promise is replaced by "it unfollows only when you confirm".
- Unfollow pricing is unconfirmed: estimated at the "Interaction: Delete" rate of $0.01 per request. If the pay-per-use plan doesn't allow it, X answers 403 and a batch stops with that message.
