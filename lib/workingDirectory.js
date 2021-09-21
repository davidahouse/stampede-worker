"use strict";
const fs = require("fs");
const { exec } = require("child_process");
const git = require("git-last-commit");

let retries = 0;
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

  // If we are configured for no gitClone we can just exit
  if (taskExecutionConfig.gitClone === "none") {
    return {
      directory: dir,
      error: null,
    };
  }

  // First determine the repo we are going to clone from, taking into account ssh/https
  const gitRepoURL = generateGitRepoURL(taskExecutionConfig);
  if (gitRepoURL == null) {
    return {
      error: "clone-error",
      message:
        "Unable to perform clone, no repository url found. Please contact the service desk and report the issue.",
    };
  }
  logger.verbose("git repo url: " + gitRepoURL);

  // Based on the scm details, determine which branch/tag we are cloning and if we need
  // to checkout a sha after the clone and finally if we need to perform a git merge
  const gitOperations = generateGitOperations(taskExecutionConfig, conf);
  if (gitOperations == null) {
    return {
      error: "clone-error",
      message:
        "Unable to perform clone, no operations available. Please contact the service desk and report the issue.",
    };
  }
  logger.verbose("git operations: " + JSON.stringify(gitOperations, null, 2));

  // Perform the clone
  if (gitOperations.clone != null) {
    let cloneResult = await cloneRepo(
      gitRepoURL,
      gitOperations.clone,
      dir,
      gitOperations.depth,
      taskExecutionConfig.gitCloneOptions,
      logger,
      conf.workspaceRoot
    );
    if (conf.cloneRetryAttempts && cloneResult !== true) {
      if (retries > conf.cloneRetryAttempts) {
        while (true) {
          await delay(conf.cloneRetryInterval);
          cloneResult = await cloneRepo(
            gitRepoURL,
            gitOperations.clone,
            dir,
            gitOperations.depth,
            taskExecutionConfig.gitCloneOptions,
            logger,
            conf.workspaceRoot
          );
          retries++;
          if (retries > conf.cloneRetryAttempts || cloneResult === true) {
            break; // we run until we get a positive clone result or we've run out of retries
          }
        }
      }
    }
    retries = 0; // reset our retry attempts
    if (cloneResult !== true) {
      retries++;
      let err = "Unable to clone the repository, please contact the service desk and report the issue.\n" 
        + cloneResult + "\n"
        + "Directory: " + dir + "\n"
        + "Repo URL: " + gitRepoURL + "\n"
      return {
        error: "clone-error",
        message: err,
      };
    }
  }

  // Perform the checkout
  if (gitOperations.shouldCheckout == true && gitOperations.sha != null) {
    const checkoutResult = await gitCheckout(gitOperations.sha, dir, logger);
    if (checkoutResult === false) {
      return {
        error: "checkout-error",
        message: "Unable to perform a git checkout to this git commit",
      };
    }
  }

  // Perform the merge
  if (gitOperations.merge == true) {
    const mergeResult = await gitMerge(gitOperations.mergeBase, dir, logger);
    if (mergeResult == false) {
      return {
        error: "merge-error",
        message:
          "Unable to merge from the base branch, solve the merge conflict so the task can run.",
      };
    }
  }

  // Collect commit details if we have no sha in the gitOperations
  if (gitOperations.sha == null) {
    const details = await commitDetails(dir, logger);
    return {
      directory: dir,
      error: null,
      sha: details != null ? details.hash : null,
      commit: details != null ? details.subject : null,
    };
  }

  logger.verbose("finished preparing working directory");
  return {
    directory: dir,
    error: null,
  };
}

/**
 * Pauses execution for specified ms
 * @param {*} ms 
 * @returns 
 */
const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Clone the repository to our working directory
 * @param {*} cloneUrl
 * @param {*} branch
 * @param {*} workingDirectory
 * @param {*} depth
 * @param {*} cloneOptions
 * @param {*} logger
 * @param {*} workspaceRoot
 */
