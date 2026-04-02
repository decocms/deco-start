---
name: run-migration
description: Run the deco-start migration script against a target site workspace. Resets the target to its Fresh/Deno state (origin/main), then runs the local migration script. Use for testing migration on real sites.
---

# Run Deco Migration

Runs the migration script from the local `@decocms/start` repo against a target site.

## How to use

1. **Identify the target site workspace.** The user will specify which site to migrate. Common targets:
   - miess-01-tanstack: `/Users/jonasjesus/conductor/workspaces/miess-01-tanstack/istanbul`

2. **Reset the target to Fresh/Deno state:**
   ```bash
   cd <target-dir>
   git checkout origin/main -- .
   git checkout -- .
   git clean -fd
   ```
   This restores the original Fresh/Deno source code.

3. **Remove old node_modules** (migration generates a new package.json):
   ```bash
   rm -rf node_modules package-lock.json
   ```

4. **Run the migration script from local deco-start:**
   ```bash
   cd <target-dir>
   npx tsx /Users/jonasjesus/conductor/workspaces/deco-start/london/scripts/migrate.ts --verbose
   ```
   The script uses `--source .` by default (current directory).

5. **Check the output** for errors and review `MIGRATION_REPORT.md`.

6. **If the user wants to test locally** after migration:
   ```bash
   cd <target-dir>
   # Ensure @decocms/start points to local repo (not npm)
   npm link /Users/jonasjesus/conductor/workspaces/deco-start/london 2>/dev/null || true
   npm install
   npm run dev  # or bun run dev
   ```

## Important notes

- The migration script is at the repo root: `scripts/migrate.ts`
- Changes to the script are immediately reflected when running (no build needed, tsx runs TS directly)
- The target site's `origin/main` branch has the original Fresh/Deno code
- NEVER push migration results to the target site's remote without explicit user confirmation
- After running, check for runtime errors and update the migration script if needed
