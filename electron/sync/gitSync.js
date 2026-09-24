const simpleGit = require("simple-git");

const GIT_TIMEOUT_MS = 30_000;

// Environment variables that can hand control of a git invocation to another
// program: an editor, a pager, a credential helper, a proxy command. The app
// launches from the user's shell, so its environment is full of these, and
// simple-git refuses to run at all while any are present. They are dropped
// here because the poller runs unattended on a timer and must never wait on
// something interactive. The rest of the environment is kept so git still
// finds PATH, HOME, and its own config.
const UNSAFE_ENV_KEYS = new Set([
  "editor",
  "git_askpass",
  "ssh_askpass",
  "pager",
  "prefix",
  "git_editor",
  "git_pager",
  "git_sequence_editor",
  "git_config",
  "git_config_global",
  "git_config_system",
  "git_config_count",
  "git_exec_path",
  "git_ssh",
  "git_ssh_command",
  "git_proxy_command",
  "git_template_dir",
  "git_external_diff",
]);

function gitEnvironment() {
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!UNSAFE_ENV_KEYS.has(key.toLowerCase())) env[key] = value;
  }

  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

// A repository the user cannot authenticate to must fail rather than block on a
// credential prompt nobody can see: the poller runs on a timer, so a hung git
// would leave the check pending forever.
function createGit(localPath, timeoutMs = GIT_TIMEOUT_MS) {
  return simpleGit({ baseDir: localPath, timeout: { block: timeoutMs } }).env(
    gitEnvironment(),
  );
}

// The branch the clone sits on, so an update pulls the same branch rather than
// whatever the remote happens to call its default.
async function getCurrentBranch(git) {
  const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

  // A detached HEAD names no branch, so fall back to asking the remote for its
  // default.
  return !branch || branch === "HEAD" ? null : branch;
}

async function getLocalHeadSha(git) {
  return (await git.revparse(["HEAD"])).trim();
}

// Asks the remote for the branch tip without transferring any objects, which is
// what makes polling for changes cheap.
async function getRemoteHeadSha(git, remoteUrl, branch) {
  const ref = branch ? `refs/heads/${branch}` : "HEAD";
  const output = await git.listRemote([remoteUrl, ref]);
  const [sha] = output.trim().split(/\s+/);

  if (!sha) {
    throw new Error(`Remote has no ref ${ref}`);
  }

  return sha;
}

// Only changes to files git already tracks are reported. Untracked files are
// deliberately ignored: `reset --hard` does not delete them, so they are not at
// risk, and counting them would let one stray dropped file park a repository
// out of sync forever.
async function hasLocalTrackedChanges(git) {
  const output = await git.raw(["status", "--porcelain", "--untracked-files=no"]);

  return output.trim().length > 0;
}

// Fast-forwards the working tree onto the remote tip and returns the commit it
// landed on. The clone is shallow, so the fetch stays shallow too; `--hard` is
// what discards local modifications, which is why callers check
// hasLocalTrackedChanges first.
async function updateWorkingTree(git, remoteUrl, branch) {
  const ref = branch ? `refs/heads/${branch}` : "HEAD";

  await git.fetch([remoteUrl, ref, "--depth", "1"]);
  const fetched = (await git.revparse(["FETCH_HEAD"])).trim();

  await git.reset(["--hard", "FETCH_HEAD"]);

  return fetched;
}

// Answers "does this need re-indexing?" without touching the working tree:
// compares the recorded commit against the remote tip, and reports whether
// local edits stand in the way. `baselineSha` is the commit the working tree is
// actually on, which is what should be recorded when the row has none yet.
async function inspectRepositoryUpdate(
  { localPath, url, commitSha },
  { timeoutMs = GIT_TIMEOUT_MS } = {},
) {
  const git = createGit(localPath, timeoutMs);
  const branch = await getCurrentBranch(git);
  const remoteSha = await getRemoteHeadSha(git, url, branch);
  const baselineSha = commitSha ?? (await getLocalHeadSha(git));

  if (remoteSha === baselineSha) {
    return { status: "unchanged", branch, remoteSha, baselineSha };
  }

  const dirty = await hasLocalTrackedChanges(git);

  return {
    status: dirty ? "dirty" : "update-available",
    branch,
    remoteSha,
    baselineSha,
  };
}

// Moves the working tree onto the remote tip. Only safe to call once the
// working tree is known to be free of tracked changes.
async function applyRepositoryUpdate(
  { localPath, url },
  { branch, timeoutMs = GIT_TIMEOUT_MS } = {},
) {
  const git = createGit(localPath, timeoutMs);

  return updateWorkingTree(git, url, branch);
}

module.exports = {
  GIT_TIMEOUT_MS,
  createGit,
  getCurrentBranch,
  getLocalHeadSha,
  getRemoteHeadSha,
  hasLocalTrackedChanges,
  updateWorkingTree,
  inspectRepositoryUpdate,
  applyRepositoryUpdate,
};
