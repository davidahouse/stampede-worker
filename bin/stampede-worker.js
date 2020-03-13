#!/usr/bin/env node
"use strict";

const chalk = require("chalk");
const figlet = require("figlet");
const fs = require("fs");
const { spawn } = require("child_process");
const Queue = require("bull");
const uuidv4 = require("uuid/v4");
const logFileReader = require("log-file-reader");
const winston = require("winston");

const queueLog = require("../lib/queueLog");
const responseTestFile = require("../lib/responseTestFile");
const executionConfig = require("../lib/executionConfig");
const workingDirectory = require("../lib/workingDirectory");

require("pkginfo")(module);

const conf = require("rc")("stampede", {
  // Required configuration
  redisHost: "localhost",
  redisPort: 6379,
  redisPassword: null,
  nodeName: null,
  workerName: null,
  stampedeScriptPath: null,
  taskQueue: "tasks",
  responseQueue: "response",
  workspaceRoot: null,
  // Test mode. Set both of these to enable test mode
  // where the worker will execute the task that is in the
  // taskTestFile, and the results will go into the
  // response file.
  taskTestFile: null,
  responseTestFile: null,
  // Task defaults
  environmentVariablePrefix: "STAMP_",
  shell: "/bin/bash",
  gitClone: "ssh",
  gitCloneOptions: "",
  stdoutLogFile: "stdout.log",
  stderrLogFile: null,
  taskTimeout: 1800000, // Default timeout: 30 minutes
  // Log file configuration
  environmentLogFile: "environment.log",
  taskDetailsLogFile: "worker.log",
  logQueuePath: null,
  // Heartbeat
  heartbeatInterval: 15000
});

const redisConfig = {
  redis: {
    port: conf.redisPort,
    host: conf.redisHost,
    password: conf.redisPassword
  }
};
const workerID = uuidv4();
let workerStatus = "idle";
let lastTask = {};
let currentSpawnedTask = null;
let currentTaskStartTime = null;
let currentTaskTimeout = conf.taskTimeout;

console.log(
  chalk.red(figlet.textSync("stampede", { horizontalLayout: "full" }))
);
console.log(chalk.yellow(module.exports.version));
console.log(chalk.red("Redis Host: " + conf.redisHost));
console.log(chalk.red("Redis Port: " + conf.redisPort));
console.log(chalk.red("Node Name: " + conf.nodeName));
console.log(chalk.red("Task Queue: " + conf.taskQueue));
console.log(chalk.red("Workspace Root: " + conf.workspaceRoot));
console.log(chalk.red("Worker Name: " + conf.workerName));
console.log(chalk.red("Worker ID: " + workerID));

// Check for all our required parameters
if (
  conf.redisHost == null ||
  conf.redisPort == null ||
  conf.nodeName == null ||
  conf.stampedeScriptPath == null ||
  conf.workspaceRoot == null
) {
  console.log(
    chalk.red("Missing required config parameters. Unable to start worker.")
  );
  process.exit(1);
}

let workerQueue = null;
let responseQueue = null;

if (conf.taskTestFile == null) {
  workerQueue = new Queue("stampede-" + conf.taskQueue, redisConfig);
  responseQueue = new Queue("stampede-" + conf.responseQueue, redisConfig);

  workerQueue.process(function(task) {
    // Save the message if our logQueuePath is set
    if (conf.logQueuePath != null) {
      queueLog.save(conf.taskQueue, task.data, conf.logQueuePath);
    }
    return handleTask(task.data, responseQueue);
  });

  if (responseQueue != null) {
    handleHeartbeat(responseQueue);
  }
} else {
  const task = JSON.parse(fs.readFileSync(conf.taskTestFile));
  responseTestFile.init(conf.responseTestFile);
  handleTask(task, responseTestFile);
}

/**
 * Handle shutdown gracefully
 */
process.on("SIGINT", function() {
  gracefulShutdown();
});

/**
 * gracefulShutdown
 */
async function gracefulShutdown() {
  console.log("Closing queues");
  await workerQueue.close();
  await responseQueue.close();
  process.exit(0);
}

/**
 * Handle an incoming task
 * @param {*} task
 */
