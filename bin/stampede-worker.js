#!/usr/bin/env node
'use strict'

const chalk = require('chalk')
const figlet = require('figlet')
const fs = require('fs')
const { spawn } = require('child_process')
const { exec } = require('child_process')
const Queue = require('bull')
const uuidv4 = require('uuid/v4')

const queueLog = require('../lib/queueLog')
const responseTestFile = require('../lib/responseTestFile')

require('pkginfo')(module)

const conf = require('rc')('stampede', {
  // Queue configuration
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
  nodeName: 'missing-node-name',
  taskQueue: null,
  responseQueue: 'stampede-response',
  // Test mode. Set both of these to enable test mode
  // where the worker will execute the task that is in the
  // taskTestFile, and the results will go into the
  // response file.
  taskTestFile: null,
  responseTestFile: null,
  // Command configuration
  taskCommand: null,
  workspaceRoot: null,
  environmentVariablePrefix: 'STAMP_',
  shell: '/bin/bash',
  gitClone: 'ssh',
  gitCloneOptions: '',
  // Log file configuration
  stdoutLogFile: 'stdout.log',
  stderrLogFile: null,
  environmentLogFile: 'environment.log',
  taskDetailsLogFile: 'worker.log',
  successSummaryFile: null,
  successTextFile: null,
  errorSummaryFile: null,
  errorTextFile: 'stderr.log',
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
console.log(chalk.red('Task Queue: ' + conf.taskQueue))
console.log(chalk.red('Worker ID: ' + workerID))

if (conf.taskQueue == null) {
  console.log(chalk.red('No task queue defined. A worker needs a task queue to operate!'))
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
  await updateTask(task, responseQueue)

  // Create the working directory and prepare it
  const workingDirectory = await prepareWorkingDirectory(task)

  // Setup our environment variables
  const environment = collectEnvironment(task, workingDirectory)
  if (conf.environmentLogFile != null && conf.environmentLogFile.length > 0) {
    fs.writeFileSync(workingDirectory + '/' + conf.environmentLogFile, JSON.stringify(environment, null, 2))
  }

  // Execute our task
  const result = await executeTask(workingDirectory, environment)
  const finishedAt = new Date()
  task.stats.finishedAt = finishedAt

  // Now finalize our task status
  task.status = 'completed'
  task.result = result
  if (conf.taskDetailsLogFile != null && conf.taskDetailsLogFile.length > 0) {
    fs.writeFileSync(workingDirectory + '/' + conf.taskDetailsLogFile, JSON.stringify(task, null, 2))
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
  queue.add(heartbeat)
  setTimeout(handleHeartbeat, conf.heartbeatInterval, queue)
}

/**
 * execute the task and capture any results
 * @param {*} workingDirectory
 * @param {*} environment
 */
async function executeTask(workingDirectory, environment) {
  return new Promise(resolve => {
    console.log(chalk.green('--- Executing: ' + conf.taskCommand))

    const stdoutlog = conf.stdoutLogFile != null ?
      fs.openSync(workingDirectory + '/' + conf.stdoutLogFile, 'a') :
      'ignore'
    const stderrlog = conf.stderrLogFile != null ?
      fs.openSync(workingDirectory + '/' + conf.stderrLogFile, 'a') :
      stdoutlog

    const options = {
      cwd: workingDirectory,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', stdoutlog, stderrlog],
      shell: conf.shell,
    }

    const spawned = spawn(conf.taskCommand, options)
    spawned.on('close', (code) => {
      console.log(chalk.green('--- task finished: ' + code))
      if (code !== 0) {
        const conclusion = prepareConclusion(workingDirectory, 'failure', 'Task results',
          'Task Failed', conf.errorSummaryFile,
          '', conf.errorTextFile)
        resolve(conclusion)
      } else {
        const conclusion = prepareConclusion(workingDirectory, 'success', 'Task results',
          'Task was successful', conf.successSummaryFile,
          '', conf.successTextFile)
        resolve(conclusion)
      }
    })
  })
}

/**
 * prepare the working directory
 * @param {*} task
 */
async function prepareWorkingDirectory(task) {
  const dir = conf.workspaceRoot + '/' + task.taskID
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  }
  console.log('--- working directory: ' + dir)

  if (conf.gitClone === 'ssh' || conf.gitClone === 'https') {
    // Do a clone into our working directory
    console.log(chalk.green('--- performing a git clone from:'))
    if (conf.gitClone === 'ssh') {
      console.log(chalk.green(task.scm.sshURL))
      await cloneRepo(task.scm.sshURL, dir, conf.gitCloneOptions)
    } else if (conf.gitClone === 'https') {
      console.log(chalk.green(task.scm.cloneURL))
      await cloneRepo(task.scm.cloneURL, dir, conf.gitCloneOptions)
    }

    // Handle pull requests differently
    if (task.scm.pullRequest != null) {
      // Now checkout our head sha
      console.log(chalk.green('--- head'))
      console.dir(task.scm.pullRequest.head)
      await gitCheckout(task.scm.pullRequest.head.sha, dir)
      // And then merge the base sha
      console.log(chalk.green('--- base'))
      console.dir(task.scm.pullRequest.base)
      await gitMerge(task.scm.pullRequest.base.sha, dir)
      // Fail if we have merge conflicts
    } else if (task.scm.branch != null) {
      console.log(chalk.green('--- sha'))
      console.dir(task.scm.branch.sha)
      await gitCheckout(task.scm.branch.sha, dir)
    } else if (task.scm.release != null) {
      console.log(chalk.green('--- sha'))
      console.dir(task.scm.release.sha)
      await gitCheckout(task.scm.release.sha, dir)
    }
  } else {
    console.log(chalk.green('--- skipping git clone as gitClone config was not ssh or https'))
  }
  return dir
}

/**
 * Return any environment parameters from the task
 * @param {*} task
 * @return {object} the config values
 */
function collectEnvironment(task, workingDirectory) {
  var environment = process.env
  console.dir(task.config)
  if (task.config != null) {
    Object.keys(task.config).forEach(function(key) {
      console.log('--- key: ' + key)
      environment[conf.environmentVariablePrefix + key.toUpperCase()] = task.config[key]
    })

    // And some common things from all events
    environment[conf.environmentVariablePrefix + 'OWNER'] = task.owner
    environment[conf.environmentVariablePrefix + 'REPO'] = task.repository
    environment[conf.environmentVariablePrefix + 'BUILDNUMBER'] = task.buildNumber
    environment[conf.environmentVariablePrefix + 'TASK'] = task.task.id
    environment[conf.environmentVariablePrefix + 'BUILDID'] = task.buildID
    environment[conf.environmentVariablePrefix + 'TASKID'] = task.taskID
    environment[conf.environmentVariablePrefix + 'WORKINGDIR'] = workingDirectory

    // Now add in the event specific details, if they are available
    if (task.scm.pullRequest != null) {
      environment[conf.environmentVariablePrefix + 'BUILDKEY'] = 'pullrequest-' + task.scm.pullRequest.number
      environment[conf.environmentVariablePrefix + 'PULLREQUESTNUMBER'] = task.scm.pullRequest.number
      environment[conf.environmentVariablePrefix + 'PULLREQUESTBRANCH'] = task.scm.pullRequest.head.ref
      environment[conf.environmentVariablePrefix + 'PULLREQUESTBASEBRANCH'] = task.scm.pullRequest.base.ref
      environment[conf.environmentVariablePrefix + 'GITSHABASE'] = task.scm.pullRequest.base.sha
      environment[conf.environmentVariablePrefix + 'GITSHAHEAD'] = task.scm.pullRequest.head.sha
    }

    if (task.scm.branch != null) {
      environment[conf.environmentVariablePrefix + 'BUILDKEY'] = task.scm.branch.name
      environment[conf.environmentVariablePrefix + 'BRANCH'] = task.scm.branch.name
      environment[conf.environmentVariablePrefix + 'GITSHA'] = task.scm.branch.sha
    }

    if (task.scm.release != null) {
      environment[conf.environmentVariablePrefix + 'BUILDKEY'] = task.scm.release.name
      environment[conf.environmentVariablePrefix + 'RELEASE'] = task.scm.release.name
      environment[conf.environmentVariablePrefix + 'TAG'] = task.scm.release.tag
      environment[conf.environmentVariablePrefix + 'GITSHA'] = task.scm.release.sha
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
  console.dir(task)
  responseQueue.add(task)
}

/**
 * Clone the repository to our working directory
 * @param {*} cloneUrl
 * @param {*} workingDirectory
 */
async function cloneRepo(cloneUrl, workingDirectory, cloneOptions) {
  return new Promise(resolve => {
    exec('git clone ' + cloneOptions + ' ' + cloneUrl + ' ' + workingDirectory, (error, stdout, stderr) => {
      if (error) {
        console.error(`cloneRepo error: ${error}`)
        // TODO: figure out the error reason
        resolve(false)
        return
      }
      console.log(`stdout: ${stdout}`)
      console.log(`stderr: ${stderr}`)
      resolve(false)
    })
  })
}

/**
 * Perform a git checkout of our branch
 * @param {*} sha
 * @param {*} workingDirectory
 */
async function gitCheckout(sha, workingDirectory) {
  return new Promise(resolve => {
    exec('git checkout -f ' + sha, {cwd: workingDirectory}, (error, stdout, stderr) => {
      if (error) {
        console.error(`gitCheckout error: ${error}`)
        // TODO: figure out the error reason
        resolve(false)
        return
      }
      console.log(`stdout: ${stdout}`)
      console.log(`stderr: ${stderr}`)
      resolve(false)
    })
  })
}

/**
 * Now merge in the target branch
 * @param {*} sha
 * @param {*} workingDirectory
 */
async function gitMerge(sha, workingDirectory) {
  return new Promise(resolve => {
    exec('git merge ' + sha, {cwd: workingDirectory}, (error, stdout, stderr) => {
      if (error) {
        console.error(`gitMerge error: ${error}`)
        // TODO: figure out the error reason
        resolve(false)
        return
      }
      console.log(`stdout: ${stdout}`)
      console.log(`stderr: ${stderr}`)
      resolve(false)
    })
  })
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
