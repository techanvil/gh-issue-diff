#!/usr/bin/env node
// Show how a GitHub issue's (or pull request's) body has changed since a given date.
//
// The "since" point can be a date/time, a relative duration (e.g. 3d), or a link to a
// comment on the issue, in which case the comment's creation time is used.
//
// Requires the GitHub CLI (`gh`, authenticated), `git` and `delta`.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

class UserError extends Error {}

// ---------------------------------------------------------------------------
// Targets and GitHub access
// ---------------------------------------------------------------------------

const URL_RE =
  /^https?:\/\/(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?:issues|pull)\/(?<number>\d+)[^#]*(?:#(?<fragment>.*))?$/;
const SHORT_RE = /^(?:(?<owner>[\w.-]+)\/(?<repo>[\w.-]+))?#?(?<number>\d+)$/;

function parseTarget(value) {
  value = value.trim();
  let m = value.match(URL_RE);
  if (m) {
    const { host, owner, repo, number, fragment } = m.groups;
    return { host, owner, repo, number: Number(number), fragment: fragment || null };
  }
  m = value.match(SHORT_RE);
  if (m) {
    let { owner, repo, number } = m.groups;
    if (!owner) [owner, repo] = currentRepo();
    return { host: "github.com", owner, repo, number: Number(number), fragment: null };
  }
  throw new UserError(`can't understand issue reference: ${JSON.stringify(value)}`);
}

const slug = (t) => `${t.owner}/${t.repo}#${t.number}`;

function run(cmd, args, what) {
  const proc = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (proc.error?.code === "ENOENT") throw new UserError(`${cmd} is required: ${what}`);
  if (proc.error) throw proc.error;
  return proc;
}

function gh(args, host) {
  if (host !== "github.com") args = [...args, "--hostname", host];
  const proc = run("gh", ["api", ...args], "https://cli.github.com/");
  if (proc.status !== 0) throw new UserError(proc.stderr.trim() || `gh api failed (${proc.status})`);
  return JSON.parse(proc.stdout);
}

function currentRepo() {
  const proc = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    "https://cli.github.com/");
  if (proc.status !== 0) {
    throw new UserError("no repository given and couldn't determine one from the current directory");
  }
  return proc.stdout.trim().split("/");
}

const EDITABLE_FIELDS = `
  title url body createdAt author { login }
  userContentEdits(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { editedAt deletedAt editor { login } diff }
  }`;
const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { ${EDITABLE_FIELDS} }
      ... on PullRequest { ${EDITABLE_FIELDS} }
    }
  }
}`;

const normalise = (text) => (text ?? "").replace(/\r\n?/g, "\n");

// Edits come back newest first; when a body has been edited at all, the last entry
// holds the original body. `body` is null for revisions deleted from the history.
function fetchIssue(t) {
  const edits = [];
  let node, cursor;
  do {
    const args = ["graphql", "-f", `query=${ISSUE_QUERY}`, "-f", `owner=${t.owner}`,
      "-f", `repo=${t.repo}`, "-F", `number=${t.number}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    node = gh(args, t.host).data.repository?.issueOrPullRequest;
    if (!node) throw new UserError(`${slug(t)} not found`);
    for (const e of node.userContentEdits.nodes) {
      edits.push({
        editedAt: new Date(e.editedAt),
        editor: e.editor?.login ?? "ghost",
        body: e.deletedAt ? null : normalise(e.diff),
      });
    }
    cursor = node.userContentEdits.pageInfo.hasNextPage && node.userContentEdits.pageInfo.endCursor;
  } while (cursor);
  return {
    kind: node.__typename === "PullRequest" ? "pull request" : "issue",
    title: node.title,
    url: node.url,
    body: normalise(node.body),
    createdAt: new Date(node.createdAt),
    edits,
  };
}

// Timestamp and description of the comment/review a URL fragment points at.
function fetchFragmentTime(t) {
  const frag = t.fragment ?? "";
  const base = `repos/${t.owner}/${t.repo}`;
  let m;
  if ((m = frag.match(/^issuecomment-(\d+)$/))) {
    const c = gh([`${base}/issues/comments/${m[1]}`], t.host);
    return [new Date(c.created_at), `comment by @${c.user.login}`];
  }
  if ((m = frag.match(/^(?:discussion_)?r(\d+)$/))) {
    const c = gh([`${base}/pulls/comments/${m[1]}`], t.host);
    return [new Date(c.created_at), `review comment by @${c.user.login}`];
  }
  if ((m = frag.match(/^pullrequestreview-(\d+)$/))) {
    const r = gh([`${base}/pulls/${t.number}/reviews/${m[1]}`], t.host);
    return [new Date(r.submitted_at), `review by @${r.user.login}`];
  }
  throw new UserError(`link doesn't point at a comment: #${frag}`);
}

