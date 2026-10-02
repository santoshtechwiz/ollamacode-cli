# Branching and releases

ocode follows git flow: `main` only ever holds released code, `develop` is where work comes together, and every
change reaches them through a short-lived branch and a pull request.

## Branches

| Branch | Holds | Branches from | Merges into | Lifetime |
|---|---|---|---|---|
| `main` | Exactly what is published to npm. Every commit on it is a tagged release. | — | — | permanent |
| `develop` | The next release, always green (typecheck + tests pass). | `main` (once) | — | permanent |
| `feature/<topic>` | One new capability. | `develop` | `develop` | until merged |
| `fix/<topic>` | One bug fix that can wait for the next release. | `develop` | `develop` | until merged |
| `release/<x.y.z>` | Stabilising a release: version bump, changelog, last fixes only. | `develop` | `main` **and** `develop` | days |
| `hotfix/<x.y.z>` | An urgent fix to what is already published. | `main` | `main` **and** `develop` | hours |

Names are lower-case, words joined by `-`: `feature/stream-debug-flag`, `fix/self-kill-guard`,
`release/0.3.0`, `hotfix/0.3.1`. Agent-made branches (`claude/...`) follow the same rules: they target `develop`.

## Rules

- **Nothing is committed straight to `main` or `develop`.** Every change is a pull request.
- **A pull request merges only when** `npm run typecheck` and `npm test` pass, and the change has been tried in a
  real `ocode` session (see the change rules in `.claude/skills/ocode-change`).
- **One concern per branch.** A fix and an unrelated refactor are two branches.
- **Merging:** feature and fix branches are squash-merged into `develop` (one commit per change, its message the
  change's summary). Release and hotfix branches are merged with a merge commit, so `main` shows each release.
- **Delete the branch once it is merged**, locally and on GitHub.

## Versions

[Semantic versioning](https://semver.org), `MAJOR.MINOR.PATCH`, from `package.json`:

- **PATCH** (`0.2.4 → 0.2.5`): fixes only; nothing the person or a config file has to change.
- **MINOR** (`0.2.x → 0.3.0`): new capability, new tool, new command or flag; existing use keeps working.
- **MAJOR** (`0.x → 1.0.0`, then `1.x → 2.0.0`): something existing stops working as before (a removed flag, a
  changed config key, a session format older versions cannot read).

While the version is `0.x`, a breaking change may go out as a MINOR release; say so in the changelog.

Every release is tagged `v<version>` on `main` (`v0.3.0`), as an annotated tag. Other tags (working baselines such as
`baseline-2026-10-02`) stay local or are deleted; only `v*` tags are pushed.

## Cutting a release

```sh
git switch develop && git pull
git switch -c release/0.3.0
npm version 0.3.0 --no-git-tag-version       # bumps package.json and package-lock.json
# add a "## 0.3.0 — <date>" section to CHANGELOG.md: what changed for the person using ocode
npm run typecheck && npm test
git commit -am "Release 0.3.0"
git push -u origin release/0.3.0             # open a PR into main
```

Only fixes for problems found while testing the release go on `release/*`; new work waits for the next one.
Once the pull request into `main` is merged, tag it; the tag publishes:

```sh
git switch main && git pull
git tag -a v0.3.0 -m "ocode 0.3.0"
git push origin v0.3.0
git branch -d release/0.3.0 && git push origin --delete release/0.3.0
```

Pushing `v0.3.0` starts the **Publish** workflow (`.github/workflows/publish.yml`). It checks that the tag matches
`package.json` and sits on `main`, runs the typecheck and tests, publishes to npm with provenance, and creates the
GitHub release with that version's `CHANGELOG.md` section as its notes. Follow it under the repository's
**Actions** tab. Then bring the release back into `develop` with a pull request from `main` into `develop`
(merge commit, not squash).

### One-time setup for publishing

1. On npmjs.com: your avatar → **Access Tokens** → **Generate New Token** → **Classic Token** → type
   **Automation** (it skips the one-time password a workflow cannot type). Copy it.
2. On GitHub: the repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**,
   name `NPM_TOKEN`, value the token.

**CI** (`.github/workflows/ci.yml`) runs the typecheck and tests on Linux and Windows for every pull request into
`develop` or `main`. Make it a required check in the branch protection rules, so nothing red can be merged.

## Hotfix

```sh
git switch main && git pull
git switch -c hotfix/0.3.1
# fix, with a test that fails without it
npm version 0.3.1 --no-git-tag-version
npm run typecheck && npm test
git commit -am "Release 0.3.1"
git push -u origin hotfix/0.3.1              # PR into main
```

Then tag, publish and merge back into `develop` exactly as for a release.

## Hooks

`npm install` points git at the shared hooks in `.githooks/` (`git config core.hooksPath .githooks`), which hold
everyone to the rules above:

| Hook | Stops |
|---|---|
| `pre-commit` | a commit on `main` or `develop`; a commit on a branch whose name breaks the naming above |
| `pre-push` | a push to `main` or `develop`; a branch with a bad name; a `release/x.y.z` or `hotfix/x.y.z` whose `package.json` is not at `x.y.z`; any tag but `v<x.y.z>`; a branch (other than `feature/*`) that fails `npm run typecheck` or `npm test` |

Deleting a remote branch or tag is never stopped. Merges into `main` and `develop` happen on GitHub, where the
pull request is, so the hooks never need bypassing in normal work. If one ever has to be (an emergency fix with
GitHub down), `--no-verify` skips it; say so in the pull request.

## Day to day

```sh
git switch develop && git pull
git switch -c fix/self-kill-guard
# work, commit
git push -u origin fix/self-kill-guard       # PR into develop
```

After it merges: `git switch develop && git pull && git branch -d fix/self-kill-guard`.
To clear out every merged branch: `git fetch --prune && git branch --merged develop | grep -vE '^\*|main|develop' | xargs git branch -d`.
