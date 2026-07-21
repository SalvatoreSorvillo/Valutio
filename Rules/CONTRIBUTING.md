# Contributing To Valutio

Thanks for helping improve Valutio. The project is intentionally small and local-first, so the best contributions are focused, readable and easy to review.

Read [`../MAINTAINER_GUIDE.md`](../MAINTAINER_GUIDE.md) before changing stored
data, calculations, imports, snapshots, tax, investments, currencies,
localization, themes or publishing behavior. It is the technical source of truth
for the application and must be updated when those contracts change.

## Ground rules

- Keep financial data private. Do not attach real backups, account exports or screenshots that expose personal information.
- Keep changes scoped to the issue or feature being worked on.
- Use the existing app patterns before adding new abstractions.
- Preserve the local-first model: no accounts, no cloud storage and no bank connections.
- Keep visible UI copy specific and plain.
- Test import/export, offline behaviour and currency handling when your change touches data.

## Development

Run the app from the repository root with a static server:

```bash
python3 -m http.server 8123
```

Then open `http://localhost:8123/`.

For a release build, install the minifier dependencies and run:

```bash
python3 Scripts/build-deploy.py
```

## Pull requests

By opening a pull request, you agree to the terms in `Rules/CLA.md`.

Good pull requests usually include:

- A short description of the problem.
- A short description of the fix.
- Notes on what you tested.
- Screenshots for visible UI changes.
