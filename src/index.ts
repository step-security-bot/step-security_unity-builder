// Thin wrapper: this action installs and shells out to the game-ci CLI
// (game-ci/cli's `build` command) as a subprocess, so the exact same code
// path this runs in CI also runs when a developer invokes the CLI directly
// on their own machine. See game-ci/roadmap#11 (workstream 2), and the
// matching rewrite already shipped for game-ci/unity-activate.
//
// Unity credentials (UNITY_EMAIL, UNITY_PASSWORD, UNITY_SERIAL,
// UNITY_LICENSE, UNITY_LICENSING_SERVER) are read by the CLI itself from
// its own process environment - never passed as CLI arguments, since argv
// can leak through process listings and command-logging.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import axios, { isAxiosError } from 'axios';
import * as exec from '@actions/exec';
import { buildCliArgs } from './build-args';
import { downloadCli } from './download-cli';
import { resolveProjectPath } from './resolve-project-path';

async function validateSubscription() {
  const repoPrivate = github.context?.payload?.repository?.private;
  const upstream = 'game-ci/unity-builder';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  core.info('');
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      { timeout: 3000 },
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(`\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`);
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}
export async function run() {
  try {
    await validateSubscription();
    const cliVersion = core.getInput('cliVersion') || 'latest';
    const cliPath = await downloadCli(cliVersion);

    const projectPath = resolveProjectPath({
      input: core.getInput('projectPath'),
      existsSync: fs.existsSync,
      joinPath: path.join,
    });

    const args = buildCliArgs({
      getInput: (name) => (name === 'projectPath' ? projectPath : core.getInput(name)),
    });

    // CodeQL flags this line (js/command-line-injection) since args
    // ultimately derives from Action inputs. Verified false positive: args
    // is an array of discrete argv entries, not a concatenated shell
    // string, and @actions/exec's toolrunner.js passes it straight to
    // child_process.spawn(fileName, args, options) - verified by reading
    // node_modules/@actions/exec/lib/toolrunner.js - never a shell string,
    // never shell-parsed. CodeQL's static analysis can't see through
    // @actions/exec's internals to confirm that. This comment does not
    // suppress the alert (GitHub Code Scanning's default setup has no
    // inline-suppression-comment mechanism - that was legacy LGTM.com
    // behavior); the alert needs dismissing via the Security tab/API.
    const exitCode = await exec.exec(cliPath, args, { ignoreReturnCode: true });

    // Matches the original action's engineExitCode output: 0 on success,
    // otherwise the exit code of whichever step (activation or build) - or,
    // for providerStrategy=local-system, whichever stage of the
    // orchestrator's setup/build/cleanup workflow - failed. Either way it's
    // exactly what the CLI subprocess itself exits with, so no special
    // handling is needed here for the orchestrate path.
    core.setOutput('engineExitCode', exitCode);

    if (exitCode !== 0) {
      core.setFailed(`Build failed with exit code ${exitCode}`);
    }

    // buildVersion/androidVersionCode are set by the CLI subprocess itself
    // via @actions/core, which writes directly to the file at
    // $GITHUB_OUTPUT - inherited by the child process, so no extra
    // plumbing is needed here to forward them.
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

if (process.env.NODE_ENV !== 'test') {
  run();
}
