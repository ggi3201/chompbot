import { execFile } from "child_process";

/** A source that is not there on this machine (a tool that is not installed, a key that is not set). Not a failure. */
export class Unavailable extends Error {}

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

/** Runs a command and returns its output. A missing program is `Unavailable`; any other failure throws with the first line of what the program said. */
export function run(command: string, args: string[], timeout = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Unavailable(`${command} is not installed`));
      // Docker Desktop that is not open is normal on a Mac; on a Linux server a dead daemon stays an error.
      if (process.platform === "darwin" && command === "docker" && /Cannot connect to the Docker daemon/.test(String(stderr))) return reject(new Unavailable("Docker is not running"));
      reject(new Error(String(stderr).split("\n")[0] || err.message));
    });
  });
}
