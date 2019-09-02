#!/usr/bin/env node
const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')
const asyncRedis = require("async-redis")
const fs = require('fs')
const { exec } = require('child_process')
const LynnRequest = require('lynn-request')

const conf = require('rc')('stampede', {
  // defaults
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
  taskQueue: 'jobDefaultQueue',
  taskCommand: null,
  workerTitle: 'stampede-worker',
  workspaceRoot: null,
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
  await updateTask(task)
}

/**
 * execute the task and capture any results
 * @param {*} workingDirectory 
 * @param {*} environment 
 */
async function executeTask(workingDirectory, environment) {
  return new Promise(resolve => {
    console.log('--- Executing: ' + conf.taskCommand)
    const options = {
      cwd: workingDirectory,
      env: environment,
    }

    exec(conf.taskCommand, options, (error, stdout, stderr) => {
      if (error) {
        console.log(chalk.green(`stdout: ${stdout}`))
        console.log(chalk.red(`stderr: ${stderr}`))
        console.error(`exec error: ${error}`)
          // TODO: figure out the error reason
        resolve({conclusion: 'failure', title: '', summary: '```\n' + error + '\n```', text: ''})
        return
      }
      console.log(chalk.green(`stdout: ${stdout}`))
      console.log(chalk.red(`stderr: ${stderr}`))
      resolve({conclusion: 'success', title: '', summary: '', text: ''})
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

  // Do a clone into our working directory
  console.log(chalk.green('--- clone url'))
  console.log(chalk.green(task.clone_url))
  await cloneRepo(task.clone_url, dir)
  await execute('ls -la', dir)

  // Now checkout our head sha
  console.log(chalk.green('--- head'))
  console.dir(task.pullRequest.head)
  await gitCheckout(task.pullRequest.head.sha, dir)
  // And then merge the base sha
  console.log(chalk.green('--- base'))
  console.dir(task.pullRequest.base)
  await gitMerge(task.pullRequest.base.sha, dir)

  // Fail if we have merge conflicts
  return dir
}

/**
 * Return any environment parameters from the task
 * @param {*} task 
 * @return {object} the config values
 */
function collectEnvironment(task) {
  return task.task.config
}

/**
 * Update the task in redis and in github
 * @param {*} task 
 */
async function updateTask(task) {
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
        body: task,
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

waitForJob()
