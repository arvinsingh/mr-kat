// Compatibility entry point for hosts that require a JavaScript filename.
import('./start.mjs').catch((error) => {
  console.error(error instanceof Error ? error.message : 'Bot startup failed.');
  process.exitCode = 1;
});