const pointsAtComment = (t) => Boolean(t.fragment) && !t.fragment.startsWith("issue-");

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const RELATIVE_RE = /^(\d+)\s*(m|min|h|d|w)(?:\s*ago)?$/i;
const UNIT_MS = { m: 6e4, min: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

function parseWhen(value) {
  value = value.trim();
  let m;
  if ((m = value.match(RELATIVE_RE))) return new Date(Date.now() - m[1] * UNIT_MS[m[2].toLowerCase()]);
  if (/^(today|yesterday)$/i.test(value)) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (/^y/i.test(value)) d.setDate(d.getDate() - 1);
    return d;
  }
  // JS treats a bare date as UTC but a bare date-time as local; make both local.
  if ((m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return new Date(m[1], m[2] - 1, m[3]);
  const d = /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value) : new Date(NaN);
  if (isNaN(d)) {
    throw new UserError(`can't understand date: ${JSON.stringify(value)} ` +
      "(try 2024-05-01, 2024-05-01T14:30, 3d, 12h, yesterday or a comment URL)");
  }
  return d;
}

// A --since/--until value: a date, a comment URL, or a bare #fragment on the same issue.
function resolveWhen(value, target) {
  if (value.startsWith("#") && !/^#\d+$/.test(value)) {
    return fetchFragmentTime({ ...target, fragment: value.slice(1) });
  }
  if (URL_RE.test(value)) return fetchFragmentTime(parseTarget(value));
  const d = parseWhen(value);
  return [d, fmtTime(d)];
}

const pad = (n) => String(n).padStart(2, "0");

function fmtTime(d) {
  const tz = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())} ${tz}`.trimEnd();
}

function fmtAgo(d) {
  const secs = (Date.now() - d) / 1000;
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["week", 604800],
    ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (secs >= size) return rtf.format(-Math.floor(secs / size), unit);
  }
  return "just now";
}

// ---------------------------------------------------------------------------
// Body history
// ---------------------------------------------------------------------------

// The body as it was at `when`, plus an optional warning.
function bodyAt(issue, when) {
  if (when < issue.createdAt) return ["", null];
  if (!issue.edits.length) return [issue.body, null];
  let candidates = issue.edits.filter((e) => e.editedAt <= when);
  if (!candidates.length) candidates = issue.edits.slice(-1);
  const i = candidates.findIndex((e) => e.body !== null);
  if (i < 0) throw new UserError("the relevant revisions of the body have been deleted from the history");
  const warning = i === 0 ? null :
    `the revision in effect at ${fmtTime(when)} has been deleted from the history; ` +
    `comparing with the revision from ${fmtTime(candidates[i].editedAt)}`;
  return [candidates[i].body, warning];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Unified diff of two bodies from `git diff --no-index`, with readable file labels.
function unifiedDiff(oldText, newText, context, oldLabel, newLabel) {
  const dir = mkdtempSync(join(tmpdir(), "gh-issue-diff-"));
  try {
    const withEol = (s) => (s && !s.endsWith("\n") ? s + "\n" : s);
    writeFileSync(join(dir, "old"), withEol(oldText));
    writeFileSync(join(dir, "new"), withEol(newText));
    const proc = spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff",
      `--unified=${context}`, "--src-prefix=", "--dst-prefix=", "old", "new"],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (proc.error?.code === "ENOENT") throw new UserError("git is required: https://git-scm.com/");
    if (proc.status > 1) throw new UserError(proc.stderr.trim() || "git diff failed");
    return proc.stdout
      .replace(/^diff --git old new$/m, `diff --git ${oldLabel} ${newLabel}`)
      .replace(/^--- old$/m, `--- ${oldLabel}`)
      .replace(/^\+\+\+ new$/m, `+++ ${newLabel}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function styler(enabled) {
  return (text, ...codes) => (enabled && codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text);
}
const [BOLD, DIM, ITALIC, GREEN, YELLOW, BLUE, MAGENTA, CYAN] = ["1", "2", "3", "32", "33", "34", "35", "36"];

function header(issue, since, sinceDesc, until, untilDesc, edits, s) {
  const out = [
    s(issue.title, BOLD) + s(`  (${issue.kind})`, DIM),
    s(issue.url, BLUE),
    "",
    `${s("since", DIM)}  ${s(sinceDesc, YELLOW)}` +
      s(sinceDesc === fmtTime(since) ? `  (${fmtAgo(since)})` : `  (${fmtTime(since)}, ${fmtAgo(since)})`, DIM),
  ];
  if (until) {
    out.push(`${s("until", DIM)}  ${s(untilDesc, YELLOW)}` +
      (untilDesc === fmtTime(until) ? "" : s(`  (${fmtTime(until)})`, DIM)));
  }
  if (edits.length) {
    out.push("", s(`${edits.length} ${edits.length === 1 ? "edit" : "edits"} in this period:`, BOLD));
    for (const e of [...edits].reverse()) {
      const what = e === issue.edits.at(-1) ? "created" : "edited";
      const gone = e.body === null ? s("  (revision deleted)", DIM, ITALIC) : "";
      out.push(`  ${s("•", MAGENTA)} ${fmtTime(e.editedAt)}  ${s(what, DIM)} by ${s("@" + e.editor, CYAN)}${gone}`);
    }
  }
  return out;
}