async function handleTask(task, responseQueue) {
  try {
    workerStatus = "busy";
    lastTask = task;
    const startedAt = new Date();
    task.status = "in_progress";
    task.stats.startedAt = startedAt;
    task.worker = {
      node: conf.nodeName,
      version: module.exports.version,
      workerID: workerID
    };
    console.log("--- Updating task to in progress");
    await updateTask(task, responseQueue);

    // Gather up the execution config options we will need for this task
    const taskExecutionConfig = await executionConfig.prepareExecutionConfig(
      task,
      conf
    );
    console.dir(taskExecutionConfig);
    if (taskExecutionConfig.error != null) {
      console.log("--- Error getting execution config");
      task.status = "completed";
      task.result = {
        conclusion: "failure",
        summary: taskExecutionConfig.error
      };
      await updateTask(task, responseQueue);
      workerStatus = "idle";
      return;
    }

    // Create the working directory and prepare it
    const directory = await workingDirectory.prepareWorkingDirectory(
      taskExecutionConfig,
      conf
    );
    if (directory == null) {
      console.log(
        chalk.red("Error getting working directory, unable to continue")
      );
      task.status = "completed";
      task.result = {
        conclusion: "failure",
        summary: "Working directory error"
      };
      await updateTask(task, responseQueue);
      workerStatus = "idle";
      return;
    }

    // Setup our environment variables
    const environment = collectEnvironment(taskExecutionConfig, directory);
    if (conf.environmentLogFile != null && conf.environmentLogFile.length > 0) {
      console.log("--- Writing out environment.log");
      try {
        let exportValues = "";
        Object.keys(environment).forEach(function(key) {
          exportValues += "export " + key + '="' + environment[key] + '"\n';
        });
        fs.writeFileSync(
          directory + "/" + conf.environmentLogFile,
          exportValues
        );
      } catch (e) {
        console.log("Error writing environment log: " + e);
      }
    }

    // Execute our task
    const result = await executeTask(
      taskExecutionConfig,
      directory,
      environment
    );
    currentSpawnedTask = null;
    currentTaskStartTime = null;
    console.log("--- Updating task record to capture completed state");
    const finishedAt = new Date();
    task.stats.finishedAt = finishedAt;

    // Now finalize our task status
    task.status = "completed";
    task.result = result;
    if (conf.taskDetailsLogFile != null && conf.taskDetailsLogFile.length > 0) {
      console.log("--- Writing out worker.log file");
      fs.writeFileSync(
        directory + "/" + conf.taskDetailsLogFile,
        JSON.stringify(task, null, 2)
      );
    }
    console.log("--- Updating task");
    await updateTask(task, responseQueue);
    workerStatus = "idle";
    console.log("--- handle task completed");
  } catch (e) {
    console.log(chalk.red("--- Error in handle task " + e));
  }
}

/**
 * send out a heartbeat notification
 */
async function handleHeartbeat(queue) {
  const heartbeat = {
    timestamp: new Date(),
    node: conf.nodeName,
    version: module.exports.version,
    workerName: conf.workerName,
    workerID: workerID,
    status: workerStatus,
    lastTask: lastTask,
    taskQueue: conf.taskQueue
  };
  queue.add(
    {
      response: "heartbeat",
      payload: heartbeat
    },
    { removeOnComplete: true, removeOnFail: true }
  );

  // Check for stalled task execution and kill it if necessary
  if (currentTaskStartTime != null) {
    let duration = new Date() - currentTaskStartTime;
    if (duration > currentTaskTimeout) {
      console.log(
        chalk.red("--- Task timeout reached! Killing spawned process")
      );
      currentSpawnedTask.kill();
      currentTaskStartTime = null;
      currentTaskTimeout = conf.taskTimeout;
    }
  }

  setTimeout(handleHeartbeat, conf.heartbeatInterval, queue);
}

/**
 * execute the task and capture any results
 * @param {*} taskExecutionConfig
 * @param {*} workingDirectory
 * @param {*} environment
 */
