#!/usr/bin/env node
'use strict'

const chalk = require('chalk')
const figlet = require('figlet')
const fs = require('fs')
const { spawn } = require('child_process')
const Queue = require('bull')
const uuidv4 = require('uuid/v4')

const queueLog = require('../lib/queueLog')
const responseTestFile = require('../lib/responseTestFile')
const executionConfig = require('../lib/executionConfig')
const workingDirectory = require('../lib/workingDirectory')

require('pkginfo')(module)

const conf = require('rc')('stampede', {
  // Required configuration
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
  nodeName: null,
  stampedeConfigPath: null,
  stampedeScriptPath: null,
  taskQueue: 'stampede-tasks',
  responseQueue: 'stampede-response',
  workspaceRoot: null,
  // Test mode. Set both of these to enable test mode
  // where the worker will execute the task that is in the
  // taskTestFile, and the results will go into the
  // response file.
  taskTestFile: null,
  responseTestFile: null,
  // Task defaults
  environmentVariablePrefix: 'STAMP_',
  shell: '/bin/bash',
  gitClone: 'ssh',
  gitCloneOptions: '',
  stdoutLogFile: 'stdout.log',
  stderrLogFile: null,
  // Log file configuration
  environmentLogFile: 'environment.log',
  taskDetailsLogFile: 'worker.log',
  logQueuePath: null,
  // Heartbeat
  heartbeatQueue: 'stampede-heartbeat',
  heartbeatInterval: 15000,
})

const redisConfig = {
  redis: {
    port: conf.redisPort,
    host: conf.redisHost,
    password: conf.redisPassword,
  },
}
const workerID = uuidv4()
let workerStatus = 'idle'
let lastTask = {}

console.log(chalk.red(figlet.textSync('stampede', {horizontalLayout: 'full'})))
console.log(chalk.yellow(module.exports.version))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))
console.log(chalk.red('Node Name: ' + conf.nodeName))
console.log(chalk.red('Config Path: ' + conf.stampedeConfigPath))
console.log(chalk.red('Script Path: ' + conf.stampedeScriptPath))
console.log(chalk.red('Task Queue: ' + conf.taskQueue))
console.log(chalk.red('Workspace Root: ' + conf.workspaceRoot))
console.log(chalk.red('Worker ID: ' + workerID))

// Check for all our required parameters
if (conf.redisHost == null || conf.redisPort == null || conf.nodeName == null ||
    conf.stampedeConfigPath == null || conf.stampedeScriptPath == null ||
    conf.workspaceRoot == null) {
  console.log(chalk.red('Missing required config parameters. Unable to start worker.'))
  process.exit(1)
}

if (conf.taskTestFile == null) {
  const workerQueue = new Queue('stampede-' + conf.taskQueue, redisConfig)
  const responseQueue = new Queue(conf.responseQueue, redisConfig)
  const heartbeatQueue = conf.heartbeatQueue != null ?
    new Queue(conf.heartbeatQueue, redisConfig) :
    null

  workerQueue.process(function(task) {
    // Save the message if our logQueuePath is set
    if (conf.logQueuePath != null) {
      queueLog.save(conf.taskQueue, task.data, conf.logQueuePath)
    }
    return handleTask(task.data, responseQueue)
  })

  if (heartbeatQueue != null) {
    handleHeartbeat(heartbeatQueue)
  }
} else {
  const task = JSON.parse(fs.readFileSync(conf.taskTestFile))
  responseTestFile.init(conf.responseTestFile)
  handleTask(task, responseTestFile)
}

/**
 * Handle an incoming task
 * @param {*} task
 */
