#!/usr/bin/env node
'use strict'

const chalk = require('chalk')
const figlet = require('figlet')
const fs = require('fs')
const { spawn } = require('child_process')
const { exec } = require('child_process')
const Queue = require('bull')

const queueLog = require('../lib/queueLog')

require('pkginfo')(module)

const conf = require('rc')('stampede', {
  // Queue configuration
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
  taskQueue: null,
  responseQueue: 'stampede-response',
  // Command configuration
  taskCommand: null,
  workspaceRoot: null,
  environmentVariablePrefix: 'STAMP_',
  shell: '/bin/bash',
  gitClone: 'ssh',
  // Log file configuration
  stdoutLogFile: 'stdout.log',
  stderrLogFile: 'stderr.log',
  environmentLogFile: 'environment.log',
  taskDetailsLogFile: 'worker.log',
  successSummaryFile: null,
  successTextFile: null,
  errorSummaryFile: null,
  errorTextFile: 'stderr.log',
  logQueuePath: null,
})

const redisConfig = {
  redis: {
    port: conf.redisPort,
    host: conf.redisHost,
    password: conf.redisPassword,
  },
}

console.log(chalk.red(figlet.textSync('stampede', {horizontalLayout: 'full'})))
console.log(chalk.yellow(module.exports.version))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))
console.log(chalk.red('Task Queue: ' + conf.taskQueue))

if (conf.taskQueue == null) {
  console.log(chalk.red('No task queue defined. A worker needs a task queue to operate!'))
  process.exit(1)
}

const workerQueue = new Queue('stampede-' + conf.taskQueue, redisConfig)

workerQueue.process(function(task) {
  // Save the message if our logQueuePath is set
  if (conf.logQueuePath != null) {
    queueLog.save(conf.taskQueue, task.data, conf.logQueuePath)
  }
  return handleTask(task.data)
})

const responseQueue = new Queue(conf.responseQueue, redisConfig)

/**
 * Handle an incoming task
 * @param {*} task
 */
async function handleTask(task) {
  console.dir(task)
  task.status = 'in_progress'
  await updateTask(task)

  // Create the working directory and prepare it
  const workingDirectory = await prepareWorkingDirectory(task)

  // Setup our environment variables
  const environment = collectEnvironment(task, workingDirectory)
  if (conf.environmentLogFile != null && conf.environmentLogFile.length > 0) {
    fs.writeFileSync(workingDirectory + '/' + conf.environmentLogFile, JSON.stringify(environment, null, 2))
  }

  // Execute our task
  const result = await executeTask(workingDirectory, environment)

  // Now finalize our task status
  task.status = 'completed'
  task.conclusion = result.conclusion
  task.output = {
    title: result.title,
    summary: result.summary,
    text: result.text,
  }
  if (conf.taskDetailsLogFile != null && conf.taskDetailsLogFile.length > 0) {
    fs.writeFileSync(workingDirectory + '/' + conf.taskDetailsLogFile, JSON.stringify(task, null, 2))
  }
  await updateTask(task)
}

/**
 * execute the task and capture any results
 * @param {*} workingDirectory
 * @param {*} environment
 */
async function executeTask(workingDirectory, environment) {
  return new Promise(resolve => {
    console.log(chalk.green('--- Executing: ' + conf.taskCommand))

    const stdoutlog = fs.openSync(workingDirectory + '/' + conf.stdoutLogFile, 'a')
    const stderrlog = fs.openSync(workingDirectory + '/' + conf.stderrLogFile, 'a')

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
  const dir = conf.workspaceRoot + '/' + task.external_id
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  }

  if (conf.gitClone === 'ssh' || conf.gitClone === 'https') {
    // Do a clone into our working directory
    console.log(chalk.green('--- performing a git clone from:'))
    if (conf.gitClone === 'ssh') {
      console.log(chalk.green(task.ssh_url))
      await cloneRepo(task.ssh_url, dir)
    } else if (conf.gitClone === 'https') {
      console.log(chalk.green(task.clone_url))
      await cloneRepo(task.clone_url, dir)
    }

    // Handle pull requests differently
    if (task.pullRequest != null) {
      // Now checkout our head sha
      console.log(chalk.green('--- head'))
      console.dir(task.pullRequest.head)
      await gitCheckout(task.pullRequest.head.sha, dir)
      // And then merge the base sha
      console.log(chalk.green('--- base'))
      console.dir(task.pullRequest.base)
      await gitMerge(task.pullRequest.base.sha, dir)
      // Fail if we have merge conflicts
    } else if (task.branch != null) {
      console.log(chalk.green('--- sha'))
      console.dir(task.branch_sha)
      await gitCheckout(task.branch_sha, dir)
    } else if (task.release != null) {
      console.log(chalk.green('--- sha'))
      console.dir(task.release_sha)
      await gitCheckout(task.release_sha, dir)
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
    environment[conf.environmentVariablePrefix + 'TASKID'] = task.task.id
    environment[conf.environmentVariablePrefix + 'BUILDID'] = task.buildID
    environment[conf.environmentVariablePrefix + 'WORKINGDIR'] = workingDirectory

    // Now add in the event specific details, if they are available
    if (task.pullRequest != null) {
      environment[conf.environmentVariablePrefix + 'PULLREQUESTNUMBER'] = task.pullRequest.number
      environment[conf.environmentVariablePrefix + 'PULLREQUESTBRANCH'] = task.pullRequest.head.ref
      environment[conf.environmentVariablePrefix + 'PULLREQUESTBASEBRANCH'] = task.pullRequest.base.ref
    }

    if (task.branch != null) {
      environment[conf.environmentVariablePrefix + 'BRANCH'] = task.branch
    }

    if (task.release != null) {
      environment[conf.environmentVariablePrefix + 'RELEASE'] = task.release
      environment[conf.environmentVariablePrefix + 'TAG'] = task.tag
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
async function updateTask(task) {
  if (task.external_id == null) {
    console.log(chalk.yellow('--- no external id so not updating task'))
    return
  }
  console.log(chalk.green('--- updating task with status: ' + task.status))
  console.dir(task)
  responseQueue.add(task)
}

/**
 * Clone the repository to our working directory
 * @param {*} cloneUrl
 * @param {*} workingDirectory
 */
async function cloneRepo(cloneUrl, workingDirectory) {
  return new Promise(resolve => {
    exec('git clone ' + cloneUrl + ' ' + workingDirectory, (error, stdout, stderr) => {
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
