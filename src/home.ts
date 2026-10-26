
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOME) return env.HOME;
  if (env.USERPROFILE) return env.USERPROFILE;
  const drive = env.HOMEDRIVE;
  const rest = env.HOMEPATH;
  if (drive && rest) return drive.replace(/\\+$/, "") + rest;
  if (drive) return drive;
  return "";
}

export function expandTilde(input: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^~(?=$|[/\\])/.test(input)) return input;
  const home = homeDir(env);
  if (!home) return input; 
  return input.replace(/^~(?=$|[/\\])/, home);
}
