# stampede-worker

This app can process tasks from a stampede queue and send task updates back to a response queue. Each worker is configured for a specific task id and also determines which command line should be executed when the task is processed.

To run the worker:

```
npm install -g stampede-worker
stampede-worker
```

## Configuration

Put a .stampederc file in the path, or pass the path to the config file using the `--config <path>` command line option when starting the worker to set the configuration parameters.

Config file is in the following format:

config param=config value

The configuration parameters are:

| Config | Default | Description |
| ------ | ------- | ----------- |
| redisHost | localhost | The host name for redis |
| redisPort | 6379 | The port for redis |
| redisPassword | null | The password for redis if needed |
| taskQueue | null | The task id that this worker should process events for |
| taskCommand | null | The command line to execute to process the task |
| workspaceRoot | null | The root folder for executing the command in |
| gitClone | 'true' | If a git clone should be made before executing command for a task |
| errorLogFile | stderr.log | The name of the file to send as the summary for a failed task |
| responseQueue | stampede-response | The name of the queue to send the task updates to |
| environmentVariablePrefix | 'STAMP_' | The prefix for any environment variables |

## Environment

The following environment variables are created and passed to the command line:

- STAMP_OWNER
- STAMP_REPO
- STAMP_BUILDNUMBER
- STAMP_TASKID
- STAMP_BUILDID

And for any configuration set from the task, the format will be:

- STAMP_CONFIGPARAMNAME = VALUE

And depending on if the task was created from a pull request, branch push or release creation, the following environment variables might also be available:

Pull requests:

- STAMP_PULLREQUESTNUMBER
- STAMP_PULLREQUESTBRANCH
- STAMP_PULLREQUESTBASEBRANCH

Branch pushes:

- STAMP_BRANCH

Releases:

- STAMP_RELEASE
- STAMP_TAG

*note:* the prefix STAMP_ is the default, but can be overriden with the `environmentVariablePrefix` config value.
