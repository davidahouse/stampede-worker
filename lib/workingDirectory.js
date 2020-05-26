"use strict";
const fs = require("fs");
const { exec } = require("child_process");
const git = require("git-last-commit");

/**
 * prepare the working directory
 * @param {*} taskExecutionConfig
 * @param {*} conf
 */
async function prepareWorkingDirectory(taskExecutionConfig, conf, logger) {
  const today = new Date();
  const todayFolder =
    (today.getMonth() + 1).toString() +
    "-" +
    today.getDate().toString() +
    "-" +
    today.getFullYear().toString();
  const dir =
    conf.workspaceRoot +
    "/" +
    todayFolder +
    "/" +
    taskExecutionConfig.task.owner +
    "-" +
    taskExecutionConfig.task.repository +
    "/" +
    taskExecutionConfig.task.buildKey +
    "/" +
    taskExecutionConfig.task.buildNumber.toString() +
    "/" +
    taskExecutionConfig.task.task.id +
    "-" +
    taskExecutionConfig.task.task.number;

  if (!fs.existsSync(dir)) {
    const mkdirResult = await mkdir(dir, logger);
    if (!mkdirResult) {
      logger.error("Error making the directory, unable to continue!");
      return {
        error: "mkdir-error",
        message:
          "Unable to create working directory, please contact the service desk and report the issue.",
      };
    }
  }
  logger.verbose("working directory: " + dir);

  if (
    taskExecutionConfig.gitClone === "ssh" ||
    taskExecutionConfig.gitClone === "https"
  ) {
    // Do a clone into our working directory
    logger.verbose("performing a git clone from:");
    if (taskExecutionConfig.gitClone === "ssh") {
      logger.verbose(taskExecutionConfig.task.scm.sshURL);
      const cloneResult = await cloneRepo(
        taskExecutionConfig.task.scm.sshURL,
        dir,
        taskExecutionConfig.gitCloneOptions,
        logger
      );
      if (cloneResult === false) {
        return {
          error: "clone-error",
          message:
            "Unable to clone the repository, please contact the service desk and report the issue.",
        };
      }
    } else if (taskExecutionConfig.gitClone === "https") {
      logger.verbose(taskExecutionConfig.task.scm.cloneURL);
      const cloneResult = await cloneRepo(
        taskExecutionConfig.task.scm.cloneURL.replace(
          "https://",
          "https://x-access-token:" +
            taskExecutionConfig.task.scm.accessToken +
            "@"
        ),
        dir,
        taskExecutionConfig.gitCloneOptions,
        logger
      );
      if (cloneResult === false) {
        return {
          error: "clone-error",
          message:
            "Unable to clone the repository, please contact the service desk and report the issue.",
        };
      }
    }

    // For PRs we need to do a checkout & merge
    if (taskExecutionConfig.task.scm.pullRequest != null) {
      // Now checkout our head sha
      logger.verbose("head");
      logger.verbose(
        JSON.stringify(taskExecutionConfig.task.scm.pullRequest.head, null, 2)
      );
      const checkoutResult = await gitCheckout(
        taskExecutionConfig.task.scm.pullRequest.head.sha,
        null,
        dir,
        logger
      );
      if (checkoutResult === false) {
        return {
          error: "checkout-error",
          message: "Unable to perform a git checkout to this git commit",
        };
      }
      // And then merge the base sha
      logger.verbose("base");
      logger.verbose(
        JSON.stringify(taskExecutionConfig.task.scm.pullRequest.base)
      );
      const mergeResult = await gitMerge(
        taskExecutionConfig.task.scm.pullRequest.base.ref,
        dir,
        logger
      );
      if (mergeResult === false) {
        return {
          error: "merge-error",
          message:
            "Unable to merge from the base branch, solve the merge conflict so the task can run.",
        };
      }
    } else if (taskExecutionConfig.task.scm.branch != null) {
      logger.verbose("sha");
      logger.verbose(JSON.stringify(taskExecutionConfig.task.scm.branch.sha));
      const checkoutResult = await gitCheckout(
        taskExecutionConfig.task.scm.branch.sha,
        taskExecutionConfig.task.scm.branch.name,
        dir,
        logger
      );
      if (checkoutResult === false) {
        return {
          error: "checkout-error",
          message: "Unable to perform a git checkout to this git commit",
        };
      }
      if (taskExecutionConfig.task.scm.branch.sha === "latest") {
        const details = await commitDetails(dir, logger);
        return {
          directory: dir,
          error: null,
          sha: details != null ? details.hash : null,
          commit: details != null ? details.body : null,
        };
      }
    } else if (taskExecutionConfig.task.scm.release != null) {
      logger.verbose("sha");
      logger.verbose(
        JSON.stringify(taskExecutionConfig.task.scm.release.sha, null, 2)
      );
      const checkoutResult = await gitCheckout(
        taskExecutionConfig.task.scm.release.sha,
        null,
        dir,
        logger
      );
      if (checkoutResult === false) {
        return {
          error: "checkout-error",
          message: "Unable to perform a git checkout to this git commit",
        };
      }
    }
  } else {
    logger.verbose(
      "skipping git clone as gitClone config was not ssh or https"
    );
  }
  return {
    directory: dir,
    error: null,
  };
}

