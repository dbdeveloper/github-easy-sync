// Vitest globalSetup hook. The named `teardown` export runs once
// after every test in the integration suite finishes (success,
// failure, or skip). The only thing it does is delete the ephemeral
// bootstrap repo if it still exists, so the public-repo +
// classic-PAT attack surface only lives for the duration of the test
// run itself.
//
// If the run never touched bootstrap (e.g. test:integration:nonbootstrap),
// the repo isn't there to delete and the 404 is a no-op.

import { bootstrapEnabled, deleteRepoIfExists, requireBootstrapEnv } from "./helpers";

// No-op setup; we only care about teardown.
export async function setup(): Promise<void> {
  // intentionally empty
}

export async function teardown(): Promise<void> {
  if (!bootstrapEnabled()) return;
  const env = requireBootstrapEnv();
  try {
    await deleteRepoIfExists(env);
    // eslint-disable-next-line no-console
    console.log(
      `[integration teardown] ephemeral bootstrap repo ${env.owner}/${env.repo} deleted`,
    );
  } catch (err) {
    // Don't fail the suite over cleanup — log so it's visible in CI.
    // eslint-disable-next-line no-console
    console.warn(`[integration teardown] failed to delete bootstrap repo: ${err}`);
  }
}
