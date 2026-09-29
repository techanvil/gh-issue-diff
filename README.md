# gh-issue-diff

Show how a GitHub issue's (or pull request's) body has changed since a given date, rendered by [delta](https://github.com/dandavison/delta).

The starting point can be a date, a relative duration, or a **link to a comment**. With a link, the comment's creation time is used, which answers "what changed in the description since this comment was posted?"

## Requirements

- Node.js 20+ (no npm dependencies)
- The [GitHub CLI](https://cli.github.com/), logged in (`gh auth login`). It handles authentication, so private repos and GitHub Enterprise work too.
- [delta](https://github.com/dandavison/delta), which renders the diff
- git, which generates the diff (`git diff --no-index`)

## Install

```sh
npm install -g .      # or: ln -s "$PWD/gh-issue-diff.mjs" ~/.local/bin/gh-issue-diff
```

## Usage

```sh
# Since a date / time (naive times are local; append Z for UTC)
gh-issue-diff https://github.com/owner/repo/issues/42 --since 2024-05-01
gh-issue-diff owner/repo#42 --since 2024-05-01T14:30

# Since a relative time
gh-issue-diff owner/repo#42 --since 3d        # also 30m, 12h, 2w, today, yesterday

# Since a comment: paste the comment's link (from its "Copy link" menu)
gh-issue-diff https://github.com/owner/repo/issues/42#issuecomment-123456

# ...or pass the comment link to --since / --until
gh-issue-diff owner/repo#42 --since https://github.com/owner/repo/issues/42#issuecomment-123456
gh-issue-diff 42 --since '#issuecomment-123456'   # issue in the current directory's repo

# A window between two points
gh-issue-diff owner/repo#42 --since 2024-05-01 --until 2024-06-01

# Pass options through to delta
gh-issue-diff owner/repo#42 --since 1w -- --side-by-side
```

Pull requests work the same way. Review comment links (`#discussion_r…`) and review links (`#pullrequestreview-…`) are also accepted.

### Options

| Option | Description |
| --- | --- |
| `-s, --since WHEN` | Date, duration or comment link to diff from |
| `-u, --until WHEN` | Date or comment link to diff to (default: the current body) |
| `-U, --context N` | Lines of context around changes (default 3) |
| `--full` | Show the whole body with the changes marked |
| `--unified` | Print a plain unified diff instead of running delta (the default when output isn't a terminal) |
| `-- …` | Everything after `--` is passed to delta |

In a terminal, the output starts with a header: the issue title, the time range, and every edit made in that range (who and when). The diff follows. Everything is piped through delta, so your delta configuration (theme, features, pager) applies. `NO_COLOR` turns off the header's colours.

## How it works

GitHub keeps every revision of an issue body (the "edited ▾" menu on the issue). The tool reads those revisions through the GraphQL `userContentEdits` API. It finds the revision in effect at the `--since` time and compares it with the current body, or with the revision in effect at `--until`. If the issue was created after `--since`, the whole body shows as added. If a revision was deleted from the history, the tool warns and falls back to the closest older revision.