function toDelta(text, deltaArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn("delta", deltaArgs, { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", (err) =>
      reject(err.code === "ENOENT" ? new UserError("delta is required: https://github.com/dandavison/delta") : err));
    child.on("close", (code) => resolve(code ?? 0));
    child.stdin.on("error", () => {}); // delta/pager quit early
    child.stdin.end(text);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `usage: gh-issue-diff ISSUE [options] [-- DELTA_OPTIONS...]

Show changes to a GitHub issue's (or PR's) body since a given date or comment, via delta.

arguments:
  ISSUE                  issue/PR URL (optionally a comment link), owner/repo#N, or N

options:
  -s, --since WHEN       date, duration or comment link to diff from
                         (default: the comment in the ISSUE link, if any)
  -u, --until WHEN       date or comment link to diff to (default: the current body)
  -U, --context N        lines of context around changes (default: 3)
      --full             show the whole body, not just the changes
      --unified          print a plain unified diff instead of running delta
                         (the default when stdout isn't a terminal)
  -h, --help             show this help

Anything after -- is passed to delta, e.g. -- --side-by-side

examples:
  gh-issue-diff https://github.com/owner/repo/issues/42 --since 2024-05-01
  gh-issue-diff owner/repo#42 --since 3d
  gh-issue-diff https://github.com/owner/repo/issues/42#issuecomment-123456
  gh-issue-diff owner/repo#42 --since https://github.com/owner/repo/issues/42#issuecomment-123456
  gh-issue-diff 42 --since '#issuecomment-123456'      (issue in the current repo)

dates: ISO 8601 (2024-05-01, 2024-05-01T14:30, 2024-05-01T14:30Z; naive times are local),
       relative (30m, 12h, 3d, 2w), 'today' or 'yesterday', or a link to a comment/review.`;

async function main(argv) {
  const sep = argv.indexOf("--");
  const deltaArgs = sep < 0 ? [] : argv.slice(sep + 1);
  let parsed;
  try {
    parsed = parseArgs({
      args: sep < 0 ? argv : argv.slice(0, sep),
      allowPositionals: true,
      options: {
        since: { type: "string", short: "s" },
        until: { type: "string", short: "u" },
        context: { type: "string", short: "U", default: "3" },
        full: { type: "boolean" },
        unified: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UserError(`${e.message}\n\n${HELP}`);
  }
  const { values: opts, positionals } = parsed;
  if (opts.help) return console.log(HELP), 0;
  if (positionals.length !== 1) throw new UserError(`expected one ISSUE argument\n\n${HELP}`);
  const context = opts.full ? 1e6 : Number.parseInt(opts.context, 10);
  if (!(context >= 0)) throw new UserError(`--context must be a number: ${opts.context}`);

  const target = parseTarget(positionals[0]);
  let since, sinceDesc;
  if (opts.since) [since, sinceDesc] = resolveWhen(opts.since, target);
  else if (pointsAtComment(target)) [since, sinceDesc] = fetchFragmentTime(target);
  else throw new UserError("say when to diff from: use --since, or pass a link to a comment");

  let until = null, untilDesc = "";
  if (opts.until) {
    [until, untilDesc] = resolveWhen(opts.until, target);
    if (until < since) throw new UserError("--until is before --since");
  }

  const issue = fetchIssue(target);
  const [oldBody, warnOld] = bodyAt(issue, since);
  const [newBody, warnNew] = until ? bodyAt(issue, until) : [issue.body, null];
  const warnings = [warnOld, warnNew].filter(Boolean);
  const edits = issue.edits.filter((e) => e.editedAt > since && (!until || e.editedAt <= until));

  const tty = process.stdout.isTTY;
  const diff = unifiedDiff(oldBody, newBody, context,
    `${slug(target)} @ ${sinceDesc}`, `${slug(target)} @ ${until ? untilDesc : "now"}`);

  if (opts.unified || !tty) {
    for (const w of warnings) console.error(`gh-issue-diff: warning: ${w}`);
    process.stdout.write(diff);
    return 0;
  }

  const s = styler(!process.env.NO_COLOR);
  const lines = header(issue, since, sinceDesc, until, untilDesc, edits, s);
  for (const w of warnings) lines.push("", s(`⚠ ${w}`, YELLOW));
  if (since < issue.createdAt) {
    lines.push("", s(`ⓘ the ${issue.kind} was created after this date (${fmtTime(issue.createdAt)}), ` +
      "so all of the body is new", DIM));
  }
  if (!diff) {
    const msg = edits.length ? "the body was edited, but its content ended up the same" : "no changes to the body";
    console.log([...lines, "", s(`✓ ${msg}`, GREEN)].join("\n"));
    return 0;
  }
  return toDelta(`${lines.join("\n")}\n\n${diff}`, deltaArgs);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (!(err instanceof UserError)) throw err;
    console.error(`gh-issue-diff: ${err.message}`);
    process.exit(1);
  },
);
