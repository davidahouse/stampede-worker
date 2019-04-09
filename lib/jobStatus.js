
async function jobDetails(client, jobIdentifier) {
    const rawJobDetails = await client.get(jobIdentifier)
    return JSON.parse(rawJobDetails)
}

async function jobDone(client, jobIdentifier, jobStatus, workerTitle, cb) {
    const job = await jobDetails(client, jobIdentifier)
    if (jobStatus === 'failed') {
        job.status.status = 'failed'
    } else {
        job.status.status = 'done'
    }
    job.status.doneTime = new Date()
    console.log('jobDone')
    await client.set(jobIdentifier, JSON.stringify(job))
    await client.lrem(workerTitle, 0, jobIdentifier)
    cb()
}

async function jobInProgress(client, jobIdentifier, worker) {
    const job = await jobDetails(client, jobIdentifier)
    job.status.status = 'inProgress'
    job.status.worker = worker
    job.status.startTime = new Date()
    await client.set(jobIdentifier, JSON.stringify(job))  
}

async function jobStartStage(client, jobIdentifier, stage) {
    const job = await jobDetails(client, jobIdentifier)
    job.status.currentStage = stage
    let stageDetails = job.status.stages
    if (stageDetails == null) {
      stageDetails = [{stage: stage, startTime: new Date()}]
    } else {
      stageDetails.push({stage: stage, startTime: new Date()})
    }
    job.status.stages = stageDetails
    await client.set(jobIdentifier, JSON.stringify(job))
}

async function jobEndStage(client, jobIdentifier, stage) {
    const job = await jobDetails(client, jobIdentifier)
    job.status.currentStage = ''
    const stageIndex = job.status.stages.findIndex(stageDetails => stageDetails.stage === stage)
    if (stageIndex != -1) {
        job.status.stages[stageIndex].endTime = new Date()    
    }
    await client.set(jobIdentifier, JSON.stringify(job))
}

async function jobStartStep(client, jobIdentifier, stage, step) {
    const job = await jobDetails(client, jobIdentifier)
    job.status.currentStep = step
    const stageIndex = job.status.stages.findIndex(stageDetails => stageDetails.stage === stage)
    let stepIndex = 0
    if (stageIndex != -1) {
      if (job.status.stages[stageIndex].steps == null) {
        job.status.stages[stageIndex].steps = [{step: step, startTime: new Date()}]
      } else {
        job.status.stages[stageIndex].steps.push({step: step, startTime: new Date()})
        stepIndex = job.status.stages[stageIndex].steps.length - 1
      }
      await client.set(jobIdentifier, JSON.stringify(job))
    } else {
      console.log('Unable to find stage, something must be wrong!')
    }  
}

async function jobEndStep(client, jobIdentifier, stage, step, stepStatus, cb) {
    const job = await jobDetails(client, jobIdentifier)
    job.status.currentStep = ''
    const stageIndex = job.status.stages.findIndex(stageDetails => stageDetails.stage === stage)
    if (stageIndex != -1) {
        const stepIndex = job.status.stages[stageIndex].steps.findIndex(stepDetails => stepDetails.step === step)
        if (stepIndex != -1) {
            job.status.stages[stageIndex].steps[stepIndex].endTime = new Date()
            job.status.stages[stageIndex].steps[stepIndex].status = stepStatus
            await client.set(jobIdentifier, JSON.stringify(job))
        } else {
            console.log('step ' + step + ' in stage ' + stage + ' not found')
        }
    } else {
        console.log('stage ' + stage + ' not found')
    }
    cb()
}

module.exports.jobDetails = jobDetails
module.exports.jobDone = jobDone
module.exports.jobInProgress = jobInProgress
module.exports.jobStartStage = jobStartStage
module.exports.jobEndStage = jobEndStage
module.exports.jobStartStep = jobStartStep
module.exports.jobEndStep = jobEndStep