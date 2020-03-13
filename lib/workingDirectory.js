"use strict";
const fs = require("fs");
const { exec } = require("child_process");

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
      return null;
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
        return null;
      }
    } else if (conf.gitClone === "https") {
      logger.verbose(taskExecutionConfig.task.scm.cloneURL);
      const cloneResult = await cloneRepo(
        taskExecutionConfig.task.scm.cloneURL.replace(
          "https://",
          "https://" + taskExecutionConfig.task.scm.accessToken + "@"
        ),
        dir,
        taskExecutionConfig.gitCloneOptions,
        logger
      );
      if (cloneResult === false) {
        return null;
      }
    }

    // Handle pull requests differently
    if (taskExecutionConfig.task.scm.pullRequest != null) {
      // Now checkout our head sha
      logger.verbose("head");
      logger.verbose(
        JSON.stringify(taskExecutionConfig.task.scm.pullRequest.head, null, 2)
      );
      await gitCheckout(
        taskExecutionConfig.task.scm.pullRequest.head.sha,
        null,
        dir,
        logger
      );
      // And then merge the base sha
      logger.verbose("base");
      logger.verbose(
        JSON.stringify(taskExecutionConfig.task.scm.pullRequest.base)
      );
      await gitMerge(
        taskExecutionConfig.task.scm.pullRequest.base.sha,
        null,
        dir,
        logger
      );
      // Fail if we have merge conflicts
    } else if (taskExecutionConfig.task.scm.branch != null) {
      logger.verbose("sha");
      logger.verbose(JSON.stringify(taskExecutionConfig.task.scm.branch.sha));
      await gitCheckout(
        taskExecutionConfig.task.scm.branch.sha,
        taskExecutionConfig.task.scm.branch.name,
        dir,
        logger
      );
    } else if (taskExecutionConfig.task.scm.release != null) {
      logger.verbose("sha");
      logger.verbose(
        JSON.stringify(taskExecutionConfig.task.scm.release.sha, null, 2)
      );
      await gitCheckout(
        taskExecutionConfig.task.scm.release.sha,
        null,
        dir,
        logger
      );
    }
  } else {
    logger.verbose(
      "skipping git clone as gitClone config was not ssh or https"
    );
  }
  return dir;
}

/**
 * Clone the repository to our working directory
 * @param {*} cloneUrl
 * @param {*} workingDirectory
 */
async function cloneRepo(cloneUrl, workingDirectory, cloneOptions, logger) {
  return new Promise(resolve => {
    exec(
      "git clone " + cloneOptions + " " + cloneUrl + " " + workingDirectory,
      (error, stdout, stderr) => {
        if (error) {
          logger.error(`cloneRepo error: ${error}`);
          // TODO: figure out the error reason
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

  return new Promise(resolve => {
    exec(
      checkoutCommand,
      { cwd: workingDirectory },
      (error, stdout, stderr) => {
        if (error) {
          logger.error(`gitCheckout error: ${error}`);
          // TODO: figure out the error reason
          resolve(false);
          return;
        }
        logger.verbose(`stdout: ${stdout}`);
        logger.verbose(`stderr: ${stderr}`);
        resolve(false);
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
  return new Promise(resolve => {
    exec(
      "git merge " + sha,
      { cwd: workingDirectory },
      (error, stdout, stderr) => {
        if (error) {
          logger.error(`gitMerge error: ${error}`);
          // TODO: figure out the error reason
          resolve(false);
          return;
        }
        logger.verbose(`stdout: ${stdout}`);
        logger.verbose(`stderr: ${stderr}`);
        resolve(false);
      }
    );
  });
}

async function mkdir(dir, logger) {
  return new Promise(resolve => {
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

module.exports.prepareWorkingDirectory = prepareWorkingDirectory;
