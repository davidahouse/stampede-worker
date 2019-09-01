#!/usr/bin/env node
const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')
const asyncRedis = require("async-redis")
const fs = require('fs')
const { exec } = require('child_process')
const LynnRequest = require('lynn-request')

const jobStatus = require('../lib/jobStatus')
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

async function waitForJob() {
  console.log(chalk.yellow('Waiting on jobs on ' + conf.taskQueue + ' queue...'))
  const taskString = await client.brpoplpush('stampede-' + conf.taskQueue, conf.workerTitle, 0)
  const task = JSON.parse(taskString)
  console.dir(task)

  const taskStatus = createTaskStatus(task)
  taskStatus.status = 'in_progress'
  await updateTaskCheck(taskStatus)

  task.status = 'in_progress'
  await updateTask(task)

  const result = await processTask(task)
  taskStatus.status = 'completed'
  taskStatus.conclusion = result.conclusion
  taskStatus.output = {
    title: result.title,
    summary: result.summary,
    text: result.text
  }
  await updateTaskCheck(taskStatus)

  task.status = 'completed'
  task.conclusion = result.conclusion
  task.output = {
    title: result.title,
    summary: result.summary,
    text: result.text
  }
  await updateTask(task)
  setTimeout(waitForJob, 0.1)
}

async function processTask(task) {
  const environment = collectEnvironment(task)
  console.dir(environment)

  const workingDirectory = await prepareWorkingDirectory(task)
  const result = await executeTask(workingDirectory, environment)
  return result
}

async function executeTask(workingDirectory, environment) {
  return new Promise(resolve => {
    const options = {
      cwd: workingDirectory,
      env: environment
    }

    exec(conf.taskCommand, options, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`)
        // TODO: figure out the error reason
        resolve({conclusion: 'failure', title: '', summary: `${error}`, text: ''})
        return
      }
      console.log(`stdout: ${stdout}`)
      console.log(`stderr: ${stderr}`)
      resolve({conclusion: 'success', title: '', summary: '', text: ''})
    })
  })
}

function createTaskStatus(task) {
  return {
    owner: task.build.owner,
    repository: task.build.repository,
    buildNumber: task.build.build,
    pullRequest: task.build.pullRequest,
    task: {
      id: task.task.id
    },
    status: task.status,
    check_run_id: task.check_run_id,
  }
}

async function prepareWorkingDirectory(task) {
  const dir = conf.workspaceRoot + '/' + task.external_id
  console.log('working directory: ' + dir)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  }

  // Do a clone into our working directory
  console.log('--- clone url')
  console.log(task.build.githubEvent.repository.clone_url)
  await cloneRepo(task.build.githubEvent.repository.clone_url, dir)
  await execute('ls -la', dir)

  // Now checkout our head sha
  console.log('--- head')
  console.dir(task.build.pullRequest.head)
  await gitCheckout(task.build.pullRequest.head.sha, dir)
  // And then merge the base sha
  console.log('--- base')
  console.dir(task.build.pullRequest.base)
  await gitMerge(task.build.pullRequest.base.sha, dir)

  // Fail if we have merge conflicts
  return dir
}

function collectEnvironment(task) {
  return task.task.config
}

async function updateTask(task) {
  console.log('--- updating task with status: ' + task.status)
  await client.set('stampede-' + task.external_id, JSON.stringify(task))
}

async function updateTaskCheck(task) {
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
    console.dir(request)
    const runner = new LynnRequest(request)
    runner.execute(function(result) {
      resolve()
    })
  })
}

async function cloneRepo(cloneUrl, workingDirectory) {
  return new Promise(resolve => {
    exec('git clone ' + cloneUrl + ' ' + workingDirectory, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`)
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

async function gitCheckout(sha, workingDirectory) {
  return new Promise(resolve => {
    exec('git checkout -f ' + sha, {cwd: workingDirectory}, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`)
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

async function gitMerge(sha, workingDirectory) {
  return new Promise(resolve => {
    exec('git merge ' + sha, {cwd: workingDirectory}, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`)
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

async function execute(cmd, workingDirectory) {
  return new Promise(resolve => {
    exec(cmd, {cwd: workingDirectory}, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`)
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

// async function executeTask(cmd, cb, jobIdentifier, stage, step) {
//   console.log('executeTask...')
//   jobStatus.jobStartStep(client, jobIdentifier, stage, step)
//   exec(cmd, (error, stdout, stderr) => {
    
//     if (error) {
//       console.error(`exec error: ${error}`)
//       currentJobStatus = 'failed'
//       jobStatus.jobEndStep(client, jobIdentifier, stage, step, 'failed', cb)
//       return
//     }
//     console.log(`stdout: ${stdout}`)
//     console.log(`stderr: ${stderr}`)
//     jobStatus.jobEndStep(client, jobIdentifier, stage, step, 'success', cb)
//   });
// }

// async function startStage(stage, jobIdentifier, cb) {
//   console.log('startStage ' + stage + '...')
//   await jobStatus.jobStartStage(client, jobIdentifier, stage)
//   cb()
// }

// async function endStage(stage, jobIdentifier, cb) {
//   console.log('endStage ' + stage + '...')
//   await jobStatus.jobEndStage(client, jobIdentifier, stage)
//   cb()
// }

// async function processJob(jobIdentifier) {
//   console.log(jobIdentifier)
//   jobStatus.jobInProgress(client, jobIdentifier, conf.workerTitle)
//   currentJobStatus = 'inProgress'
//   currentQueue = new Queue(function(task, cb) {
//     console.log(JSON.stringify(task))
//     if (currentJobStatus != 'failed') {
//       if (task.task === 'execute') {
//         executeTask(task.command, cb, jobIdentifier, task.stage, task.step)
//       } else if (task.task == 'startStage') {
//         startStage(task.stage, jobIdentifier, cb)
//       } else if (task.task == 'endStage') {
//         endStage(task.stage, jobIdentifier, cb)
//       } else {
//         cb()
//       }
//     } else {
//       cb()
//     }
//   })

//   currentQueue.on('drain', function() {
//     jobStatus.jobDone(client, jobIdentifier, currentJobStatus, conf.workerTitle, function() {
//       currentJobStatus = 'done'
//       waitForJob()
//     })
//   })

//   const job = await jobStatus.jobDetails(client, jobIdentifier)
//   job.details.stages.forEach((stage) => {
//     currentQueue.push({task: 'startStage', stage: stage.title})
//     if (stage.onStart != null) {
//       currentQueue.push({task: 'execute', command: stage.onStart})
//     }
//     if (stage.steps != null) [
//       stage.steps.forEach((step) => {
//         currentQueue.push({task: 'execute', command: step.command, stage: stage.title, step: step.title})
//       })
//     ]
//     currentQueue.push({task: 'endStage', stage: stage.title})
//   })
// }

clear()
console.log(chalk.red(figlet.textSync('stampede worker', {horizontalLayout: 'full'})))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))

waitForJob()