/**
 * Clone the repository to our working directory
 * @param {*} cloneUrl
 * @param {*} workingDirectory
 */
async function cloneRepo(cloneUrl, workingDirectory, cloneOptions, logger) {
  return new Promise((resolve) => {
    exec(
      "git clone " + cloneOptions + " " + cloneUrl + " " + workingDirectory,
      (error, stdout, stderr) => {
        if (error) {
          logger.error(`cloneRepo error: ${error}`);
          try {
            const cloneErrorLog =
              "cloneRepo error: " +
              error +
              "\n" +
              "stdout: " +
              stdout +
              "\n" +
              "stderr: " +
              stderr +
              "\n";
            fs.writeFileSync(
              workingDirectory + "/cloneerror.log",
              cloneErrorLog
            );
          } catch (e) {
            logger.error(`error writing out clone log: ` + e);
          }
          resolve(false);
          return;
        }
        logger.verbose(`stdout: ${stdout}`);
        logger.verbose(`stderr: ${stderr}`);
        resolve(true);
      }
    );
  });
}

/**
 * Perform a git checkout of our branch
 * @param {*} sha
 * @param {*} branch
 * @param {*} workingDirectory
 */
async function gitCheckout(sha, branch, workingDirectory, logger) {
  let checkoutCommand = "";
  if (sha === "latest") {
    checkoutCommand = "git checkout " + branch;
  } else {
    checkoutCommand = "git checkout -f " + sha;
  }

  return new Promise((resolve) => {
    exec(
      checkoutCommand,
      { cwd: workingDirectory },
      (error, stdout, stderr) => {
        if (error) {
          logger.error(`gitCheckout error: ${error}`);
          resolve(false);
          return;
        }
        logger.verbose(`stdout: ${stdout}`);
        logger.verbose(`stderr: ${stderr}`);
        resolve(true);
      }
    );
  });
}

/**
 * Now merge in the target branch
 * @param {*} sha
 * @param {*} workingDirectory
 */
async function gitMerge(sha, workingDirectory, logger) {
  return new Promise((resolve) => {
    exec(
      "git merge " + sha,
      { cwd: workingDirectory },
      (error, stdout, stderr) => {
        if (error) {
          logger.error(`gitMerge error: ${error}`);
          resolve(false);
          return;
        }
        logger.verbose(`stdout: ${stdout}`);
        logger.verbose(`stderr: ${stderr}`);
        resolve(true);
      }
    );
  });
}

async function mkdir(dir, logger) {
  return new Promise((resolve) => {
    exec("mkdir -p " + dir, (error, stdout, stderr) => {
      if (error) {
        logger.error(`mkdir error: ${error}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

async function commitDetails(dir, logger) {
  return new Promise((resolve) => {
    git.getLastCommit(
      function (err, commit) {
        if (err != null) {
          resolve(null);
        } else {
          resolve(commit);
        }
      },
      { dst: dir }
    );
  });
}

module.exports.prepareWorkingDirectory = prepareWorkingDirectory;