async function handleTask(task, responseQueue) {
  workerStatus = 'busy'
  lastTask = task
  const startedAt = new Date()
  task.status = 'in_progress'
  task.stats.startedAt = startedAt
  task.worker = {
    node: conf.nodeName,
    version: module.exports.version,
    workerID: workerID,
  }
  console.log('--- Updating task to in progress')
  await updateTask(task, responseQueue)

  // Gather up the execution config options we will need for this task
  const taskExecutionConfig = await executionConfig.prepareExecutionConfig(task, conf)
  console.dir(taskExecutionConfig)
  if (taskExecutionConfig.error != null) {
    console.log('--- Error getting execution config')
    task.status = 'completed'
    task.result = {
      conclusion: 'failure',
      summary: taskExecutionConfig.error,
    }
    await updateTask(task, responseQueue)
    workerStatus = 'idle'
    return
  }

  // Create the working directory and prepare it
  const directory = await workingDirectory.prepareWorkingDirectory(taskExecutionConfig, conf)
  if (directory == null) {
    console.log(chalk.red('Error getting working directory, unable to continue'))
    task.status = 'completed'
    task.result = {
      conclusion: 'failure',
      summary: 'Working directory error',
    }
    await updateTask(task, responseQueue)
    workerStatus = 'idle'
    return
  }

  // Setup our environment variables
  const environment = collectEnvironment(taskExecutionConfig, directory)
  if (conf.environmentLogFile != null && conf.environmentLogFile.length > 0) {
    fs.writeFileSync(directory + '/' + conf.environmentLogFile, JSON.stringify(environment, null, 2))
  }

  // Execute our task
  const result = await executeTask(taskExecutionConfig, directory, environment)
  const finishedAt = new Date()
  task.stats.finishedAt = finishedAt

  // Now finalize our task status
  task.status = 'completed'
  task.result = result
  if (conf.taskDetailsLogFile != null && conf.taskDetailsLogFile.length > 0) {
    fs.writeFileSync(directory + '/' + conf.taskDetailsLogFile, JSON.stringify(task, null, 2))
  }
  await updateTask(task, responseQueue)
  workerStatus = 'idle'
}

/**
 * send out a heartbeat notification
 * @param {*} queue
 */
async function handleHeartbeat(queue) {
  const heartbeat = {
    timestamp: new Date(),
    node: conf.nodeName,
    version: module.exports.version,
    workerID: workerID,
    status: workerStatus,
    lastTask: lastTask,
    taskQueue: conf.taskQueue,
  }
  queue.add(heartbeat, {removeOnComplete: true, removeOnFail: true})
  setTimeout(handleHeartbeat, conf.heartbeatInterval, queue)
}

/**
 * execute the task and capture any results
 * @param {*} taskExecutionConfig
 * @param {*} workingDirectory
 * @param {*} environment
 */
async function executeTask(taskExecutionConfig, workingDirectory, environment) {
  return new Promise(resolve => {
    const taskCommand = conf.stampedeScriptPath + '/' + taskExecutionConfig.taskCommand
    console.log(chalk.green('--- Executing: ' + taskCommand))

    const stdoutlog = taskExecutionConfig.stdoutLogFile != null ?
      fs.openSync(workingDirectory + '/' + taskExecutionConfig.stdoutLogFile, 'a') :
      'ignore'
    const stderrlog = taskExecutionConfig.stderrLogFile != null ?
      fs.openSync(workingDirectory + '/' + taskExecutionConfig.stderrLogFile, 'a') :
      stdoutlog

    const options = {
      cwd: workingDirectory,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', stdoutlog, stderrlog],
      shell: taskExecutionConfig.shell,
    }

    const spawned = spawn(taskCommand, taskExecutionConfig.taskArguments, options)
    spawned.on('close', (code) => {
      console.log(chalk.green('--- task finished: ' + code))
      if (code !== 0) {
        const conclusion = prepareConclusion(workingDirectory, 'failure', 'Task results',
          'Task Failed', taskExecutionConfig.errorSummaryFile,
          '', taskExecutionConfig.errorTextFile)
        resolve(conclusion)
      } else {
        const conclusion = prepareConclusion(workingDirectory, 'success', 'Task results',
          'Task was successful', taskExecutionConfig.successSummaryFile,
          '', taskExecutionConfig.successTextFile)
        resolve(conclusion)
      }
    })
  })
}

/**
 * Return any environment parameters from the task
 * @param {*} taskExecutionConfig
 * @return {object} the config values
 */
