# Continuous integration

The `CI` GitHub Actions workflow is a deployment-free quality gate. It runs for
pull requests targeting `master`, pushes to `master`, and manual dispatches.

The workflow uses Node.js 20 and reproducible `npm ci` installs from each
project's committed lockfile. Its required checks are:

- **Frontend tests and build**: runs the Vitest suite, enforces the configured
  coverage thresholds, type-checks the frontend, and creates the production
  Vite bundle.
- **Backend build**: compiles the backend TypeScript project.
- **Infrastructure build**: compiles the AWS CDK TypeScript project without
  synthesizing or deploying a stack.

The workflow has read-only repository permissions and does not load AWS
credentials. Deployment remains a separate, explicitly initiated operation.

The frontend type-check uses its strict TypeScript configuration across the
complete `frontend/src` and `frontend/tests` trees. It is separate from the
narrower runtime coverage scope described below.

## Frontend coverage scope

The frontend's `npm run test:coverage` command enforces **100% lines, branches,
functions, and statements** for the files currently listed in
`frontend/vitest.config.ts`:

- `src/AccessibleDialog.tsx`
- `src/InstanceDetailTabs.tsx`
- `src/LaunchControls.tsx`
- `src/uiSemantics.ts`

Test files are not included in the coverage calculation. This is a strict gate
for the four production units above; it does not claim 100% coverage of the
entire frontend. `App.tsx`, `ServerConfigEditor.tsx`, `api.ts`, `auth.ts`,
`main.tsx`, `types.ts`, styles, browser-level flows, and live AWS/API operations
are outside the current coverage scope. Expand the configured file list as
those areas gain an appropriate integration harness; files added to the list
must meet all four 100% thresholds for CI to pass.

## Local equivalent

Run the same commands before opening a pull request:

```bash
cd frontend
npm ci
npm run typecheck
npm run test:coverage
npm run build

cd ../backend
npm ci
npm run build

cd ../infra
npm ci
npm run build
```

To enforce the gate, configure branch protection for `master` after the
workflow has run once, and require these status checks:

- `Frontend tests and build`
- `Backend build`
- `Infrastructure build`
