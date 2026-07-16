# Production build

The editable source stays in `index.html`, `js/`, and `css/`. Production files are generated in `dist/` and are not committed.

## Local verification

```powershell
npm ci
npm run build
npm run preview
```

Open `http://127.0.0.1:4173/`. The build performs these production-only steps:

- bundles and minifies JavaScript modules;
- minifies CSS;
- disables source maps;
- hashes JavaScript and CSS filenames;
- generates a Service Worker that only references generated files;
- copies the PWA manifest, icons, and small-world offline fallback data.

## Deployment

`.github/workflows/deploy-pages.yml` builds the project on every push to `main` and uploads only `dist/` as the GitHub Pages artifact.

GitHub Pages must use **GitHub Actions** as its build and deployment source. Repository visibility is separate from deployment: use a private source repository if the editable source must not be browsable.

## Recovery

Before this build pipeline was introduced, the static app was archived under `backups/box-app-pre-dist-build-2026-07-14-162335.zip`. Restore by extracting that archive over the static app files, then remove `package.json`, `package-lock.json`, `scripts/build-app.mjs`, and `.github/workflows/deploy-pages.yml` if the build layer is no longer wanted.

For normal application rollback, prefer reverting to a verified Git tag and letting GitHub Actions rebuild `dist/`. The 2026-07-15 pre-mainline recovery tag is `stable-pre-mainlines-2026-07-15`; current operational steps are maintained in `docs/runbook.md`.
