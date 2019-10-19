'use strict';
const fs = require('fs');
const yaml = require('js-yaml');

/**
 * prepareExecutionConfig
 * @param {*} task
 * @return {*} config
 */
async function prepareExecutionConfig(task, conf) {
  // Find the task config from our config path. If this doesn't exist, we can't continue
  console.log('--- preparing execution config:');
  const taskConfig = await localTaskConfig(task, conf);
  console.dir(taskConfig);
  if (taskConfig == null) {
    return { error: 'task-config-not-found' };
  }

  if (taskConfig.worker == null) {
    return { error: 'task-worker-config-not-found' };
  }
  const workerConfig = taskConfig.worker;

  // Check for required fields
  if (workerConfig.taskCommand == null) {
    return { error: 'task-config-missing-task-command' };
  }

  return {
    task: task,
    taskCommand: workerConfig.taskCommand,
    taskArguments:
      workerConfig.taskArguments != null
        ? workerConfig.taskArguments.split(' ')
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
    errorTextFile: workerConfig.errorTextFile
  };
}

/**
 * localTaskConfig
 * @param {*} task
 * @param {*} conf
 */
async function localTaskConfig(task, conf) {
  try {
    const taskFileContents = fs.readFileSync(
      conf.stampedeConfigPath + '/tasks/' + task.task.id + '.yaml'
    );
    if (taskFileContents == null) {
      return null;
    }
    const taskFile = yaml.safeLoad(taskFileContents);
    return taskFile;
  } catch (e) {
    console.log('Error reading task config: ' + e);
    return null;
  }
}

module.exports.prepareExecutionConfig = prepareExecutionConfig;
