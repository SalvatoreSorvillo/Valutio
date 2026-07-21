# Publishing Valutio

Use this workflow for the first public GitHub release and for every update after that.

The goal is to publish a clean repository that starts from the polished public version, without carrying over local working history.

## First public release

From `Valutio-source`, run:

```bash
bash publish-public.sh
```

This updates `../Valutio-public/github`, the clean source folder to connect to GitHub.

Then publish from the clean folder:

```bash
cd ../Valutio-public/github
git status
git add .
git commit -m "Initial public release"
git remote add origin https://github.com/SalvatoreSorvillo/Valutio.git
git push -u origin main
```


## Every app update

1. Edit the app in `Valutio-source`.
2. Bump the service-worker cache version in `sw.js`.
3. Bump the query strings in `index.html` for `app.css` and `app.js`.
4. Run the basic checks:

```bash
node --check app.js
node --check app.i18n.js
node --check statement-categorizer.js
node Scripts/test-financial-logic.mjs
node Scripts/test-statement-categorizer.mjs
node Scripts/generate-stress-wallet.mjs /tmp/valutio-stress-wallet.json
node Scripts/validate-wallet-backup.mjs /tmp/valutio-stress-wallet.json
```

5. Run:

```bash
bash publish-public.sh
```

6. Go to `../Valutio-public/github`, review the generated changes, commit and push.
7. Deploy `../valutio-deploy` to Netlify. The generated root includes the Yahoo Finance function and redirect needed by live market refreshes.

The script overwrites the generated GitHub export from `Valutio-source`, runs `Scripts/build-deploy.py` unless you pass `--skip-build`, and mirrors `../Website-source/assets/demo` into `../valutio-deploy/assets/demo`. It only replaces the generated `assets/demo` folder, leaving other deploy assets untouched. Do not edit `../Valutio-public/github` manually; source history is handled by GitHub commits and release tags.

## Useful options

Skip the deploy build if you only changed documentation:

```bash
bash publish-public.sh --skip-build
```

The Bash wrapper passes `--force` by default because `../Valutio-public/github` is generated from `Valutio-source`. Call `python3 Scripts/publish-public.py` directly only if you want the lower-level safety checks.
