/**
 * The user's home directory, on every platform (#110).
 *
 * `process.env.HOME` is a POSIX convention and is normally UNSET on Windows, so
 * expanding `~` with `process.env.HOME ?? "~"` produced the LITERAL "~" there —
 * and since the result reached `path.resolve` + `mkdirSync`, teapot created a
 * directory named `~`.
 *
 * The `env` parameters exist so a test can drive the Windows shape
 * deterministically; `os.homedir()` on a Linux CI box would report `/root` and
 * hide the condition under test.
 */

/** @returns "" when no home is known — callers leave `~` alone rather than invent a path */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOME) return env.HOME;
  if (env.USERPROFILE) return env.USERPROFILE;
  // Windows can report HOMEDRIVE + HOMEPATH. Both must be present:
  // `undefined + path` yields the STRING "undefined", which is exactly the class
  // of bug this helper exists to remove.
  const drive = env.HOMEDRIVE;
  const rest = env.HOMEPATH;
  if (drive && rest) return drive.replace(/\\+$/, "") + rest;
  if (drive) return drive;
  return "";
}

/** Expand a leading `~`. One place, so the Windows case cannot be got wrong twice (#110). */
export function expandTilde(input: string, env: NodeJS.ProcessEnv = process.env): string {
  // a Windows path can be `~\foo`, hence the backslash in the lookahead
  if (!/^~(?=$|[/\\])/.test(input)) return input;
  const home = homeDir(env);
  if (!home) return input; // no home known: leaving `~` is more honest than inventing one
  return input.replace(/^~(?=$|[/\\])/, home);
}
