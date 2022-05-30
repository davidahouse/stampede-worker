#!/usr/bin/env node
"use strict";

const figlet = require("figlet");
const fs = require("fs");
const { spawn } = require("child_process");
const Queue = require("bull");
const { v4: uuidv4 } = require("uuid");
const logFileReader = require("log-file-reader");
const winston = require("winston");
const csv = require("csv-parser");

const queueLog = require("../lib/queueLog");
const responseTestFile = require("../lib/responseTestFile");
const executionConfig = require("../lib/executionConfig");
const workingDirectory = require("../lib/workingDirectory");

require("pkginfo")(module);

const conf = require("rc-house")("stampede", {
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
  logLevel: "info",
  // Test mode. Set both of these to enable test mode
  // where the worker will execute the task that is in the
  // taskTestFile, and the results will go into the
  // response file.
  taskTestFile: null,
  responseTestFile: null,
  // Task defaults
  environmentVariablePrefix: "STAMP_",
  shell: "/bin/bash",
  gitClone: "https",
  gitCloneOptions: "",
  defaultGitCloneDepth: 15,
  gitMerge: false,
  stdoutLogFile: "stdout.log",
  stderrLogFile: null,
  taskTimeout: 1800000, // Default timeout: 30 minutes
  artifactListFile: "artifacts.csv",
  summaryTableFile: "summarytable.json",
  // Log file configuration
  taskDetailsLogFile: "worker.log",
  releaseBodyFile: "releasebody.txt",
  logQueuePath: null,
  // Heartbeat
  heartbeatInterval: 15000,
  cloneRetryInterval: 1 * 60 * 1000, // retry every minute must be specified in milliseconds
  cloneRetryAttempts: 3, // retry 3 tiems
});

// Configure winston logging
const logFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp(),
  winston.format.align(),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

const logger = winston.createLogger({
  level: conf.logLevel,
  format: logFormat,
  transports: [new winston.transports.Console()],
});

