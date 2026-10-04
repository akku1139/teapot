/**
 * The user's home directory, on every platform.
 *
 * #110: `process.env.HOME` is a POSIX convention and is normally UNSET on
 * Windows. Code that expanded `~` with `process.env.HOME ?? "~"` therefore got
 * the LITERAL string "~" back on Windows — and since the result was then passed
 * to `path.resolve(base, …)` and `mkdirSync`, teapot created a directory named
 * `~`. That is the reported symptom.
 *
 * `os.homedir()` is the answer: on Windows Node resolves it from `USERPROFILE`,
 * on POSIX from `HOME`, so it is never the literal `~`. The env lookups are kept
 * only so a test can drive the Windows shape deterministically — `os.homedir()`
 * on a Linux CI box would report `/root` and hide the very condition under test.
 *
 * Returns "" only when nothing at all is known, which callers treat as "leave the
 * `~` alone" rather than inventing a path.
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOME) return env.HOME;
  if (env.USERPROFILE) return env.USERPROFILE;
  // Windows also reports a home as HOMEDRIVE + HOMEPATH. Concatenate
  // defensively: `drive.replace(...) + path` yields the STRING "undefined"
  // rather than undefined when either part is missing, which is exactly the
  // class of bug this helper exists to remove.
  const drive = env.HOMEDRIVE;
  const rest = env.HOMEPATH;
  if (drive && rest) return drive.replace(/\\+$/, "") + rest;
  if (drive) return drive;
  return "";
}

/**
 * Expand a leading `~` to the home directory.
 *
 * Kept in one place so the Windows case cannot be got wrong a second time — the
 * bug existed in three separate places before this helper (#110).
 */
export function expandTilde(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // #110: on Windows a path can be `~\foo`, hence the backslash in the lookahead.
  if (!/^~(?=$|[/\\])/.test(input)) return input;
  const home = homeDir(env);
  // With no home known, returning the input untouched is more honest than
  // substituting a literal that would become a real directory.
  if (!home) return input;
  return input.replace(/^~(?=$|[/\\])/, home);
}
