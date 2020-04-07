"use strict";
const fs = require("fs");
const yaml = require("js-yaml");

/**
 * prepareExecutionConfig
 * @param {*} task
 * @return {*} config
 */
async function prepareExecutionConfig(task, conf, logger) {
  // Find the task config from our config path. If this doesn't exist, we can't continue
  logger.verbose("preparing execution config:");
  const workerConfig = task.workerConfig;
  logger.verbose(JSON.stringify(workerConfig, null, 2));

  // Check for required fields
  if (workerConfig.taskCommand == null) {
    return { error: "task-config-missing-task-command" };
  }

  return {
    task: task,
    taskCommand: workerConfig.taskCommand,
    taskArguments:
      workerConfig.taskArguments != null
        ? workerConfig.taskArguments.split(" ")
        : [],
    gitClone:
      workerConfig.gitClone != null ? workerConfig.gitClone : conf.gitClone,
    gitCloneOptions:
      workerConfig.gitCloneOptions != null
        ? workerConfig.gitCloneOptions
        : conf.gitCloneOptions,
    environmentVariablePrefix:
      workerConfig.environmentVariablePrefix != null
        ? workerConfig.environmentVariablePrefix
        : conf.environmentVariablePrefix,
    shell: workerConfig.shell != null ? workerConfig.shell : conf.shell,
    stdoutLogFile:
      workerConfig.stdoutLogFile != null
        ? workerConfig.stdoutLogFile
        : conf.stdoutLogFile,
    stderrLogFile:
      workerConfig.stderrLogFile != null
        ? workerConfig.stderrLogFile
        : conf.stderrLogFile,
    successSummaryFile: workerConfig.successSummaryFile,
    successTextFile: workerConfig.successTextFile,
    errorSummaryFile: workerConfig.errorSummaryFile,
    errorTextFile: workerConfig.errorTextFile,
    taskTimeout:
      workerConfig.taskTimeout != null
        ? workerConfig.taskTimeout
        : conf.taskTimeout,
    artifactListFile:
      workerConfig.artifactListFile != null
        ? workerConfig.artifactListFile
        : conf.artifactListFile,
  };
}

module.exports.prepareExecutionConfig = prepareExecutionConfig;
