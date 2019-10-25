"use strict";
const fs = require("fs");
const chalk = require("chalk");
const { exec } = require("child_process");

/**
 * prepare the working directory
 * @param {*} taskExecutionConfig
 * @param {*} conf
 */
async function prepareWorkingDirectory(taskExecutionConfig, conf) {
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
    const mkdirResult = await mkdir(dir);
    if (!mkdirResult) {
      console.log(chalk.red("Error making the directory, unable to continue!"));
      return null;
    }
  }
  console.log("--- working directory: " + dir);

  if (
    taskExecutionConfig.gitClone === "ssh" ||
    taskExecutionConfig.gitClone === "https"
  ) {
    // Do a clone into our working directory
    console.log(chalk.green("--- performing a git clone from:"));
    if (taskExecutionConfig.gitClone === "ssh") {
      console.log(chalk.green(taskExecutionConfig.task.scm.sshURL));
      await cloneRepo(
        taskExecutionConfig.task.scm.sshURL,
        dir,
        taskExecutionConfig.gitCloneOptions
      );
    } else if (conf.gitClone === "https") {
      console.log(chalk.green(taskExecutionConfig.task.scm.cloneURL));
      await cloneRepo(
        taskExecutionConfig.task.scm.cloneURL,
        dir,
        taskExecutionConfig.gitCloneOptions
      );
    }

    // Handle pull requests differently
    if (taskExecutionConfig.task.scm.pullRequest != null) {
      // Now checkout our head sha
      console.log(chalk.green("--- head"));
      console.dir(taskExecutionConfig.task.scm.pullRequest.head);
      await gitCheckout(taskExecutionConfig.task.scm.pullRequest.head.sha, dir);
      // And then merge the base sha
      console.log(chalk.green("--- base"));
      console.dir(taskExecutionConfig.task.scm.pullRequest.base);
      await gitMerge(taskExecutionConfig.task.scm.pullRequest.base.sha, dir);
      // Fail if we have merge conflicts
    } else if (taskExecutionConfig.task.scm.branch != null) {
      console.log(chalk.green("--- sha"));
      console.dir(taskExecutionConfig.task.scm.branch.sha);
      await gitCheckout(taskExecutionConfig.task.scm.branch.sha, dir);
    } else if (taskExecutionConfig.task.scm.release != null) {
      console.log(chalk.green("--- sha"));
      console.dir(taskExecutionConfig.task.scm.release.sha);
      await gitCheckout(taskExecutionConfig.task.scm.release.sha, dir);
    }
  } else {
    console.log(
      chalk.green(
        "--- skipping git clone as gitClone config was not ssh or https"
      )
    );
  }
  return dir;
}

/**
 * Clone the repository to our working directory
 * @param {*} cloneUrl
 * @param {*} workingDirectory
 */
async function cloneRepo(cloneUrl, workingDirectory, cloneOptions) {
  return new Promise(resolve => {
    exec(
      "git clone " + cloneOptions + " " + cloneUrl + " " + workingDirectory,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`cloneRepo error: ${error}`);
          // TODO: figure out the error reason
          resolve(false);
          return;
        }
        console.log(`stdout: ${stdout}`);
        console.log(`stderr: ${stderr}`);
        resolve(false);
      }
    );
  });
}

/**
 * Perform a git checkout of our branch
 * @param {*} sha
 * @param {*} workingDirectory
 */
async function gitCheckout(sha, workingDirectory) {
  return new Promise(resolve => {
    exec(
      "git checkout -f " + sha,
      { cwd: workingDirectory },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`gitCheckout error: ${error}`);
          // TODO: figure out the error reason
          resolve(false);
          return;
        }
        console.log(`stdout: ${stdout}`);
        console.log(`stderr: ${stderr}`);
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
async function gitMerge(sha, workingDirectory) {
  return new Promise(resolve => {
    exec(
      "git merge " + sha,
      { cwd: workingDirectory },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`gitMerge error: ${error}`);
          // TODO: figure out the error reason
          resolve(false);
          return;
        }
        console.log(`stdout: ${stdout}`);
        console.log(`stderr: ${stderr}`);
        resolve(false);
      }
    );
  });
}

async function mkdir(dir) {
  return new Promise(resolve => {
    exec("mkdir -p " + dir, (error, stdout, stderr) => {
      if (error) {
        console.error(`mkdir error: ${error}`);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

module.exports.prepareWorkingDirectory = prepareWorkingDirectory;
