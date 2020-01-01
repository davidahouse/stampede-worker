# stampede-worker

![npm](https://img.shields.io/npm/v/stampede-worker?style=for-the-badge)

[www.stampedeci.com](https://www.stampedeci.com)

This app can process tasks from a stampede queue and send task updates back to a response queue. Each worker is configured for a specific task id and also determines which command line should be executed when the task is processed.

To run the worker:

```
npm install -g stampede-worker
stampede-worker
```