async function executeTask(taskExecutionConfig, workingDirectory, environment) {
  if (taskExecutionConfig.taskCommand.endsWith(".js")) {
    return executeJavaScriptTask(taskExecutionConfig, workingDirectory);
  } else {
    return new Promise(resolve => {
      try {
        const taskCommand =
          conf.stampedeScriptPath + "/" + taskExecutionConfig.taskCommand;
        if (!fs.existsSync(taskCommand)) {
          const conclusion = {
            conclusion: "failure",
            title: "Task results",
            summary:
              "Task configured incorrectly, contact your stampede admin.",
            text: ""
          };
          resolve(conclusion);
          return;
        }
        console.log(chalk.green("--- Executing: " + taskCommand));

        const stdoutlog =
          taskExecutionConfig.stdoutLogFile != null
            ? fs.openSync(
                workingDirectory + "/" + taskExecutionConfig.stdoutLogFile,
                "a"
              )
            : "ignore";
        const stderrlog =
          taskExecutionConfig.stderrLogFile != null
            ? fs.openSync(
                workingDirectory + "/" + taskExecutionConfig.stderrLogFile,
                "a"
              )
            : stdoutlog;

        const options = {
          cwd: workingDirectory,
          env: environment,
          encoding: "utf8",
          stdio: ["ignore", stdoutlog, stderrlog],
          shell: taskExecutionConfig.shell
        };

        currentTaskStartTime = new Date();
        currentTaskTimeout = taskExecutionConfig.taskTimeout;
        currentSpawnedTask = spawn(
          taskCommand,
          taskExecutionConfig.taskArguments,
          options
        );
        currentSpawnedTask.on("close", code => {
          console.log(chalk.green("--- task finished: " + code));
          try {
            if (code !== 0) {
              console.log(chalk.red("--- Task failed, preparing conclusion"));
              prepareConclusion(
                workingDirectory,
                "failure",
                "Task results",
                code == null ? "Task timeout" : "Task Failed",
                taskExecutionConfig.errorSummaryFile,
                "",
                taskExecutionConfig.errorTextFile,
                resolve
              );
            } else {
              console.log(
                chalk.green("--- Task succeeded, preparing conclusion")
              );
              prepareConclusion(
                workingDirectory,
                "success",
                "Task results",
                "Task was successful",
                taskExecutionConfig.successSummaryFile,
                "",
                taskExecutionConfig.successTextFile,
                resolve
              );
            }
          } catch (e) {
            console.log(chalk.red("Exception handling task close event: " + e));
            resolve({
              conclusion: "failure",
              title: "Task results",
              summary: "Task failed due to internal error",
              text: e.toString()
            });
          }
        });
      } catch (e) {
        console.log(chalk.red("Exception handling task: " + e));
        resolve({
          conclusion: "failure",
          title: "Task results",
          summary: "Task failed due to internal error",
          text: e.toString()
        });
      }
    });
  }
}

/**
 * execute the task and capture any results
 * @param {*} taskExecutionConfig
 * @param {*} workingDirectory
 * @param {*} environment
 */
async function executeJavaScriptTask(taskExecutionConfig, workingDirectory) {
  const taskCommand =
    conf.stampedeScriptPath + "/" + taskExecutionConfig.taskCommand;
  try {
    if (!fs.existsSync(taskCommand)) {
      const conclusion = {
        conclusion: "failure",
        title: "Task results",
        summary: "Task configured incorrectly, contact your stampede admin.",
        text: ""
      };
      return conclusion;
    }
    console.log(chalk.green("--- Executing: " + taskCommand));

    const logger = winston.createLogger({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.align(),
        winston.format.printf(
          info => `${info.timestamp} ${info.level}: ${info.message}`
        )
      ),
      transports: [
        new winston.transports.File({
          filename: workingDirectory + "/" + taskExecutionConfig.stdoutLogFile
        })
      ]
    });

    const taskModule = require(`${taskCommand}`);
    const result = await taskModule.execute(
      taskExecutionConfig,
      workingDirectory,
      logger
    );
    logger.end();

    if (require.cache[require.resolve(taskCommand)] != null) {
      delete require.cache[require.resolve(taskCommand)];
    }
    return result;
  } catch (e) {
    console.log(chalk.red("Exception handling task: " + e));
    if (require.cache[require.resolve(taskCommand)] != null) {
      delete require.cache[require.resolve(taskCommand)];
    }
    return {
      conclusion: "failure",
      title: "Task results",
      summary: "Task failed due to internal error",
      text: e.toString()
    };
  }
}

/**
 * Return any environment parameters from the task
 * @param {*} taskExecutionConfig
 * @return {object} the config values
 */