async function cloneRepo(
  cloneUrl,
  branch,
  workingDirectory,
  depth,
  cloneOptions,
  logger,
  workspaceRoot
) {
  let cloneCommand =
    "git clone -b " +
    branch +
    " --single-branch " +
    " --depth " +
    depth +
    " " +
    cloneOptions +
    " " +
    cloneUrl +
    " " +
    workingDirectory;
  logger.verbose("clone: " + cloneCommand);
  return new Promise((resolve) => {
    let success = true;
    exec(cloneCommand, { cwd: workspaceRoot }, (error, stdout, stderr) => {
      if (error) {
        success = false;
        logger.error(`cloneRepo error: ${error}`);
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
        try {
          fs.writeFileSync(workingDirectory + "/cloneerror.log", cloneErrorLog);
        } catch (e) {
          logger.error(`error writing out clone log: ` + e);
        }
        resolve(cloneErrorLog); // no retries attempted
        return;
      }
      logger.verbose(`stdout: ${stdout}`);
      logger.verbose(`stderr: ${stderr}`);
      if (success) {
        resolve(true); // original attempt or a retry succeeded
      }
    });
  });
}

/**
 * Perform a git checkout of our branch
 * @param {*} sha
 * @param {*} branch
 * @param {*} workingDirectory
 */
async function gitCheckout(sha, workingDirectory, logger) {
  let checkoutCommand = "git checkout -f " + sha;
  logger.verbose("checkout: " + checkoutCommand);
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
  logger.verbose("git merge: " + sha);
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

/**
 * Make our working directory
 * @param {*} dir
 * @param {*} logger
 */
async function mkdir(dir, logger) {
  logger.verbose("making directory: " + dir);
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

/**
 * Get the last commit details
 * @param {*} dir
 * @param {*} logger
 */
async function commitDetails(dir, logger) {
  logger.verbose("getting commit details " + dir);
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

/**
 * Generate our git repo URL that we can clone from
 * @param {*} taskExecutionConfig
 */
function generateGitRepoURL(taskExecutionConfig) {
  if (taskExecutionConfig.gitClone === "ssh") {
    return taskExecutionConfig.task.scm.sshURL;
  } else if (taskExecutionConfig.gitClone === "https") {
    return taskExecutionConfig.task.scm.cloneURL.replace(
      "https://",
      "https://x-access-token:" + taskExecutionConfig.task.scm.accessToken + "@"
    );
  } else {
    return null;
  }
}

/**
 * Generate the git operation details that we need to perform
 * @param {*} taskExecutionConfig
 */
function generateGitOperations(taskExecutionConfig, conf) {
  if (taskExecutionConfig.task.scm.pullRequest != null) {
    return {
      clone: taskExecutionConfig.task.scm.pullRequest.head.ref,
      sha: taskExecutionConfig.task.scm.pullRequest.head.sha,
      shouldCheckout: true,
      depth: parseInt(conf.defaultGitCloneDepth),
      merge: conf.gitMerge,
      mergeBase: taskExecutionConfig.task.scm.pullRequest.base.ref,
    };
  } else if (taskExecutionConfig.task.scm.branch != null) {
    if (taskExecutionConfig.task.scm.branch.sha === "latest") {
      return {
        clone: taskExecutionConfig.task.scm.branch.name,
        sha: null,
        shouldCheckout: false,
        depth: parseInt(conf.defaultGitCloneDepth),
        merge: false,
      };
    } else {
      return {
        clone: taskExecutionConfig.task.scm.branch.name,
        sha: taskExecutionConfig.task.scm.branch.sha,
        shouldCheckout: true,
        depth: parseInt(conf.defaultGitCloneDepth),
        merge: false,
      };
    }
  } else if (taskExecutionConfig.task.scm.release != null) {
    return {
      clone: taskExecutionConfig.task.scm.release.tag,
      sha: taskExecutionConfig.task.scm.release.sha,
      shouldCheckout: false,
      depth: parseInt(conf.defaultGitCloneDepth),
      merge: false,
    };
  } else {
    return null;
  }
}

module.exports.prepareWorkingDirectory = prepareWorkingDirectory;