const redisConfig = {
  redis: {
    port: conf.redisPort,
    host: conf.redisHost,
    password: conf.redisPassword,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
};
const workerID = uuidv4();
let workerStatus = "idle";
let lastTask = {};
let currentSpawnedTask = null;
let currentTaskStartTime = null;
let currentTaskTimeout = conf.taskTimeout;
let pendingShutdown = false;

logger.info(figlet.textSync("stampede", { horizontalLayout: "full" }));
logger.info(module.exports.version);
logger.info("Redis Host: " + conf.redisHost);
logger.info("Redis Port: " + conf.redisPort);
logger.info("Node Name: " + conf.nodeName);
logger.info("Task Queue: " + conf.taskQueue);
logger.info("Workspace Root: " + conf.workspaceRoot);
logger.info("Worker Name: " + conf.workerName);
logger.info("Worker ID: " + workerID);

// Check for all our required parameters
if (
  conf.redisHost == null ||
  conf.redisPort == null ||
  conf.nodeName == null ||
  conf.stampedeScriptPath == null ||
  conf.workspaceRoot == null
) {
  logger.error("Missing required config parameters. Unable to start worker.");
  process.exit(1);
}

let workerQueue = null;
let responseQueue = null;

if (conf.taskTestFile == null) {
  workerQueue = new Queue("stampede-" + conf.taskQueue, redisConfig);
  responseQueue = new Queue("stampede-" + conf.responseQueue, redisConfig);

  workerQueue.process(function (task) {
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
process.on("SIGINT", function () {
  gracefulShutdown();
});

process.on("SIGHUP", function () {
  gracefulShutdown();
});

/**
 * gracefulShutdown
 */
async function gracefulShutdown() {
  if (currentSpawnedTask != null) {
    pendingShutdown = true;
  } else {
    logger.info("Closing worker queue");
    await workerQueue.close();
    logger.info("Closing response queue");
    await responseQueue.close();
    logger.info("Done");
    process.exit(0);
  }
}

/**
 * Handle an incoming task
 * @param {*} task
 */
async function handleTask(task, responseQueue) {
  logger.info("Handling task: " + task.taskID);
  try {
    workerStatus = "busy";
    lastTask = task;
    const startedAt = new Date();
    task.status = "in_progress";
    task.stats.startedAt = startedAt;
    task.worker = {
      node: conf.nodeName,
      version: module.exports.version,
      workerID: workerID,
    };
    logger.verbose("Updating task to in progress");
    await updateTask(task, responseQueue);

    // Gather up the execution config options we will need for this task
    const taskExecutionConfig = await executionConfig.prepareExecutionConfig(
      task,
      conf,
      logger
    );
    logger.verbose(JSON.stringify(taskExecutionConfig, null, 2));
    if (taskExecutionConfig.error != null) {
      logger.error(" Error getting execution config");
      task.status = "completed";
      task.result = {
        conclusion: "failure",
        summary: taskExecutionConfig.error,
      };
      task.stats.finishedAt = new Date();
      await updateTask(task, responseQueue);
      workerStatus = "idle";
      return;
    }

    // Create the working directory and prepare it
    const prepareDirectory = await workingDirectory.prepareWorkingDirectory(
      taskExecutionConfig,
      conf,
      logger
    );
    if (prepareDirectory.error != null) {
      logger.error(prepareDirectory.message);
      task.status = "completed";
      task.result = {
        conclusion: "failure",
        summary: prepareDirectory.message,
      };
      task.stats.finishedAt = new Date();
      await updateTask(task, responseQueue);
      workerStatus = "idle";
      return;
    }

    const directory = prepareDirectory.directory;
    task.worker.directory = prepareDirectory.directory;
    if (prepareDirectory.sha != null) {
      task.scm.branch.sha = prepareDirectory.sha;
    }
    if (prepareDirectory.commit != null) {
      task.scm.commitMessage = prepareDirectory.commit;
    }

    // Setup our environment variables
    const environment = collectEnvironment(taskExecutionConfig, directory);
    try {
      let exportValues = "";
      Object.keys(environment).forEach(function (key) {
        if (key.startsWith(taskExecutionConfig.environmentVariablePrefix)) {
          exportValues += key + "=" + environment[key] + "\n";
        }
      });
      fs.writeFileSync(directory + "/.env", exportValues);
    } catch (e) {
      logger.error("Error writing environment log: " + e);
    }

    // Write out release body if found
    if (
      conf.releaseBodyFile != null &&
      taskExecutionConfig.task.scm.release != null &&
      taskExecutionConfig.task.scm.release.body != null
    ) {
      logger.verbose("Writing out release body");
      try {
        fs.writeFileSync(
          directory + "/" + conf.releaseBodyFile,
          taskExecutionConfig.task.scm.release.body
        );
      } catch (e) {
        logger.error("Error writing release body: " + e);
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

    // If we kill the task due to a pending shutdown then just close our worker queue and return
    // so that the task will get re-queued
    if (pendingShutdown == true) {
      task.status = "queued";
      task.stats.startedAt = null;
      await updateTask(task, responseQueue);
      await workerQueue.close();
      return;
    }

    logger.verbose("Updating task record to capture completed state");
    const finishedAt = new Date();
    task.stats.finishedAt = finishedAt;

    // Now finalize our task status
    task.status = "completed";
    task.result = result;
    if (conf.taskDetailsLogFile != null && conf.taskDetailsLogFile.length > 0) {
      logger.verbose("Writing out worker.log file");
      fs.writeFileSync(
        directory + "/" + conf.taskDetailsLogFile,
        JSON.stringify(task, null, 2)
      );
    }

    // Load any metadata pointed to by an artifact
    if (task.result.artifacts != null) {
      for (let aindex = 0; aindex < task.result.artifacts.length; aindex++) {
        if (
          task.result.artifacts[aindex].metadata_file != null &&
          task.result.artifacts[aindex].metadata_file != ""
        ) {
          try {
            const metadata = JSON.parse(
              fs.readFileSync(
                directory + "/" + task.result.artifacts[aindex].metadata_file
              )
            );
            task.result.artifacts[aindex].metadata = metadata;
          } catch (e) {
            logger.error(
              "Error reading metadata json file: " +
                directory +
                "/" +
                task.result.artifacts[aindex].metadata_file +
                " " +
                e
            );
          }
        }

        if (
          task.result.artifacts[aindex].contents_file != null &&
          task.result.artifacts[aindex].contents_file != ""
        ) {
          try {
            const contents = JSON.parse(
              fs.readFileSync(
                directory + "/" + task.result.artifacts[aindex].contents_file
              )
            );
            task.result.artifacts[aindex].contents = contents;
          } catch (e) {
            logger.error(
              "Error reading contents json file: " +
                directory +
                "/" +
                task.result.artifacts[aindex].contents_file +
                " " +
                e
            );
          }
        }
      }
    }

    logger.verbose("Updating task");
    await updateTask(task, responseQueue);
    workerStatus = "idle";
    logger.verbose("handle task completed");
  } catch (e) {
    logger.error(" Error in handle task " + e);
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
    taskQueue: conf.taskQueue,
  };
  queue.add(
    {
      response: "heartbeat",
      payload: heartbeat,
    },
    { removeOnComplete: true, removeOnFail: true }
  );

  // Check for stalled task execution and kill it if necessary
  if (currentTaskStartTime != null) {
    let duration = new Date() - currentTaskStartTime;
    if (duration > currentTaskTimeout) {
      logger.error(" Task timeout reached! Killing spawned process");
      currentSpawnedTask.kill();
      currentTaskStartTime = null;
      currentTaskTimeout = conf.taskTimeout;
    }
  }

  // If we are trying to shutdown during a task execution, go ahead and kill the task
  if (pendingShutdown == true) {
    if (currentSpawnedTask != null) {
      currentSpawnedTask.kill();
      currentTaskStartTime = null;
      currentTaskTimeout = conf.taskTimeout;
    } else {
      logger.info("Closing response queue");
      await responseQueue.close();
      logger.info("Done");
      process.exit(0);
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
    return new Promise((resolve) => {
      try {
        const taskCommand =
          conf.stampedeScriptPath + "/" + taskExecutionConfig.taskCommand;
        if (!fs.existsSync(taskCommand)) {
          const conclusion = {
            conclusion: "failure",
            title: "Task results",
            summary:
              "Task configured incorrectly, contact your stampede admin.",
            text: "",
          };
          resolve(conclusion);
          return;
        }
        logger.info("Executing: " + taskCommand);

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
          shell: taskExecutionConfig.shell,
        };

        currentTaskStartTime = new Date();
        currentTaskTimeout = taskExecutionConfig.taskTimeout;
        currentSpawnedTask = spawn(
          taskCommand,
          taskExecutionConfig.taskArguments,
          options
        );
        currentSpawnedTask.on("close", (code) => {
          logger.info("task finished: " + code);
          try {
            if (code !== 0) {
              logger.error(" Task failed, preparing conclusion");
              prepareConclusion(
                workingDirectory,
                "failure",
                "Task results",
                code == null ? "Task timeout" : "Task Failed",
                taskExecutionConfig.errorSummaryFile,
                "",
                taskExecutionConfig.errorTextFile,
                taskExecutionConfig.artifactListFile,
                taskExecutionConfig.summaryTableFile,
                resolve
              );
            } else {
              logger.info("Task succeeded, preparing conclusion");
              prepareConclusion(
                workingDirectory,
                "success",
                "Task results",
                "Task was successful",
                taskExecutionConfig.successSummaryFile,
                "",
                taskExecutionConfig.successTextFile,
                taskExecutionConfig.artifactListFile,
                taskExecutionConfig.summaryTableFile,
                resolve
              );
            }
          } catch (e) {
            logger.error("Exception handling task close event: " + e);
            resolve({
              conclusion: "failure",
              title: "Task results",
              summary: "Task failed due to internal error",
              text: e.toString(),
            });
          }
        });
      } catch (e) {
        logger.error("Exception handling task: " + e);
        resolve({
          conclusion: "failure",
          title: "Task results",
          summary: "Task failed due to internal error",
          text: e.toString(),
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
        text: "",
      };
      return conclusion;
    }
    logger.info("Executing: " + taskCommand);

    const taskLogger = winston.createLogger({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.align(),
        winston.format.printf(
          (info) => `${info.timestamp} ${info.level}: ${info.message}`
        )
      ),
      transports: [
        new winston.transports.File({
          filename: workingDirectory + "/" + taskExecutionConfig.stdoutLogFile,
        }),
      ],
    });

    const taskModule = require(`${taskCommand}`);
    const result = await taskModule.execute(
      taskExecutionConfig,
      workingDirectory,
      taskLogger
    );
    taskLogger.end();

    if (require.cache[require.resolve(taskCommand)] != null) {
      delete require.cache[require.resolve(taskCommand)];
    }
    return result;
  } catch (e) {
    logger.error("Exception handling task: " + e);
    if (require.cache[require.resolve(taskCommand)] != null) {
      delete require.cache[require.resolve(taskCommand)];
    }
    return {
      conclusion: "failure",
      title: "Task results",
      summary: "Task failed due to internal error",
      text: e.toString(),
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
  Object.keys(process.env).forEach(function (key) {
    if (!key.startsWith(taskExecutionConfig.environmentVariablePrefix)) {
      environment[key] = process.env[key];
    }
  });

  const task = taskExecutionConfig.task;
  logger.verbose(JSON.stringify(task.config, null, 2));
  if (task.config != null) {
    Object.keys(task.config).forEach(function (key) {
      logger.verbose("key: " + key);
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
    environment[taskExecutionConfig.environmentVariablePrefix + "WORKINGDIR"] =
      workingDirectory;
    environment[taskExecutionConfig.environmentVariablePrefix + "ACCESSTOKEN"] =
      task.scm.accessToken;

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
      if (task.scm.pullRequest.login != null) {
        environment[
          taskExecutionConfig.environmentVariablePrefix + "PULLREQUESTLOGIN"
        ] = task.scm.pullRequest.login;
      }
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
    logger.info("no config found!");
  }

  return environment;
}

/**
 * Update the task in redis and in github
 * @param {*} task
 */
async function updateTask(task, responseQueue) {
  logger.info("updating task with status: " + task.status);
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
 * @param {*} artifactListFile
 * @param {*} summaryTableFile
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
  artifactListFile,
  summaryTableFile,
  resolve
) {
  let summary = defaultSummary;
  if (summaryFile != null && summaryFile.length > 0) {
    if (fs.existsSync(workingDirectory + "/" + summaryFile)) {
      const results = await logFileReader.parseLog(
        workingDirectory + "/" + summaryFile,
        { lastKB: 63000 }
      );
      summary = results.map((x) => x.line).join("\n");
    }
  }

  let text = defaultText;
  if (textFile != null && textFile.length > 0) {
    if (fs.existsSync(workingDirectory + "/" + textFile)) {
      const results = await logFileReader.parseLog(
        workingDirectory + "/" + textFile,
        { lastKB: 63000 }
      );
      text = results.map((x) => x.line).join("\n");
    }
  }

  let artifacts = [];
  if (artifactListFile != null && artifactListFile.length > 0) {
    if (fs.existsSync(workingDirectory + "/" + artifactListFile)) {
      const foundArtifacts = await parseArtifactsCSV(
        workingDirectory + "/" + artifactListFile
      );
      artifacts = foundArtifacts;
    }
  }

  let summaryTable = [];
  if (summaryTableFile != null && summaryTableFile.length > 0) {
    if (fs.existsSync(workingDirectory + "/" + summaryTableFile)) {
      try {
        const results = fs.readFileSync(
          workingDirectory + "/" + summaryTableFile
        );
        summaryTable = JSON.parse(results);
      } catch (e) {
        console.log("Error reading summary table: " + e);
      }
    }
  }

  resolve({
    conclusion: conclusion,
    title: title,
    summary: summary,
    text: text,
    artifacts: artifacts,
    summaryTable: summaryTable,
  });
}

/**
 * parseArtifactsCSV
 * @param {*} csvFile
 */
async function parseArtifactsCSV(csvFile) {
  return new Promise((resolve) => {
    const artifacts = [];
    fs.createReadStream(csvFile)
      .pipe(csv(["title", "url", "type", "metadata_file", "contents_file"]))
      .on("data", (data) => artifacts.push(data))
      .on("end", () => {
        resolve(artifacts);
      });
  });
}