function collectEnvironment(taskExecutionConfig, workingDirectory) {
  var environment = process.env
  const task = taskExecutionConfig.task
  console.dir(task.config)
  if (task.config != null) {
    Object.keys(task.config).forEach(function(key) {
      console.log('--- key: ' + key)
      const envVar = taskExecutionConfig.environmentVariablePrefix + key.toUpperCase()
      environment[envVar] = task.config[key]
    })

    // And some common things from all events
    environment[taskExecutionConfig.environmentVariablePrefix + 'OWNER'] = task.owner
    environment[taskExecutionConfig.environmentVariablePrefix + 'REPO'] = task.repository
    environment[taskExecutionConfig.environmentVariablePrefix + 'BUILDNUMBER'] = task.buildNumber
    environment[taskExecutionConfig.environmentVariablePrefix + 'TASK'] = task.task.id
    environment[taskExecutionConfig.environmentVariablePrefix + 'BUILDID'] = task.buildID
    environment[taskExecutionConfig.environmentVariablePrefix + 'TASKID'] = task.taskID
    environment[taskExecutionConfig.environmentVariablePrefix + 'WORKINGDIR'] = workingDirectory

    // Now add in the event specific details, if they are available
    if (task.scm.pullRequest != null) {
      environment[taskExecutionConfig.environmentVariablePrefix + 'BUILDKEY'] = 'pullrequest-' + task.scm.pullRequest.number
      environment[taskExecutionConfig.environmentVariablePrefix + 'PULLREQUESTNUMBER'] = task.scm.pullRequest.number
      environment[taskExecutionConfig.environmentVariablePrefix + 'PULLREQUESTBRANCH'] = task.scm.pullRequest.head.ref
      environment[taskExecutionConfig.environmentVariablePrefix + 'PULLREQUESTBASEBRANCH'] = task.scm.pullRequest.base.ref
      environment[taskExecutionConfig.environmentVariablePrefix + 'GITSHABASE'] = task.scm.pullRequest.base.sha
      environment[taskExecutionConfig.environmentVariablePrefix + 'GITSHAHEAD'] = task.scm.pullRequest.head.sha
    }

    if (task.scm.branch != null) {
      environment[taskExecutionConfig.environmentVariablePrefix + 'BUILDKEY'] = task.scm.branch.name
      environment[taskExecutionConfig.environmentVariablePrefix + 'BRANCH'] = task.scm.branch.name
      environment[taskExecutionConfig.environmentVariablePrefix + 'GITSHA'] = task.scm.branch.sha
    }

    if (task.scm.release != null) {
      environment[taskExecutionConfig.environmentVariablePrefix + 'BUILDKEY'] = task.scm.release.name
      environment[taskExecutionConfig.environmentVariablePrefix + 'RELEASE'] = task.scm.release.name
      environment[taskExecutionConfig.environmentVariablePrefix + 'TAG'] = task.scm.release.tag
      environment[taskExecutionConfig.environmentVariablePrefix + 'GITSHA'] = task.scm.release.sha
    }
  } else {
    console.log(chalk.red('--- no config found!'))
  }

  return environment
}

/**
 * Update the task in redis and in github
 * @param {*} task
 */
async function updateTask(task, responseQueue) {
  console.log(chalk.green('--- updating task with status: ' + task.status))
  responseQueue.add(task, {removeOnComplete: true, removeOnFail: true})
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
async function prepareConclusion(workingDirectory, conclusion, title, defaultSummary, summaryFile,
  defaultText, textFile) {

  let summary = defaultSummary
  if (summaryFile != null && summaryFile.length > 0) {
    if (fs.existsSync(workingDirectory + '/' + summaryFile)) {
      summary = fs.readFileSync(workingDirectory + '/' + summaryFile, 'utf8')
    }
  }

  let text = defaultText
  if (textFile != null && textFile.length > 0) {
    if (fs.existsSync(workingDirectory + '/' + textFile)) {
      text = fs.readFileSync(workingDirectory + '/' + textFile, 'utf8')
    }
  }

  return {conclusion: conclusion,
    title: title,
    summary: summary,
    text: text}
}