function collectEnvironment(taskExecutionConfig, workingDirectory) {
  var environment = {};
  // Remove any STAMP_ environment variables since they shouldn't be
  // a part of this execution
  Object.keys(process.env).forEach(function(key) {
    if (!key.startsWith(taskExecutionConfig.environmentVariablePrefix)) {
      environment[key] = process.env[key];
    }
  });

  const task = taskExecutionConfig.task;
  console.dir(task.config);
  if (task.config != null) {
    Object.keys(task.config).forEach(function(key) {
      console.log("--- key: " + key);
      const envVar =
        taskExecutionConfig.environmentVariablePrefix + key.toUpperCase();
      environment[envVar] = task.config[key].value;
    });

    // And some common things from all events
    environment[taskExecutionConfig.environmentVariablePrefix + "OWNER"] =
      task.owner;
    environment[taskExecutionConfig.environmentVariablePrefix + "REPO"] =
      task.repository;
    environment[taskExecutionConfig.environmentVariablePrefix + "BUILDNUMBER"] =
      task.buildNumber;
    environment[taskExecutionConfig.environmentVariablePrefix + "TASK"] =
      task.task.id;
    environment[taskExecutionConfig.environmentVariablePrefix + "BUILDID"] =
      task.buildID;
    environment[taskExecutionConfig.environmentVariablePrefix + "TASKID"] =
      task.taskID;
    environment[
      taskExecutionConfig.environmentVariablePrefix + "WORKINGDIR"
    ] = workingDirectory;

    // Now add in the event specific details, if they are available
    if (task.scm.pullRequest != null) {
      environment[taskExecutionConfig.environmentVariablePrefix + "BUILDKEY"] =
        "pullrequest-" + task.scm.pullRequest.number;
      environment[
        taskExecutionConfig.environmentVariablePrefix + "PULLREQUESTNUMBER"
      ] = task.scm.pullRequest.number;
      environment[
        taskExecutionConfig.environmentVariablePrefix + "PULLREQUESTBRANCH"
      ] = task.scm.pullRequest.head.ref;
      environment[
        taskExecutionConfig.environmentVariablePrefix + "PULLREQUESTBASEBRANCH"
      ] = task.scm.pullRequest.base.ref;
      environment[
        taskExecutionConfig.environmentVariablePrefix + "GITSHABASE"
      ] = task.scm.pullRequest.base.sha;
      environment[
        taskExecutionConfig.environmentVariablePrefix + "GITSHAHEAD"
      ] = task.scm.pullRequest.head.sha;
      environment[taskExecutionConfig.environmentVariablePrefix + "PRTITLE"] =
        task.scm.pullRequest.title;
      environment[
        taskExecutionConfig.environmentVariablePrefix + "PRBODYLENGTH"
      ] = task.scm.pullRequest.bodyLength;
      environment[
        taskExecutionConfig.environmentVariablePrefix + "PRMILESTONE"
      ] = task.scm.pullRequest.milestone;
      environment[taskExecutionConfig.environmentVariablePrefix + "PRLABELS"] =
        task.scm.pullRequest.labels != null
          ? task.scm.pullRequest.labels.join(",")
          : "";
    }

    if (task.scm.branch != null) {
      environment[taskExecutionConfig.environmentVariablePrefix + "BUILDKEY"] =
        task.scm.branch.name;
      environment[taskExecutionConfig.environmentVariablePrefix + "BRANCH"] =
        task.scm.branch.name;
      environment[taskExecutionConfig.environmentVariablePrefix + "GITSHA"] =
        task.scm.branch.sha;
    }

    if (task.scm.release != null) {
      environment[taskExecutionConfig.environmentVariablePrefix + "BUILDKEY"] =
        task.scm.release.name;
      environment[taskExecutionConfig.environmentVariablePrefix + "RELEASE"] =
        task.scm.release.name;
      environment[taskExecutionConfig.environmentVariablePrefix + "TAG"] =
        task.scm.release.tag;
      environment[taskExecutionConfig.environmentVariablePrefix + "GITSHA"] =
        task.scm.release.sha;
    }
  } else {
    console.log(chalk.red("--- no config found!"));
  }

  return environment;
}

/**
 * Update the task in redis and in github
 * @param {*} task
 */
async function updateTask(task, responseQueue) {
  console.log(chalk.green("--- updating task with status: " + task.status));
  responseQueue.add(
    { response: "taskUpdate", payload: task },
    { removeOnComplete: true, removeOnFail: true }
  );
}

/**
 * prepareConclusion
 * @param {*} workingDirectory
 * @param {*} conclusion
 * @param {*} title
 * @param {*} defaultSummary
 * @param {*} summaryFile
 * @param {*} defaultText
 * @param {*} textFile
 * @return {*} The conclusion object to set in our task details
 */
async function prepareConclusion(
  workingDirectory,
  conclusion,
  title,
  defaultSummary,
  summaryFile,
  defaultText,
  textFile,
  resolve
) {
  let summary = defaultSummary;
  if (summaryFile != null && summaryFile.length > 0) {
    if (fs.existsSync(workingDirectory + "/" + summaryFile)) {
      const results = await logFileReader.parseLog(
        workingDirectory + "/" + summaryFile,
        { lastKB: 63000 }
      );
      summary = results.map(x => x.line).join("\n");
    }
  }

  let text = defaultText;
  if (textFile != null && textFile.length > 0) {
    if (fs.existsSync(workingDirectory + "/" + textFile)) {
      const results = await logFileReader.parseLog(
        workingDirectory + "/" + textFile,
        { lastKB: 63000 }
      );
      text = results.map(x => x.line).join("\n");
    }
  }

  resolve({
    conclusion: conclusion,
    title: title,
    summary: summary,
    text: text
  });
}
