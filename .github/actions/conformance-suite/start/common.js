import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
export const suiteDir = join(workspace, 'conformance-suite');
export const composeFile = join(suiteDir, 'docker-compose-prebuilt.yml');
export const overrideFile = join(suiteDir, 'docker-compose-prebuilt.override.yml');
export const mongoDir = join(suiteDir, 'mongo');
export const composeArgs = ['compose', '-f', composeFile, '-f', overrideFile];

export function run(command, args, options = {}) {
  const { reject = true, stdio = 'inherit' } = options;

  return new Promise((resolve, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      stdio,
    });

    child.on('error', (err) => {
      if (reject) {
        rejectPromise(err);
      } else {
        resolve(1);
      }
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(0);
        return;
      }

      if (!reject) {
        resolve(code || 1);
        return;
      }

      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectPromise(new Error(`${command} ${args.join(' ')} failed with ${status}`));
    });
  });
}
