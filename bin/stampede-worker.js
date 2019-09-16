#!/usr/bin/env node
'use strict'

const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')
const fs = require('fs')
const { spawn } = require('child_process')
const { exec } = require('child_process')
const Queue = require('bull')

const conf = require('rc')('stampede', {
  // defaults
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
  taskQueue: null,
  taskCommand: null,
  taskArguments: '',
  workerTitle: 'stampede-worker',
  workspaceRoot: null,
  gitClone: 'true',
  errorLogFile: 'stderr.log',
  responseQueue: 'stampede-response',
  environmentVariablePrefix: 'STAMP-',
})

const redisConfig = {
  redis: {
    port: conf.redisPort,
    host: conf.redisHost,
    password: conf.redisPassword,
  },
}

clear()
console.log(chalk.red(figlet.textSync('stampede worker', {horizontalLayout: 'full'})))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))
console.log(process.env.PATH)

const workerQueue = new Queue('stampede-' + conf.taskQueue, {
  redisConfig,
})

workerQueue.process(function(task) {
  return handleTask(task.data)
})

const responseQueue = new Queue(conf.responseQueue, {
  redisConfig,
})

/**
 * Handle an incoming task
 * @param {*} task
 */
async function handleTask(task) {
  console.dir(task)
  task.status = 'in_progress'
  await updateTask(task)

  // Setup our environment variables
  const environment = collectEnvironment(task)

  // Create the working directory and prepare it
  const workingDirectory = await prepareWorkingDirectory(task)
  fs.writeFileSync(workingDirectory + '/environment.log', JSON.stringify(environment, null, 2))

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
  fs.writeFileSync(workingDirectory + '/worker.log', JSON.stringify(task, null, 2))
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

    const stdoutlog = fs.openSync(workingDirectory + '/stdout.log', 'a')
    const stderrlog = fs.openSync(workingDirectory + '/stderr.log', 'a')

    const options = {
      cwd: workingDirectory,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', stdoutlog, stderrlog],
      shell: '/bin/zsh',
    }

    const spawned = spawn(conf.taskCommand, options)
    spawned.on('close', (code) => {
      console.log(chalk.green('--- task finished: ' + code))
      if (code != 0) {
        let errorLog = ''
        if (fs.existsSync(workingDirectory + '/' + conf.errorLogFile)) {
          errorLog = fs.readFileSync(workingDirectory + '/' + conf.errorLogFile, 'utf8')
        }
        resolve({conclusion: 'failure', title: 'Task results', summary: 'Task failed', text: errorLog})
      } else {
        let taskLog = ''
        if (fs.existsSync(workingDirectory + '/task.log')) {
          taskLog = fs.readFileSync(workingDirectory + '/task.log', 'utf8')
        }
        resolve({conclusion: 'success', title: 'Task results', summary: 'Task was successfull', text: taskLog})
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

  if (conf.gitClone == 'true') {
    // Do a clone into our working directory
    console.log(chalk.green('--- clone url'))
    console.log(chalk.green(task.clone_url))
    await cloneRepo(task.clone_url, dir)
    await execute('ls -la', dir)

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
  }
  return dir
}

/**
 * Return any environment parameters from the task
 * @param {*} task
 * @return {object} the config values
 */
function collectEnvironment(task) {
  var environment = process.env
  console.dir(task.config)
  console.dir(task.config.config)
  if (task.config != null && task.config.config != null) {
    Object.keys(task.config.config).forEach(function(key) {
      console.log('--- key: ' + key)
      environment[conf.environmentVariablePrefix + key.toUpperCase()] = task.config.config[key]
    })

    // And some common things from all events
    environment[conf.environmentVariablePrefix + 'OWNER'] = task.owner
    environment[conf.environmentVariablePrefix + 'REPO'] = task.repository
    environment[conf.environmentVariablePrefix + 'BUILDNUMBER'] = task.buildNumber
    environment[conf.environmentVariablePrefix + 'TASKID'] = task.task.id
    environment[conf.environmentVariablePrefix + 'BUILDID'] = task.buildID

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
 * Execute a command
 * @param {*} cmd
 * @param {*} workingDirectory
 */
async function execute(cmd, workingDirectory) {
  return new Promise(resolve => {
    exec(cmd, {cwd: workingDirectory}, (error, stdout, stderr) => {
      if (error) {
        console.error(`execute error: ${error}`)
        // TODO: figure out the error reason
        resolve(false)
        return
      }
      console.log(`stdout: ${stdout}`)
      console.log(`stderr: ${stderr}`)
      resolve(true)
    })
  })
}
