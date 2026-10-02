/**
 * Starts the production server in a cross-platform way.
 *
 * The original "npm run build && NODE_ENV=production tsx server/index.ts" uses
 * POSIX syntax (NODE_ENV=value command) which cmd.exe on Windows does not
 * understand. This script sets the environment variable and spawns the server,
 * passing through stdio and exit codes.
 */
import { spawn } from 'node:child_process';

process.env.NODE_ENV = 'production';

const server = spawn('npx', ['tsx', 'server/index.ts'], {
  stdio: 'inherit',
  shell: true,
});

server.on('exit', (code) => {
  process.exit(code ?? 1);
});
