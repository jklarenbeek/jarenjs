# Optional Windows qualification

Hosted CI runs on Linux to bound runner costs. The complete Windows packaging
and source-consumer jobs are preserved in
[windows.yml](../../.github/optional-workflows/windows.yml), outside GitHub's
active `.github/workflows` directory. Neither pushes nor pull requests schedule
them. Hosted green therefore does not claim Windows qualification.

The backup retains the Node version from `.nvmrc`, pinned npm/Bun and actions,
portable lock and native toolchain checks, lint, tests, builds, declarations,
tree shaking, packed consumers and source consumption. Failures still fail the
job, independent checks still run, and the original deadlines remain in place.
Keep its toolchain and action pins aligned with the active CI workflow.

## Run locally on Windows with act

Use a disposable clean checkout on a native Windows machine with Git, Node
from `.nvmrc`, PowerShell 7 (`pwsh`) and [act](https://github.com/nektos/act)
installed. Run from the repository root in PowerShell:

```powershell
act workflow_dispatch -W .github/optional-workflows/windows.yml -l
act workflow_dispatch -W .github/optional-workflows/windows.yml -j gate -P windows-latest=-self-hosted
act workflow_dispatch -W .github/optional-workflows/windows.yml -j source-consumption -P windows-latest=-self-hosted
```

Run the two jobs sequentially. The `-self-hosted` mapping tells act to execute
directly on that Windows host; it does not register a GitHub self-hosted runner
or use paid hosted runner time. These jobs install the pinned toolchain and
dependencies and clean generated output, so use a checkout and tool environment
where those writes are intended. Internet access is needed for actions and
package downloads.

[act's runner documentation](https://nektosact.com/usage/runners.html) describes
this native-host mode. Running the command inside WSL, or mapping Windows to a
Linux Docker image, exercises Linux rather than Windows. These instructions
preserve the native qualification path; they are not evidence of a successful
Windows run. Record the commit, tool versions, exit codes and logs when running
it. A local failure remains a failure even when hosted Linux checks pass.

## Restore hosted Windows checks later

Copy the backup into the active directory and commit that explicit opt-in:

```powershell
Copy-Item .github/optional-workflows/windows.yml .github/workflows/windows.yml
```

The copied workflow has only `workflow_dispatch`, so even then it runs only
when explicitly dispatched in GitHub Actions and incurs hosted Windows costs
only for that run. To restore automatic coverage, deliberately add push and
pull-request triggers or restore the Windows entries in the main matrices;
avoid enabling both mechanisms for the same event. Keep one active Windows
qualification owner.
