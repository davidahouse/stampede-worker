#!/usr/bin/env node
"use strict";
const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')
const asyncRedis = require("async-redis")
const fs = require('fs')
const { spawn } = require('child_process')
const { exec } = require('child_process')
const LynnRequest = require('lynn-request')

const conf = require('rc')('stampede', {
  // defaults
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
  taskQueue: 'jobDefaultQueue',
  taskCommand: null,
  taskArguments: '',
  workerTitle: 'stampede-worker',
  workspaceRoot: null,
  gitClone: 'true',
  errorLogFile: 'stderr.log'
})

let client = createRedisClient()
client.on('error', function(err) {
  console.log('redis connect error: ' + err)
})

/**
 * create the redis client
 */
function createRedisClient() {
  if (conf.redisPassword != null) {
    return asyncRedis.createClient({host: conf.redisHost, 
                               port: conf.redisPort, 
                               password: conf.redisPassword})
  } else {
    return asyncRedis.createClient({host: conf.redisHost, 
                               port: conf.redisPort})
  }
}

/**
 * wait for a job to arrive on our task queue
 */
async function waitForJob() {
  console.log(chalk.yellow('Waiting on jobs on ' + conf.taskQueue + ' queue...'))
  const taskString = await client.brpoplpush('stampede-' + conf.taskQueue, conf.workerTitle, 0)
  if (taskString != null) {
    const task = JSON.parse(taskString)
    await handleTask(task)
  }
  setTimeout(waitForJob, 0.1)
}

/**
 * Handle an incoming task
 * @param {*} task 
 */
async function handleTask(task) {
  task.status = 'in_progress'
  await updateTask(task)

  // Setup our environment variables
  const environment = collectEnvironment(task)

  // Create the working directory and prepare it
  const workingDirectory = await prepareWorkingDirectory(task)

  // Execute our task
  const result = await executeTask(workingDirectory, environment)

  // Now finalize our task status
  task.status = 'completed'
  task.conclusion = result.conclusion
  task.output = {
    title: result.title,
    summary: result.summary,
    text: result.text
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
      shell: '/bin/zsh'
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
      environment[key.toUpperCase()] = task.config.config[key]
    })
    environment['PULLREQUESTNUMBER'] = task.pullRequest.number
    environment['PULLREQUESTBRANCH'] = task.pullRequest.head.ref
    environment['PULLREQUESTBASEBRANCH'] = task.pullRequest.base.ref
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
  await client.set('stampede-' + task.external_id, JSON.stringify(task))
  return new Promise(resolve => {
    const request = {
      title: 'taskUpdate',
      options: {
        protocol: 'http:',
        port: 7766,
        method: 'POST',
        host: 'localhost',
        path: '/task',
        body: {
          external_id: task.external_id
        },
        headers: {
          'Content-Type': 'application/json',
        },
      }
    }
    const runner = new LynnRequest(request)
    runner.execute(function(result) {
      resolve()
    })
  })
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

clear()
console.log(chalk.red(figlet.textSync('stampede worker', {horizontalLayout: 'full'})))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))
console.log(process.env.PATH)
waitForJob()
