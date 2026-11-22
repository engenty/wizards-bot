# Contributing

Thanks for using wizards.bot. We'd love to hear from you.

The best way to help is to [open an issue](https://github.com/engenty/wizards-bot/issues/new):

- **Found a bug?** Tell us what you did, what you expected and what happened instead, along with your version and environment.
- **Have an idea?** Describe the problem you'd like solved. That helps us most in finding the right solution.
- **Got a question?** Just ask.

We read every issue.

## Changes

A change reaches `main` as a pull request, squash-merged with its title as the commit message.
The title is a [Conventional Commit](https://www.conventionalcommits.org): `type(scope): description`.
`feat`, `fix`, `perf`, `refactor` and `docs` show in [CHANGELOG.md](CHANGELOG.md); `chore`, `ci`,
`test`, `build` and `style` do not. Before you open one, run:

```bash
pnpm fix
pnpm lint
pnpm typecheck
pnpm test
```

## Releases

The version is the `version` of the root `package.json`; a release is the tag `vX.Y.Z` on `main`.
Before `1.0` a patch bump is fixes and features, a minor bump a notable or breaking change.

```bash
pnpm release
```

writes the release's block of CHANGELOG.md, bumps the version and commits on `release/vX.Y.Z`.
Push that branch and open a pull request. Once it is merged:

```bash
pnpm release:tag
```

tags main's release commit and pushes the tag; the GitHub release follows from it.
`pnpm release:changelog` only refreshes the Unreleased block of CHANGELOG.md.
