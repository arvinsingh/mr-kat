import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { databaseMetadata } from './database-schema.js';
import type { InspectionResult } from './backup-inspector.js';
import { serial } from './concurrency.js';
import { UserError } from './errors.js';

const inspections = {};

export function inspectDatabase(path: string, guildId?: string) {
  // One inspection at a time bounds worker memory/CPU even when owners click Verify repeatedly.
  return serial(
    inspections,
    'backup',
    () =>
      new Promise<ReturnType<typeof databaseMetadata>>((resolve, reject) => {
        const source = import.meta.url.endsWith('.ts');
        const module = new URL(
          source ? './backup-inspector.ts' : './backup-inspector.js',
          import.meta.url,
        );
        const worker = source
          ? new Worker(
              `const { workerData } = require('node:worker_threads');
          import(workerData.loader).then(({ tsImport }) => tsImport(workerData.module, workerData.module));`,
              {
                eval: true,
                execArgv: [],
                workerData: {
                  path,
                  guildId,
                  module: module.href,
                  loader: pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href,
                },
              },
            )
          : new Worker(module, { execArgv: [], workerData: { path, guildId } });
        let result: InspectionResult | undefined;
        let failure: Error | undefined;
        worker.once('message', (value: InspectionResult) => {
          result = value;
        });
        worker.once('error', (error) => {
          failure = error;
        });
        worker.once('exit', (code) => {
          // Wait for exit before renaming files; the worker must release its SQLite handle first.
          if (failure) reject(failure);
          else if (code !== 0 || !result)
            reject(new Error(`Backup inspection stopped without a result (exit ${code}).`));
          else if (result.ok) resolve(result.metadata);
          else reject(result.userError ? new UserError(result.error) : new Error(result.error));
        });
      }),
  );
}
